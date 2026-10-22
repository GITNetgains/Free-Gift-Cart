import type { PrismaClient } from "@prisma/client";
import { classifyImage, type Credentials, type DetectorResult } from "./detector.server";
import { analyzeEditing, withClassifierEvidence, type EditResult } from "./forensics.server";
import { analyzeExif, analyzeWatermark, type ExifResult, type WatermarkResult } from "./metadata.server";
import { computeHashes, hammingDistanceHex } from "./pixels.server";
import { analyzeC2pa, type C2paResult } from "./signatures.server";

// AI / authenticity check for customer photos, ported from Armorship's layered scan:
//   1. C2PA Content Credentials    4. Hash / duplicate within this store
//   2. Watermarks and signatures   5. Dedicated AI detector (store's own key)
//   3. EXIF and metadata           +  Edit forensics, reported alongside
// Layers 1-4 are free and decide whenever they can; the paid detector is
// asked only when they can't, and per the store's detector mode.

export type Verdict = "likely_ai" | "duplicate" | "uncertain" | "likely_real" | "error";
export const DETECTOR_MODES = ["always", "suspicious", "manual"] as const;
// A near-duplicate (re-saved, re-compressed, cropped) differs from the
// original in only a few of the 64 dHash bits.
const PERCEPTUAL_DISTANCE_THRESHOLD = 6;
const STALE_PENDING_MS = Math.max(60_000, Number(process.env.AI_SCAN_STALE_MS) || 10 * 60_000);

export type Duplicate = {
  duplicateOfAttachmentId: string; matchType: "exact" | "perceptual"; distance: number; ticketId: string; ticketNumber: number;
  fileName: string; uploadedAt: Date; sameTicket: boolean; previousVerdict: string | null;
};

// Matches against every image already scanned for the SAME store, never
// across stores, so one merchant's evidence never shows in another's admin.
async function findMatches(db: PrismaClient, lookup: { shop: string; attachmentId: string; ticketId: string; contentHash: string | null; perceptualHash: string | null }) {
  if (!lookup.contentHash && !lookup.perceptualHash) return [];
  const rows = await db.helpDeskImageScan.findMany({
    where: { shop: lookup.shop, attachmentId: { not: lookup.attachmentId }, OR: [{ contentHash: { not: null } }, { perceptualHash: { not: null } }] },
    select: { attachmentId: true, contentHash: true, perceptualHash: true, overallVerdict: true, createdAt: true, attachment: { select: { name: true, ticket: { select: { id: true, number: true } } } } },
  });
  const matches: Duplicate[] = [];
  for (const row of rows) {
    const describe = (matchType: Duplicate["matchType"], distance: number): Duplicate => ({
      duplicateOfAttachmentId: row.attachmentId, matchType, distance, ticketId: row.attachment.ticket.id, ticketNumber: row.attachment.ticket.number,
      fileName: row.attachment.name, uploadedAt: row.createdAt,
      // The same photo on one ticket is ordinary; the same evidence reused across tickets is what matters.
      sameTicket: row.attachment.ticket.id === lookup.ticketId, previousVerdict: row.overallVerdict,
    });
    if (lookup.contentHash && row.contentHash === lookup.contentHash) { matches.push(describe("exact", 0)); continue; }
    const distance = hammingDistanceHex(lookup.perceptualHash, row.perceptualHash);
    if (distance <= PERCEPTUAL_DISTANCE_THRESHOLD) matches.push(describe("perceptual", distance));
  }
  return matches;
}

// An AI finding outranks closeness: a re-export that exact-matches its own
// cleared twin but near-matches the flagged original must report the original.
export function pickDuplicate(matches: Duplicate[]) {
  const byCloseness = [...matches].sort((a, b) => (a.matchType === "exact" ? -1 : 0) - (b.matchType === "exact" ? -1 : 0) || a.distance - b.distance);
  return byCloseness.find((match) => match.previousVerdict === "likely_ai") || byCloseness[0] || null;
}

type Layers = { c2pa?: C2paResult | null; watermark?: WatermarkResult | null; exif?: Partial<ExifResult> | null; duplicate?: Duplicate | null; classifier?: DetectorResult | null };

