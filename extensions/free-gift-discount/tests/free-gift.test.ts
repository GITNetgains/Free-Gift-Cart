import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run";
import { DiscountClass, type CartInput } from "../generated/api";

const variantId = "gid://shopify/ProductVariant/123";

function input(amount = "100.00", allowedId = variantId, presentmentCurrencyRate = "1.0"): CartInput {
  return {
    presentmentCurrencyRate,
    enteredDiscountCodes: [],
    discount: { discountClasses: [DiscountClass.Product] },
    shop: {
      giftSettings: {
        jsonValue: {
          enabled: true,
          minimumSpend: 5000,
          products: [{ variantId: allowedId }],
        },
      },
    },
    cart: {
      lines: [
        {
          id: "paid-line",
          quantity: 1,
          giftMarker: null,
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/999" },
          cost: { subtotalAmount: { amount } },
        },
        {
          id: "gift-line",
          quantity: 1,
          giftMarker: { value: "true" },
          merchandise: { __typename: "ProductVariant", id: variantId },
          cost: { subtotalAmount: { amount: "20.00" } },
        },
      ],
    },
  } as unknown as CartInput;
}

function restrictedProductWithCode(): CartInput {
  const data = input();
  data.enteredDiscountCodes = [{ code: "TEST", rejectable: true }];
  data.shop.restrictionSettings = {
    jsonValue: { enabled: true, productIds: ["gid://shopify/Product/1"] },
  };
  data.cart.lines[0].merchandise = {
    __typename: "ProductVariant",
    id: "gid://shopify/ProductVariant/999",
    product: { id: "gid://shopify/Product/1" },
  };
  return data;
}

function configuredVariantsInput(allowedIds: string[], giftId: string, markedAsGift = true): CartInput {
  const data = input();
  data.shop.giftSettings!.jsonValue = {
    enabled: true,
    minimumSpend: 5000,
    products: allowedIds.map((variantId) => ({ variantId })),
  };
  const giftLine = data.cart.lines[1];
  giftLine.giftMarker = markedAsGift ? { value: "true" } : null;
  giftLine.merchandise = {
    __typename: "ProductVariant",
    id: giftId,
    product: { id: "gid://shopify/Product/2" },
  };
  return data;
}

describe("free gift discount", () => {
  test("discounts one configured gift when threshold is met", () => {
    const result = cartLinesDiscountsGenerateRun(input());
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      productDiscountsAdd: {
        candidates: [{
          targets: [{ cartLine: { id: "gift-line", quantity: 1 } }],
          value: { percentage: { value: "100" } },
        }],
      },
    });
  });

  test("does not discount below the threshold", () => {
    expect(cartLinesDiscountsGenerateRun(input("49.99")).operations).toEqual([]);
  });

  test("converts the threshold into the buyer's currency", () => {
    // $50 USD threshold at 1.4 CAD per USD needs CA$70.
    expect(cartLinesDiscountsGenerateRun(input("69.99", variantId, "1.4")).operations).toEqual([]);
    expect(cartLinesDiscountsGenerateRun(input("70.00", variantId, "1.4")).operations).toHaveLength(1);
  });

  test("rejects an unconfigured gift variant", () => {
    expect(cartLinesDiscountsGenerateRun(input("100.00", "gid://shopify/ProductVariant/456")).operations).toEqual([]);
  });

  test("accepts a gift from multiple configured products", () => {
    const secondGift = "gid://shopify/ProductVariant/456";
    const result = cartLinesDiscountsGenerateRun(configuredVariantsInput([variantId, secondGift], secondGift));
    expect(result.operations).toHaveLength(1);
  });

  test("does not discount a configured product bought normally", () => {
    const result = cartLinesDiscountsGenerateRun(configuredVariantsInput([variantId], variantId, false));
    expect(result.operations).toEqual([]);
  });

  test("rejects entered discount codes when a restricted product is in the cart", () => {
    const result = cartLinesDiscountsGenerateRun(restrictedProductWithCode());
    expect(result.operations).toContainEqual({
      enteredDiscountCodesReject: {
        codes: [{ code: "TEST" }],
        message: "Discount codes are not valid with one or more products in your cart.",
      },
    });
  });
});
