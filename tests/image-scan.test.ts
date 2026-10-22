import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// The scan queue spaces one store's scans 3s apart in production; not needed here.
vi.hoisted(() => { process.env.AI_SCAN_PER_STORE_PER_MINUTE = "60000"; });
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyImage, describeError, shapeTruthscan, verifyCredentials } from "../app/services/image-scan/detector.server";
import { assessCameraCoherence, matchIjgQuality, readJpegStructure, scaleIjgTable } from "../app/services/image-scan/forensics.server";
import { matchGeneratorSize } from "../app/services/image-scan/metadata.server";
import { detectGeminiSparkle, hammingDistanceHex } from "../app/services/image-scan/pixels.server";
import { combineLayers, detectorDecision, reusableDetectorResult, ScanQueue, scanImage, serializeScan } from "../app/services/image-scan/scan.server";
import { analyzeC2pa, findGeneratorSignature } from "../app/services/image-scan/signatures.server";

const temp = mkdtempSync(join(tmpdir(), "image-scan-test-"));
const db = new PrismaClient({ datasourceUrl: `file:${join(temp, "test.sqlite").replaceAll("\\", "/")}` });
const shop = "scan.myshopify.com";

beforeAll(async () => {
  for (const migration of readdirSync("prisma/migrations").filter(name => name.includes("help_desk")).sort()) {
    const sql = readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8");
    for (const statement of sql.split(";").filter(value => value.trim())) await db.$executeRawUnsafe(statement);
  }
  // Keep the paid detector out of every scan unless a test opts in.
  await db.helpDeskSettings.create({ data: { shop, aiDetectorMode: "manual" } });
});
afterAll(async () => { await db.$disconnect(); rmSync(temp, { recursive: true, force: true }); });

// A photo-like image: noisy gradient so hashes and forensics have texture to work with.
async function photo(seed = 1, width = 640, height = 480) {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed * 7919;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const index = (y * width + x) * 3;
      pixels[index] = (x * 255) / width;
      pixels[index + 1] = (y * 255) / height;
      pixels[index + 2] = ((x + y + seed * 40) % 255) ^ (state & 15);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// Inserts a PNG tEXt chunk before IEND, the way Stable Diffusion tools record their settings.
function withPngText(png: Buffer, key: string, value: string) {
  const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]);
  const type = Buffer.from("tEXt", "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const iend = png.length - 12;
  return Buffer.concat([png.subarray(0, iend), length, type, data, crc, png.subarray(iend)]);
}

let ticketCount = 0;
async function attach(data: Buffer, name: string, type = "image/jpeg") {
  ticketCount++;
  const ticket = await db.helpDeskTicket.create({
    data: { shop, requestKey: `scan-${ticketCount}-${Date.now()}`, number: 1000 + ticketCount, accessToken: `${ticketCount}`.padStart(48, "0"), name: "Customer", email: "c@example.com", topic: "Order Queries", details: "{}", products: "[]" },
  });
  return db.helpDeskAttachment.create({ data: { ticketId: ticket.id, name, type, data: new Uint8Array(data) } });
}
const scan = async (id: string, options = {}) => serializeScan(await scanImage(db, id, options));

