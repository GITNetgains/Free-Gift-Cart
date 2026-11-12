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

function input(paid: string, gifts: Gift[], rate = "1.0"): CartInput {
  return {
    presentmentCurrencyRate: rate,
    discount: { discountClasses: [DiscountClass.Product], tierSettings: { jsonValue: settings } },
    cart: {
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

  test("300+ makes every gift of the tier free", () => {
    const result = cartLinesDiscountsGenerateRun(input("300.00", [
      { id: "g1", tier: "t300", variantId: SLING3.variantId },
      { id: "g2", tier: "t300", variantId: SHIRT.variantId },
    ]));
    expect(targets(result)).toEqual(["g1", "g2"]);
  });

  test("a gift claimed for the lower tier is not free in the higher tier", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("300.00", [{ id: "g1", tier: "t120", variantId: SLING2.variantId }])))).toEqual([]);
  });

  test("a variant from another tier is not free", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("150.00", [{ id: "g1", tier: "t120", variantId: SLING3.variantId }])))).toEqual([]);
  });

  test("thresholds follow the buyer currency rate", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("200.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "2.0")))).toEqual([]);
    expect(targets(cartLinesDiscountsGenerateRun(input("240.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }], "2.0")))).toEqual(["g1"]);
  });

  test("gift lines do not count toward the subtotal", () => {
    expect(targets(cartLinesDiscountsGenerateRun(input("100.00", [{ id: "g1", tier: "t120", variantId: SHIRT.variantId }])))).toEqual([]);
  });
});
