import exifr from "exifr";
// exifreader is CommonJS, so under Node ESM only its default export exists.
import ExifReader from "exifreader";
import sharp from "sharp";
import { detectGeminiSparkle, type Sparkle } from "./pixels.server";
import { EDITOR_PATTERNS, findGeneratorSignature, type C2paResult, type GeneratorSignature } from "./signatures.server";

// ---------- EXIF & metadata (Layer 3) ----------
//
// Metadata is stripped by every messaging app, so this layer only ever ADDS
// suspicion; nothing it finds, or fails to find, proves an image genuine.

const AI_TOOL_NAME_PATTERNS = [
  /midjourney/i, /dall-?e/i, /stable diffusion/i, /automatic1111/i, /comfyui/i, /invoke ?ai/i, /adobe firefly/i, /firefly/i,
  /google gemini/i, /imagefx/i, /leonardo\.?ai/i, /nightcafe/i, /playground ?ai/i, /ideogram/i, /runway/i, /novel ?ai/i,
  /fooocus/i, /openai/i, /gpt-image/i, /flux/i,
];

// Generators name downloads predictably, and the customer's filename survives
// an upload even when the EXIF doesn't. Renaming defeats it, so it only adds suspicion.
const AI_FILENAME_PATTERNS = [
  /^chatgpt[ _-]image/i, /^dall[·e_ -]/i, /^gemini[_ -]generated[_ -]image/i, /^grok[_ -]image/i, /^firefly[_ -]/i,
  /^midjourney/i, /^leonardo[_ -]/i, /^stable[_ -]?diffusion/i, /^comfyui[_ -]?\d+/i,
  /^designer(\s*\(\d+\))?\.\w+$/i, // Microsoft Designer / Bing Image Creator
  /^\d{5}-\d{9,}\./, // Automatic1111 default: 00001-1234567890.png
  /^[a-z0-9_]+_[a-z0-9 ,.-]{10,}_[0-9a-f-]{8,}\./i, // Midjourney: user_prompt_uuid
];

// Generators render to a pixel budget, not to sensor sizes: OpenAI's gpt-image
// lands at ~1.572 MP whatever the aspect ratio. Circumstantial (a resize
// defeats it, a real photo can land here by chance), so it never flags on its
// own; it only stops a "likely real" verdict.
const GENERATOR_PIXEL_BUDGETS = [{ generator: "OpenAI gpt-image", min: 1_571_000, max: 1_574_000 }];

export function matchGeneratorSize(width: number | null, height: number | null) {
  if (!width || !height) return null;
  const budget = GENERATOR_PIXEL_BUDGETS.find((entry) => width * height >= entry.min && width * height <= entry.max);
  return budget ? { generator: budget.generator, width, height } : null;
}

function matchAny(patterns: RegExp[], values: unknown[]) {
  for (const value of values.filter(Boolean).map(String)) if (patterns.some((pattern) => pattern.test(value))) return value.slice(0, 120);
  return null;
}

const toDate = (value: unknown) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

export type ExifResult = Awaited<ReturnType<typeof analyzeExif>>;