describe("Image scan layers", () => {
  it("flags an embedded Stable Diffusion generation record", async () => {
    const png = withPngText(await (await photo(2)).png().toBuffer(), "parameters", "a cracked phone case\nSteps: 30, Sampler: Euler a, CFG scale: 7, Seed: 1234");
    expect(findGeneratorSignature(png)?.tool).toBe("Automatic1111 / Stable Diffusion WebUI");
    const result = await scan((await attach(png, "damage.png", "image/png")).id);
    expect(result).toMatchObject({ status: "completed", overallVerdict: "likely_ai", overallConfidence: 0.93 });
    expect(result?.layers.watermark?.reason).toMatch(/generation record/);
  });

  it("flags C2PA provenance that declares AI generation", async () => {
    const jpeg = Buffer.concat([await (await photo(3)).jpeg().toBuffer(), Buffer.from("jumbjumdc2pa...c2pa.actions..c2pa.created..digitalSourceType http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia OpenAI Media Service API")]);
    const c2pa = analyzeC2pa(jpeg);
    expect(c2pa).toMatchObject({ present: true, isAiGenerated: true, claimGenerator: "OpenAI Media Service API", capturedByCamera: false });
    expect(c2pa.actions).toContain("c2pa.created");
    expect((await scan((await attach(jpeg, "photo.jpg")).id))?.overallVerdict).toBe("likely_ai");
    // Without the container markers, the same words are not trusted.
    expect(analyzeC2pa(Buffer.from("trainedAlgorithmicMedia")).present).toBe(false);
  });

  it("flags generator file names and catches the same photo reused on another ticket", async () => {
    const jpeg = await (await photo(4)).jpeg().toBuffer();
    expect((await scan((await attach(jpeg, "ChatGPT Image Sep 14, 2026, 12_04_18 PM.jpg")).id))).toMatchObject({ overallVerdict: "likely_ai", overallConfidence: 0.7 });
    // Same bytes, innocent name: the earlier AI finding carries over.
    const copy = await scan((await attach(jpeg, "IMG_2041.jpg")).id);
    expect(copy).toMatchObject({ overallVerdict: "likely_ai", overallConfidence: 0.94 });
    expect(copy?.layers.hash?.match).toMatchObject({ matchType: "exact", sameTicket: false });

    const plain = await (await photo(5)).jpeg({ quality: 90 }).toBuffer();
    await scan((await attach(plain, "a.jpg")).id);
    // Re-compressed copy: different bytes, near-identical picture.
    const resaved = await sharp(plain).jpeg({ quality: 60 }).toBuffer();
    const near = await scan((await attach(resaved, "b.jpg")).id);
    expect(near?.overallVerdict).toBe("duplicate");
    expect(near?.layers.hash?.match?.matchType).toBe("perceptual");
  });

  it("treats software-encoded images without camera data as not camera originals, and leaves them uncertain without a detector", async () => {
    const result = await scan((await attach(await (await photo(6)).jpeg({ quality: 82 }).toBuffer(), "upload.jpg")).id);
    expect(result).toMatchObject({ overallVerdict: "uncertain" });
    expect(result?.layers.editing?.level).toBe("not_original");
    expect(result?.layers.editing?.signals.map(signal => signal.id)).toContain("software_encoder");
    expect(result?.layers.classifier).toMatchObject({ skipped: true, skipReason: "manual" });
  });

  it("clears a coherent camera original without spending a detector check", async () => {
    await db.helpDeskSettings.update({ where: { shop }, data: { aiDetectorMode: "suspicious" } });
    try {
      const jpeg = await (await photo(7, 800, 600)).withExif({ IFD0: { Make: "Apple", Model: "iPhone 15 Pro" }, IFD2: { DateTimeOriginal: "2026:10:01 10:00:00", PixelXDimension: "800", PixelYDimension: "600" } }).jpeg().toBuffer();
      const result = await scan((await attach(jpeg, "IMG_0001.jpg")).id);
      expect(result?.layers.exif?.camera).toMatchObject({ make: "Apple", model: "iPhone 15 Pro" });
      expect(result?.layers.editing?.level).toBe("consistent");
      expect(result?.layers.classifier).toMatchObject({ skipped: true, skipReason: "camera_original" });
      expect(result).toMatchObject({ overallVerdict: "likely_real", overallConfidence: 0.7 });
    } finally {
      await db.helpDeskSettings.update({ where: { shop }, data: { aiDetectorMode: "manual" } });
    }
  });

  it("finds a Gemini-style sparkle in the bottom-right corner, even after re-compression, but not in a plain photo", async () => {
    // A softly lit surface, like a table top under a lamp.
    const base = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><radialGradient id="g" cx="0.3" cy="0.3" r="0.9"><stop offset="0" stop-color="#b59a7c"/><stop offset="1" stop-color="#5e4a39"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/></svg>`)).png().toBuffer();
    const star = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><path transform="translate(${1024 - 40 - 64} ${1024 - 40 - 64})" d="M32 0 C36 24 40 28 64 32 C40 36 36 40 32 64 C28 40 24 36 0 32 C24 28 28 24 32 0 Z" fill="white" fill-opacity="0.7"/></svg>`);
    const marked = await sharp(base).composite([{ input: star }]).png().toBuffer();
    expect((await detectGeminiSparkle(marked))?.detected).toBe(true);
    // A forward through a messaging app: smaller and lossy.
    const forwarded = await sharp(marked).resize(640).jpeg({ quality: 60 }).toBuffer();
    expect((await detectGeminiSparkle(forwarded))?.detected).toBe(true);
    expect((await detectGeminiSparkle(base))?.detected).toBe(false);
  });
});

