import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  type CartInput,
  type CartLinesDiscountsGenerateRunResult,
} from "../generated/api";

type GiftSettings = {
  enabled?: boolean;
  minimumSpend?: number;
  products?: Array<{ variantId?: string }>;
};

type RestrictionSettings = {
  enabled?: boolean;
  productIds?: string[];
};

export function cartLinesDiscountsGenerateRun(input: CartInput): CartLinesDiscountsGenerateRunResult {
  const operations: CartLinesDiscountsGenerateRunResult["operations"] = [];
  const restrictionSettings = input.shop.restrictionSettings?.jsonValue as RestrictionSettings | undefined;
  const restrictedProductIds = new Set(restrictionSettings?.productIds || []);
  const hasRestrictedProduct = restrictionSettings?.enabled && input.cart.lines.some((line) =>
    line.merchandise.__typename === "ProductVariant" && restrictedProductIds.has(line.merchandise.product.id));
  const rejectableCodes = hasRestrictedProduct
    ? input.enteredDiscountCodes.filter((discountCode) => discountCode.rejectable).map(({ code }) => ({ code }))
    : [];
  if (rejectableCodes.length > 0) {
    operations.push({
      enteredDiscountCodesReject: {
        codes: rejectableCodes,
        message: "Discount codes are not valid with one or more products in your cart.",
      },
    });
  }

  if (!input.discount.discountClasses.includes(DiscountClass.Product)) return { operations };
  // Discount-owned configuration is the reliable source for a discount
  // function. Keep the shop metafield fallback for discounts created by older
  // app versions while merchants migrate through their next settings save.
  const settings = (input.discount.giftSettings?.jsonValue ??
    input.shop.giftSettings?.jsonValue) as GiftSettings | undefined;
  if (!settings?.enabled || !Array.isArray(settings.products)) return { operations };

  const allowedVariantIds = new Set(settings.products.map((product) => product.variantId).filter(Boolean));
  const paidSubtotalCents = input.cart.lines.reduce((total, line) => {
    if (line.giftMarker?.value === "true") return total;
    return total + Math.round(Number(line.cost.subtotalAmount.amount) * 100);
  }, 0);
  if (paidSubtotalCents < Number(settings.minimumSpend || 0)) return { operations };

  const giftLine = input.cart.lines.find((line) =>
    line.giftMarker?.value === "true" &&
    line.merchandise.__typename === "ProductVariant" &&
    allowedVariantIds.has(line.merchandise.id));
  if (!giftLine) return { operations };

  operations.push({
      productDiscountsAdd: {
        candidates: [{
          message: "Free gift",
          targets: [{ cartLine: { id: giftLine.id, quantity: 1 } }],
          value: { percentage: { value: "100" } },
        }],
        selectionStrategy: ProductDiscountSelectionStrategy.First,
      },
    });
  return { operations };
}
