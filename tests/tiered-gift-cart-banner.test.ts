import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../extensions/free-gift-popup/assets/tiered-gift-cart-banner.js", import.meta.url), "utf8");

const gift = (product: string, variant: string, title: string) => ({
  productId: `gid://shopify/Product/${product}`, productTitle: title, variantId: `gid://shopify/ProductVariant/${variant}`, imageUrl: "",
});
const settings = {
  enabled: true,
  tiers: [
    { id: "t1", minimumSpend: 29900, products: [gift("1", "11", "Sling 2.0"), gift("2", "21", "T-Shirt")] },
    { id: "t2", minimumSpend: 39900, products: [gift("3", "31", "Sling 3.0"), gift("2", "21", "T-Shirt")] },
  ],
};
const paid = (cents: number) => ({ key: "paid", variant_id: 999, product_id: 999, quantity: 1, original_line_price: cents, original_price: cents });
const tierGift = (variant: number, tier: string) => ({ key: "g", variant_id: variant, product_id: variant, quantity: 1, original_line_price: 3000, original_price: 3000, properties: { _tier_gift: tier } });

async function render(items: unknown[], shopCurrency = "INR") {
  const root = {
    dataset: { shopCurrency } as Record<string, string>, hidden: true, innerHTML: "", addEventListener() {},
    querySelector: () => ({ textContent: JSON.stringify(settings) }),
  };
  runInNewContext(source, {
    document: {
      querySelectorAll: () => [root],
      createElement: () => { let text = ""; return { set textContent(value: string) { text = value; }, get innerHTML() { return text; } }; },
    },
    window: { Shopify: { currency: { rate: "0.012", active: "USD" }, routes: { root: "/" } }, setInterval() {} },
    fetch: async () => ({ ok: true, json: async () => ({ currency: "USD", items }) }),
    Intl, JSON, Number, String, Math, Set, Map, Array, Object,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return root;
}

describe("price gifts cart banner", () => {
  test("below Tier 1 it counts down to $299 with the Tier 1 gifts", async () => {
    const root = await render([paid(1700)]);
    expect(root.hidden).toBe(false);
    expect(root.innerHTML).toContain("FREE GIFT AWAITS");
    expect(root.innerHTML).toContain("$282.00");
    expect(root.innerHTML).toContain("Sling 2.0");
  });

  test("Tier 1 reached but no gift yet: unlocked, Tier 1 gifts", async () => {
    const root = await render([paid(30000)]);
    expect(root.innerHTML).toContain("TIER 1 UNLOCKED");
    expect(root.innerHTML).toContain("You've unlocked");
    expect(root.innerHTML).toContain("Sling 2.0");
    expect(root.innerHTML).not.toContain("Sling 3.0");
    expect(root.innerHTML).toContain("width:100%");
    expect(root.innerHTML).toContain("data-open-gift");
  });

  test("Tier 1 gift in the cart: everything switches to Tier 2", async () => {
    const root = await render([paid(30000), tierGift(11, "t1")]);
    expect(root.innerHTML).toContain("UPGRADE TO TIER 2");
    expect(root.innerHTML).toContain("$99.00");
    expect(root.innerHTML).toContain("$300.00&nbsp;/&nbsp;$399.00");
    expect(root.innerHTML).toContain("Sling 3.0");
    expect(root.innerHTML).not.toContain("Sling 2.0");
  });

  test("Tier 2 reached: unlocked until its gift is claimed, then hidden", async () => {
    expect((await render([paid(40000)])).innerHTML).toContain("TIER 2 UNLOCKED");
    expect((await render([paid(40000), tierGift(31, "t2")])).hidden).toBe(true);
  });
});
