// In-memory request limits for the public (app proxy) endpoints. Counts live
// in this server process, so they reset on restart and aren't shared across
// instances; that's enough to stop a single client from hammering a form or
// guessing ticket numbers.

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
}

// Counts one hit for key and says whether it's within limit per windowMs.
export function hit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  sweep(now);
  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  window.count += 1;
  return window.count <= limit;
}

// Whether key has already used up its limit, without counting a hit.
export function blocked(key: string, limit: number) {
  const window = windows.get(key);
  return Boolean(window && window.resetAt > Date.now() && window.count >= limit);
}

export const clear = (key: string) => void windows.delete(key);

// Shopify's app proxy passes the shopper's address in X-Forwarded-For.
export function clientKey(request: Request, shop: string) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `${shop}|${ip}`;
}

export function resetRateLimits() { windows.clear(); }
