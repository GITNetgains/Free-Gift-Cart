// Live UPS Ground rate for Alaska and Hawaii, priced through the store's own
// UPS account in ShipStation. ShipStation's checkout integration leaves UPS
// Ground out for some carts (e.g. a 13 lb suitcase to Anchorage), even though
// the ShipStation API quotes it, so the app offers it as its own rate.
//
// UPS takes at most 150 lb per package, and ShipStation errors on anything
// heavier. Carts over that are split into packages of up to 150 lb (items are
// never split), each package is quoted, and the quotes are added up.

export const UPS_GROUND_STATES = ["AK", "HI"];
export const UPS_GROUND_SERVICE_NAME = "UPS Ground";
export const UPS_GROUND_SERVICE_CODE = "zion_ups_ground";

const SHIPSTATION_CARRIER = "ups"; // the store's own UPS account ("ups_walleted" quotes nothing to AK/HI)
const SHIPSTATION_SERVICE = "ups_ground";
const FROM_POSTAL_CODE = "61847"; // Zion Cases warehouse, Gifford IL (ShipStation default)
const GRAMS_PER_OUNCE = 28.349523125;
export const MAX_PACKAGE_OUNCES = 150 * 16; // UPS per-package limit
// Shown when ShipStation can't be reached in time. Only used for a cart that
// fits in one package; a flat $75 would badly undercharge a multi-box order.
export const FALLBACK_PRICE_CENTS = 7500;
// Shopify waits up to 10 seconds for a carrier rate; ShipStation usually
// answers in 1-2 s but sometimes takes over 5 s.
const TIMEOUT_MS = 8000;
const FRESH_MS = 6 * 60 * 60 * 1000; // reuse a live quote for 6 hours
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // if ShipStation fails, a quote up to 7 days old beats the flat fallback

type Destination = { country?: string; province?: string; postal_code?: string; city?: string };
export type ShippingItem = { grams: number; quantity: number };
export type UpsGroundPrice =
  | { cents: number; live: boolean; source: string; packages: number[] }
  | { cents: null; live: false; source: string; packages: number[] };

// Live quotes by state + ZIP + ounces. In memory only, so a restart clears it.
const quotes = new Map<string, { cents: number; at: number }>();

export function isUpsGroundDestination(destination?: Destination | null) {
  return destination?.country === "US"
    && UPS_GROUND_STATES.includes(String(destination.province ?? "").toUpperCase());
}

// Shopify sends grams rounded from the product's pounds (13 lb = 5897 g
// = 208.01 oz). Rounding up made that 209 oz, which UPS bills as 14 lb.
const toOunces = (grams: number) => Math.round(grams / GRAMS_PER_OUNCE);

/**
 * Package weights in ounces: every unit goes into the first package it fits
 * (heaviest units first), packages hold up to 150 lb, and a unit is never split.
 */
export function packPackages(items: ShippingItem[]): number[] {
  const units: number[] = [];
  for (const item of items) {
    const ounces = item.grams / GRAMS_PER_OUNCE;
    for (let i = 0; i < Math.max(0, Math.floor(item.quantity)); i++) units.push(ounces);
  }
  units.sort((a, b) => b - a);
  const packages: number[] = [];
  for (const unit of units) {
    const index = packages.findIndex((total) => total + unit <= MAX_PACKAGE_OUNCES);
    if (index === -1) packages.push(unit);
    else packages[index] += unit;
  }
  if (!packages.length) return [1];
  return packages.map((ounces) => Math.max(1, Math.round(ounces)));
}

async function quotePackage(state: string, destination: Destination, ounces: number) {
  const zip = String(destination.postal_code ?? "").slice(0, 5);
  const cacheKey = `${state}|${zip}|${ounces}`;
  const cached = quotes.get(cacheKey);
  if (cached && Date.now() - cached.at < FRESH_MS) return { cents: cached.cents, live: true, source: "cache" };

  const failed = (reason: string) => {
    if (cached && Date.now() - cached.at < STALE_MS) {
      console.error(`[ups-ground] ${reason}; using the last live quote for ${cacheKey}`);
      return { cents: cached.cents, live: false, source: "last-quote" };
    }
    console.error(`[ups-ground] ${reason} for ${cacheKey}`);
    return null;
  };

  if (ounces > MAX_PACKAGE_OUNCES) return failed(`one item weighs ${(ounces / 16).toFixed(1)} lb, over the UPS 150 lb limit`);

  const key = process.env.SHIPSTATION_API_KEY;
  const secret = process.env.SHIPSTATION_API_SECRET;
  if (!key || !secret) return failed("SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET missing");

  try {
    const response = await fetch("https://ssapi.shipstation.com/shipments/getrates", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        carrierCode: SHIPSTATION_CARRIER,
        serviceCode: SHIPSTATION_SERVICE,
        fromPostalCode: FROM_POSTAL_CODE,
        toCountry: "US",
        toState: state,
        toPostalCode: destination.postal_code ?? "",
        toCity: destination.city ?? "",
        weight: { value: ounces, units: "ounces" },
        residential: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const rates = await response.json().catch(() => null);
    const ground = Array.isArray(rates)
      ? rates.find((rate: { serviceCode?: string }) => rate.serviceCode === SHIPSTATION_SERVICE)
      : null;
    if (!ground) return failed(`ShipStation returned no UPS Ground rate (${response.status} ${JSON.stringify(rates).slice(0, 200)})`);
    const dollars = Number(ground.shipmentCost ?? 0) + Number(ground.otherCost ?? 0);
    const cents = Math.round(dollars * 100);
    quotes.set(cacheKey, { cents, at: Date.now() });
    return { cents, live: true, source: "shipstation" };
  } catch (error) {
    return failed(`ShipStation request failed (${error instanceof Error ? error.name : String(error)})`);
  }
}

/**
 * UPS Ground price in cents for the whole cart: the sum of each package's
 * quote (cached or live from ShipStation, else the last known quote). A
 * one-package cart falls back to the flat price; a multi-package cart gets no
 * price (cents: null), so checkout shows ShipStation's own rates instead of a
 * far-too-low one.
 */
export async function upsGroundPriceCents(destination: Destination, items: ShippingItem[]): Promise<UpsGroundPrice> {
  const state = String(destination.province).toUpperCase();
  const packages = packPackages(items);
  // Packages of the same weight cost the same: quote each weight once.
  const weights = [...new Set(packages)];
  const results = new Map(await Promise.all(weights.map(async (ounces) =>
    [ounces, await quotePackage(state, destination, ounces)] as const)));

  if ([...results.values()].some((result) => !result)) {
    if (packages.length === 1 && packages[0] <= MAX_PACKAGE_OUNCES) {
      return { cents: FALLBACK_PRICE_CENTS, live: false, source: "fallback", packages };
    }
    return { cents: null, live: false, source: "no-rate", packages };
  }

  const cents = packages.reduce((sum, ounces) => sum + results.get(ounces)!.cents, 0);
  const all = [...results.values()].map((result) => result!);
  return {
    cents,
    live: all.every((result) => result.live),
    source: [...new Set(all.map((result) => result.source))].join("+"),
    packages,
  };
}
