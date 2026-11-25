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
  // Price gifts (spend tiers) replace the original free gift while they are
  // on, so only their rules apply then.
  const tiers = tierSettings(input);
  const giftErrors = tiers ? tierGiftErrors(input, tiers) : hasTierGiftLine(input) ? [] : freeGiftErrors(input);
  const errors = [...noDiscountErrors(input), ...giftErrors];
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

// ---- Price gifts (app/routes/app.price-gifts.tsx, tiered-gift-discount) ----
type Tier = { id?: string; minimumSpend?: number; maximumSpend?: number | null; products?: Array<{ productId?: string }> };
type TierSettings = { enabled?: boolean; shopCurrency?: string; tiers?: Tier[] };
type Line = CartValidationsGenerateRunInput["cart"]["lines"][number];

// The app saves a small copy for functions (the full settings come back null
// past 10,000 bytes). Off or unreadable: undefined.
function tierSettings(input: CartValidationsGenerateRunInput): TierSettings | undefined {
  const settings = (input.shop.tierRules?.jsonValue ?? input.shop.tierSettings?.jsonValue) as TierSettings | undefined;
  return settings?.enabled && Array.isArray(settings.tiers) && settings.tiers.length > 0 ? settings : undefined;
}

// Unreadable tier settings with tier gifts in the cart: the old free gift
// rules don't describe these lines, so they don't block the order.
function hasTierGiftLine(input: CartValidationsGenerateRunInput) {
  return input.cart.lines.some((line) => Boolean(line.tierMarker?.value));
}

// Same tier rule as the tiered-gift-discount function: paid lines (gift lines
// left out) against the tier minimums in US dollars, converted for a USD store
// selling in another currency. Tier 1 allows 1 gift, Tier 2 allows 2, below
// Tier 1 (or between a maximum and the next tier) none. A gift line the
// discount can't make free would otherwise be charged at full price, e.g. a
// cart that reached $350, claimed two gifts and dropped back before checkout.
function tierGiftErrors(input: CartValidationsGenerateRunInput, settings: TierSettings): ValidationError[] {
  if (input.buyerJourney.step === BuyerJourneyStep.CartInteraction) return [];
  const tiers = [...(settings.tiers || [])].sort((a, b) => Number(a.minimumSpend || 0) - Number(b.minimumSpend || 0));
  const giftProductIds = new Set(tiers.flatMap((tier) => (tier.products || []).map((product) => product.productId).filter(Boolean)));
  const productId = (line: Line) => line.merchandise.__typename === "ProductVariant" ? line.merchandise.product.id : "";
  // Claimed gifts carry _tier_gift. A gift product line at $0 without it was
  // added outside the app (old $0 gift variants) and counts too.
  const isGift = (line: Line) => Boolean(line.tierMarker?.value) || line.giftMarker?.value === "true"
    || (giftProductIds.has(productId(line)) && Number(line.cost.subtotalAmount.amount) === 0);
  const giftLines = input.cart.lines.filter(isGift);
  const giftQuantity = giftLines.reduce((total, line) => total + line.quantity, 0);
  if (!giftQuantity) return [];

  // After discounts: each paid line less every discount allocated to it
  // (sale prices, discount codes, order discounts), as in the cart popup.
  const paidSubtotalCents = Math.max(0, input.cart.lines.reduce((total, line) => {
    if (isGift(line)) return total;
    const discounts = line.discountAllocations.reduce((sum, allocation) => sum + Number(allocation.discountedAmount.amount), 0);
    return total + Math.round((Number(line.cost.subtotalAmount.amount) - discounts) * 100);
  }, 0));
  const cartCurrency = input.cart.cost?.subtotalAmount?.currencyCode;
  const rate = cartCurrency === "USD" ? 1 : settings.shopCurrency === "USD" ? Number(input.presentmentCurrencyRate) || 1 : 1;
  const reached = tiers.reduce((index, tier, tierIndex) =>
    paidSubtotalCents >= Math.round(Number(tier.minimumSpend || 0) * rate) ? tierIndex : index, -1);
  const tier = tiers[reached];
  const pastMaximum = tier?.maximumSpend != null && paidSubtotalCents >= Math.round((Number(tier.maximumSpend) + 100) * rate);
  const allowed = !tier || pastMaximum ? 0 : reached === 1 ? 2 : 1;
  const distinctProducts = new Set(giftLines.map(productId)).size;
  if (giftQuantity <= allowed && distinctProducts === giftQuantity) return [];

  return [{
    message: allowed === 0
      ? "Your order doesn't qualify for a free gift yet. Remove the free gift or add more items to continue."
      : allowed === 1
        ? "Your order qualifies for 1 free gift. Remove the extra free gift to continue."
        : "Your order qualifies for 2 different free gifts. Remove the extra free gifts to continue.",
    target: "$.cart",
  }];
}

function freeGiftErrors(input: CartValidationsGenerateRunInput): ValidationError[] {
  // Cart changes are left alone, so a buyer can still remove a paid item (the
  // storefront then takes the gift out). Checkout is where the order is held.
  const step = input.buyerJourney.step;
  if (step === BuyerJourneyStep.CartInteraction) return [];

  // The full settings come back null once they pass 10,000 bytes, so the app
  // also saves a small copy for functions. Shops not saved since read the old one.
  const settings = (input.shop.giftRules?.jsonValue ??
    input.shop.giftSettings?.jsonValue) as GiftSettings | undefined;
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
  // Settings that can't be read say nothing about the offer, so the order
  // isn't blocked on them (the one-gift limit above still holds).
  if (settings && (step === BuyerJourneyStep.CheckoutCompletion || step == null)) {
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
