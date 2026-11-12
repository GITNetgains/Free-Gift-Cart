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
// T-shirt sizes and colours: S/black, M/black and L/gray exist; L/black and S/gray don't.
const shirtVariants = [["21", "S", "black"], ["22", "M", "black"], ["23", "L", "gray"]].map(([id, size, color]) => ({
  ...shirt, variantId: `gid://shopify/ProductVariant/${id}`, variantTitle: `${size} / ${color}`, optionNames: ["Size", "Color"], optionValues: [size, color],
}));
const sling3 = gift("3", "31", "Zion Cases Sling 3.0");
const settings = {
  enabled: true,
  tiers: [
    { id: "t1", minimumSpend: 29900, mode: "one", products: [sling2, shirt] },
    // Saved as "all" by an older version: still one gift.
    { id: "t2", minimumSpend: 39900, mode: "all", products: [...shirtVariants, sling3] },
  ],
};

type Item = { key: string; variant_id: number; product_id: number; quantity: number; original_line_price: number; original_price: number; properties?: Record<string, string> };
const paid = (cents: number): Item => ({ key: "paid", variant_id: 999, product_id: 999, quantity: 1, original_line_price: cents, original_price: cents });
const giftLine = (key: string, variant: number, tier: string): Item => ({ key, variant_id: variant, product_id: variant, quantity: 1, original_line_price: 3000, original_price: 3000, properties: { _tier_gift: tier } });

// A Dawn-style cart row: id CartItem-<line>, a product link and a quantity selector.
function cartRow(line: number) {
  const attributes: Record<string, string> = { href: "/products/hoodie?variant=31" };
  const link = {
    dataset: {} as Record<string, string>,
    getAttribute: (name: string) => attributes[name] ?? null,
    setAttribute: (name: string, value: string) => { attributes[name] = value; },
    removeAttribute: (name: string) => { delete attributes[name]; },
  };
  const quantityBox = { hidden: false, querySelector: () => null };
  const quantityInput = { hidden: false, closest: () => quantityBox };
  const row = {
    id: `CartItem-${line}`, classes: new Set<string>(),
    classList: { add(name: string) { row.classes.add(name); } },
    closest: () => row,
    querySelectorAll: (selector: string) => selector === "a[href]" ? (attributes.href ? [link] : []) : selector.includes("updates[]") ? [quantityInput] : [],
  };
  return { row, link: attributes, quantityBox };
}

