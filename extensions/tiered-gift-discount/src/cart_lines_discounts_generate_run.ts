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
  // Optional upper end, included. Empty: until the next tier's minimum.
  maximumSpend?: number | null;
  // "one" / "two": choose distinct products. "all": every gift is free.
  mode: "one" | "two" | "all";
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

// The highest tier whose minimum the cart reaches, unless the cart is past
// that tier's maximum (a gap before the next tier: no gift).
export function activeTier(tiers: Tier[], paidSubtotalCents: number, currencyRate: number) {
  const tier = [...tiers]
    .sort((a, b) => b.minimumSpend - a.minimumSpend)
    .find((candidate) => paidSubtotalCents >= Math.round(candidate.minimumSpend * currencyRate));
  if (!tier) return undefined;
  if (tier.maximumSpend != null && paidSubtotalCents >= Math.round((tier.maximumSpend + 100) * currencyRate)) return undefined;
  return tier;
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
  const orderedTiers = [...settings.tiers].sort((a, b) => a.minimumSpend - b.minimumSpend);
  const tier = activeTier(orderedTiers, paidSubtotalCents, rate);
  if (!tier) return { operations: [] };
  const tierIndex = orderedTiers.findIndex((candidate) => candidate.id === tier.id);

  // A selected gift product allows all its variants, including variants added
  // after settings were saved. Shopify supplies the trusted parent product ID.
  // Tier 2 (pick two): a gift claimed in Tier 1 counts as one of the two and
  // stays free, even when Tier 2 lists other products.
  const pool = tierIndex === 1 ? orderedTiers.slice(0, 2) : [tier];
  const allowedProducts = new Set(pool.flatMap((candidate) => candidate.products.map((product) => product.productId)));
  const discountedProducts = new Set<string>();
  const targets: Array<{ cartLine: { id: string; quantity: number } }> = [];
  for (const line of input.cart.lines) {
    // Any claimed gift line counts, including one claimed in a lower tier,
    // as long as its variant is one of this tier's gifts (e.g. the T-shirt
    // claimed at $150 stays free at $350).
    if (!line.tierMarker?.value || line.merchandise.__typename !== "ProductVariant") continue;
    const productId = line.merchandise.product.id;
    if (!allowedProducts.has(productId) || discountedProducts.has(productId)) continue;
    // One unit per different product. Tier 2 allows two gifts; Tier 1 and
    // later tiers allow one gift per order.
    const limit = tierIndex === 1 ? 2 : 1;
    if (targets.length >= limit) break;
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
