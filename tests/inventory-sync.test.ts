import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPair, enqueueInventory } from "../app/services/inventory-sync-engine.server";
import { createLink, changeLink } from "../app/services/inventory-sync-settings.server";
import type { GraphqlClient } from "../app/services/inventory-sync-api.server";

const temp = mkdtempSync(join(tmpdir(), "inventory-sync-test-"));
const db = new PrismaClient({ datasourceUrl: `file:${join(temp, "test.sqlite").replaceAll("\\", "/")}` });
const shop = "local-test.myshopify.com";
const gid = (kind: string, id: number) => `gid://shopify/${kind}/${id}`;
const originalId = gid("ProductVariant", 1);
const duplicateId = gid("ProductVariant", 2);
const locationId = gid("Location", 1);

function fakeShopify() {
  const quantities = [10, 3];
  const calls: Array<{ key: string; side: number; quantity: number }> = [];
  const completed = new Map<string, unknown>();
  let failSide = -1;
  let conflictSide = -1;
  let tracked = true;
  let policy = "DENY";
  let sameProduct = false;
  let missing = false;
  let inactive = false;
  let unstocked = false;
  let failure = "network";
  let readCount = 0;
  const admin: GraphqlClient = { graphql: async (operation, options) => {
    const variables = options?.variables || {};
    if (operation.includes("query InventorySyncVariants")) {
      readCount++;
      return { json: async () => ({ data: {
        nodes: [0, 1].map((side) => missing && side === 1 ? null : ({
          id: side === 0 ? originalId : duplicateId, title: "Black", inventoryPolicy: policy,
          product: { id: gid("Product", sameProduct ? 1 : side + 1), title: side ? "Duplicate case" : "Original case" },
          inventoryItem: { id: gid("InventoryItem", side + 1), tracked, inventoryLevel: unstocked ? null : { quantities: [{ name: "available", quantity: quantities[side] }] } },
        })),
        location: { id: locationId, name: "Main warehouse", isActive: !inactive, fulfillmentService: null },
      } }) };
    }
    if (!operation.includes("mutation InventorySyncSet")) throw new Error("Unexpected operation");
    const input = variables.input as { quantities: Array<{ inventoryItemId: string; quantity: number; compareQuantity: number }> };
    const change = input.quantities[0];
    const key = variables.key as string;
    const side = change.inventoryItemId.endsWith("/1") ? 0 : 1;
    calls.push({ key, side, quantity: change.quantity });
    if (completed.has(key)) return { json: async () => completed.get(key) };
    if (conflictSide === side) { conflictSide = -1; quantities[side]--; }
    if (change.compareQuantity !== quantities[side]) return { json: async () => ({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ code: "COMPARE_QUANTITY_STALE", message: "Stock changed during sync" }] } } }) };
    if (failSide === side && failure === "before") { failSide = -1; throw new Error("Network unavailable"); }
    quantities[side] = change.quantity;
    const response = { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { createdAt: new Date().toISOString() }, userErrors: [] } } };
    completed.set(key, response);
    if (failSide === side) { failSide = -1; throw new Error("Response lost after Shopify applied update"); }
    return { json: async () => response };
  } };
  return {
    admin, quantities, calls, get readCount() { return readCount; },
    fail: (side: number, mode = "network") => { failSide = side; failure = mode; },
    conflict: (side: number) => { conflictSide = side; },
    invalid: (mode: string) => { tracked = mode !== "untracked"; policy = mode === "oversell" ? "CONTINUE" : "DENY"; sameProduct = mode === "sameProduct"; missing = mode === "missing"; inactive = mode === "inactive"; unstocked = mode === "unstocked"; },
  };
}
let api = fakeShopify();
const create = () => createLink(db, api.admin, shop, originalId, duplicateId, locationId);
const run = (id: string) => processPair(db, id, async () => api.admin);
const saved = (id: string) => db.inventorySyncPair.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  const sql = readFileSync(new URL("../prisma/migrations/20260918000000_inventory_sync/migration.sql", import.meta.url), "utf8");
  for (const statement of sql.split(";").filter((part) => part.trim())) await db.$executeRawUnsafe(statement);
});
beforeEach(async () => { await db.inventorySyncPair.deleteMany(); api = fakeShopify(); });
afterAll(async () => { await db.$disconnect(); rmSync(temp, { recursive: true, force: true }); });

