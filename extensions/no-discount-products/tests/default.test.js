import { describe, expect, test } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";

const restrictedProductId = "gid://shopify/Product/1";
const normalProductId = "gid://shopify/Product/2";
const slingProductId = "gid://shopify/Product/8708096557231";
const shirtProductId = "gid://shopify/Product/8431587655855";

const line = (productId, isRestricted, hasDiscount, { quantity = 1, amount = "50.0", gift = false } = {}) => ({
  quantity,
  giftMarker: gift ? { value: "true" } : null,
  cost: { subtotalAmount: { amount } },
  discountAllocations: hasDiscount ? [{ discountedAmount: { amount: "5.0" } }] : [],
  merchandise: {
    __typename: "ProductVariant",
    product: { id: productId, noDiscount: isRestricted ? { value: "true" } : null },
  },
});

const giftLine = (productId, options = {}) => line(productId, false, false, { amount: "0.0", ...options });

const input = (enabled, lines, { step = "CHECKOUT_COMPLETION", gift = { enabled: true, minimumSpend: 30000, products: [] } } = {}) => ({
  buyerJourney: { step },
  presentmentCurrencyRate: "1.0",
  shop: { restrictionSettings: { jsonValue: { enabled } }, giftSettings: gift ? { jsonValue: gift } : null },
  cart: { lines },
});

const messages = (result) => result.operations.flatMap((operation) => operation.validationAdd.errors.map((error) => error.message));

describe("no-discount product validation", () => {
  test("blocks checkout when a restricted product's own line has a discount", () => {
    const result = cartValidationsGenerateRun(input(true, [line(restrictedProductId, true, true)]));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].validationAdd.errors[0].target).toBe("$.cart");
  });

  test("allows checkout when the restricted product has no discount on its own line", () => {
    expect(cartValidationsGenerateRun(input(true, [line(restrictedProductId, true, false)]))).toEqual({ operations: [] });
  });

  test("allows checkout when a discount applies only to a non-restricted line", () => {
    const lines = [line(restrictedProductId, true, false), line(normalProductId, false, true)];
    expect(cartValidationsGenerateRun(input(true, lines))).toEqual({ operations: [] });
  });

  test("allows checkout when the feature is disabled", () => {
    expect(cartValidationsGenerateRun(input(false, [line(restrictedProductId, true, true)]))).toEqual({ operations: [] });
  });
});