// Layers 1-4, strongest evidence first. Null means they can't settle it.
export function deterministicVerdict({ c2pa, watermark, exif, duplicate }: Layers): { overallVerdict: Verdict; overallConfidence: number } | null {
  if (c2pa?.isAiGenerated) return { overallVerdict: "likely_ai", overallConfidence: 0.9 };
  // A copy of a photo already identified as AI carries the finding over.
  if (duplicate?.previousVerdict === "likely_ai") return { overallVerdict: "likely_ai", overallConfidence: duplicate.matchType === "exact" ? 0.94 : 0.88 };
  if (watermark?.generatorSignature) return { overallVerdict: "likely_ai", overallConfidence: 0.93 };
  if (watermark?.visibleMark) return { overallVerdict: "likely_ai", overallConfidence: 0.9 };
  if (exif?.xmpDigitalSourceType) return { overallVerdict: "likely_ai", overallConfidence: 0.9 };
  if (watermark?.declared) return { overallVerdict: "likely_ai", overallConfidence: 0.9 };
  if (exif?.suspiciousSoftwareMatch) return { overallVerdict: "likely_ai", overallConfidence: 0.75 };
  if (exif?.suspiciousFileNameMatch) return { overallVerdict: "likely_ai", overallConfidence: 0.7 };
  if (duplicate) return { overallVerdict: "duplicate", overallConfidence: duplicate.matchType === "exact" ? 0.99 : 0.85 };
  return null;
}

export function combineLayers(layers: Layers): { overallVerdict: Verdict; overallConfidence: number } {
  const deterministic = deterministicVerdict(layers);
  if (deterministic) return deterministic;
  const { classifier, exif, c2pa } = layers;
  // Skipped because it's a clear camera original (the store's chosen trade-off).
  if (classifier?.skipReason === "camera_original") return { overallVerdict: "likely_real", overallConfidence: 0.7 };
  if (classifier && !classifier.error && typeof classifier.aiProbability === "number") {
    // Wide bands so a re-scan moving a few points doesn't flip the verdict.
    const { aiProbability } = classifier;
    if (aiProbability >= 70) return { overallVerdict: "likely_ai", overallConfidence: aiProbability / 100 };
    if (aiProbability < 40) {
      // Detectors are often fooled by current generators; a generator-sized
      // image doesn't get cleared on a low score alone.
      if (exif?.generatorSizeMatch) return { overallVerdict: "uncertain", overallConfidence: 0.5 };
      return { overallVerdict: "likely_real", overallConfidence: (100 - aiProbability) / 100 };
    }
    return { overallVerdict: "uncertain", overallConfidence: 0.5 };
  }
  // No detector score: the local layers found nothing, which is real
  // information, but they can't catch an AI image with stripped metadata.
  if (c2pa?.checked || exif?.checked) return { overallVerdict: "uncertain", overallConfidence: 0.3 };
  return { overallVerdict: "error", overallConfidence: 0 };
}

// When the paid detector runs: 'always' (default) for every photo layers 1-4
// can't settle; 'suspicious' also skips clear camera originals
// (coherent, self-consistent camera data, nothing generator-like);
// 'manual' only on request.
export function detectorDecision({ mode = "always", editing, exif, force = false }: { mode?: string; editing?: Pick<EditResult, "level" | "cameraCoherence"> | null; exif?: Partial<ExifResult> | null; force?: boolean }) {
  if (force) return { run: true } as const;
  if (mode === "manual") return { run: false, skipReason: "manual", reason: "The AI detector runs only when you ask: use \"Check with AI detector\"." } as const;
  if (mode === "always") return { run: true } as const;
  const cameraOriginal = editing?.level === "consistent" && editing.cameraCoherence?.coherent === true && !exif?.generatorSizeMatch;
  if (cameraOriginal) return { run: false, skipReason: "camera_original", reason: "Genuine camera photo: the camera data is intact, so the AI detector wasn't needed." } as const;
  return { run: true } as const;
}

