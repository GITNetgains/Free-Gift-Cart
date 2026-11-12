import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../extensions/free-gift-popup/assets/tiered-gift-popup.js", import.meta.url), "utf8");

const gift = (product: string, variant: string, title: string, price = "30.00") => ({
  productId: `gid://shopify/Product/${product}`, productTitle: title, variantId: `gid://shopify/ProductVariant/${variant}`,
  variantTitle: "Default Title", price, imageUrl: "",
});
const sling2 = gift("1", "11", "Zion Cases Sling 2.0");
const shirt = gift("2", "21", "FREE GIFT | T-Shirt");
const sling3 = gift("3", "31", "Zion Cases Sling 3.0");
const settings = {
  enabled: true,
  tiers: [
    { id: "t1", minimumSpend: 29900, mode: "one", products: [sling2, shirt] },
    { id: "t2", minimumSpend: 39900, mode: "all", products: [sling3, shirt] },
  ],
};

type Item = { key: string; variant_id: number; product_id: number; quantity: number; original_line_price: number; original_price: number; properties?: Record<string, string> };
const paid = (cents: number): Item => ({ key: "paid", variant_id: 999, product_id: 999, quantity: 1, original_line_price: cents, original_price: cents });
const giftLine = (key: string, variant: number, tier: string): Item => ({ key, variant_id: variant, product_id: variant, quantity: 1, original_line_price: 3000, original_price: 3000, properties: { _tier_gift: tier } });

async function run(items: Item[], pathname = "/products/case") {
  let html = "";
  let content = "";
  const updates: Array<Record<string, number>> = [];
  const element = () => ({ set innerHTML(value: string) { content = value; }, get innerHTML() { return content; }, addEventListener() {}, focus() {}, classList: { add() {} } });
  const nodes: Record<string, { textContent: string }> = {
    "[data-tiered-gift-settings]": { textContent: JSON.stringify(settings) },
    "[data-free-gift-settings]": { textContent: "{}" },
    "[data-tiered-gift-inventory]": { textContent: "{}" },
  };
  const root = {
    dataset: { cartPath: "/cart" } as Record<string, string>, hidden: true, classList: { add() {} }, style: { setProperty() {} },
    querySelector: (selector: string) => nodes[selector] || (selector === ".fgc-overlay" ? (html ? element() : null) : element()),
    querySelectorAll: () => [],
    insertAdjacentHTML: (_: string, value: string) => { html += value; },
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.endsWith("cart.js")) return { ok: true, json: async () => ({ currency: "USD", items }) };
    if (url.endsWith("cart/update.js")) { updates.push(JSON.parse(init!.body!).updates); return { ok: true, json: async () => ({ items: [] }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const window = {
    fetch, location: { pathname, reload() {} }, setInterval() {}, setTimeout() {},
    Shopify: { currency: { rate: "1.0", active: "USD" }, routes: { root: "/" } },
  };
  runInNewContext(source, {
    window, document: {
      getElementById: () => root, addEventListener() {}, visibilityState: "visible",
      documentElement: { classList: { add() {}, remove() {} }, lang: "en" },
      createElement: () => { let text = ""; return { set textContent(value: string) { text = value; }, get innerHTML() { return text.replaceAll("<", "&lt;"); } }; },
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    XMLHttpRequest: function XMLHttpRequest() {}, Intl, JSON, Number, String, Math, Set, Map, Object, Array, Promise,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { html, content, updates };
}

describe("price gifts popup", () => {
  test("no popup below the first tier", async () => {
    expect((await run([paid(29800)])).html).toBe("");
  });

  test("crossing Tier 1 on any page opens the pick-one popup", async () => {
    const { html, content } = await run([paid(29900)]);
    expect(html).toContain("YOU’VE UNLOCKED A FREE GIFT!");
    expect(html).toContain("fgc-urgency");
    expect(content).toContain("Zion Cases Sling 2.0");
    expect(content).toContain("FREE GIFT | T-Shirt");
    expect(content).not.toContain("fgc-products--all");
  });

  test("Tier 2 offers every gift and removes the Tier 1 gift", async () => {
    const { html, content, updates } = await run([paid(40000), giftLine("old", 11, "t1")]);
    expect(updates).toEqual([{ old: 0 }]);
    expect(html).toContain("FREE GIFTS");
    expect(content).toContain("Zion Cases Sling 3.0");
    expect(content).toContain("fgc-products--all");
  });

  test("in a pick-one tier the newest gift replaces the earlier one", async () => {
    const { updates, html } = await run([giftLine("newest", 21, "t1"), paid(30000), giftLine("earlier", 11, "t1")]);
    expect(updates).toEqual([{ earlier: 0 }]);
    expect(html).toBe("");
  });
});
