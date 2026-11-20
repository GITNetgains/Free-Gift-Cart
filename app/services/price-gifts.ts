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

export type GiftTier = {
  id: string;
  // Paid cart subtotal range, in dollar cents, both ends included. With no
  // maximum the tier runs up to the next tier's minimum (no limit for the
  // last tier).
  minimumSpend: number;
  maximumSpend?: number | null;
  // "one": the shopper picks one of the gifts. "all": every gift is free
  // (e.g. from $350 both the T-shirt and the Sling).
  mode: "one" | "all";
  // This tier's own gift products (every chosen variant).
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
  // The sale shoppers see in the banner and popup, e.g. "Black Friday Sale",
  // with its dates (YYYY-MM-DD, store time zone, both days included; empty:
  // no limit). Outside the dates the storefront shows nothing and the
  // checkout discount is off.
  saleName: string;
  saleStartDate: string;
  saleEndDate: string;
  // The same dates as UTC instants (start of the first day, end of the last
  // day in the store time zone), set on save for the storefront scripts.
  saleStartsAt?: string | null;
  saleEndsAt?: string | null;
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
  saleName: "",
  saleStartDate: "",
  saleEndDate: "",
};

const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

// A wall clock date in the store time zone (start or end of that day) as a
// UTC ISO string.
export function zonedToUtc(date: string, timeZone: string, endOfDay: boolean) {
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  const offsetAt = (instant: number) => {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(instant).map((part) => [part.type, part.value]));
      return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - instant;
    } catch {
      return 0;
    }
  };
  // Twice, so a day next to a daylight saving change lands right.
  let instant = wall - offsetAt(wall);
  instant = wall - offsetAt(instant);
  return new Date(instant).toISOString();
}

// "Nov 20 – Dec 31, 2026", "Starts Nov 20, 2026", "Ends Dec 31, 2026".
export function saleDatesLabel(start: string, end: string) {
  const format = (date: string, withYear = true) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", ...(withYear ? { year: "numeric" as const } : {}),
  });
  if (start && end) return `${format(start, start.slice(0, 4) !== end.slice(0, 4))} – ${format(end)}`;
  if (start) return `Starts ${format(start)}`;
  if (end) return `Ends ${format(end)}`;
  return "";
}

export function saleDateErrors(settings: Pick<PriceGiftSettings, "saleStartDate" | "saleEndDate">) {
  return settings.saleStartDate && settings.saleEndDate && settings.saleEndDate < settings.saleStartDate
    ? ["The sale end date is before its start date."] : [];
}

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

// A tier's gift products in order, each with its variants.
export function productGroups(products: TierGiftProduct[]) {
  const groups = new Map<string, TierGiftProduct[]>();
  products.forEach((product) => groups.set(product.productId, [...(groups.get(product.productId) || []), product]));
  return [...groups.entries()].map(([productId, variants]) => ({ productId, title: variants[0].productTitle, variants }));
}

// Cleans saved or submitted settings: valid ids, whole-dollar amounts and
// tiers sorted low to high. Each tier keeps its own gifts and its own rule
// (pick one, or all free). Older settings' per-tier "replacements" are dropped.
export function normalizeSettings(raw: Partial<PriceGiftSettings> | undefined | null): PriceGiftSettings {
  const settings = { ...DEFAULT_PRICE_GIFT_SETTINGS, ...(raw || {}) };
  const tiers: GiftTier[] = (Array.isArray(raw?.tiers) ? raw!.tiers : [])
    .slice(0, MAX_TIERS)
    .map((tier) => ({
      id: typeof tier?.id === "string" && /^[a-z0-9]{1,24}$/i.test(tier.id) ? tier.id : newTierId(),
      minimumSpend: Math.max(0, Math.round((Number(tier?.minimumSpend) || 0) / 100) * 100),
      maximumSpend: tier?.maximumSpend === null || tier?.maximumSpend === undefined || String(tier.maximumSpend) === ""
        ? null
        : Math.max(0, Math.round((Number(tier.maximumSpend) || 0) / 100) * 100),
      mode: tier?.mode === "all" ? "all" as const : "one" as const,
      products: limitProducts(Array.isArray(tier?.products) ? tier.products : []),
    }))
    // Stable for equal minimums; the save action refuses those.
    .sort((a, b) => a.minimumSpend - b.minimumSpend);
  return {
    ...settings,
    enabled: Boolean(settings.enabled),
    tiers,
    saleName: typeof settings.saleName === "string" ? settings.saleName.slice(0, 80) : "",
    saleStartDate: isDate(settings.saleStartDate) ? settings.saleStartDate : "",
    saleEndDate: isDate(settings.saleEndDate) ? settings.saleEndDate : "",
  };
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
      maximumSpend: tier.maximumSpend ?? null,
      mode: tier.mode,
      products: tier.products.map(({ productId, variantId }) => ({ productId, variantId })),
    })),
  });
}

export const formatDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en")}`;

// "$120 – $299" / "$300 or more", from the next tier's minimum.
export function tierRange(tiers: GiftTier[], index: number) {
  const tier = tiers[index];
  const next = tiers[index + 1];
  const from = formatDollars(tier.minimumSpend);
  if (tier.maximumSpend != null) return `${from} – ${formatDollars(tier.maximumSpend)}`;
  return next ? `${from} – ${formatDollars(next.minimumSpend - 100)}` : `${from} or more`;
}

// Problems that stop a save: a maximum below its minimum, or ranges that
// overlap the next tier.
export function tierRangeErrors(tiers: GiftTier[]) {
  const errors: string[] = [];
  tiers.forEach((tier, index) => {
    const next = tiers[index + 1];
    if (tier.maximumSpend != null && tier.maximumSpend < tier.minimumSpend) {
      errors.push(`Tier ${index + 1}: the maximum is below the minimum.`);
    }
    if (next && next.minimumSpend === tier.minimumSpend) {
      errors.push(`Tier ${index + 1} and Tier ${index + 2} start at the same amount.`);
    } else if (next && tier.maximumSpend != null && tier.maximumSpend >= next.minimumSpend) {
      errors.push(`Tier ${index + 1} ends at ${formatDollars(tier.maximumSpend)}, inside Tier ${index + 2} (from ${formatDollars(next.minimumSpend)}).`);
    }
  });
  return errors;
}
