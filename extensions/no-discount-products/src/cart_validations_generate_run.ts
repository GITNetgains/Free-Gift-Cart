import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
} from "../generated/api";

type RestrictionSettings = {
  enabled?: boolean;
  productIds?: string[];
};

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const settings = input.shop.restrictionSettings?.jsonValue as RestrictionSettings | undefined;
  if (!settings?.enabled || !Array.isArray(settings.productIds) || settings.productIds.length === 0) {
    return { operations: [] };
  }

  const restrictedIds = new Set(settings.productIds);
  const hasRestrictedProduct = input.cart.lines.some((line) =>
    line.merchandise.__typename === "ProductVariant" &&
    restrictedIds.has(line.merchandise.product.id));
  const hasAnyDiscount = input.cart.discountApplications.length > 0;

  if (!hasRestrictedProduct || !hasAnyDiscount) return { operations: [] };

  return {
    operations: [{
      validationAdd: {
        errors: [{
          message: "Discounts cannot be applied to one or more products in your cart. Remove the discount to continue.",
          target: "$.cart",
        }],
      },
    }],
  };
}