describe("Image scan verdict rules", () => {
  it("bands detector scores and won't clear a generator-sized image on a low score", () => {
    const checked = { c2pa: { present: false, checked: true as const } };
    expect(combineLayers({ ...checked, classifier: { aiProbability: 85 } })).toEqual({ overallVerdict: "likely_ai", overallConfidence: 0.85 });
    expect(combineLayers({ ...checked, classifier: { aiProbability: 55 } }).overallVerdict).toBe("uncertain");
    expect(combineLayers({ ...checked, classifier: { aiProbability: 10 } })).toEqual({ overallVerdict: "likely_real", overallConfidence: 0.9 });
    expect(combineLayers({ ...checked, exif: { generatorSizeMatch: matchGeneratorSize(1536, 1024) }, classifier: { aiProbability: 10 } }).overallVerdict).toBe("uncertain");
    expect(combineLayers({ ...checked, classifier: { error: "down" } })).toEqual({ overallVerdict: "uncertain", overallConfidence: 0.3 });
    expect(combineLayers({}).overallVerdict).toBe("error");
  });
  it("decides when the paid detector runs", () => {
    const original = { level: "consistent" as const, cameraCoherence: { coherent: true, reason: null, attested: false } };
    expect(detectorDecision({ mode: "suspicious", editing: original })).toMatchObject({ run: false, skipReason: "camera_original" });
    expect(detectorDecision({ mode: "suspicious", editing: { ...original, level: "not_original" } }).run).toBe(true);
    expect(detectorDecision({ mode: "manual" }).run).toBe(false);
    expect(detectorDecision({ mode: "manual", force: true }).run).toBe(true);
    expect(detectorDecision({ mode: "always", editing: original }).run).toBe(true);
    // Default: layer 5 runs for every photo layers 1-4 couldn't settle.
    expect(detectorDecision({ editing: original }).run).toBe(true);
    expect(reusableDetectorResult(JSON.stringify({ aiProbability: 20, provider: "sightengine" }), "truthscan")).toBeNull();
    expect(reusableDetectorResult({ aiProbability: 20, provider: "truthscan" }, "truthscan")?.aiProbability).toBe(20);
  });
  it("judges camera data by consistency, not by brand names", () => {
    const exif = { hasCameraMetadata: true, dateTimeOriginal: new Date() };
    expect(assessCameraCoherence({ exif, dimensionsDisagree: false }).coherent).toBe(true);
    expect(assessCameraCoherence({ exif: { hasCameraMetadata: true }, dimensionsDisagree: false }).reason).toBe("no_capture_time");
    expect(assessCameraCoherence({ exif: { ...exif, editedWith: "Adobe Photoshop" }, dimensionsDisagree: false }).reason).toBe("editor_named");
    expect(assessCameraCoherence({ exif, dimensionsDisagree: true }).reason).toBe("dimensions_disagree");
  });
  it("recognises libjpeg encoder tables and dHash distances", async () => {
    const jpeg = readJpegStructure(await (await photo(9)).jpeg({ quality: 75 }).toBuffer());
    expect(matchIjgQuality(jpeg!.quantTables)).toBe(75);
    expect(matchIjgQuality([{ id: 0, values: scaleIjgTable(Array(64).fill(3), 50) }])).toBeNull();
    expect(hammingDistanceHex("ffff", "fffe")).toBe(1);
    expect(hammingDistanceHex("ff", "ffff")).toBe(Infinity);
  });
  it("shares one run per image and caps the queue", async () => {
    const queue = new ScanQueue(1, 6000, 1, async () => undefined);
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = queue.run("a", "shop", async () => { runs++; await gate; return 1; });
    const same = queue.run("a", "shop", async () => { runs++; return 2; });
    const waiting = queue.run("b", "shop", async () => 3);
    await expect(queue.run("c", "shop", async () => 4)).rejects.toThrow(/full/);
    release();
    expect(await Promise.all([first, same, waiting])).toEqual([1, 1, 3]);
    expect(runs).toBe(1);
  });
});

describe("AI detector", () => {
  const image = Buffer.alloc(2048, 1);
  it("asks for credentials instead of failing when none are saved", async () => {
    expect(await classifyImage(image, "image/jpeg", "a.jpg", { apiUser: "", apiSecret: "" }, "sightengine")).toMatchObject({ skipped: true, missingApiKey: true });
  });
  it("reads Sightengine scores and explains rejected credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ status: "success", type: { ai_generated: 0.91, ai_generators: { midjourney: 0.8, dalle: 0.05 } }, request: { id: "r1" } }))
      .mockResolvedValueOnce(Response.json({ status: "failure", error: { type: "credentials_error", message: "Incorrect API user or API secret" } }, { status: 401 }));
    try {
      const ok = await classifyImage(image, "image/jpeg", "a.jpg", { apiUser: "u", apiSecret: "s" }, "sightengine");
      expect(ok).toMatchObject({ aiProbability: 91, realProbability: 9, generators: [{ name: "Midjourney", score: 80 }] });
      expect(ok.reasoning).toMatch(/most likely made with Midjourney/);
      const rejected = await classifyImage(image, "image/jpeg", "a.jpg", { apiUser: "u", apiSecret: "bad" }, "sightengine");
      expect(rejected).toMatchObject({ errorKind: "auth" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("reads TruthScan verdicts, including edited photos, and checks keys for free", async () => {
    expect(shapeTruthscan({ result: 12, result_details: { final_result: "Digitally Edited", final_label_confidence: 88 } })).toMatchObject({ aiProbability: 12, editProbability: 88 });
    expect(shapeTruthscan({ result: 90, result_details: { final_result: "Real" } }).aiProbability).toBe(10);
    expect(describeError({ message: "Not enough credits", type: "usage_limit" }, "TruthScan").errorKind).toBe("billing");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ credits: 0 }));
    try {
      expect(await verifyCredentials("truthscan", { apiKey: "k" })).toMatchObject({ valid: true, warning: expect.stringMatching(/used up/) });
      expect(await verifyCredentials("truthscan", { apiKey: "" })).toMatchObject({ valid: false });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
