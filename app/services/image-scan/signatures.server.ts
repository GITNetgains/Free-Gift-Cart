import zlib from "node:zlib";

// Photo editors, as they name themselves in Software / CreatorTool / XMP
// history / PNG text / JPEG comments. Editing an image isn't generating one,
// so these never drive an AI verdict; they're shown because "this evidence
// photo was retouched" is worth a human look on a damage claim.
export const EDITOR_PATTERNS = [
  /photoshop/i, /lightroom/i, /adobe express/i, /\bgimp\b/i, /affinity photo/i, /snapseed/i, /pixelmator/i,
  /paint\.net/i, /photopea/i, /picsart/i, /facetune/i, /luminar/i, /capture one/i, /remove\.?bg/i,
  /\bcanva\b/i, // word-bounded: "canvas" encoders are not Canva
  /pixlr/i, /fotor/i, /\bvsco\b/i, /meitu/i, /inshot/i, /photodirector/i, /polarr/i, /lightx/i, /photoroom/i,
  /airbrush/i, /befunky/i, /corel/i, /darktable/i, /rawtherapee/i,
];

// Locally-run generators write their whole generation record (prompt,
// sampler, seed, model hash) into PNG text chunks. A hit is strong evidence;
// a miss proves nothing, because a screenshot or re-save drops it.
const SIGNATURES: { tool: string; test: (key: string, value: string) => boolean }[] = [
  {
    tool: "Automatic1111 / Stable Diffusion WebUI",
    test: (key, value) => key.toLowerCase() === "parameters" && /steps:\s*\d+/i.test(value) && /(sampler|cfg scale|seed|model hash)\s*:/i.test(value),
  },
  { tool: "ComfyUI", test: (key, value) => ["prompt", "workflow"].includes(key.toLowerCase()) && /"class_type"|"nodes"\s*:/.test(value) },
  { tool: "NovelAI", test: (key, value) => /novelai/i.test(value) && (key.toLowerCase() === "software" || /"steps"|"sampler"/i.test(value)) },
  { tool: "InvokeAI", test: (key) => ["invokeai_metadata", "sd-metadata", "invokeai_graph"].includes(key.toLowerCase()) },
  { tool: "Fooocus", test: (key, value) => key.toLowerCase() === "fooocus_scheme" || /fooocus/i.test(value) },
  { tool: "Draw Things", test: (_key, value) => /draw ?things/i.test(value) },
];

// PNG text lives in tEXt (plain), zTXt (deflated) and iTXt (optionally
// deflated, with language tags) chunks; different tools pick different ones.
export function readPngTextChunks(buffer: Buffer) {
  const chunks: { key: string; value: string }[] = [];
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return chunks;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") break;
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    try {
      if (type === "tEXt") {
        const split = body.indexOf(0);
        chunks.push({ key: body.toString("latin1", 0, split), value: body.toString("latin1", split + 1) });
      } else if (type === "zTXt") {
        const split = body.indexOf(0);
        chunks.push({ key: body.toString("latin1", 0, split), value: zlib.inflateSync(body.subarray(split + 2)).toString("latin1") });
      } else if (type === "iTXt") {
        const key = body.toString("latin1", 0, body.indexOf(0));
        let cursor = body.indexOf(0) + 1;
        const compressed = body[cursor] === 1;
        cursor += 2; // compression flag + method
        cursor = body.indexOf(0, cursor) + 1; // language tag
        cursor = body.indexOf(0, cursor) + 1; // translated keyword
        const rest = body.subarray(cursor);
        chunks.push({ key, value: (compressed ? zlib.inflateSync(rest) : rest).toString("utf8") });
      }
    } catch {
      // A malformed or truncated chunk isn't worth failing the scan over.
    }
    offset += 12 + length;
  }
  return chunks;
}

export type GeneratorSignature = { tool: string; field: string; excerpt: string };

export function findGeneratorSignature(buffer: Buffer): GeneratorSignature | null {
  for (const { key, value } of readPngTextChunks(buffer)) {
    const match = SIGNATURES.find((signature) => signature.test(key, value || ""));
    if (match) return { tool: match.tool, field: key, excerpt: String(value).replace(/\s+/g, " ").trim().slice(0, 300) };
  }
  return null;
}

