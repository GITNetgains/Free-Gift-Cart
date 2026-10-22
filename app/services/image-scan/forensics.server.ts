import exifr from "exifr";
import sharp from "sharp";
import { analyzeDeviceSignature, type DeviceSignature, type ExifResult } from "./metadata.server";
import { analyzeAlpha, dHashBits, type AlphaInfo } from "./pixels.server";
import { EDITOR_PATTERNS, readPngTextChunks } from "./signatures.server";

// Edit forensics: "was this photo altered after the camera took it?"
//
// Most editors strip EXIF on export, so a retouched photo arrives looking like
// a metadata-less one. This reads what survives: the file's own structure, and
// the camera data's internal consistency when it's kept.
//
//  strong -> 'edited': the file affirmatively says it was worked on (an
//    editor's own segment, an editor named in the file, a camera preview that
//    no longer shows the same picture, a design-tool frame).
//  weak -> 'not_original': not what a camera writes, but a screenshot or a
//    WhatsApp forward looks the same. Worth attention, NOT evidence of editing.
//  info: context only; never moves the level.

// libjpeg's reference quantization tables (ITU T.81 Annex K). Desktop/web
// software encodes with these scaled by quality; phone cameras ship their own.
const IJG_LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const IJG_CHROMINANCE = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...Array(32).fill(99),
];
// DQT segments store coefficients in zigzag order.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

export function scaleIjgTable(base: number[], quality: number) {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return ZIGZAG.map((index) => Math.min(255, Math.max(1, Math.floor((base[index] * scale + 50) / 100))));
}
const sameTable = (a?: number[], b?: number[]) => Boolean(a && b && a.length === b.length && a.every((value, index) => value === b[index]));