describe("inventory sync with SQLite and a simulated Shopify API", () => {
  test("creating a link only queues it; first sync copies original stock", async () => {
    const pair = await create();
    expect(api.calls).toHaveLength(0);
    await run(pair.id);
    expect(api.quantities).toEqual([10, 10]);
    expect((await saved(pair.id)).pending).toBeNull();
  });
  test.each([0, 1])("a sale on side %i updates both listings", async (side) => {
    const pair = await create(); await run(pair.id);
    api.quantities[side] -= 2; await run(pair.id);
    expect(api.quantities).toEqual([8, 8]);
  });
  test("concurrent sales on both sides are summed", async () => {
    const pair = await create(); await run(pair.id);
    api.quantities[0] -= 2; api.quantities[1] -= 3;
    await run(pair.id);
    expect(api.quantities).toEqual([5, 5]);
  });
  test.each([0, 1])("restocks and restocked returns on side %i sync", async (side) => {
    const pair = await create(); await run(pair.id);
    api.quantities[side] += 5; await run(pair.id);
    expect(api.quantities).toEqual([15, 15]);
  });
  test("sales between link creation and first sync are preserved", async () => {
    const pair = await create(); api.quantities[0]--; api.quantities[1]--;
    await run(pair.id); expect(api.quantities).toEqual([8, 8]);
  });
  test("duplicate and self-generated webhooks do not deduct again", async () => {
    const pair = await create(); await run(pair.id);
    api.quantities[1]--; await run(pair.id);
    const writes = api.calls.length;
    for (let i = 0; i < 3; i++) {
      await enqueueInventory(db, shop, gid("InventoryItem", 2), locationId);
      await run(pair.id);
    }
    expect(api.quantities).toEqual([9, 9]); expect(api.calls).toHaveLength(writes);
  });
  test.each([0, 1])("lost response on side %i reuses its durable idempotency key", async (side) => {
    const pair = await create(); api.fail(side); await run(pair.id);
    expect((await saved(pair.id)).pending).not.toBeNull();
    api.quantities[0]--; // Another order arrives before retry.
    await run(pair.id); await run(pair.id);
    expect(api.quantities).toEqual([9, 9]);
    const keys = api.calls.filter((call) => call.side === side).map((call) => call.key);
    expect(keys[0]).toBe(keys[1]);
    expect((await saved(pair.id)).lastError).toBeNull();
  });
  test("failure before a write retries without losing inventory", async () => {
    const pair = await create(); api.fail(0, "before"); await run(pair.id);
    expect(api.quantities).toEqual([10, 3]);
    await run(pair.id); expect(api.quantities).toEqual([10, 10]);
  });
  test.each([0, 1])("compare-and-set conflict on side %i preserves new sale", async (side) => {
    const pair = await create(); api.conflict(side); await run(pair.id);
    expect((await saved(pair.id)).lastError).toContain("Stock changed");
    expect((await saved(pair.id)).pending).toBeNull();
    await run(pair.id); expect(api.quantities).toEqual([9, 9]);
  });
  test("zero and negative stock remain accurate", async () => {
    const pair = await create(); await run(pair.id);
    api.quantities[0] = 0; api.quantities[1] = 9;
    await run(pair.id); expect(api.quantities).toEqual([-1, -1]);
    api.quantities[0]++; await run(pair.id); expect(api.quantities).toEqual([0, 0]);
  });
  test("pause stops writes; resume accounts for changes during pause", async () => {
    const pair = await create(); await run(pair.id);
    await changeLink(db, shop, pair.id, "pause");
    api.quantities[0] -= 2; await run(pair.id); expect(api.quantities).toEqual([8, 10]);
    await changeLink(db, shop, pair.id, "resume"); await run(pair.id); expect(api.quantities).toEqual([8, 8]);
  });
  test("an active lease prevents another worker from writing", async () => {
    const pair = await create();
    await db.inventorySyncPair.update({ where: { id: pair.id }, data: { lockToken: "other-worker", lockUntil: new Date(Date.now() + 60_000) } });
    await run(pair.id); expect(api.calls).toHaveLength(0);
    await expect(changeLink(db, shop, pair.id, "pause")).rejects.toThrow("running");
  });
  test("expired lease can be recovered after a restart", async () => {
    const pair = await create();
    await db.inventorySyncPair.update({ where: { id: pair.id }, data: { lockToken: "dead-worker", lockUntil: new Date(0) } });
    await run(pair.id); expect(api.quantities).toEqual([10, 10]);
  });
  test("expired idempotency window pauses rather than replaying an ambiguous write", async () => {
    const pair = await create(); api.fail(0); await run(pair.id);
    const pending = JSON.parse((await saved(pair.id)).pending!);
    pending.createdAt = Date.now() - 24 * 60 * 60 * 1000;
    await db.inventorySyncPair.update({ where: { id: pair.id }, data: { pending: JSON.stringify(pending) } });
    const count = api.calls.length; await run(pair.id);
    expect(api.calls).toHaveLength(count); expect((await saved(pair.id)).enabled).toBe(false);
  });
  test("duplicate or reversed links are rejected by the database", async () => {
    await create();
    await expect(create()).rejects.toThrow("already linked");
    await expect(createLink(db, api.admin, shop, duplicateId, originalId, locationId)).rejects.toThrow("already linked");
    expect(await db.inventorySyncPair.count()).toBe(1);
  });
  test("pair actions are tenant isolated", async () => {
    const pair = await create();
    await expect(changeLink(db, "another.myshopify.com", pair.id, "pause")).rejects.toThrow("not found");
    const before = (await saved(pair.id)).nextRunAt;
    await enqueueInventory(db, "another.myshopify.com", gid("InventoryItem", 1), locationId);
    expect((await saved(pair.id)).nextRunAt).toEqual(before);
  });
  test("webhooks for another location do not wake the pair", async () => {
    const pair = await create(); const before = pair.nextRunAt;
    await enqueueInventory(db, shop, gid("InventoryItem", 1), gid("Location", 2));
    expect((await saved(pair.id)).nextRunAt).toEqual(before);
  });
  test("remove requires a paused link and cleans membership records", async () => {
    const pair = await create();
    await expect(changeLink(db, shop, pair.id, "remove")).rejects.toThrow("Pause");
    await changeLink(db, shop, pair.id, "pause"); await changeLink(db, shop, pair.id, "remove");
    expect(await db.inventorySyncMember.count()).toBe(0);
  });
  test("unconfirmed writes cannot be removed", async () => {
    const pair = await create(); api.fail(0); await run(pair.id);
    await changeLink(db, shop, pair.id, "pause");
    await expect(changeLink(db, shop, pair.id, "remove")).rejects.toThrow("unconfirmed");
  });
  test.each(["untracked", "oversell", "sameProduct", "missing", "inactive", "unstocked"])("rejects unsafe configuration: %s", async (mode) => {
    api.invalid(mode); await expect(create()).rejects.toThrow();
    expect(await db.inventorySyncPair.count()).toBe(0);
  });
  test("rejects the same variant and invalid identifiers before an API call", async () => {
    await expect(createLink(db, api.admin, shop, originalId, originalId, locationId)).rejects.toThrow("different");
    await expect(createLink(db, api.admin, shop, "bad", duplicateId, locationId)).rejects.toThrow("Select");
    expect(api.readCount).toBe(0);
  });
});