// A detector result that can stand in for a new paid check: a real score
// from the detector the store uses now.
export function reusableDetectorResult(value: string | DetectorResult | null | undefined, provider: string) {
  let result = value;
  if (typeof result === "string") { try { result = JSON.parse(result) as DetectorResult; } catch { return null; } }
  if (!result || typeof result.aiProbability !== "number" || result.provider !== provider) return null;
  return result;
}

const credentialsFor = (settings: { aiDetectionProvider: string; sightengineUser: string; sightengineSecret: string; truthscanKey: string } | null): Credentials | null => {
  if (!settings) return null;
  return settings.aiDetectionProvider === "truthscan" ? { apiKey: settings.truthscanKey } : { apiUser: settings.sightengineUser, apiSecret: settings.sightengineSecret };
};

async function runScan(db: PrismaClient, attachmentId: string, options: { forceDetector?: boolean; manual?: boolean } = {}) {
  const attachment = await db.helpDeskAttachment.findUnique({ where: { id: attachmentId }, include: { ticket: { select: { id: true, shop: true } }, scan: true } });
  if (!attachment || !attachment.type.startsWith("image/")) return null;
  const shop = attachment.ticket.shop;
  const settings = await db.helpDeskSettings.findUnique({ where: { shop } });
  // Turned off: leave any earlier scan as it is and start no new one (a manual re-scan still runs).
  if (settings?.aiDetectionEnabled === false && !options.manual) return null;
  const previousDetector = attachment.scan?.classifierResult || null;
  const previousContentHash = attachment.scan?.contentHash || null;
  const scan = await db.helpDeskImageScan.upsert({
    where: { attachmentId }, update: { status: "pending", error: null }, create: { attachmentId, shop, status: "pending" },
  });
  try {
    const input = Buffer.from(attachment.data);
    const provider = settings?.aiDetectionProvider || "sightengine";
    const c2pa = (() => { try { return analyzeC2pa(input); } catch (error) { return { present: false, checked: true, error: (error as Error).message } as C2paResult; } })();
    const [exif, hashes] = await Promise.all([
      analyzeExif(input, attachment.name).catch((error) => ({ checked: true, error: (error as Error).message }) as unknown as ExifResult),
      computeHashes(input),
    ]);
    const watermark = await analyzeWatermark(input, c2pa);
    // Needs the camera metadata; reported alongside the verdict, never folded
    // into it (an edited real photo isn't an AI image).
    const structural = await analyzeEditing(input, exif).catch((error) => ({ checked: false, level: "unknown", editor: null, signals: [], error: (error as Error).message }) as unknown as EditResult);
    const lookup = { shop, attachmentId, ticketId: attachment.ticket.id, contentHash: hashes.contentHash, perceptualHash: hashes.perceptualHash };
    let duplicate = pickDuplicate(await findMatches(db, lookup));
    let deterministic = deterministicVerdict({ c2pa, watermark, exif, duplicate });

    // Never pay twice for the same picture.
    let reused: DetectorResult | null = null;
    if (!options.forceDetector) {
      if (previousContentHash && previousContentHash === hashes.contentHash) {
        const result = reusableDetectorResult(previousDetector, provider);
        if (result) reused = { ...result, reused: true, reusedFrom: "previous_scan" };
      }
      if (!reused && duplicate && (duplicate.matchType === "exact" || duplicate.distance <= 2)) {
        const earlier = await db.helpDeskImageScan.findUnique({ where: { attachmentId: duplicate.duplicateOfAttachmentId }, select: { classifierResult: true } });
        const result = reusableDetectorResult(earlier?.classifierResult, provider);
        if (result) reused = { ...result, reused: true, reusedFrom: duplicate.duplicateOfAttachmentId };
      }
    }
    const runDetector = () => classifyImage(input, attachment.type, attachment.name, credentialsFor(settings), provider);
    let classifier: DetectorResult;
    if (deterministic) {
      // A second opinion can be asked for, but never overrules hard evidence.
      classifier = options.forceDetector ? await runDetector()
        : reused || { skipped: true, reason: "Not needed: the provenance, metadata and hash checks already settled it.", canRunDetector: true };
    } else if (reused) {
      classifier = reused;
    } else {
      const decision = detectorDecision({ mode: settings?.aiDetectorMode || "always", editing: structural, exif, force: options.forceDetector });
      classifier = decision.run ? await runDetector() : { skipped: true, skipReason: decision.skipReason, reason: decision.reason, canRunDetector: true };
    }
    const editing = withClassifierEvidence(structural, classifier);
    if (classifier.error && !classifier.missingApiKey) console.warn(`Help Desk AI detector (${classifier.providerLabel}) failed for ${attachmentId} on ${shop}: ${classifier.errorTitle || classifier.error}`);
    // Photos from one message scan concurrently; look again after the slow detector call.
    if (!deterministic) {
      duplicate = pickDuplicate(await findMatches(db, lookup));
      deterministic = deterministicVerdict({ c2pa, watermark, exif, duplicate });
    }
    const { overallVerdict, overallConfidence } = deterministic || combineLayers({ c2pa, watermark, exif, duplicate, classifier });
    const saved = await db.helpDeskImageScan.update({
      where: { id: scan.id },
      data: {
        status: "completed", overallVerdict, overallConfidence, error: null,
        contentHash: hashes.contentHash, perceptualHash: hashes.perceptualHash, duplicateOfAttachmentId: duplicate?.duplicateOfAttachmentId || null,
        c2paResult: JSON.stringify(c2pa), watermarkResult: JSON.stringify(watermark), exifResult: JSON.stringify(exif), editResult: JSON.stringify(editing),
        classifierResult: JSON.stringify(classifier),
        hashResult: JSON.stringify({ checked: true, contentHash: hashes.contentHash, perceptualHash: hashes.perceptualHash, algorithms: { content: "sha256", perceptual: "dHash-64" }, match: duplicate }),
      },
    });
    // Copies already cleared (they'd lost the provenance) pick the finding up.
    if (overallVerdict === "likely_ai") {
      const stale = (await findMatches(db, lookup)).filter((match) => match.previousVerdict && match.previousVerdict !== "likely_ai");
      for (const match of stale) void scanImage(db, match.duplicateOfAttachmentId);
    }
    return saved;
  } catch (error) {
    console.error(`Help Desk image scan of ${attachmentId} on ${shop} failed:`, error);
    return db.helpDeskImageScan.update({ where: { id: scan.id }, data: { status: "failed", error: (error as Error).message.slice(0, 500) } });
  }
}