// The libjpeg quality whose tables reproduce these exactly, or null.
export function matchIjgQuality(tables: { id: number; values: number[] }[]) {
  const luma = tables.find((table) => table.id === 0)?.values;
  const chroma = tables.find((table) => table.id === 1)?.values;
  if (!luma) return null;
  for (let quality = 100; quality >= 1; quality--) {
    if (!sameTable(luma, scaleIjgTable(IJG_LUMINANCE, quality))) continue;
    if (chroma && !sameTable(chroma, scaleIjgTable(IJG_CHROMINANCE, quality))) continue;
    return quality;
  }
  return null;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// 8BIM resources that record actual editing state (alpha channels, slices,
// layer comps, Photoshop's JPEG quality). Ordinary IPTC/XMP/resolution blocks
// travel with copied metadata and were seen on plain phone photos, so they're excluded.
const PHOTOSHOP_EDITING_RESOURCE_IDS = new Set([0x03ee, 0x0406, 0x0415, 0x041a, 0x0429, 0x042d]);
const isPathResource = (id: number) => id >= 0x07d0 && id <= 0x0bb7;

function readPhotoshopResources(body: Buffer) {
  const ids: number[] = [];
  let offset = body.indexOf("8BIM", 0, "latin1");
  if (offset < 0) return ids;
  while (offset + 12 <= body.length && body.toString("latin1", offset, offset + 4) === "8BIM") {
    const id = body.readUInt16BE(offset + 4);
    const nameLength = body[offset + 6];
    let cursor = offset + 7 + nameLength;
    if ((nameLength + 1) % 2) cursor++;
    if (cursor + 4 > body.length) break;
    const size = body.readUInt32BE(cursor);
    ids.push(id);
    offset = cursor + 4 + size + (size % 2);
  }
  return ids;
}

export type JpegStructure = {
  hasExif: boolean; xmp: string | null; photoshopIrb: boolean; photoshopResourceIds: number[]; photoshopEditingResourceIds: number[];
  photoshopEditingResource: boolean; adobeApp14: boolean; ducky: boolean; comments: string[]; quantTables: { id: number; values: number[] }[];
  frame: { progressive: boolean; height: number; width: number; subsampling: string | null } | null;
};

function describeSubsampling(components: { h: number; v: number }[]) {
  if (components.length < 3) return components.length === 1 ? "grayscale" : null;
  const [y, cb] = components;
  if (y.h === cb.h && y.v === cb.v) return "4:4:4";
  if (y.h === 2 * cb.h && y.v === 2 * cb.v) return "4:2:0";
  if (y.h === 2 * cb.h && y.v === cb.v) return "4:2:2";
  return "other";
}

// Walks the JPEG header up to the start of scan; a malformed file just stops early.
export function readJpegStructure(buffer: Buffer): JpegStructure | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const result: JpegStructure = {
    hasExif: false, xmp: null, photoshopIrb: false, photoshopResourceIds: [], photoshopEditingResourceIds: [], photoshopEditingResource: false,
    adobeApp14: false, ducky: false, comments: [], quantTables: [], frame: null,
  };
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset + 2);
    const body = buffer.subarray(offset + 4, Math.min(buffer.length, offset + 2 + length));
    const head = body.toString("latin1", 0, 32);
    try {
      if (marker === 0xe1 && head.startsWith("Exif\0")) result.hasExif = true;
      else if (marker === 0xe1 && head.startsWith("http://ns.adobe.com/xap/")) result.xmp = body.toString("utf8");
      else if (marker === 0xed && head.startsWith("Photoshop 3.0")) {
        // A large IRB is split across several APP13s, so these accumulate.
        result.photoshopIrb = true;
        result.photoshopResourceIds.push(...readPhotoshopResources(body));
        result.photoshopEditingResourceIds = result.photoshopResourceIds.filter((id) => PHOTOSHOP_EDITING_RESOURCE_IDS.has(id) || isPathResource(id));
        result.photoshopEditingResource = result.photoshopEditingResourceIds.length > 0;
      } else if (marker === 0xee && head.startsWith("Adobe")) result.adobeApp14 = true;
      else if (marker === 0xec && head.startsWith("Ducky")) result.ducky = true;
      else if (marker === 0xfe) result.comments.push(body.toString("latin1").replace(/\0+$/, "").trim());
      else if (marker === 0xdb) {
        let position = 0;
        while (position < body.length) {
          const precision = body[position] >> 4;
          const id = body[position] & 0x0f;
          position++;
          const values: number[] = [];
          for (let index = 0; index < 64; index++) values.push(precision ? body.readUInt16BE(position + index * 2) : body[position + index]);
          position += precision ? 128 : 64;
          result.quantTables.push({ id, values });
        }
      } else if (SOF_MARKERS.has(marker) && body.length >= 6) {
        const components: { h: number; v: number }[] = [];
        for (let index = 0; index < body[5]; index++) {
          const sampling = body[6 + index * 3 + 1];
          components.push({ h: sampling >> 4, v: sampling & 0x0f });
        }
        result.frame = { progressive: marker === 0xc2, height: body.readUInt16BE(1), width: body.readUInt16BE(3), subsampling: describeSubsampling(components) };
      }
    } catch {
      break; // truncated segment
    }
    offset += 2 + length;
  }
  return result;
}

function matchEditor(values: unknown[]) {
  for (const value of values.filter(Boolean).map(String)) if (EDITOR_PATTERNS.some((pattern) => pattern.test(value))) return value.slice(0, 80);
  return null;
}

// A camera writes a small preview at capture. Editors that keep EXIF often
// don't regenerate it, so a preview that no longer matches shows the pixels
// changed. The threshold sits far above re-encoding noise (out of 64 bits).
const THUMBNAIL_MISMATCH_BITS = 18;