describe("free gift validation", () => {
  const paid = line(normalProductId, false, false, { amount: "468.0" });

  test("allows one claimed gift on a qualifying order", () => {
    expect(cartValidationsGenerateRun(input(false, [paid, giftLine(slingProductId, { gift: true })]))).toEqual({ operations: [] });
  });

  test("blocks the order from #101910: several free slings added outside the app", () => {
    const lines = [
      paid,
      giftLine(slingProductId),
      giftLine(slingProductId),
      giftLine(slingProductId, { quantity: 2 }),
      giftLine(slingProductId, { gift: true }),
    ];
    expect(messages(cartValidationsGenerateRun(input(false, lines)))).toEqual([
      expect.stringContaining("Only one free gift"),
    ]);
  });

  test("blocks a single gift line with quantity above one", () => {
    const result = cartValidationsGenerateRun(input(false, [paid, giftLine(shirtProductId, { gift: true, quantity: 3 })]));
    expect(messages(result)).toEqual([expect.stringContaining("Only one free gift")]);
  });

  test("blocks a sling and a t-shirt together", () => {
    const result = cartValidationsGenerateRun(input(false, [paid, giftLine(slingProductId, { gift: true }), giftLine(shirtProductId)]));
    expect(messages(result)).toEqual([expect.stringContaining("Only one free gift")]);
  });

  test("blocks a gift without the marker attribute too (product URL or console add)", () => {
    const result = cartValidationsGenerateRun(input(false, [paid, giftLine(slingProductId), giftLine(slingProductId)]));
    expect(messages(result)).toEqual([expect.stringContaining("Only one free gift")]);
  });

  test("blocks a gift on an order under the minimum", () => {
    const cheap = line(normalProductId, false, false, { amount: "29.99" });
    expect(messages(cartValidationsGenerateRun(input(false, [cheap, giftLine(slingProductId, { gift: true })])))).toEqual([
      expect.stringContaining("doesn't qualify"),
    ]);
  });

  test("converts the minimum into the buyer's currency", () => {
    const lines = [line(normalProductId, false, false, { amount: "400.0" }), giftLine(slingProductId, { gift: true })];
    const cad = { ...input(false, lines), presentmentCurrencyRate: "1.4" };
    expect(messages(cartValidationsGenerateRun(cad))).toEqual([expect.stringContaining("doesn't qualify")]);
  });

  test("limits products listed in the gift settings as well", () => {
    const otherGift = "gid://shopify/Product/99";
    const gift = { enabled: true, minimumSpend: 30000, products: [{ productId: otherGift }] };
    const result = cartValidationsGenerateRun(input(false, [paid, giftLine(otherGift, { quantity: 2 })], { gift }));
    expect(messages(result)).toEqual([expect.stringContaining("Only one free gift")]);
  });

  test("blocks gift products while the offer is switched off", () => {
    const gift = { enabled: false, minimumSpend: 30000, products: [] };
    const result = cartValidationsGenerateRun(input(false, [paid, giftLine(slingProductId, { gift: true })], { gift }));
    expect(messages(result)).toEqual([expect.stringContaining("isn't available")]);
  });

  test("reads the small function copy of the settings first", () => {
    const lines = [line(normalProductId, false, false, { amount: "299.99" }), giftLine(slingProductId, { gift: true })];
    const data = input(false, lines, { gift: null });
    data.shop.giftRules = { jsonValue: { enabled: true, minimumSpend: 25000, products: [] } };
    expect(cartValidationsGenerateRun(data)).toEqual({ operations: [] });
  });

  test("doesn't block the order when the settings come back null (over 10,000 bytes)", () => {
    const one = [paid, giftLine(slingProductId, { gift: true })];
    expect(cartValidationsGenerateRun(input(false, one, { gift: null }))).toEqual({ operations: [] });
    const two = [paid, giftLine(slingProductId, { gift: true, quantity: 2 })];
    expect(messages(cartValidationsGenerateRun(input(false, two, { gift: null })))).toEqual([
      expect.stringContaining("Only one free gift"),
    ]);
  });

  test("leaves cart changes alone so buyers can fix their cart", () => {
    const lines = [giftLine(slingProductId), giftLine(slingProductId)];
    expect(cartValidationsGenerateRun(input(false, lines, { step: "CART_INTERACTION" }))).toEqual({ operations: [] });
  });

  test("checks quantity during checkout but the minimum only when placing the order", () => {
    const cheap = line(normalProductId, false, false, { amount: "29.99" });
    const one = [cheap, giftLine(slingProductId, { gift: true })];
    expect(cartValidationsGenerateRun(input(false, one, { step: "CHECKOUT_INTERACTION" }))).toEqual({ operations: [] });
    const two = [cheap, giftLine(slingProductId, { gift: true, quantity: 2 })];
    expect(messages(cartValidationsGenerateRun(input(false, two, { step: "CHECKOUT_INTERACTION" })))).toEqual([
      expect.stringContaining("Only one free gift"),
    ]);
  });
});

