import { randomUUID } from "node:crypto";
import type { InventorySyncPair, PrismaClient } from "@prisma/client";
import { InventoryRejectedError, readPair, setQuantity, type GraphqlClient } from "./inventory-sync-api.server";

type Pending = { key: string; createdAt: number; target: number; original: number; duplicate: number; step: 0 | 1 };
const LEASE_MS = 120_000;

export function sharedTarget(pair: Pick<InventorySyncPair, "sharedQuantity" | "originalBaseline" | "duplicateBaseline">, original: number, duplicate: number) {
  // Add BOTH changes so simultaneous orders are preserved. Negative stock is
  // retained (never clamped) so a later return cannot hide an oversell.
  return pair.sharedQuantity + original - pair.originalBaseline + duplicate - pair.duplicateBaseline;
}

export async function processPair(db: PrismaClient, id: string, getAdmin: (shop: string) => Promise<GraphqlClient>) {
  const token = randomUUID();
  const now = new Date();
  const claimed = await db.inventorySyncPair.updateMany({
    where: { id, enabled: true, OR: [{ lockUntil: null }, { lockUntil: { lt: now } }] },
    data: { lockToken: token, lockUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (!claimed.count) return;
  const save = async (data: Parameters<typeof db.inventorySyncPair.updateMany>[0]["data"]) => {
    const result = await db.inventorySyncPair.updateMany({ where: { id, lockToken: token }, data });
    if (!result.count) throw new Error("Inventory sync lease was lost.");
  };
  try {
    const pair = await db.inventorySyncPair.findUniqueOrThrow({ where: { id } });
    let pending = pair.pending ? JSON.parse(pair.pending) as Pending : null;
    if (pending && Date.now() - pending.createdAt > 23 * 60 * 60 * 1000) {
      await save({ enabled: false, lastError: "An unconfirmed inventory write is over 23 hours old. Review Shopify inventory history before removing and recreating this link." });
      return;
    }
    const admin = await getAdmin(pair.shop);
    if (!pending) {
      const current = await readPair(admin, pair.originalVariantId, pair.duplicateVariantId, pair.locationId);
      if (current.original.inventoryItem.id !== pair.originalItemId || current.duplicate.inventoryItem.id !== pair.duplicateItemId) throw new Error("Inventory item changed. Recreate this link.");
      const target = sharedTarget(pair, current.originalQuantity, current.duplicateQuantity);
      if (target === current.originalQuantity && target === current.duplicateQuantity) {
        await save({ sharedQuantity: target, originalBaseline: target, duplicateBaseline: target, lastSyncedAt: new Date(), lastError: null, attempts: 0, nextRunAt: new Date(Date.now() + 60_000) });
        return;
      }
      pending = { key: randomUUID(), createdAt: Date.now(), target, original: current.originalQuantity, duplicate: current.duplicateQuantity, step: 0 };
      await save({ pending: JSON.stringify(pending), lockUntil: new Date(Date.now() + LEASE_MS) });
    }
    // Each write has its own durable key. Baselines are committed after EACH
    // successful side, so partial failure cannot double-count a sale on retry.
    if (pending.step === 0) {
      await save({ lockUntil: new Date(Date.now() + LEASE_MS) });
      await setQuantity(admin, { itemId: pair.originalItemId, locationId: pair.locationId, quantity: pending.target, compareQuantity: pending.original, key: `${pending.key}-original`, pairId: id });
      pending = { ...pending, step: 1 };
      await save({ sharedQuantity: pending.target, originalBaseline: pending.target, duplicateBaseline: pending.duplicate, pending: JSON.stringify(pending) });
    }
    await save({ lockUntil: new Date(Date.now() + LEASE_MS) });
    await setQuantity(admin, { itemId: pair.duplicateItemId, locationId: pair.locationId, quantity: pending.target, compareQuantity: pending.duplicate, key: `${pending.key}-duplicate`, pairId: id });
    await save({ duplicateBaseline: pending.target, pending: null, lastSyncedAt: new Date(), lastError: null, attempts: 0, nextRunAt: new Date(Date.now() + 2_000) });
  } catch (error) {
    const pair = await db.inventorySyncPair.findUnique({ where: { id } });
    if (pair?.lockToken === token) {
      const attempts = pair.attempts + 1;
      await save({
        // A definitive rejection changed nothing on this side. Re-read current
        // stock. Network/GraphQL failures retain the exact request for replay.
        ...(error instanceof InventoryRejectedError ? { pending: null } : {}),
        attempts, lastError: error instanceof Error ? error.message : "Inventory sync failed.",
        nextRunAt: new Date(Date.now() + Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 7))),
      });
    }
  } finally {
    await db.inventorySyncPair.updateMany({ where: { id, lockToken: token }, data: { lockToken: null, lockUntil: null } });
  }
}

export async function enqueueInventory(db: PrismaClient, shop: string, itemId: string, locationId: string) {
  // Webhooks are wake-up signals only. Their quantities can be stale, duplicated
  // or reordered; the worker always reads current Shopify inventory instead.
  await db.inventorySyncPair.updateMany({ where: { shop, enabled: true, locationId, OR: [{ originalItemId: itemId }, { duplicateItemId: itemId }] }, data: { nextRunAt: new Date() } });
}