async function compareExifThumbnail(input: Buffer, width?: number | null, height?: number | null) {
  if (!width || !height) return null;
  try {
    // eslint-disable-next-line import/no-named-as-default-member -- CommonJS: only the default export exists under Node ESM
    const thumbnail = await exifr.thumbnail(input);
    if (!thumbnail) return null;
    const thumb = Buffer.from(thumbnail);
    const meta = await sharp(thumb).metadata();
    if (!meta.width || !meta.height) return null;
    // Cameras letterbox a wide photo into a 4:3 preview; crop to the main aspect first.
    const ratio = width / height;
    let cropW = meta.width;
    let cropH = Math.round(meta.width / ratio);
    if (cropH > meta.height) { cropH = meta.height; cropW = Math.round(meta.height * ratio); }
    const crop = { left: Math.floor((meta.width - cropW) / 2), top: Math.floor((meta.height - cropH) / 2), width: Math.max(1, cropW), height: Math.max(1, cropH) };
    const [thumbBits, mainBits] = await Promise.all([dHashBits(thumb, crop), dHashBits(input)]);
    const distance = thumbBits.reduce((sum, bit, index) => sum + (bit !== mainBits[index] ? 1 : 0), 0);
    return { distance, mismatch: distance >= THUMBNAIL_MISMATCH_BITS };
  } catch {
    return null;
  }
}

// Canva-style export: a fully-opaque rectangle inset on every side of a
// transparent, feathered page. Cut-outs and rounded screenshots don't qualify.
export function detectDesignFrame(alpha: AlphaInfo | null) {
  if (!alpha?.core || !alpha.coreFullyOpaque || !alpha.partialPixels) return null;
  const { width, height, core } = alpha;
  const margins = [core.left, core.top, width - core.left - core.width, height - core.top - core.height];
  if (margins.some((margin) => margin < Math.min(width, height) * 0.01)) return null;
  return { core, insetPercent: Math.round((1 - core.width / width) * 100) };
}

export type Coherence = { coherent: boolean; reason: string | null; attested: boolean };

// Does the camera data hang together as a real capture? Consistency, not a
// list of phone models: make/model plus a capture time, dimensions that match
// the pixels, and nothing naming an editor or generator.
export function assessCameraCoherence({ exif, dimensionsDisagree, device }: { exif?: Partial<ExifResult> | null; dimensionsDisagree: boolean; device?: DeviceSignature | null }): Coherence {
  const attested = device?.attested === true;
  if (!exif?.hasCameraMetadata) return { coherent: false, reason: "no_camera_metadata", attested };
  if (!exif.dateTimeOriginal && !exif.createDate) return { coherent: false, reason: "no_capture_time", attested };
  if (dimensionsDisagree) return { coherent: false, reason: "dimensions_disagree", attested };
  if (exif.editedWith) return { coherent: false, reason: "editor_named", attested };
  if (exif.suspiciousSoftwareMatch) return { coherent: false, reason: "ai_tool_named", attested };
  if (exif.xmpDigitalSourceType) return { coherent: false, reason: "declared_algorithmic", attested };
  if (exif.generatorSizeMatch) return { coherent: false, reason: "generator_pixel_budget", attested };
  return { coherent: true, reason: null, attested };
}

export type Signal = { id: string; strength: "strong" | "weak" | "info"; detail: string };
export type EditLevel = "edited" | "not_original" | "consistent" | "limited" | "unknown";