// ---------- Queue ----------
// Scans are expensive and arrive in bursts (a message with several photos),
// so: bounded concurrency, a per-store pace so one shop can't burn its
// detector quota in seconds, a queue cap, and one run per attachment however
// many callers ask (an upload still scanning plus an impatient re-scan).
export class ScanQueue {
  running = 0;
  waiting: { resolve: () => void }[] = [];
  inFlight = new Map<string, Promise<unknown>>();
  storeNextRunAt = new Map<string, number>();
  constructor(public concurrency = 2, public perStorePerMinute = 20, public maxQueued = 200, private sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  private acquire() {
    if (this.running < this.concurrency) { this.running++; return Promise.resolve(); }
    if (this.waiting.length >= this.maxQueued) return Promise.reject(new Error("The image scan queue is full. Try again shortly."));
    return new Promise<void>((resolve) => this.waiting.push({ resolve }));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next.resolve(); else this.running = Math.max(0, this.running - 1);
  }

  private async waitForStore(store: string) {
    const interval = Math.ceil(60_000 / this.perStorePerMinute);
    const now = Date.now();
    const earliest = Math.max(now, this.storeNextRunAt.get(store) || 0);
    this.storeNextRunAt.set(store, earliest + interval);
    if (earliest > now) await this.sleep(earliest - now);
  }

  run<T>(key: string, store: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = (async () => {
      await this.acquire();
      try { await this.waitForStore(store); return await task(); } finally { this.release(); }
    })();
    this.inFlight.set(key, promise);
    promise.catch(() => undefined).finally(() => { if (this.inFlight.get(key) === promise) this.inFlight.delete(key); });
    return promise;
  }
}

const queue = new ScanQueue(Math.max(1, Number(process.env.AI_SCAN_CONCURRENCY) || 2), Math.max(1, Number(process.env.AI_SCAN_PER_STORE_PER_MINUTE) || 20));

export async function scanImage(db: PrismaClient, attachmentId: string, options: { forceDetector?: boolean; manual?: boolean } = {}) {
  const attachment = await db.helpDeskAttachment.findUnique({ where: { id: attachmentId }, select: { ticket: { select: { shop: true } } } });
  if (!attachment) return null;
  return queue.run(attachmentId, attachment.ticket.shop, () => runScan(db, attachmentId, options));
}

// Fire-and-forget for new uploads: scanning must never delay or fail the customer's submission.
export function queueImageScans(db: PrismaClient, attachmentIds: string[]) {
  ensureScanMaintenance(db);
  for (const id of attachmentIds) {
    scanImage(db, id).catch((error) => console.error(`Help Desk image scan for ${id} failed:`, error));
  }
}

// Scans a new ticket's photos, or the photos sent with one message.
export async function queueTicketScans(db: PrismaClient, ticketId: string, messageId: string | null = null) {
  try {
    const files = await db.helpDeskAttachment.findMany({ where: { ticketId, messageId }, select: { id: true } });
    queueImageScans(db, files.map((file) => file.id));
  } catch (error) {
    console.error(`Help Desk could not queue image scans for ticket ${ticketId}:`, error);
  }
}

// A restart mid-scan leaves a row pending forever; close old ones as failed
// so the admin shows "Scan incomplete" with a re-scan button.
export async function recoverStaleScans(db: PrismaClient) {
  const { count } = await db.helpDeskImageScan.updateMany({
    where: { status: "pending", updatedAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } },
    data: { status: "failed", error: "The scan didn't finish. Re-scan to try again." },
  });
  return count;
}

