import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../extensions/free-gift-popup/assets/tiered-gift-product-widget.js", import.meta.url), "utf8");

const gift = (product: string, variant: string, title: string) => ({
  productId: `gid://shopify/Product/${product}`, productTitle: title, variantId: `gid://shopify/ProductVariant/${variant}`, imageUrl: "",
});
const three = [gift("1", "11", "Slab Case One"), gift("2", "21", "T-Shirt"), gift("3", "31", "Sling 2.0")];
const campaign = { enabled: true, tiers: [
  { id: "low", minimumSpend: 15000, mode: "one", products: three },
  { id: "high", minimumSpend: 35000, mode: "two", products: three },
] };
const paid = (cents: number) => ({ key: "paid", variant_id: 999, product_id: 999, quantity: 1, original_line_price: cents, original_price: cents });
const tierGift = (id: number) => ({ key: `g${id}`, variant_id: id * 10 + 1, product_id: id, quantity: 1, original_line_price: 3000, original_price: 3000, properties: { _tier_gift: "low" } });

async function widget(items: unknown[], settings = campaign, embed = true, productStock: Record<string, unknown> = {}) {
  let click: ((event: unknown) => void) | undefined;
  const events: string[] = [];
  const status = { textContent: "" };
  const root = {
    dataset: { shopCurrency: "USD" } as Record<string, string>, hidden: true, innerHTML: "",
    querySelector: (selector: string) => selector === "[data-fgpw-tiers]" ? { textContent: JSON.stringify(settings) } : selector === ".fgpw-status" ? status : null,
    addEventListener: (_: string, callback: (event: unknown) => void) => { click = callback; },
  };
  const popupRoot = { querySelector: (selector: string) => selector === "[data-tiered-gift-settings]" ? {} : selector === "[data-tiered-gift-inventory]" ? { textContent: "{}" } : null };
  class Element { constructor(public selector: string) {} closest(selector: string) { return selector === this.selector ? this : null; } }
  runInNewContext(source, {
    document: {
      getElementById: () => embed ? popupRoot : null,
      querySelectorAll: () => [root],
      createElement: () => { let text = ""; return { set textContent(value: string) { text = value; }, get innerHTML() { return text; } }; },
      dispatchEvent: (event: { type: string }) => { events.push(event.type); },
    },
    window: { Shopify: { currency: { active: "USD", rate: "1.0" }, routes: { root: "/" } }, setInterval() {} },
    fetch: async (url: string) => {
      const handle = String(url).match(/products\/([^/]+)\.js/)?.[1];
      if (handle) return productStock[handle] ? { ok: true, json: async () => productStock[handle] } : { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ currency: "USD", items }) };
    },
    AbortSignal: { timeout: () => undefined },
    CustomEvent: class { constructor(public type: string) {} }, Element,
    Intl, JSON, Number, String, Math, Set, Map, Array, Object, Date,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { root, status, events, clickClaim: () => click?.({ target: new Element(".fgpw-claim") }) };
}

describe("Netgains10 product page widget", () => {
  test("a sold-out gift is not shown", async () => {
    const offer = { ...campaign, tiers: campaign.tiers.map((t) => ({ ...t, products: t.products.map((p) => ({ ...p, productHandle: "h" + p.productId.split("/").pop() })) })) };
    const { root } = await widget([paid(9999)], offer, true, { h2: { id: 2, variants: [{ id: 21, available: false }] } });
    expect(root.innerHTML).not.toContain("T-Shirt");
    expect(root.innerHTML).toContain("Slab Case One");
    expect(root.innerHTML).toContain("Sling 2.0");
  });
  test("below Tier 1 it shows all 3 gifts and both offers", async () => {
    const { root } = await widget([paid(9999)]);
    for (const title of ["Slab Case One", "T-Shirt", "Sling 2.0"]) expect(root.innerHTML).toContain(title);
    expect(root.innerHTML).toContain("fgpw-products--three");
    expect(root.innerHTML).toContain("Unlock a <strong>FREE Gift</strong> on Orders <strong>$150+</strong>");
    expect(root.innerHTML).toContain("Spend <strong>$150 &amp; above</strong>, choose <strong>1 FREE gift</strong>.<br>Spend <strong>$350 &amp; above</strong>, choose <strong>any 2 FREE gifts</strong>.");
    expect(root.hidden).toBe(false);
  });
  test("below Tier 1 there is no claim button", async () => {
    const w = await widget([paid(9999)]);
    expect(w.root.innerHTML).not.toContain("fgpw-claim");
    expect(w.root.innerHTML).toContain("fgpw-footer");
  });
  test("Tier 1 reached: 1 free gift, no claim button (the popup opens by itself)", async () => {
    const w = await widget([paid(20000)]);
    expect(w.root.innerHTML).toContain("You've unlocked <strong>1 FREE Gift</strong>!");
    expect(w.root.innerHTML).toContain("spend <strong>$150</strong> more to choose <strong>any 2 FREE gifts</strong>");
    expect(w.root.innerHTML).not.toContain("fgpw-claim");
  });
  test("Tier 1 gift claimed: shows the Tier 2 offer without a claim button", async () => {
    const { root } = await widget([paid(20000), tierGift(1)]);
    expect(root.innerHTML).toContain("Spend <strong>$150</strong> more to choose <strong>any 2 FREE gifts</strong>");
    expect(root.innerHTML).not.toContain("fgpw-claim");
  });
  test("Tier 2 with a Tier 1 gift: 1 more to claim", async () => {
    const { root } = await widget([paid(35000), tierGift(1)]);
    expect(root.innerHTML).toContain("You've unlocked <strong>1 FREE Gift</strong>!");
  });
  test("Tier 2 with nothing claimed: 2 gifts", async () => {
    const { root } = await widget([paid(35000)]);
    expect(root.innerHTML).toContain("You've unlocked <strong>2 FREE Gifts</strong>!");
    expect(root.innerHTML).not.toContain("CLAIM MY FREE GIFT");
  });
  test("both Tier 2 gifts claimed hides the widget", async () => {
    const { root } = await widget([paid(35000), tierGift(1), tierGift(2)]);
    expect(root.hidden).toBe(true);
  });
  test("no app embed, no widget", async () => {
    const { root } = await widget([paid(9999)], campaign, false);
    expect(root.innerHTML).toBe("");
    expect(root.hidden).toBe(true);
  });
});
