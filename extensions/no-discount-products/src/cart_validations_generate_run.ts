import {
  BuyerJourneyStep,
  type CartValidationsGenerateRunInput,
  type CartValidationsGenerateRunResult,
} from "../generated/api";

type RestrictionSettings = {
  enabled?: boolean;
};

type GiftSettings = {
  enabled?: boolean;
  minimumSpend?: number;
  products?: Array<{ productId?: string }>;
};

type ValidationError = { message: string; target: string };

// Free gift products are $0 variants, so they are free whether or not the
// free-gift-discount applies. Anyone can add them to a cart outside the app
// (the product URL, /cart/add.js from the console, a cart permalink), so the
// limit is enforced here, on the server, rather than only in the storefront.
// These two are always limited, even if they're dropped from the gift settings.
const ALWAYS_GIFT_PRODUCT_IDS = [
  "gid://shopify/Product/8708096557231",
  "gid://shopify/Product/8431587655855",
];

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const errors = [...noDiscountErrors(input), ...freeGiftErrors(input)];
  if (!errors.length) return { operations: [] };
  return { operations: [{ validationAdd: { errors } }] };
}

function noDiscountErrors(input: CartValidationsGenerateRunInput): ValidationError[] {
  const settings = input.shop.restrictionSettings?.jsonValue as RestrictionSettings | undefined;
  if (!settings?.enabled) return [];

  const hasRestrictedDiscountedLine = input.cart.lines.some((line) => {
    if (line.merchandise.__typename !== "ProductVariant") return false;
    const isRestricted = line.merchandise.product.noDiscount?.value === "true";
    return isRestricted && line.discountAllocations.length > 0;
  });
  if (!hasRestrictedDiscountedLine) return [];

  return [{
    message: "Discounts cannot be applied to one or more products in your cart. Remove the discount to continue.",
    target: "$.cart",
  }];
}

function freeGiftErrors(input: CartValidationsGenerateRunInput): ValidationError[] {
  // Cart changes are left alone, so a buyer can still remove a paid item (the
  // storefront then takes the gift out). Checkout is where the order is held.
  const step = input.buyerJourney.step;
  if (step === BuyerJourneyStep.CartInteraction) return [];

  const settings = input.shop.giftSettings?.jsonValue as GiftSettings | undefined;
  const giftProductIds = new Set([
    ...ALWAYS_GIFT_PRODUCT_IDS,
    ...(settings?.products || []).map((product) => product.productId).filter((id): id is string => Boolean(id)),
  ]);
  const isGiftProduct = (line: CartValidationsGenerateRunInput["cart"]["lines"][number]) =>
    line.merchandise.__typename === "ProductVariant" && giftProductIds.has(line.merchandise.product.id);

  const giftLines = input.cart.lines.filter(isGiftProduct);
  const giftQuantity = giftLines.reduce((total, line) => total + line.quantity, 0);
  if (!giftQuantity) return [];

  const errors: ValidationError[] = [];
  if (giftQuantity > 1) {
    errors.push({
      message: "Only one free gift is allowed per order. Remove the extra free items to continue.",
      target: "$.cart",
    });
  }

  // Same rule as the free-gift-discount: paid lines, before discounts, must
  // reach the minimum (saved in shop-currency cents). Checked when the order
  // is placed, so buyers can still change their cart in checkout first.
  if (step === BuyerJourneyStep.CheckoutCompletion || step == null) {
    const paidSubtotalCents = input.cart.lines.reduce((total, line) => {
      if (isGiftProduct(line) || line.giftMarker?.value === "true") return total;
      return total + Math.round(Number(line.cost.subtotalAmount.amount) * 100);
    }, 0);
    const currencyRate = Number(input.presentmentCurrencyRate) || 1;
    const thresholdCents = settings?.enabled
      ? Math.round(Number(settings.minimumSpend || 0) * currencyRate)
      : Infinity;
    if (paidSubtotalCents < thresholdCents) {
      errors.push({
        message: settings?.enabled
          ? "Your order doesn't qualify for the free gift yet. Remove the free gift or add more items to continue."
          : "The free gift offer isn't available right now. Remove the free gift to continue.",
        target: "$.cart",
      });
    }
  }
  return errors;
}