const maintenance = globalThis as typeof globalThis & { helpDeskScanMaintenance?: ReturnType<typeof setInterval> };

export function ensureScanMaintenance(db: PrismaClient) {
  if (maintenance.helpDeskScanMaintenance || process.env.VITEST) return;
  const sweep = () => recoverStaleScans(db).catch((error) => console.error("Help Desk stale scan sweep failed:", error));
  void sweep();
  maintenance.helpDeskScanMaintenance = setInterval(sweep, 5 * 60_000);
  maintenance.helpDeskScanMaintenance.unref?.();
}

// Re-runs scans that skipped the detector for lack of credentials, after a
// store saves them. Capped: each one may spend a check on their plan.
export async function rescanMissingKeyScans(db: PrismaClient, shop: string, limit = 25) {
  const rows = await db.helpDeskImageScan.findMany({ where: { shop, classifierResult: { contains: "\"missingApiKey\":true" } }, orderBy: { updatedAt: "desc" }, take: limit, select: { attachmentId: true } });
  for (const row of rows) void scanImage(db, row.attachmentId).catch(() => undefined);
  return rows.length;
}

// Parses a scan row's JSON columns for the admin.
export function serializeScan(scan: {
  status: string; overallVerdict: string | null; overallConfidence: number | null; duplicateOfAttachmentId: string | null; error: string | null;
  c2paResult: string | null; watermarkResult: string | null; exifResult: string | null; hashResult: string | null; classifierResult: string | null; editResult: string | null;
} | null) {
  if (!scan) return null;
  const parse = (value: string | null) => { if (!value) return null; try { return JSON.parse(value); } catch { return null; } };
  return {
    status: scan.status, overallVerdict: scan.overallVerdict, overallConfidence: scan.overallConfidence, duplicateOfAttachmentId: scan.duplicateOfAttachmentId, error: scan.error,
    layers: {
      c2pa: parse(scan.c2paResult) as C2paResult | null, watermark: parse(scan.watermarkResult) as WatermarkResult | null, exif: parse(scan.exifResult) as ExifResult | null,
      hash: parse(scan.hashResult) as { match: Duplicate | null } | null, classifier: parse(scan.classifierResult) as DetectorResult | null, editing: parse(scan.editResult) as EditResult | null,
    },
  };
}
