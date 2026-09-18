import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPair, enqueueInventory } from "../app/services/inventory-sync-engine.server";
import { createLink, changeLink, createLinksBulk } from "../app/services/inventory-sync-settings.server";
import { readProductMatches, type GraphqlClient } from "../app/services/inventory-sync-api.server";

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
    const input = variables.input as { quantities: Array<{ inventoryItemId: string; quantity: number; changeFromQuantity: number }> };
    const change = input.quantities[0];
    const key = variables.key as string;
    const side = change.inventoryItemId.endsWith("/1") ? 0 : 1;
    calls.push({ key, side, quantity: change.quantity });
    if (completed.has(key)) return { json: async () => completed.get(key) };
    if (conflictSide === side) { conflictSide = -1; quantities[side]--; }
    if (change.changeFromQuantity !== quantities[side]) return { json: async () => ({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ code: "CHANGE_FROM_QUANTITY_STALE", message: "Stock changed during sync" }] } } }) };
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

type FakeVariant = { id: string; title: string; policy: string; tracked: boolean; options: Array<{ name: string; value: string }>; available: number | null };
function fakeProductShop(fakeLocationId: string) {
  const variantsById = new Map<string, FakeVariant & { productId: string; productTitle: string }>();
  const productsById = new Map<string, { id: string; title: string; variantIds: string[] }>();
  let locationActive = true;
  const addProduct = (id: string, title: string, variants: FakeVariant[]) => {
    productsById.set(id, { id, title, variantIds: variants.map((variant) => variant.id) });
    for (const variant of variants) variantsById.set(variant.id, { ...variant, productId: id, productTitle: title });
  };
  const inventoryItem = (variant: FakeVariant) => ({ id: `${variant.id}-item`, tracked: variant.tracked, inventoryLevel: variant.available == null ? null : { quantities: [{ name: "available", quantity: variant.available }] } });
  const admin: GraphqlClient = { graphql: async (operation, options) => {
    const variables = options?.variables || {};
    const location = { id: fakeLocationId, name: "Main warehouse", isActive: locationActive, fulfillmentService: null };
    if (operation.includes("query InventorySyncProductVariants")) {
      const ids = variables.ids as string[];
      const nodes = ids.map((id) => {
        const product = productsById.get(id);
        if (!product) return null;
        return { id: product.id, title: product.title, variants: { nodes: product.variantIds.map((variantId) => {
          const variant = variantsById.get(variantId)!;
          return { id: variant.id, title: variant.title, inventoryPolicy: variant.policy, selectedOptions: variant.options, inventoryItem: inventoryItem(variant) };
        }) } };
      });
      return { json: async () => ({ data: { nodes, location } }) };
    }
    if (operation.includes("query InventorySyncVariants")) {
      const ids = variables.ids as string[];
      const nodes = ids.map((id) => {
        const variant = variantsById.get(id);
        if (!variant) return null;
        return { id: variant.id, title: variant.title, inventoryPolicy: variant.policy, product: { id: variant.productId, title: variant.productTitle }, inventoryItem: inventoryItem(variant) };
      });
      return { json: async () => ({ data: { nodes, location } }) };
    }
    throw new Error("Unexpected operation");
  } };
  return { admin, addProduct, setLocationActive: (value: boolean) => { locationActive = value; } };
}

describe("matching and linking whole products", () => {
  const productShopId = "product-match-test.myshopify.com";
  const matchLocationId = gid("Location", 9);
  const originalProductId = gid("Product", 10);
  const duplicateProductId = gid("Product", 20);
  let shopApi: ReturnType<typeof fakeProductShop>;

  beforeEach(() => {
    shopApi = fakeProductShop(matchLocationId);
    shopApi.addProduct(originalProductId, "Slab Case", [
      { id: gid("ProductVariant", 101), title: "Black", policy: "DENY", tracked: true, options: [{ name: "Color", value: "Black" }], available: 10 },
      { id: gid("ProductVariant", 102), title: "Silver", policy: "DENY", tracked: true, options: [{ name: "Color", value: "Silver" }], available: 5 },
      { id: gid("ProductVariant", 103), title: "Rose", policy: "DENY", tracked: false, options: [{ name: "Color", value: "Rose" }], available: 1 },
    ]);
    shopApi.addProduct(duplicateProductId, "Slab Case - Gift", [
      { id: gid("ProductVariant", 201), title: "Black", policy: "DENY", tracked: true, options: [{ name: "Color", value: "Black" }], available: 3 },
      { id: gid("ProductVariant", 202), title: "Silver", policy: "DENY", tracked: true, options: [{ name: "Color", value: "Silver" }], available: 2 },
      { id: gid("ProductVariant", 203), title: "Gold", policy: "DENY", tracked: true, options: [{ name: "Color", value: "Gold" }], available: 4 },
    ]);
  });

  test("matches variants that share the same option values, reporting unmatched and invalid ones", async () => {
    const result = await readProductMatches(shopApi.admin, originalProductId, duplicateProductId, matchLocationId);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((match) => match.originalTitle)).toEqual(["Slab Case / Black", "Slab Case / Silver"]);
    const black = result.matches.find((match) => match.originalTitle.endsWith("Black"))!;
    expect(black.duplicateTitle).toBe("Slab Case - Gift / Black");
    expect(black.originalQuantity).toBe(10);
    expect(black.duplicateQuantity).toBe(3);
    expect(result.unmatchedDuplicate).toEqual(["Slab Case - Gift / Gold"]);
    expect(result.unmatchedOriginal).toEqual([]);
    expect(result.invalid[0]).toContain("inventory tracking is off");
  });

  test("rejects matching a product against itself and invalid identifiers before an API call", async () => {
    await expect(readProductMatches(shopApi.admin, originalProductId, originalProductId, matchLocationId)).rejects.toThrow("different product");
    await expect(readProductMatches(shopApi.admin, "bad", duplicateProductId, matchLocationId)).rejects.toThrow("Select two products");
  });

  test("throws when no variants match between the two products", async () => {
    shopApi.addProduct(gid("Product", 30), "Unrelated", [
      { id: gid("ProductVariant", 301), title: "Teal", policy: "DENY", tracked: true, options: [{ name: "Color", value: "Teal" }], available: 2 },
    ]);
    await expect(readProductMatches(shopApi.admin, originalProductId, gid("Product", 30), matchLocationId)).rejects.toThrow("No variants matched");
  });

  test("rejects an inactive location", async () => {
    shopApi.setLocationActive(false);
    await expect(readProductMatches(shopApi.admin, originalProductId, duplicateProductId, matchLocationId)).rejects.toThrow("active merchant-managed location");
  });

  test("bulk-creates a link per matched variant pair and reports ones that fail", async () => {
    await db.inventorySyncPair.deleteMany({ where: { shop: productShopId } });
    const result = await readProductMatches(shopApi.admin, originalProductId, duplicateProductId, matchLocationId);
    const pairs = result.matches.map((match) => ({ originalId: match.originalId, duplicateId: match.duplicateId }));
    const first = await createLinksBulk(db, shopApi.admin, productShopId, pairs, matchLocationId);
    expect(first.created).toBe(2);
    expect(first.failed).toEqual([]);
    const second = await createLinksBulk(db, shopApi.admin, productShopId, pairs, matchLocationId);
    expect(second.created).toBe(0);
    expect(second.failed).toHaveLength(2);
    expect(second.failed[0].reason).toContain("already linked");
  });
});
