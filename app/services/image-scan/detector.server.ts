import sharp from "sharp";

// Layer 5: a dedicated AI-image detector, the last resort, reached only when
// the local layers couldn't settle a photo. General chatbots are poor at this,
// so it uses services trained for it, on the STORE'S OWN account:
//   Sightengine: synchronous, free plan of 2,000 checks/month.
//   TruthScan:   the engine behind ZeroGPT's image detector; asynchronous.
// Without credentials the layer is skipped with a `missingApiKey` note.

const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.AI_DETECTOR_TIMEOUT_MS) || 30000);
const TRUTHSCAN_MAX_WAIT_MS = Math.max(10000, Number(process.env.TRUTHSCAN_MAX_WAIT_MS) || 90000);
const TRUTHSCAN_POLL_INTERVAL_MS = Math.max(250, Number(process.env.TRUTHSCAN_POLL_INTERVAL_MS) || 1500);
const TRUTHSCAN_CREDITS_PER_IMAGE = 1000;
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GENERATOR_LABELS: Record<string, string> = {
  dalle: "DALL·E", firefly: "Adobe Firefly", flux: "Flux", gan: "GAN", gpt: "ChatGPT (gpt-image)", ideogram: "Ideogram", imagen: "Google Imagen",
  midjourney: "Midjourney", recraft: "Recraft", reve: "Reve", seedream: "Seedream", stable_diffusion: "Stable Diffusion", wan: "Wan",
  gemini: "Google Gemini", qwen: "Qwen", hidream: "HiDream", kolors: "Kolors", grok: "Grok",
};

export type Provider = "sightengine" | "truthscan";
export type Credentials = { apiUser?: string; apiSecret?: string; apiKey?: string };
type Request = { credentials: Credentials; image: Buffer; mimeType: string; fileName: string };
type Raw = { aiProbability: number; generators?: { name: string; score: number }[]; verdictLabel?: string | null; editProbability?: number | null; editReasoning?: string | null; requestId?: string | null };

