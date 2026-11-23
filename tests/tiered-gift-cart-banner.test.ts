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
    { id: "t1", minimumSpend: 29900, mode: "one", products: [gift("1", "11", "Sling 2.0"), gift("2", "21", "T-Shirt")] },
    { id: "t2", minimumSpend: 39900, mode: "all", products: [gift("3", "31", "Sling 3.0"), gift("2", "21", "T-Shirt")] },
  ],
};
const paid = (cents: number) => ({ key: "paid", variant_id: 999, product_id: 999, quantity: 1, original_line_price: cents, original_price: cents });
const tierGift = (variant: number, tier: string) => ({ key: `g${variant}`, variant_id: variant, product_id: variant, quantity: 1, original_line_price: 3000, original_price: 3000, properties: { _tier_gift: tier } });

async function render(items: unknown[], shopCurrency = "INR") {
  const root = {
    dataset: { shopCurrency } as Record<string, string>, hidden: true, innerHTML: "", addEventListener() {},
    querySelector: () => ({ textContent: JSON.stringify(settings) }),
  };
  runInNewContext(source, {
    document: {
      querySelectorAll: () => [root], getElementById: () => null, head: { appendChild() {} },
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
    expect(root.innerHTML).toContain("Spend <strong>$399.00</strong> and get <strong>BOTH</strong> gifts");
    expect(root.innerHTML).toContain(`<div class="fgcb-alt" aria-hidden="true">OR</div>`);
  });

  test("Tier 1 reached but no gift yet: unlocked, Tier 1 gifts", async () => {
    const root = await render([paid(30000)]);
    expect(root.innerHTML).toContain("TIER 1 UNLOCKED");
    expect(root.innerHTML).toContain("You've unlocked");
    expect(root.innerHTML).toContain("Sling 2.0");
    expect(root.innerHTML).not.toContain("Sling 3.0");
    expect(root.innerHTML).toContain("width:100%");
    expect(root.innerHTML).toContain("data-open-gift");
    expect(root.innerHTML).toContain("Choose 1 below");
    expect(root.innerHTML).not.toContain("fgcb-alt");
    expect(root.innerHTML).toContain("Add <strong>$99.00</strong> more to get a 2nd gift <strong>FREE</strong>");
  });

  test("Tier 1 gift in the cart: everything switches to Tier 2", async () => {
    const root = await render([paid(30000), tierGift(11, "t1")]);
    expect(root.innerHTML).toContain("2 MORE GIFTS FREE");
    // Sling 2.0 isn't a Tier 2 gift, so both Tier 2 gifts are still to come.
    expect(root.innerHTML).toContain("more and get <strong>2 more gifts</strong>");
    expect(root.innerHTML).toContain("<span>+</span>");
    expect(root.innerHTML).toContain("$99.00");
    expect(root.innerHTML).toContain("$300.00&nbsp;/&nbsp;$399.00");
    expect(root.innerHTML).toContain("Sling 3.0");
    expect(root.innerHTML).not.toContain("Sling 2.0");
  });

  test("Tier 1 T-shirt in the cart: add more and get 1 more gift, showing only the missing one", async () => {
    const html = (await render([paid(30000), tierGift(21, "t1")])).innerHTML;
    expect(html).toContain("1 MORE GIFT FREE");
    expect(html).toContain("Add <strong>$99.00</strong> more and get <strong>1 more gift</strong> <strong>FREE</strong>!");
    expect(html).toContain("Add $99.00 more to also get");
    expect(html).toContain("Sling 3.0");
    expect(html).not.toContain("T-Shirt");
  });

  test("Tier 2 (all gifts) stays unlocked until every gift is claimed, then hides", async () => {
    expect((await render([paid(40000)])).innerHTML).toContain("TIER 2 UNLOCKED");
    expect((await render([paid(40000)])).innerHTML).toContain("unlocked <strong>BOTH</strong> gifts");
    const one = (await render([paid(40000), tierGift(31, "t2")])).innerHTML;
    expect(one).toContain("Claim your <strong>2nd</strong> gift <strong>FREE</strong>!");
    expect(one).toContain("T-Shirt");
    expect(one).not.toContain("Sling 3.0");
    expect((await render([paid(40000), tierGift(31, "t2"), tierGift(21, "t1")])).hidden).toBe(true);
  });

  test("Tier 1 offers its gifts with OR", async () => {
    expect((await render([paid(30000)])).innerHTML).toContain("<span>OR</span>");
  });
});
