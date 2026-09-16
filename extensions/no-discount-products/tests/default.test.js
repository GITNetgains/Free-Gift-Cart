import { describe, expect, test } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";

const restrictedProductId = "gid://shopify/Product/1";
const input = (hasDiscount) => ({
  shop: { restrictionSettings: { jsonValue: { enabled: true, productIds: [restrictedProductId] } } },
  cart: {
    discountApplications: hasDiscount ? [{ allocationMethod: "ACROSS" }] : [],
    lines: [{
      merchandise: { __typename: "ProductVariant", product: { id: restrictedProductId } },
    }],
  },
});

describe("no-discount product validation", () => {
  test("blocks checkout when a restricted product receives a discount", () => {
    const result = cartValidationsGenerateRun(input(true));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].validationAdd.errors[0].target).toBe("$.cart");
  });

  test("allows checkout when a restricted product has no discount", () => {
    expect(cartValidationsGenerateRun(input(false))).toEqual({ operations: [] });
  });
});