class DetectorError extends Error {
  status: number | null;
  type: string | null;
  constructor(message: string, { status = null, type = null }: { status?: number | null; type?: string | null } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

async function fetchWithTimeout(url: string, options: RequestInit, label: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new DetectorError((error as Error).name === "AbortError" ? `${label} did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s` : `Could not reach ${label}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ----- Sightengine: POST /1.0/check.json, models=genai -----
const sightengineUrl = () => `${process.env.SIGHTENGINE_BASE_URL || "https://api.sightengine.com"}/1.0/check.json`;

async function callSightengine({ credentials, image, mimeType, fileName }: Request): Promise<Raw> {
  const form = new FormData();
  form.append("models", "genai");
  form.append("api_user", credentials.apiUser!);
  form.append("api_secret", credentials.apiSecret!);
  form.append("media", new Blob([new Uint8Array(image)], { type: mimeType || "image/jpeg" }), fileName || "photo.jpg");
  const response = await fetchWithTimeout(sightengineUrl(), { method: "POST", body: form }, "Sightengine");
  const body = await response.json().catch(() => null) as { status?: string; error?: { message?: string; type?: string }; type?: { ai_generated?: number; ai_generators?: Record<string, number> }; request?: { id?: string } } | null;
  if (!response.ok || body?.status !== "success") {
    throw new DetectorError(body?.error?.message || `Sightengine returned HTTP ${response.status}`, { status: response.status, type: body?.error?.type || null });
  }
  const score = Number(body.type?.ai_generated);
  if (!Number.isFinite(score)) throw new DetectorError("Sightengine returned no AI score");
  const generators = Object.entries(body.type?.ai_generators || {})
    .filter(([, value]) => Number(value) >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name, value]) => ({ name: GENERATOR_LABELS[name] || name, score: Math.round(Number(value) * 100) }));
  return { aiProbability: Math.round(score * 100), generators, requestId: body.request?.id || null };
}

// ----- TruthScan: presign, upload, detect, poll -----
const truthscanBase = () => process.env.TRUTHSCAN_BASE_URL || "https://detect-image.truthscan.com";
const truthscanStorageBase = () => (process.env.TRUTHSCAN_STORAGE_BASE_URL || "https://ai-image-detector-prod.nyc3.digitaloceanspaces.com").replace(/\/+$/, "");
const TRUTHSCAN_MIME_BY_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png", webp: "image/webp" };

// /detect fetches the image from TruthScan's bucket. When the presigned URL
// points straight at it, it's authoritative; otherwise use the storage host.
function truthscanImageUrl(presign: { presigned_url: string; file_path?: string }) {
  const filePath = String(presign.file_path || "").replace(/^\/+/, "");
  if (!filePath) throw new DetectorError("TruthScan returned no file path");
  try {
    const signed = new URL(presign.presigned_url);
    if (signed.pathname.replace(/^\/+/, "").endsWith(filePath)) return `${signed.origin}${signed.pathname}`;
  } catch { /* fall through */ }
  return `${truthscanStorageBase()}/${filePath}`;
}

async function truthscanJson(response: Response, label: string) {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.ok) return body;
  const message = body?.error || body?.detail || body?.message || `${label} returned HTTP ${response.status}`;
  const text = typeof message === "string" ? message : JSON.stringify(message);
  // A spent balance and a bad key are both 403, told apart by the message; an unknown key is 404 "User not found".
  const type = response.status === 403 ? (/credit/i.test(text) ? "usage_limit" : "credentials_error")
    : response.status === 401 || (response.status === 404 && /user not found|api key/i.test(text)) ? "credentials_error"
    : response.status === 400 || response.status === 422 ? "media_error" : null;
  throw new DetectorError(text, { status: response.status, type });
}

async function callTruthscan({ credentials, image, mimeType, fileName }: Request): Promise<Raw> {
  const apiKey = credentials.apiKey!;
  const base = truthscanBase();
  const safeName = (fileName || "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_");
  // The upload is signed for the type TruthScan infers from the extension.
  const uploadType = TRUTHSCAN_MIME_BY_EXT[(safeName.split(".").pop() || "").toLowerCase()] || mimeType || "image/jpeg";
  if (image.length < 1024 || image.length > 10 * 1024 * 1024) {
    throw new DetectorError(`TruthScan only accepts images between 1KB and 10MB; this one is ${(image.length / (1024 * 1024)).toFixed(1)}MB`, { type: "media_error" });
  }
  const presign = await truthscanJson(await fetchWithTimeout(`${base}/get-presigned-url?file_name=${encodeURIComponent(safeName)}`, { headers: { apikey: apiKey } }, "TruthScan"), "TruthScan") as { presigned_url?: string; file_path?: string } | null;
  if (!presign?.presigned_url) throw new DetectorError("TruthScan returned no upload URL");
  const upload = await fetchWithTimeout(presign.presigned_url, { method: "PUT", headers: { "Content-Type": uploadType, "x-amz-acl": "private" }, body: new Uint8Array(image) }, "TruthScan storage");
  if (!upload.ok) {
    const detail = await upload.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(detail)?.[1] || detail.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new DetectorError(`Uploading to TruthScan failed (HTTP ${upload.status}${code ? `: ${code}` : ""})`, { status: upload.status, type: [400, 413, 415].includes(upload.status) ? "media_error" : null });
  }
  const submitted = await truthscanJson(await fetchWithTimeout(`${base}/detect`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: apiKey, url: truthscanImageUrl(presign as { presigned_url: string; file_path?: string }), generate_preview: false, generate_heatmap: false, generate_analysis_details: false }),
  }, "TruthScan"), "TruthScan") as { id?: string } | null;
  if (!submitted?.id) throw new DetectorError("TruthScan returned no job id");
  const deadline = Date.now() + TRUTHSCAN_MAX_WAIT_MS;
  for (;;) {
    const job = await truthscanJson(await fetchWithTimeout(`${base}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: submitted.id }) }, "TruthScan"), "TruthScan") as { status?: string; result?: number; id?: string; result_details?: Record<string, unknown> } | null;
    if (job?.status === "done") return shapeTruthscan(job);
    if (job?.status === "failed") throw new DetectorError(String(job?.result_details?.error || "TruthScan could not analyse this image"), { type: "media_error" });
    if (Date.now() + TRUTHSCAN_POLL_INTERVAL_MS > deadline) throw new DetectorError(`TruthScan did not finish within ${Math.round(TRUTHSCAN_MAX_WAIT_MS / 1000)}s`);
    await sleep(TRUTHSCAN_POLL_INTERVAL_MS);
  }
}

