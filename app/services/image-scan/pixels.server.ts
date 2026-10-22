import { createHash } from "node:crypto";
import sharp from "sharp";

// ---------- Hashes (Layer 4) ----------
//
// contentHash (sha256 of the bytes) catches the exact same file re-uploaded;
// perceptualHash (64-bit dHash) catches the same photo re-saved, re-compressed
// or cropped, which differs by only a few bits.

export type AlphaInfo = { width: number; height: number; core: { left: number; top: number; width: number; height: number } | null; coreFullyOpaque: boolean; partialPixels: number };

// Canva-style "frame" exports place the photo, scaled down, on a canvas with a
// transparent feathered border, which moves the dHash far from the original.
// Hashing only the fully-opaque region keeps such a copy matching. Edit
// forensics also reads this to recognise a design-tool export.
export async function analyzeAlpha(input: Buffer): Promise<AlphaInfo | null> {
  const { hasAlpha } = await sharp(input).metadata();
  if (!hasAlpha) return null;
  const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let left = width, top = height, right = -1, bottom = -1, opaquePixels = 0, partialPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + channels - 1];
      if (alpha > 0 && alpha < 255) partialPixels++;
      if (alpha !== 255) continue;
      opaquePixels++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const core = right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
  // Every pixel inside the opaque box is opaque: a clean rectangle, not a cut-out.
  return { width, height, core, coreFullyOpaque: Boolean(core) && opaquePixels === core!.width * core!.height, partialPixels };
}

// 9x8 grayscale grid -> 64 "darker than the next pixel" bits.
export async function dHashBits(input: Buffer, crop?: { left: number; top: number; width: number; height: number } | null, options: { flatten?: boolean } = {}) {
  let pipeline = sharp(input);
  if (crop) pipeline = pipeline.extract(crop);
  if (options.flatten) pipeline = pipeline.removeAlpha();
  const { data } = await pipeline.grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const bits: number[] = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) bits.push(data[row * 9 + col] > data[row * 9 + col + 1] ? 1 : 0);
  return bits;
}

async function perceptualHash(input: Buffer) {
  const alpha = await analyzeAlpha(input);
  const region = alpha?.core && (alpha.core.width !== alpha.width || alpha.core.height !== alpha.height) ? alpha.core : null;
  const bits = await dHashBits(input, region, { flatten: true });
  let hex = "";
  for (let index = 0; index < 64; index += 4) hex += parseInt(bits.slice(index, index + 4).join(""), 2).toString(16);
  return hex;
}

export function hammingDistanceHex(a: string | null, b: string | null) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let distance = 0;
  for (let index = 0; index < a.length; index++) {
    let diff = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    while (diff) { distance += diff & 1; diff >>= 1; }
  }
  return distance;
}

export async function computeHashes(input: Buffer) {
  return {
    contentHash: createHash("sha256").update(input).digest("hex"),
    perceptualHash: await perceptualHash(input).catch(() => null),
  };
}

// ---------- Visible watermark: Gemini's sparkle (part of Layer 2) ----------
//
// Gemini stamps a translucent four-point star in the bottom-right corner. Unlike
// metadata it survives WhatsApp forwards and screenshots. Its size and margin
// vary by version and any resize scales both, so a concave-star template is
// matched against the corner over a range of sizes, along the diagonal where
// the right and bottom gaps are about equal. Armorship calibrated the
// threshold on real uploads (marked images 0.73-0.78, unmarked at most 0.52).
// A miss proves nothing: the mark is cropped out in seconds.

const WORKING_SHORT_SIDE = 512;
export const SPARKLE_THRESHOLD = 0.65;
const MIN_CONTRAST = 8;
const MIN_SIZE = 12;

// |x|^p + |y|^p <= 1 with p < 1 is a star with concave sides.
export function starTemplate(size: number, p = 0.6) {
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.abs(((x + 0.5) / size) * 2 - 1);
      const v = Math.abs(((y + 0.5) / size) * 2 - 1);
      mask[y * size + x] = u ** p + v ** p <= 1 ? 1 : 0;
    }
  }
  return mask;
}

export type Sparkle = { detected: boolean; generator?: string; mark?: string; score: number; size?: number; gapRight?: number; gapBottom?: number };

export async function detectGeminiSparkle(input: Buffer): Promise<Sparkle | null> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) return null;
  const scale = Math.min(1, WORKING_SHORT_SIDE / Math.min(meta.width, meta.height));
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);
  const shortSide = Math.min(width, height);
  const region = Math.round(shortSide * 0.4);
  if (region < MIN_SIZE * 2) return { detected: false, score: 0 };

  const corner = { left: width - region, top: height - region, width: region, height: region };
  const pixels = await sharp(input).removeAlpha().resize(width, height).grayscale().extract(corner).raw().toBuffer();
  // Brightness over a median background cancels texture and lighting.
  const background = await sharp(pixels, { raw: { width: region, height: region, channels: 1 } })
    .median(Math.round(shortSide * 0.06) | 1).raw().toBuffer();
  const lift = new Float32Array(region * region);
  for (let index = 0; index < lift.length; index++) lift[index] = pixels[index] - background[index];

  let best: { score: number; size: number; gapRight: number; gapBottom: number } | null = null;
  for (let fraction = 0.025; fraction <= 0.12; fraction += 0.0025) {
    const size = Math.round(shortSide * fraction);
    if (size < MIN_SIZE || size >= region) continue;
    const template = starTemplate(size);
    const n = size * size;
    let starPixels = 0;
    for (const value of template) starPixels += value;
    const templateMean = starPixels / n;
    const templateVar = starPixels * (1 - templateMean) ** 2 + (n - starPixels) * templateMean ** 2;
    for (let gap = Math.round(shortSide * 0.01); gap <= shortSide * 0.25 && gap + size <= region; gap++) {
      const skewLimit = Math.round(gap * 0.2 + 3);
      for (let skew = -skewLimit; skew <= skewLimit; skew++) {
        const gapBottom = gap + skew;
        if (gapBottom < 0 || gapBottom + size > region) continue;
        const ox = region - gap - size;
        const oy = region - gapBottom - size;
        let sum = 0, sumSq = 0, starSum = 0;
        for (let y = 0; y < size; y++) {
          const row = (oy + y) * region + ox;
          for (let x = 0; x < size; x++) {
            const value = lift[row + x];
            sum += value;
            sumSq += value * value;
            if (template[y * size + x]) starSum += value;
          }
        }
        const mean = sum / n;
        const variance = sumSq - n * mean * mean;
        if (variance <= 0) continue;
        const ncc = (starSum - starPixels * mean) / Math.sqrt(variance * templateVar);
        const contrast = starSum / starPixels - (sum - starSum) / (n - starPixels);
        if (contrast > MIN_CONTRAST && (!best || ncc > best.score)) best = { score: ncc, size, gapRight: gap, gapBottom };
      }
    }
  }
  if (!best) return { detected: false, score: 0 };
  const toOriginal = (value: number) => Math.round(value / scale);
  return {
    detected: best.score >= SPARKLE_THRESHOLD, generator: "Google Gemini", mark: "sparkle", score: Math.round(best.score * 1000) / 1000,
    size: toOriginal(best.size), gapRight: toOriginal(best.gapRight), gapBottom: toOriginal(best.gapBottom),
  };
}