// The judgement, separate from file reading so it can be tested without fixtures.
export function assessEditing({ format, jpeg, pngSoftware, exif, thumbnail, designFrame, device }: {
  format: string; jpeg?: JpegStructure | null; pngSoftware?: string | null; exif?: Partial<ExifResult> | null;
  thumbnail?: { distance: number; mismatch: boolean } | null; designFrame?: ReturnType<typeof detectDesignFrame>; device?: DeviceSignature | null;
}) {
  const signals: Signal[] = [];
  const strong = (id: string, detail: string) => signals.push({ id, strength: "strong", detail });
  const weak = (id: string, detail: string) => signals.push({ id, strength: "weak", detail });
  const info = (id: string, detail: string) => signals.push({ id, strength: "info", detail });

  const exifW = exif?.image?.exifWidth;
  const exifH = exif?.image?.exifHeight;
  const actualW = jpeg?.frame?.width || exif?.image?.width;
  const actualH = jpeg?.frame?.height || exif?.image?.height;
  const dimensionsDisagree = Boolean(exifW && exifH && actualW && actualH && !((exifW === actualW && exifH === actualH) || (exifW === actualH && exifH === actualW)));
  const cameraCoherence = assessCameraCoherence({ exif, dimensionsDisagree, device });

  let editor = exif?.editedWith || null;
  if (editor) strong("metadata_editor", `Metadata names an editor: ${editor}`);

  if (jpeg?.ducky || jpeg?.photoshopEditingResource) {
    const ids = jpeg.photoshopEditingResourceIds.map((id) => `0x${id.toString(16).padStart(4, "0")}`).join(", ");
    const what = jpeg.ducky ? "Photoshop \"Save for Web\" data" : `Photoshop editing resources (${ids})`;
    if (cameraCoherence.coherent) {
      info("photoshop_segment", `Contains ${what}. The camera data is a coherent original and this block travels with copied metadata, so on its own it isn't evidence of editing`);
    } else {
      editor = editor || "Adobe Photoshop";
      strong("photoshop_segment", `Contains ${what}`);
    }
  } else if (jpeg?.photoshopIrb) {
    info("iptc_metadata_block", "Carries an IPTC/8BIM metadata block, written by many tools, not evidence of editing");
  } else if (jpeg?.adobeApp14 && !exif?.hasCameraMetadata) {
    weak("adobe_encoder", "Saved by an Adobe-compatible JPEG encoder");
  }

  const xmpEditor = matchEditor([jpeg?.xmp?.match(/CreatorTool[">=\s]+([^<"]+)/)?.[1], ...(jpeg?.xmp?.match(/softwareAgent[">=\s]+([^<"]+)/g) || [])]);
  if (xmpEditor && !exif?.editedWith) { editor = editor || xmpEditor; strong("xmp_editor", `XMP records an editor: ${xmpEditor}`); }
  const commentEditor = matchEditor(jpeg?.comments || []);
  if (commentEditor) { editor = editor || commentEditor; strong("comment_editor", `JPEG comment names an editor: ${commentEditor}`); }
  if (pngSoftware) {
    const pngEditor = matchEditor([pngSoftware]);
    if (pngEditor) { editor = editor || pngEditor; strong("png_editor", `PNG records an editor: ${pngEditor}`); }
    else weak("png_software", `Saved by software: ${String(pngSoftware).slice(0, 80)}`);
  }
  if (designFrame) strong("design_frame", `Placed on a design canvas: the picture is shrunk ${designFrame.insetPercent}% inside a transparent, feathered frame (a design-tool export such as Canva)`);

  if (exif?.hasCameraMetadata) {
    if (dimensionsDisagree) weak("dimension_mismatch", `Camera recorded ${exifW}×${exifH} but the image is ${actualW}×${actualH}: resized or cropped after capture`);
    if (device?.attested) {
      info("camera_hardware_signature", `Carries ${device.makerNote?.vendor}'s own camera data block${device.makerNote?.bytes ? `, ${device.makerNote.bytes} bytes` : ""}, matching the recorded make: a hardware fingerprint, not just a name tag`);
    }
    // Phones rewrite ModifyDate routinely (an iOS HEIC→JPEG export stamps every upload), so this is never scored.
    if (exif.modifiedAfterCapture) info("modified_after_capture", "Metadata timestamp differs from capture time; this happens in normal phone processing such as an iOS HEIC→JPEG export");
  } else if (exif?.dateTimeOriginal) {
    info("minimal_camera_data", "Camera capture with limited camera data: a capture time, but no make or model (typical of webcams and computer camera apps)");
  } else if (format === "jpeg" && jpeg) {
    const quality = matchIjgQuality(jpeg.quantTables);
    if (quality != null) {
      weak("software_encoder", `No camera data, and encoded by standard software (quality ${quality}${jpeg.frame?.subsampling === "4:4:4" ? ", full-resolution colour" : ""}): an editor export, screenshot or app re-save, not a camera original`);
    } else if (!jpeg.hasExif) {
      weak("no_camera_data", "No camera data at all: re-saved by an app, not a camera original");
    }
  } else if (["png", "webp", "gif"].includes(format)) {
    weak("non_camera_format", `A ${format.toUpperCase()} with no camera data: a screenshot, editor export or web image, not a camera original`);
  }

  // A preview mismatch proves pixels and preview diverged, not which moved; a
  // phone's own pipeline can cause it, so on a coherent capture it only counts
  // when something else already says the file was worked on.
  if (thumbnail?.mismatch) {
    const corroborated = signals.some((signal) => signal.strength !== "info");
    const detail = "The camera's embedded preview no longer matches the image";
    if (!cameraCoherence.coherent) strong("thumbnail_mismatch", `${detail}: the pixels were changed after capture`);
    else if (corroborated) strong("thumbnail_mismatch", `${detail}, alongside other evidence the file was modified`);
    else info("thumbnail_mismatch", `${detail}. On a coherent camera original this also happens through normal phone processing, so on its own it isn't evidence of editing`);
  }

  const level: EditLevel = signals.some((signal) => signal.strength === "strong") ? "edited"
    : signals.some((signal) => signal.strength === "weak") ? "not_original"
    : exif?.hasCameraMetadata ? "consistent"
    : signals.some((signal) => signal.id === "minimal_camera_data") ? "limited" : "unknown";
  return { level, editor, signals, cameraCoherence };
}

