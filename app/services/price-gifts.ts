// Spend-tier gifts ("Price gifts"). Kept apart from the original free gift
// offer (app/routes/app.free-gift.tsx): own settings metafield, own discount
// function (extensions/tiered-gift-discount) and own `_tier_gift` line
// attribute. On the storefront the Free Gift App (Master) embed shows the
// same popup, run by tiered-gift-popup.js, while these settings are on.

// Stores that see the feature. Others get no menu link, no page and no
// settings, so the storefront embed and the discount stay idle there.
export const PRICE_GIFT_SHOPS = ["netgains10.myshopify.com"];
export const priceGiftsEnabledFor = (shop: string) => PRICE_GIFT_SHOPS.includes(shop);

export const PRICE_GIFT_NAMESPACE = "tiered_gift";
export const MAX_TIERS = 5;
export const MAX_TIER_PRODUCTS = 5;

export type TierGiftProduct = {
  productId: string;
  productTitle: string;
  productHandle?: string;
  variantId: string;
  variantTitle: string;
  sku?: string;
  imageUrl: string;
  price: string;
  availableForSale?: boolean;
  inventoryQuantity?: number;
  inventoryTracked?: boolean;
  optionNames?: string[];
  optionValues?: string[];
};

// In tiers above the first, a first-tier gift product can be swapped for
// another product (e.g. Sling 2.0 -> Sling 3.0).
export type TierReplacement = { fromProductId: string; products: TierGiftProduct[] };

export type GiftTier = {
  id: string;
  // Lowest paid cart subtotal, in shop-currency cents. The tier runs up to the
  // next tier's minimum.
  minimumSpend: number;
  // "one": the shopper picks one of the gifts. "all": every gift is free.
  mode: "one" | "all";
  // First tier: the chosen gifts. Higher tiers: computed from the first
  // tier's gifts with `replacements` applied.
  products: TierGiftProduct[];
  replacements: TierReplacement[];
};

export type PriceGiftSettings = {
  enabled: boolean;
  heading: string;
  subheading: string;
  buttonLabel: string;
  successMessage: string;
  backgroundColor: string;
  textColor: string;
  buttonColor: string;
  buttonTextColor: string;
  overlayColor: string;
  tiers: GiftTier[];
  discountId?: string;
  // The store currency at the last save. Tier minimums are US dollars; only
  // a USD store converts them to the buyer's currency.
  shopCurrency?: string;
};

export const DEFAULT_PRICE_GIFT_SETTINGS: PriceGiftSettings = {
  enabled: false,
  heading: "You've unlocked a free gift!",
  subheading: "Your order qualifies for the gift below.",
  buttonLabel: "Claim my free gift",
  successMessage: "Your free gift was added to the cart.",
  backgroundColor: "#FFFFFF",
  textColor: "#111111",
  buttonColor: "#111111",
  buttonTextColor: "#FFFFFF",
  overlayColor: "#000000B3",
  tiers: [],
};

export const newTierId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function limitProducts(products: TierGiftProduct[]) {
  const productIds = new Set<string>();
  const variantIds = new Set<string>();
  return products.filter((product) => {
    if (!product?.variantId || !product.productId) return false;
    if (!productIds.has(product.productId)) {
      if (productIds.size >= MAX_TIER_PRODUCTS) return false;
      productIds.add(product.productId);
    }
    if (variantIds.has(product.variantId)) return false;
    variantIds.add(product.variantId);
    return true;
  });
}

export const countProducts = (products: TierGiftProduct[]) => new Set(products.map((product) => product.productId)).size;

// First-tier gift products in order, each with its variants.
export function baseProductGroups(products: TierGiftProduct[]) {
  const groups = new Map<string, TierGiftProduct[]>();
  products.forEach((product) => groups.set(product.productId, [...(groups.get(product.productId) || []), product]));
  return [...groups.entries()].map(([productId, variants]) => ({ productId, title: variants[0].productTitle, variants }));
}

// Cleans saved or submitted settings: valid ids, whole-dollar minimums,
// unique minimums, tiers sorted low to high, and higher tiers' gifts rebuilt
// from the first tier plus replacements.
export function normalizeSettings(raw: Partial<PriceGiftSettings> | undefined | null): PriceGiftSettings {
  const settings = { ...DEFAULT_PRICE_GIFT_SETTINGS, ...(raw || {}) };
  const tiers = (Array.isArray(raw?.tiers) ? raw!.tiers : [])
    .slice(0, MAX_TIERS)
    .map((tier) => ({
      id: typeof tier?.id === "string" && /^[a-z0-9]{1,24}$/i.test(tier.id) ? tier.id : newTierId(),
      minimumSpend: Math.max(0, Math.round((Number(tier?.minimumSpend) || 0) / 100) * 100),
      // One gift per order in every tier.
      mode: "one" as const,
      products: limitProducts(Array.isArray(tier?.products) ? tier.products : []),
      replacements: (Array.isArray(tier?.replacements) ? tier.replacements : [])
        .filter((replacement) => typeof replacement?.fromProductId === "string")
        .map((replacement) => ({
          fromProductId: replacement.fromProductId,
          products: limitProducts(Array.isArray(replacement.products) ? replacement.products : [])
            .filter((product, _, all) => product.productId === all[0].productId),
        }))
        .filter((replacement) => replacement.products.length > 0),
    }))
    // Stable for equal minimums; the save action refuses those.
    .sort((a, b) => a.minimumSpend - b.minimumSpend);

  const base = tiers[0];
  if (base) {
    base.replacements = [];
    const groups = baseProductGroups(base.products);
    tiers.slice(1).forEach((tier) => {
      tier.replacements = tier.replacements.filter((replacement, index, all) =>
        groups.some((group) => group.productId === replacement.fromProductId) &&
        all.findIndex((item) => item.fromProductId === replacement.fromProductId) === index);
      tier.products = limitProducts(groups.flatMap((group) =>
        tier.replacements.find((replacement) => replacement.fromProductId === group.productId)?.products || group.variants));
    });
  }
  return { ...settings, enabled: Boolean(settings.enabled), tiers };
}

// The discount function only needs ids and rules (and a function metafield
// over 10,000 bytes arrives as null), so it gets this small copy.
export function functionSettings(settings: PriceGiftSettings) {
  return JSON.stringify({
    enabled: settings.enabled,
    shopCurrency: settings.shopCurrency,
    tiers: settings.tiers.map((tier) => ({
      id: tier.id,
      minimumSpend: tier.minimumSpend,
      mode: tier.mode,
      products: tier.products.map(({ productId, variantId }) => ({ productId, variantId })),
    })),
  });
}

export const formatDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en")}`;

// "$120 – $299" / "$300 or more", from the next tier's minimum.
export function tierRange(tiers: GiftTier[], index: number) {
  const next = tiers[index + 1];
  const from = formatDollars(tiers[index].minimumSpend);
  return next ? `${from} – ${formatDollars(next.minimumSpend - 100)}` : `${from} or more`;
}