// ---------- C2PA / Content Credentials (Layer 1) ----------
//
// A C2PA manifest (OpenAI, Adobe Firefly, Bing Image Creator, Google...)
// declaring the asset AI-generated is the strongest signal there is. The
// manifest bytes sit in the file (a caBX chunk in PNG, a JUMBF APP11 segment
// in JPEG) and the values that decide this are plain text inside the CBOR, so
// they're read directly, extracting only unambiguous spec-defined constants.
// Reading bytes isn't verifying a signature, so provenance found this way is
// "unverified" and is only ever allowed to ADD suspicion, never clear a photo.

const SOURCE_TYPE_MARKERS = [
  { marker: "compositeWithTrainedAlgorithmicMedia", ai: true, label: "Partly AI-generated (composite with AI media)" },
  { marker: "trainedAlgorithmicMedia", ai: true, label: "AI-generated (trained algorithmic media)" },
  { marker: "algorithmicMedia", ai: true, label: "Algorithmically generated" },
  { marker: "digitalCapture", ai: false, label: "Captured by a camera" },
];

// Suffixes are listed rather than matched with \w+ because in raw CBOR the
// next key runs straight into the action name.
const ACTION_PATTERN = /c2pa\.(created|opened|edited|converted|placed|cropped|filtered|resized|color_adjustments|drawing|watermarked(?:\.(?:unbound|bound))?|transcoded|repackaged|printed|published|managed|produced|redacted|removed|orientation)/g;

const KNOWN_GENERATORS = [
  "OpenAI Media Service API", "gpt-image", "DALL-E", "DALL·E", "Google Media Processing Services", "Google C2PA Media Services",
  "Midjourney", "Adobe Firefly", "Firefly", "Imagen", "Gemini", "Stability", "Stable Diffusion", "Flux", "Leonardo",
  "Bing Image Creator", "Microsoft Designer", "Grok",
];

export type C2paResult = {
  present: boolean; checked: true; source?: "raw-manifest"; validation?: { state: "unverified"; tampered: false };
  claimGenerator?: string | null; softwareAgent?: string | null; softwareVersion?: string | null; generatedAt?: string | null;
  signatureIssuer?: string | null; specVersion?: string | null; actions?: string[]; aiActions?: string[];
  isAiGenerated?: boolean; capturedByCamera?: false; declaresWatermark?: boolean; error?: string;
};

export function analyzeC2pa(buffer: Buffer): C2paResult {
  const text = buffer.toString("latin1");
  // Require real C2PA container markers first, so a chance byte sequence in
  // pixel data can't be read as provenance.
  if (!text.includes("jumb") || !text.includes("c2pa")) return { present: false, checked: true };
  const sourceType = SOURCE_TYPE_MARKERS.find((type) => text.includes(type.marker));
  const capture = (pattern: RegExp) => { const match = text.match(pattern); return match ? (match[1] || match[0]) : null; };
  return {
    present: true,
    checked: true,
    source: "raw-manifest",
    validation: { state: "unverified", tampered: false },
    claimGenerator: KNOWN_GENERATORS.find((name) => text.includes(name)) || null,
    softwareAgent: capture(/dname.(gpt-image|midjourney|imagen|firefly|dall-?e|stable[- ]?diffusion)/i),
    softwareVersion: capture(/gversion.(\d+\.\d+(?:\.\d+)?)/),
    // Only the ISO instant beside an action's `when`; ASN.1 times elsewhere belong to certificates.
    generatedAt: capture(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/),
    signatureIssuer: capture(/(SSL\.com|DigiCert|GlobalSign|Entrust|Adobe Inc|Truepic|Google LLC)/i),
    specVersion: capture(/specVersion.{0,2}(\d+\.\d+\.\d+)/),
    actions: [...new Set(Array.from(text.matchAll(ACTION_PATTERN), (match) => match[0]))],
    aiActions: sourceType?.ai ? [sourceType.label] : [],
    isAiGenerated: Boolean(sourceType?.ai),
    // Deliberately never true here: finding the word "digitalCapture" in the
    // bytes verifies nothing, so it must not clear a photo.
    capturedByCamera: false,
    declaresWatermark: /c2pa\.watermarked/.test(text),
  };
}
