// Spend-tier gifts ("Price gifts"). Kept apart from the original free gift
// offer (app/routes/app.free-gift.tsx): own settings metafield, own discount
// function (extensions/tiered-gift-discount), own theme embed and own
// `_tier_gift` line attribute.

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

export type GiftTier = {
  id: string;
  // Lowest paid cart subtotal, in shop-currency cents. The tier runs up to the
  // next tier's minimum.
  minimumSpend: number;
  // "one": the shopper picks one of the gifts. "all": every gift is free.
  mode: "one" | "all";
  products: TierGiftProduct[];
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

// Cleans saved or submitted settings: valid ids, whole-dollar minimums,
// unique minimums, tiers sorted low to high.
export function normalizeSettings(raw: Partial<PriceGiftSettings> | undefined | null): PriceGiftSettings {
  const settings = { ...DEFAULT_PRICE_GIFT_SETTINGS, ...(raw || {}) };
  const seenMinimums = new Set<number>();
  const tiers = (Array.isArray(raw?.tiers) ? raw!.tiers : [])
    .slice(0, MAX_TIERS)
    .map((tier) => ({
      id: typeof tier?.id === "string" && /^[a-z0-9]{1,24}$/i.test(tier.id) ? tier.id : newTierId(),
      minimumSpend: Math.max(0, Math.round((Number(tier?.minimumSpend) || 0) / 100) * 100),
      mode: tier?.mode === "all" ? "all" as const : "one" as const,
      products: limitProducts(Array.isArray(tier?.products) ? tier.products : []),
    }))
    .sort((a, b) => a.minimumSpend - b.minimumSpend)
    .filter((tier) => {
      if (seenMinimums.has(tier.minimumSpend)) return false;
      seenMinimums.add(tier.minimumSpend);
      return true;
    });
  return { ...settings, enabled: Boolean(settings.enabled), tiers };
}

// The discount function only needs ids and rules (and a function metafield
// over 10,000 bytes arrives as null), so it gets this small copy.
export function functionSettings(settings: PriceGiftSettings) {
  return JSON.stringify({
    enabled: settings.enabled,
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