// `result` is the AI probability; final_result is "AI Generated" | "Real" | "Digitally Edited" | "AI Edited".
export function shapeTruthscan(job: { result?: number; id?: string; result_details?: Record<string, unknown> }): Raw {
  const details = job.result_details || {};
  const label = (details.final_result as string) || null;
  let aiProbability = Number(job.result);
  if (!Number.isFinite(aiProbability)) aiProbability = Number(details.confidence);
  if (!Number.isFinite(aiProbability)) throw new DetectorError("TruthScan returned no AI score");
  aiProbability = Math.max(0, Math.min(100, Math.round(aiProbability)));
  // A high `result` on a "Real" verdict is confidence in "Real", not an AI score.
  if (label === "Real" && aiProbability > 50) aiProbability = 100 - aiProbability;
  const labelConfidence = Number(details.final_label_confidence);
  const edited = label === "Digitally Edited" || label === "AI Edited";
  return {
    aiProbability, verdictLabel: label,
    editProbability: edited && Number.isFinite(labelConfidence) ? Math.round(labelConfidence) : null,
    editReasoning: edited ? `TruthScan labels this photo "${label}".` : null,
    generators: [], requestId: job.id || null,
  };
}

async function verifyTruthscan(credentials: Credentials) {
  const body = await truthscanJson(await fetchWithTimeout(`${truthscanBase()}/check-user-credits`, { headers: { apikey: credentials.apiKey! } }, "TruthScan"), "TruthScan") as { credits?: number } | null;
  const credits = Number(body?.credits);
  return { remainingChecks: Number.isFinite(credits) ? Math.floor(credits / TRUTHSCAN_CREDITS_PER_IMAGE) : null };
}

export const PROVIDERS: Record<Provider, {
  label: string; needsApiUser: boolean; freePlanNote: string; call: (request: Request) => Promise<Raw>;
  verify?: (credentials: Credentials) => Promise<{ remainingChecks: number | null }>; normalize: (value: Credentials | null) => Credentials | null;
}> = {
  sightengine: {
    label: "Sightengine", needsApiUser: true, freePlanNote: "the free plan allows 2,000 a month, max 500 a day", call: callSightengine,
    normalize: (value) => (value?.apiUser?.trim() && value?.apiSecret?.trim() ? { apiUser: value.apiUser.trim(), apiSecret: value.apiSecret.trim() } : null),
  },
  truthscan: {
    label: "TruthScan", needsApiUser: false, freePlanNote: "the free plan includes 25 a month", call: callTruthscan, verify: verifyTruthscan,
    normalize: (value) => (value?.apiKey?.trim() ? { apiKey: value.apiKey.trim() } : null),
  },
};
export const DEFAULT_PROVIDER: Provider = "sightengine";
const resolve = (provider: string) => (provider in PROVIDERS ? provider as Provider : DEFAULT_PROVIDER);

// Why the detector refused, in terms a merchant can act on.
export function describeError(error: { message?: string; status?: number | null; type?: string | null }, label: string, freePlanNote = "") {
  const message = error?.message || String(error);
  const { status, type } = error || {};
  if (type === "credentials_error" || /incorrect api user|api secret|invalid api key|credentials/i.test(message) || status === 401) {
    return { errorKind: "auth", errorTitle: `${label} rejected your API credentials`, errorHint: `Check them in Help Desk settings → AI photo check. Copy them again from your ${label} dashboard.` };
  }
  if (type === "usage_limit" || /usage limit|not enough credits|limit .*exceeded|quota/i.test(message)) {
    return { errorKind: "billing", errorTitle: `${label} checks used up`, errorHint: `Your ${label} plan has no checks left${freePlanNote ? ` (${freePlanNote})` : ""}. Wait for it to reset or upgrade, then re-scan.` };
  }
  if (type === "plan_error") return { errorKind: "plan", errorTitle: `AI image detection isn't on your ${label} plan`, errorHint: `Turn on AI-generated image detection in your ${label} dashboard, then re-scan.` };
  if (status === 429) return { errorKind: "rate_limit", errorTitle: `${label} is rate-limiting your account`, errorHint: "Too many checks at once. Re-scan this photo in a minute." };
  if (type === "media_error") return { errorKind: "media", errorTitle: `${label} couldn't read this image`, errorHint: "The file may be corrupt, too small or in an unsupported format." };
  return { errorKind: "other", errorTitle: `${label} is unavailable`, errorHint: "Re-scan this photo." };
}

