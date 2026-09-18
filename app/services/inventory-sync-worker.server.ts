import db from "../db.server";
import { processPair } from "./inventory-sync-engine.server";

declare global {
  // eslint-disable-next-line no-var
  var inventorySyncWorker: ReturnType<typeof setInterval> | undefined;
}

export function startInventorySyncWorker() {
  // Explicit opt-in keeps local development and builds from mutating a store.
  if (process.env.INVENTORY_SYNC_WORKER_ENABLED !== "true" || global.inventorySyncWorker) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { unauthenticated } = await import("../shopify.server");
      const pairs = await db.inventorySyncPair.findMany({ where: { enabled: true, nextRunAt: { lte: new Date() }, OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }] }, orderBy: { nextRunAt: "asc" }, take: 20, select: { id: true } });
      for (const pair of pairs) await processPair(db, pair.id, async (shop) => (await unauthenticated.admin(shop)).admin);
    } catch (error) {
      console.error("Inventory sync worker failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      running = false;
    }
  };
  global.inventorySyncWorker = setInterval(() => void tick(), 2_000);
  global.inventorySyncWorker.unref();
}
