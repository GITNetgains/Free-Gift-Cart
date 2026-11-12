import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run";
import { DiscountClass, type CartInput } from "../generated/api";

const SLING2 = { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/11" };
const SHIRT = { productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/21" };
const SLING3 = { productId: "gid://shopify/Product/3", variantId: "gid://shopify/ProductVariant/31" };

const settings = {
  enabled: true,
  tiers: [
    { id: "t120", minimumSpend: 12000, mode: "one", products: [SLING2, SHIRT] },
    { id: "t300", minimumSpend: 30000, mode: "all", products: [SLING3, SHIRT] },
  ],
};

type Gift = { id: string; tier: string; variantId: string };

function input(paid: string, gifts: Gift[], rate = "1.0", cartCurrency = "USD", shopCurrency = "USD"): CartInput {
  return {
    presentmentCurrencyRate: rate,
    discount: { discountClasses: [DiscountClass.Product], tierSettings: { jsonValue: { ...settings, shopCurrency } } },
    cart: {
      cost: { subtotalAmount: { currencyCode: cartCurrency } },
      lines: [
        { id: "paid", quantity: 1, tierMarker: null, oldGiftMarker: null,
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/999", product: { id: "gid://shopify/Product/999" } },
          cost: { subtotalAmount: { amount: paid } } },
        ...gifts.map((gift) => ({
          id: gift.id, quantity: 1, tierMarker: { value: gift.tier }, oldGiftMarker: null,
          merchandise: { __typename: "ProductVariant", id: gift.variantId, product: { id: "x" } },
          cost: { subtotalAmount: { amount: "50.00" } },
        })),
      ],
    },
  } as unknown as CartInput;
}

const targets = (result: ReturnType<typeof cartLinesDiscountsGenerateRun>) =>
  result.operations.flatMap((op) => op.productDiscountsAdd?.candidates[0].targets.map((t) => t.cartLine?.id ?? "") ?? []);

describe("tiered gift discount", () => {
  test("below the first tier nothing is free", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("119.99", [{ id: "g1", tier: "t120", variantId: SLING2.variantId }])))).toEqual([]);
  });

  test("120-299 makes one chosen gift free", () => {
    const result = cartLinesDiscountsGenerateRun(input("150.00", [
      { id: "g1", tier: "t120", variantId: SHIRT.variantId },
      { id: "g2", tier: "t120", variantId: SLING2.variantId },
    ]));
    expect(targets(result)).toEqual(["g1"]);
  });

  test("300+ makes only one gift free, even if the tier was saved as all", () => {
    const result = cartLinesDiscountsGenerateRun(input("300.00", [
      { id: "g1", tier: "t300", variantId: SLING3.variantId },
      { id: "g2", tier: "t300", variantId: SHIRT.variantId },
    ]));
    expect(targets(result)).toEqual(["g1"]);
  });

  test("a gift claimed for the lower tier is not free in the higher tier", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("300.00", [{ id: "g1", tier: "t120", variantId: SLING2.variantId }])))).toEqual([]);
  });

  test("a variant from another tier is not free", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("150.00", [{ id: "g1", tier: "t120", variantId: SLING3.variantId }])))).toEqual([]);
  });

  test("a USD store converts thresholds to the buyer currency", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("200.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "2.0", "EUR")))).toEqual([]);
    expect(targets(cartLinesDiscountsGenerateRun(input("240.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "2.0", "EUR")))).toEqual(["g1"]);
  });

  test("an INR store with a USD cart compares dollars directly", () => {
    // presentment rate INR -> USD is tiny; converting would make $120 about $1.4.
    expect(targets(cartLinesDiscountsGenerateRun(input("17.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "0.012", "USD", "INR")))).toEqual([]);
    expect(targets(cartLinesDiscountsGenerateRun(input("120.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "0.012", "USD", "INR")))).toEqual(["g1"]);
  });

  test("an INR store with an INR cart compares the numbers as shown", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("119.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "1.0", "INR", "INR")))).toEqual([]);
    expect(targets(cartLinesDiscountsGenerateRun(input("120.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "1.0", "INR", "INR")))).toEqual(["g1"]);
  });

  test("a tier stops at its maximum: a gap before the next tier gives nothing", () => {
    // Tier 1 $120 – $200, Tier 2 from $300.
    const withMax = (paid: string) => {
      const data = input(paid, [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }]);
      data.discount.tierSettings = { jsonValue: {
        ...settings, shopCurrency: "USD",
        tiers: [{ ...settings.tiers[0], maximumSpend: 20000 }, settings.tiers[1]],
      } };
      return data;
    };
    expect(targets(cartLinesDiscountsGenerateRun(withMax("200.00")))).toEqual(["g1"]);
    expect(targets(cartLinesDiscountsGenerateRun(withMax("250.00")))).toEqual([]);
  });

  test("gift lines do not count toward the subtotal", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("100.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }])))).toEqual([]);
  });
});