async function run(items: Item[], pathname = "/products/case", shop = { currency: "USD", rate: "1.0" }, rows: Array<ReturnType<typeof cartRow>> = []) {
  let html = "";
  // Every innerHTML the popup writes (cards, then each options refresh).
  const writes: string[] = [];
  const updates: Array<Record<string, number>> = [];
  const element = (): Record<string, unknown> => {
    let inner = "";
    return {
      set innerHTML(value: string) { inner = value; writes.push(value); }, get innerHTML() { return inner; },
      addEventListener() {}, focus() {}, classList: { add() {}, toggle() {} }, hidden: false,
      querySelector: () => element(), querySelectorAll: () => [],
    };
  };
  const nodes: Record<string, { textContent: string }> = {
    "[data-tiered-gift-settings]": { textContent: JSON.stringify(settings) },
    "[data-free-gift-settings]": { textContent: "{}" },
    "[data-tiered-gift-inventory]": { textContent: "{}" },
  };
  const root = {
    dataset: { cartPath: "/cart", shopCurrency: shop.currency } as Record<string, string>, hidden: true, classList: { add() {} }, style: { setProperty() {} },
    querySelector: (selector: string) => nodes[selector] || (selector === ".fgc-overlay" ? (html ? element() : null) : element()),
    querySelectorAll: () => [],
    contains: () => false,
    insertAdjacentHTML: (_: string, value: string) => { html += value; },
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.endsWith("cart.js")) return { ok: true, json: async () => ({ currency: "USD", items }) };
    if (url.endsWith("cart/update.js")) { updates.push(JSON.parse(init!.body!).updates); return { ok: true, json: async () => ({ items: [] }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const window = {
    fetch, location: { pathname, reload() {} }, setInterval() {}, setTimeout() {},
    Shopify: { currency: { rate: shop.rate, active: "USD" }, routes: { root: "/" } },
  };
  runInNewContext(source, {
    window, document: {
      getElementById: () => root, addEventListener() {}, visibilityState: "visible", body: {},
      querySelectorAll: (selector: string) => rows.filter(({ row }) => selector.includes(`#${row.id},`) || selector.endsWith(`#${row.id}`)).map(({ row }) => row),
      documentElement: { classList: { add() {}, remove() {} }, lang: "en" },
      createElement: () => { let text = ""; return { set textContent(value: string) { text = value; }, get innerHTML() { return text.replaceAll("<", "&lt;"); } }; },
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    XMLHttpRequest: function XMLHttpRequest() {}, MutationObserver: class { observe() {} }, Element: class {},
    Intl, JSON, Number, String, Math, Set, Map, Object, Array, Promise,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { html, content: writes.join("\n"), updates };
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

  test("Tier 2 removes the Tier 1 gift and offers one gift, even if saved as all", async () => {
    const { html, content, updates } = await run([paid(40000), giftLine("old", 11, "t1")]);
    expect(updates).toEqual([{ old: 0 }]);
    expect(html).toContain("YOU’VE UNLOCKED A FREE GIFT!");
    expect(html).not.toContain("FREE GIFTS");
    expect(content).toContain("Zion Cases Sling 3.0");
    expect(content).not.toContain("fgc-products--all");
  });

  test("Tier 2 keeps a single Tier 2 gift and removes any second one", async () => {
    const { updates, html } = await run([giftLine("newest", 31, "t2"), paid(40000), giftLine("earlier", 21, "t2")]);
    expect(updates).toEqual([{ earlier: 0 }]);
    expect(html).toBe("");
  });

  test("in a pick-one tier the newest gift replaces the earlier one", async () => {
    const { updates, html } = await run([giftLine("newest", 21, "t1"), paid(30000), giftLine("earlier", 11, "t1")]);
    expect(updates).toEqual([{ earlier: 0 }]);
    expect(html).toBe("");
  });

  test("an INR store showing dollars opens Tier 1 at $299, not at $17", async () => {
    const inrShop = { currency: "INR", rate: "0.012" };
    expect((await run([paid(1700)], "/products/case", inrShop)).html).toBe("");
    expect((await run([paid(29800)], "/products/case", inrShop)).html).toBe("");
    expect((await run([paid(29900)], "/products/case", inrShop)).html).toContain("YOU’VE UNLOCKED A FREE GIFT!");
  });

  test("only the chosen gift's options show", async () => {
    const { content } = await run([paid(40000)]);
    expect(content).toContain('data-options-for="gid://shopify/Product/2"');
    expect(content).not.toContain('data-options-for="gid://shopify/Product/3"');
    expect(content).toContain("Choose your size");
    expect(content).toContain("Choose your color");
  });

  test("colours follow the chosen size: only combinations that exist are listed", async () => {
    const { content } = await run([paid(40000)]);
    const panel = content.slice(content.lastIndexOf("data-options-for"));
    const option = (value: string) => panel.match(new RegExp(`<button class="fgc-option([^"]*)"[^>]*data-option-value="${value}"`))?.[1];
    // Every size is listed; S/black is chosen.
    expect(option("S")).toContain("is-selected");
    expect(option("M")).toBe("");
    expect(option("L")).toBe("");
    // Only black exists in size S, so gray isn't offered.
    expect(option("black")).toContain("is-selected");
    expect(option("gray")).toBeUndefined();
  });

  test("the gift line in the cart has no product link and no quantity selector; paid lines are untouched", async () => {
    const paidRow = cartRow(1);
    const giftRow = cartRow(2);
    await run([paid(40000), giftLine("gift", 31, "t2")], "/cart", undefined, [paidRow, giftRow]);
    expect(giftRow.link.href).toBeUndefined();
    expect(giftRow.link["aria-disabled"]).toBe("true");
    expect(giftRow.quantityBox.hidden).toBe(true);
    expect(giftRow.row.classes.has("fgc-gift-line")).toBe(true);
    expect(paidRow.link.href).toBe("/products/hoodie?variant=31");
    expect(paidRow.quantityBox.hidden).toBe(false);
  });
});
