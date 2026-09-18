import type { InventorySyncPair, PrismaClient } from "@prisma/client";
import { readPair, type GraphqlClient } from "./inventory-sync-api.server";

export async function createLink(db: PrismaClient, admin: GraphqlClient, shop: string, originalId: string, duplicateId: string, locationId: string) {
  const data = await readPair(admin, originalId, duplicateId, locationId);
  const title = (variant: typeof data.original) => `${variant.product.title}${variant.title === "Default Title" ? "" : ` / ${variant.title}`}`;
  try {
    return await db.inventorySyncPair.create({ data: {
      shop, originalVariantId: originalId, duplicateVariantId: duplicateId,
      originalItemId: data.original.inventoryItem.id, duplicateItemId: data.duplicate.inventoryItem.id,
      originalTitle: title(data.original), duplicateTitle: title(data.duplicate),
      locationId, locationName: data.location.name,
      sharedQuantity: data.originalQuantity, originalBaseline: data.originalQuantity, duplicateBaseline: data.duplicateQuantity,
      members: { create: [data.original, data.duplicate].map((variant) => ({ shop, locationId, inventoryItemId: variant.inventoryItem.id })) },
    } });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new Error("One of these variants is already linked at this location. Remove its existing link first.");
    throw error;
  }
}

export async function changeLink(db: PrismaClient, shop: string, id: string, intent: string) {
  if (!["pause", "resume", "sync", "remove"].includes(intent)) throw new Error("Unknown inventory sync action.");
  const pair = await db.inventorySyncPair.findFirst({ where: { id, shop } });
  if (!pair) throw new Error("Inventory link not found.");
  const idle = { id, shop, OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }] };
  if (intent === "remove") {
    if (pair.enabled) throw new Error("Pause the link before removing it.");
    if (pair.pending) throw new Error("An inventory write is unconfirmed. Resolve it before removing this link.");
    const result = await db.inventorySyncPair.deleteMany({ where: { ...idle, enabled: false, pending: null } });
    if (!result.count) throw new Error("Sync is running. Try again in a moment.");
    return;
  }
  if (intent === "sync" && !pair.enabled) throw new Error("Resume this link before syncing.");
  const result = await db.inventorySyncPair.updateMany({ where: idle, data: {
    ...(intent === "pause" ? { enabled: false } : intent === "resume" ? { enabled: true } : {}),
    ...(intent !== "pause" ? { nextRunAt: new Date() } : {}),
  } });
  if (!result.count) throw new Error("Sync is running. Try again in a moment.");
}

export function publicPair(pair: InventorySyncPair) {
  return {
    id: pair.id, originalTitle: pair.originalTitle, duplicateTitle: pair.duplicateTitle,
    locationName: pair.locationName, enabled: pair.enabled, quantity: pair.sharedQuantity,
    lastSyncedAt: pair.lastSyncedAt?.toISOString() ?? null, lastError: pair.lastError,
    pending: Boolean(pair.pending),
  };
}