export async function analyzeExif(input: Buffer, fileName: string) {
  const suspiciousFileNameMatch = matchAny(AI_FILENAME_PATTERNS, [fileName]);
  const generatorMetadata = findGeneratorSignature(input);
  let fields: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    // eslint-disable-next-line import/no-named-as-default-member -- CommonJS: only the default export exists under Node ESM
    fields = (await exifr.parse(input, { xmp: true, iptc: true, tiff: true, exif: true, gps: true })) || {};
  } catch (error) {
    parseError = (error as Error).message;
  }
  const field = (key: string) => (fields[key] ?? null) as string | number | null;
  const decoded = await sharp(input).metadata().catch(() => ({} as sharp.Metadata));
  const image = {
    width: decoded.width || (field("ImageWidth") as number) || (field("ExifImageWidth") as number) || null,
    height: decoded.height || (field("ImageHeight") as number) || (field("ExifImageHeight") as number) || null,
    // What the camera recorded; edit forensics compares these with the pixels.
    exifWidth: (field("ExifImageWidth") as number) || null,
    exifHeight: (field("ExifImageHeight") as number) || null,
    hasAlpha: decoded.hasAlpha ?? null,
    format: decoded.format ?? null,
    fileSize: input.length,
    megapixels: 0,
  };
  image.megapixels = image.width && image.height ? Math.round((image.width * image.height) / 10000) / 100 : 0;

  const software = field("Software") ? String(field("Software")) : null;
  const creatorTool = field("CreatorTool") ? String(field("CreatorTool")) : null;
  const camera = {
    make: field("Make") ? String(field("Make")) : null,
    model: field("Model") ? String(field("Model")) : null,
    lens: field("LensModel") ? String(field("LensModel")) : null,
    iso: field("ISO"), fNumber: field("FNumber"), exposureTime: field("ExposureTime"), focalLength: field("FocalLength"),
  };
  const hasCameraMetadata = Boolean(camera.make || camera.model || camera.lens);
  const hasGps = fields.latitude != null && fields.longitude != null;
  const dateTimeOriginal = toDate(fields.DateTimeOriginal);
  const createDate = toDate(fields.CreateDate);
  const modifyDate = toDate(fields.ModifyDate);
  // A minute of slack keeps camera write-behind from reading as an edit.
  const captured = dateTimeOriginal || createDate;
  const modifiedAfterCapture = Boolean(captured && modifyDate && modifyDate.getTime() - captured.getTime() > 60_000);

  // XMP's edit history lists every tool that touched the file, even when Software was reset.
  const history = fields.History;
  const editHistory = (Array.isArray(history) ? history : history ? [history] : [])
    .map((entry) => (typeof entry === "string" ? entry : (entry as Record<string, unknown>)?.softwareAgent || (entry as Record<string, unknown>)?.SoftwareAgent))
    .filter(Boolean).map(String);
  const editedWith = matchAny(EDITOR_PATTERNS, [software, creatorTool, ...editHistory]);
  const suspiciousSoftwareMatch = matchAny(AI_TOOL_NAME_PATTERNS, [software, creatorTool, camera.make, camera.model, fields.Creator, ...editHistory]);
  const xmpDigitalSourceType = matchAny([/algorithmicMedia|trainedAlgorithmic/i], [fields.DigitalSourceType, fields["Iptc4xmpExt:DigitalSourceType"], fields.digitalSourceType]);
  // Real camera metadata means it isn't a generator render, whatever its size.
  const generatorSizeMatch = hasCameraMetadata ? null : matchGeneratorSize(image.width, image.height);
  const metadataStripped = !software && !creatorTool && !hasCameraMetadata && !dateTimeOriginal && !createDate && !modifyDate;

  const findings: string[] = [];
  if (suspiciousSoftwareMatch) findings.push(`Metadata names an AI tool: "${suspiciousSoftwareMatch}"`);
  if (xmpDigitalSourceType) findings.push(`XMP declares the source type as "${xmpDigitalSourceType}"`);
  if (generatorMetadata) findings.push(`Embedded ${generatorMetadata.tool} generation record`);
  if (suspiciousFileNameMatch) findings.push("Filename matches an AI generator's naming pattern");
  if (generatorSizeMatch) findings.push(`Pixel count matches ${generatorSizeMatch.generator} output (${image.width}×${image.height})`);
  if (editedWith) findings.push(`Edited with ${editedWith}`);
  if (modifiedAfterCapture) findings.push("Last modified after the capture date");
  if (metadataStripped) findings.push("No metadata at all, so it can't corroborate the image either way");
  else if (!hasCameraMetadata) findings.push("No camera information");

  return {
    checked: true as const, image, software, creatorTool, camera, hasCameraMetadata, hasGps, dateTimeOriginal, createDate, modifyDate,
    modifiedAfterCapture, editedWith, editHistory, suspiciousSoftwareMatch, suspiciousFileNameMatch, generatorSizeMatch,
    xmpDigitalSourceType, generatorMetadata, metadataStripped, findings, ...(parseError ? { error: parseError } : {}),
  };
}

// ---------- Device signature ----------
//
// Make/Model are plain text anyone can write. A phone also writes a MakerNote,
// a proprietary binary block starting with the vendor's magic bytes, which a
// casual forger doesn't. A matching MakerNote corroborates a coherent capture;
// its absence is the normal state of a forwarded photo and never counts against it.

