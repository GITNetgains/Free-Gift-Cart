import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  type CartInput,
  type CartLinesDiscountsGenerateRunResult,
} from "../generated/api";

// Spend-based gift tiers ("Price gifts" in the app, app/routes/app.price-gifts.tsx).
// Separate from the original free-gift-discount: its own discount, its own
// settings and its own `_tier_gift` line attribute, so neither offer touches
// the other's lines.
type Tier = {
  id: string;
  // Lowest paid subtotal for this tier, in shop-currency cents. A tier runs
  // up to the next tier's minimum.
  minimumSpend: number;
  // "one": the shopper picks one gift. "all": every gift product is free.
  mode: "one" | "all";
  products: Array<{ productId: string; variantId: string }>;
};
// shopCurrency: the store's currency when the settings were saved.
type TierSettings = { enabled?: boolean; shopCurrency?: string; tiers?: Tier[] };

// Tier minimums are US dollars, as the admin page shows them. A USD cart
// compares directly; a USD store converts to the buyer's currency with the
// presentment rate. Otherwise (e.g. an INR store showing "$") the numbers
// compare as they are, matching what the shopper sees.
export function thresholdRate(cartCurrency: string | undefined, shopCurrency: string | undefined, presentmentRate: number) {
  if (cartCurrency === "USD") return 1;
  if (shopCurrency === "USD") return presentmentRate || 1;
  return 1;
}

export function activeTier(tiers: Tier[], paidSubtotalCents: number, currencyRate: number) {
  return [...tiers]
    .sort((a, b) => b.minimumSpend - a.minimumSpend)
    .find((tier) => paidSubtotalCents >= Math.round(tier.minimumSpend * currencyRate));
}

export function cartLinesDiscountsGenerateRun(input: CartInput): CartLinesDiscountsGenerateRunResult {
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) return { operations: [] };
  const settings = input.discount.tierSettings?.jsonValue as TierSettings | undefined;
  if (!settings?.enabled || !Array.isArray(settings.tiers) || settings.tiers.length === 0) return { operations: [] };

  const isGift = (line: CartInput["cart"]["lines"][number]) =>
    Boolean(line.tierMarker?.value) || line.oldGiftMarker?.value === "true";
  const paidSubtotalCents = input.cart.lines.reduce((total, line) =>
    isGift(line) ? total : total + Math.round(Number(line.cost.subtotalAmount.amount) * 100), 0);
  const rate = thresholdRate(input.cart.cost.subtotalAmount.currencyCode, settings.shopCurrency, Number(input.presentmentCurrencyRate) || 1);
  const tier = activeTier(settings.tiers, paidSubtotalCents, rate);
  if (!tier) return { operations: [] };

  const productByVariant = new Map(tier.products.map((product) => [product.variantId, product.productId]));
  const discountedProducts = new Set<string>();
  const targets: Array<{ cartLine: { id: string; quantity: number } }> = [];
  for (const line of input.cart.lines) {
    if (line.tierMarker?.value !== tier.id || line.merchandise.__typename !== "ProductVariant") continue;
    const productId = productByVariant.get(line.merchandise.id);
    if (!productId || discountedProducts.has(productId)) continue;
    if (tier.mode === "one" && targets.length >= 1) break;
    discountedProducts.add(productId);
    targets.push({ cartLine: { id: line.id, quantity: 1 } });
  }
  if (targets.length === 0) return { operations: [] };

  return {
    operations: [{
      productDiscountsAdd: {
        candidates: [{
          message: "Free gift",
          targets,
          value: { percentage: { value: "100" } },
        }],
        selectionStrategy: ProductDiscountSelectionStrategy.First,
      },
    }],
  };
}