describe("price gift (tier) validation", () => {
  const slab = "gid://shopify/Product/10390754525359";
  const gifts = [{ productId: slab }, { productId: slingProductId }, { productId: shirtProductId }];
  const tiers = { enabled: true, shopCurrency: "USD", tiers: [
    { id: "a", minimumSpend: 15000, maximumSpend: 34900, products: gifts },
    { id: "b", minimumSpend: 35000, maximumSpend: null, products: gifts },
  ] };
  const tierInput = (paidAmount, giftProducts, { step = "CHECKOUT_COMPLETION", currency = "USD", rate = "1.0" } = {}) => ({
    buyerJourney: { step },
    presentmentCurrencyRate: rate,
    shop: { restrictionSettings: null, giftSettings: { jsonValue: { enabled: true, minimumSpend: 30000, products: [] } }, tierRules: { jsonValue: tiers } },
    cart: { cost: { subtotalAmount: { currencyCode: currency } }, lines: [
      { ...line(normalProductId, false, false, { amount: String(paidAmount) }), tierMarker: null },
      ...giftProducts.map((id) => ({ ...line(id, false, false, { amount: "40.0" }), tierMarker: { value: "a" } })),
    ] },
  });

  test("$150-$349: one gift passes, two are blocked", () => {
    expect(cartValidationsGenerateRun(tierInput(200, [slingProductId]))).toEqual({ operations: [] });
    expect(messages(cartValidationsGenerateRun(tierInput(200, [slingProductId, shirtProductId])))[0]).toContain("1 free gift");
  });
  test("$350+: two different gifts pass (old one-gift rule no longer applies), three are blocked", () => {
    expect(cartValidationsGenerateRun(tierInput(400, [slingProductId, shirtProductId]))).toEqual({ operations: [] });
    expect(messages(cartValidationsGenerateRun(tierInput(400, [slingProductId, shirtProductId, slab])))[0]).toContain("2 different");
  });
  test("$150-$299 with one gift isn't blocked by the old $300 minimum", () => {
    expect(cartValidationsGenerateRun(tierInput(160, [slingProductId]))).toEqual({ operations: [] });
  });
  test("below $150 a gift is blocked", () => {
    expect(messages(cartValidationsGenerateRun(tierInput(100, [slingProductId])))[0]).toContain("doesn't qualify");
  });
  test("cart changes are never blocked", () => {
    expect(cartValidationsGenerateRun(tierInput(200, [slingProductId, shirtProductId], { step: "CART_INTERACTION" }))).toEqual({ operations: [] });
  });
  test("CAD cart converts the minimum", () => {
    expect(messages(cartValidationsGenerateRun(tierInput(200, [slingProductId], { currency: "CAD", rate: "1.45" })))[0]).toContain("doesn't qualify");
    expect(cartValidationsGenerateRun(tierInput(220, [slingProductId], { currency: "CAD", rate: "1.45" }))).toEqual({ operations: [] });
  });
});

test("price gifts: $349.98 is still Tier 1 (a $349 maximum covers its cents)", () => {
  const gifts = [{ productId: "gid://shopify/Product/8708096557231" }];
  const tiers = { enabled: true, shopCurrency: "USD", tiers: [
    { id: "a", minimumSpend: 15000, maximumSpend: 34900, products: gifts },
    { id: "b", minimumSpend: 35000, maximumSpend: null, products: gifts },
  ] };
  const result = cartValidationsGenerateRun({
    buyerJourney: { step: "CHECKOUT_COMPLETION" }, presentmentCurrencyRate: "1.0",
    shop: { restrictionSettings: null, tierRules: { jsonValue: tiers } },
    cart: { cost: { subtotalAmount: { currencyCode: "USD" } }, lines: [
      { ...line("gid://shopify/Product/2", false, false, { amount: "349.98" }), tierMarker: null },
      { ...line("gid://shopify/Product/8708096557231", false, false, { amount: "40.0" }), tierMarker: { value: "a" } },
    ] },
  });
  expect(result).toEqual({ operations: [] });
});

test("price gifts: the tier follows the total after discounts ($169.98 on sale for $127.50 gets no gift)", () => {
  const gifts = [{ productId: "gid://shopify/Product/8708096557231" }];
  const tiers = { enabled: true, shopCurrency: "USD", tiers: [
    { id: "a", minimumSpend: 15000, maximumSpend: 34900, products: gifts },
    { id: "b", minimumSpend: 35000, maximumSpend: null, products: gifts },
  ] };
  const run = (discount) => cartValidationsGenerateRun({
    buyerJourney: { step: "CHECKOUT_COMPLETION" }, presentmentCurrencyRate: "1.0",
    shop: { restrictionSettings: null, tierRules: { jsonValue: tiers } },
    cart: { cost: { subtotalAmount: { currencyCode: "USD" } }, lines: [
      { ...line("gid://shopify/Product/2", false, false, { amount: "169.98" }), discountAllocations: [{ discountedAmount: { amount: discount } }], tierMarker: null },
      { ...line("gid://shopify/Product/8708096557231", false, false, { amount: "40.0" }), tierMarker: { value: "a" } },
    ] },
  });
  expect(messages(run("42.48"))[0]).toContain("doesn't qualify");
  expect(run("10.00")).toEqual({ operations: [] });
});