// Only server-side hiccups are worth retrying; credential and quota problems fail the same way every time.
function isTransient(error: DetectorError) {
  if (error?.type) return error.type === "api_error" || error.type === "unknown_error";
  if (error?.status) return error.status === 429 || error.status >= 500;
  return /did not answer|could not reach/i.test(error?.message || "");
}

async function callWithRetries(call: (request: Request) => Promise<Raw>, request: Request) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(request);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isTransient(error as DetectorError)) throw error;
      await sleep(attempt * 1000 + Math.floor(Math.random() * 400));
    }
  }
}

export type DetectorResult = {
  provider?: string; providerLabel?: string; aiProbability?: number; realProbability?: number; verdictLabel?: string | null; reasoning?: string;
  generators?: { name: string; score: number }[]; editProbability?: number | null; editReasoning?: string | null; requestId?: string | null;
  skipped?: boolean; skipReason?: string; missingApiKey?: boolean; reason?: string; canRunDetector?: boolean; reused?: boolean; reusedFrom?: string;
  error?: string; errorKind?: string; errorTitle?: string; errorHint?: string;
};

export async function classifyImage(image: Buffer, mimeType: string, fileName: string, credentials: Credentials | null, providerName: string): Promise<DetectorResult> {
  const provider = resolve(providerName);
  const impl = PROVIDERS[provider];
  const normalized = impl.normalize(credentials);
  if (!normalized) {
    return { skipped: true, missingApiKey: true, provider, providerLabel: impl.label, reason: `The AI detector needs your ${impl.label} API credentials. Add them in Help Desk settings → AI photo check.` };
  }
  try {
    const raw = await callWithRetries(impl.call, { credentials: normalized, image, mimeType, fileName });
    const top = raw.generators?.[0];
    return {
      provider, providerLabel: impl.label, aiProbability: raw.aiProbability, realProbability: 100 - raw.aiProbability, verdictLabel: raw.verdictLabel || null,
      reasoning: `${impl.label}'s AI-image model rates this ${raw.aiProbability}% likely AI-generated${raw.verdictLabel ? ` (verdict: ${raw.verdictLabel})` : ""}${top && raw.aiProbability >= 40 ? `, most likely made with ${top.name}.` : "."}`,
      generators: raw.generators || [], editProbability: raw.editProbability ?? null, editReasoning: raw.editReasoning || null, requestId: raw.requestId || null,
    };
  } catch (error) {
    return { provider, providerLabel: impl.label, error: (error as Error).message, ...describeError(error as DetectorError, impl.label, impl.freePlanNote) };
  }
}

// Checks credentials before they're saved, so a typo is caught in settings.
// TruthScan has a free credits endpoint; Sightengine needs one tiny real
// check (failed requests cost nothing). An outage saves the key unverified.
export async function verifyCredentials(providerName: string, credentials: Credentials) {
  if (!(providerName in PROVIDERS)) return { valid: false, message: "Unknown AI detector." };
  const impl = PROVIDERS[providerName as Provider];
  const normalized = impl.normalize(credentials);
  if (!normalized) return { valid: false, message: impl.needsApiUser ? `Enter both the ${impl.label} API user and API secret.` : `Enter your ${impl.label} API key.` };
  try {
    if (impl.verify) {
      const { remainingChecks } = await impl.verify(normalized);
      if (remainingChecks === 0) return { valid: true, warning: `${impl.label} checks used up. Your account has no credits left for image checks (${impl.freePlanNote}).` };
      return { valid: true, remainingChecks };
    }
    const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    await impl.call({ credentials: normalized, image, mimeType: "image/jpeg", fileName: "key-check.jpg" });
    return { valid: true };
  } catch (error) {
    const { errorKind, errorTitle, errorHint } = describeError(error as DetectorError, impl.label, impl.freePlanNote);
    if (errorKind === "auth" || errorKind === "plan") return { valid: false, message: `${errorTitle}. ${errorHint}` };
    if (errorKind === "billing") return { valid: true, warning: `${errorTitle}. ${errorHint}` };
    if (errorKind === "media") return { valid: true };
    return { valid: true, unverified: true, message: (error as Error).message };
  }
}