const VENDOR_SIGNATURES = [
  { vendor: "Apple", pattern: /^Apple iOS\0/ }, { vendor: "Samsung", pattern: /^(SAMSUNG|SEMC)/i }, { vendor: "Nikon", pattern: /^Nikon\0/i },
  { vendor: "Sony", pattern: /^SONY (DSC|CAM|MOBILE)/i }, { vendor: "Panasonic", pattern: /^Panasonic\0/i }, { vendor: "Olympus", pattern: /^(OLYMP|OM SYSTEM)/i },
  { vendor: "Fujifilm", pattern: /^FUJIFILM/i }, { vendor: "Ricoh", pattern: /^(RICOH|PENTAX)/i }, { vendor: "Leica", pattern: /^LEICA/i },
  { vendor: "Motorola", pattern: /^MOT/i },
];

export function readVendorSignature(bytes: Buffer | null) {
  if (!bytes || bytes.length < 4) return null;
  const head = bytes.toString("latin1", 0, Math.min(16, bytes.length));
  return VENDOR_SIGNATURES.find((signature) => signature.pattern.test(head))?.vendor || null;
}

export function vendorMatchesMake(vendor: string | null, make: string | null) {
  if (!vendor || !make) return false;
  const a = vendor.toLowerCase();
  const b = make.toLowerCase();
  return b.includes(a) || a.includes(b.split(/[\s,]/)[0]);
}

export type DeviceSignature = { checked: boolean; attested: boolean; make?: string | null; model?: string | null; makerNote?: { present: boolean; bytes: number; vendor: string | null }; error?: string };

export async function analyzeDeviceSignature(input: Buffer): Promise<DeviceSignature> {
  let tags: Record<string, Record<string, { value?: unknown; description?: unknown }>>;
  try {
    // eslint-disable-next-line import/no-named-as-default-member -- see the import note above
    tags = (await ExifReader.load(input, { expanded: true, includeUnknown: true })) as unknown as typeof tags;
  } catch (error) {
    return { checked: false, attested: false, error: (error as Error).message };
  }
  const exif = tags.exif || {};
  const make = exif.Make?.description ? String(exif.Make.description) : null;
  const model = exif.Model?.description ? String(exif.Model.description) : null;
  const raw = exif.MakerNote?.value;
  const bytes = raw && (Array.isArray(raw) || ArrayBuffer.isView(raw)) ? Buffer.from(raw as Uint8Array) : null;
  // Canon and Pentax write no magic; ExifReader decodes them into a makerNotes group instead.
  const decodedGroup = Boolean(tags.makerNotes && Object.keys(tags.makerNotes).length);
  const vendor = readVendorSignature(bytes) || (decodedGroup && /^(canon|pentax)/i.test(make || "") ? make : null);
  return {
    checked: true, make: make?.slice(0, 80) ?? null, model: model?.slice(0, 80) ?? null,
    makerNote: { present: Boolean(bytes?.length || decodedGroup), bytes: bytes?.length || 0, vendor },
    attested: Boolean(vendor && vendorMatchesMake(vendor, make)),
  };
}

// ---------- Watermarks (Layer 2) ----------
//
// Locally checkable: an embedded generator record, a watermark the C2PA
// manifest declares, and Gemini's visible sparkle. SynthID-style invisible
// pixel watermarks need the vendor's own detector, so a miss here doesn't
// mean there's no watermark.

export type WatermarkResult = {
  checked: true; detected: boolean; declared: boolean; generatorSignature: GeneratorSignature | null;
  visibleMark: Sparkle | null; visibleScore?: number | null; reason: string;
};

export async function analyzeWatermark(input: Buffer, c2pa: C2paResult): Promise<WatermarkResult> {
  const generatorSignature = findGeneratorSignature(input);
  const declared = Boolean(c2pa?.declaresWatermark);
  const visible = await detectGeminiSparkle(input).catch(() => null);
  const visibleMark = visible?.detected ? visible : null;
  if (generatorSignature || declared || visibleMark) {
    return {
      checked: true, detected: true, declared, generatorSignature, visibleMark,
      reason: generatorSignature ? `The file carries a ${generatorSignature.tool} generation record.`
        : visibleMark ? `${visibleMark.generator}'s visible ${visibleMark.mark} watermark is in the bottom-right corner (match ${Math.round(visibleMark.score * 100)}%).`
        : "The image's own C2PA provenance declares an embedded invisible watermark.",
    };
  }
  return {
    checked: true, detected: false, declared: false, generatorSignature: null, visibleMark: null, visibleScore: visible?.score ?? null,
    reason: "No embedded generator signature, declared watermark or visible generator mark found. Invisible pixel watermarks such as SynthID can't be checked offline, so this doesn't rule one out.",
  };
}