export type EditResult = Awaited<ReturnType<typeof analyzeEditing>>;

export async function analyzeEditing(input: Buffer, exif: ExifResult | null) {
  const format = input[0] === 0xff && input[1] === 0xd8 ? "jpeg"
    : input.length > 4 && input.readUInt32BE(0) === 0x89504e47 ? "png"
    : input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP" ? "webp"
    : input.toString("ascii", 0, 3) === "GIF" ? "gif" : "other";
  const jpeg = format === "jpeg" ? readJpegStructure(input) : null;
  const pngSoftware = format === "png" ? readPngTextChunks(input).find((chunk) => /^software$/i.test(chunk.key))?.value || null : null;
  const width = jpeg?.frame?.width || exif?.image?.width;
  const height = jpeg?.frame?.height || exif?.image?.height;
  const [thumbnail, alpha, device] = await Promise.all([
    exif?.hasCameraMetadata ? compareExifThumbnail(input, width, height) : null,
    format === "png" || format === "webp" ? analyzeAlpha(input).catch(() => null) : null,
    // Only worth reading when the file still claims to be a camera photo.
    exif?.hasCameraMetadata ? analyzeDeviceSignature(input).catch(() => null) : null,
  ]);
  const designFrame = detectDesignFrame(alpha);
  const { level, editor, signals, cameraCoherence } = assessEditing({ format, jpeg, pngSoftware, exif, thumbnail, designFrame, device });
  return {
    checked: true, level, editor, signals, cameraCoherence, device,
    encoder: {
      format,
      ...(jpeg ? { standardTablesQuality: matchIjgQuality(jpeg.quantTables), subsampling: jpeg.frame?.subsampling || null, progressive: jpeg.frame?.progressive || false } : {}),
      ...(pngSoftware ? { software: String(pngSoftware).slice(0, 120) } : {}),
    },
    thumbnail, designFrame,
  };
}

// The detector looks at the picture itself, the only way to catch an edit
// whose file was laundered. Only a confident call counts as manipulation.
const CLASSIFIER_EDIT_THRESHOLD = 70;

export function withClassifierEvidence<T extends { level: EditLevel; signals: Signal[] }>(editing: T, classifier: { editProbability?: number | null; editReasoning?: string | null } | null): T {
  if (typeof classifier?.editProbability !== "number" || classifier.editProbability < CLASSIFIER_EDIT_THRESHOLD) return editing;
  return {
    ...editing, level: "edited",
    signals: [...editing.signals, { id: "visual_manipulation", strength: "strong", detail: `Visual analysis suggests manipulation (${classifier.editProbability}%)${classifier.editReasoning ? `: ${classifier.editReasoning}` : ""}` }],
  };
}
