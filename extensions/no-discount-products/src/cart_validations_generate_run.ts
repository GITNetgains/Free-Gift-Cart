import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
} from "../generated/api";

type RestrictionSettings = {
  enabled?: boolean;
};

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const settings = input.shop.restrictionSettings?.jsonValue as RestrictionSettings | undefined;
  if (!settings?.enabled) {
    return { operations: [] };
  }

  const hasRestrictedDiscountedLine = input.cart.lines.some((line) => {
    if (line.merchandise.__typename !== "ProductVariant") return false;
    const isRestricted = line.merchandise.product.noDiscount?.value === "true";
    return isRestricted && line.discountAllocations.length > 0;
  });

  if (!hasRestrictedDiscountedLine) return { operations: [] };

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
