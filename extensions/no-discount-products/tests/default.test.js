import { describe, expect, test } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";

const restrictedProductId = "gid://shopify/Product/1";
const normalProductId = "gid://shopify/Product/2";

const line = (productId, isRestricted, hasDiscount) => ({
  discountAllocations: hasDiscount ? [{ discountedAmount: { amount: "5.0" } }] : [],
  merchandise: {
    __typename: "ProductVariant",
    product: { id: productId, noDiscount: isRestricted ? { value: "true" } : null },
  },
});

const input = (enabled, lines) => ({
  shop: { restrictionSettings: { jsonValue: { enabled } } },
  cart: { lines },
});

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
