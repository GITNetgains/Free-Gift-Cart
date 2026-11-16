// Live UPS Ground rate for Alaska and Hawaii, priced through the store's own
// UPS account in ShipStation. ShipStation's checkout integration leaves UPS
// Ground out for some carts (e.g. a 13 lb suitcase to Anchorage), even though
// the ShipStation API quotes it, so the app offers it as its own rate.

export const UPS_GROUND_STATES = ["AK", "HI"];
export const UPS_GROUND_SERVICE_NAME = "UPS Ground";
export const UPS_GROUND_SERVICE_CODE = "zion_ups_ground";

const SHIPSTATION_CARRIER = "ups"; // the store's own UPS account ("ups_walleted" quotes nothing to AK/HI)
const SHIPSTATION_SERVICE = "ups_ground";
const FROM_POSTAL_CODE = "61847"; // Zion Cases warehouse, Gifford IL (ShipStation default)
export const FALLBACK_PRICE_CENTS = 7500; // shown when ShipStation can't be reached in time
// Shopify waits up to 10 seconds for a carrier rate; ShipStation usually
// answers in 1-2 s but sometimes takes over 5 s.
const TIMEOUT_MS = 8000;
const FRESH_MS = 6 * 60 * 60 * 1000; // reuse a live quote for 6 hours
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // if ShipStation fails, a quote up to 7 days old beats the flat fallback

type Destination = { country?: string; province?: string; postal_code?: string; city?: string };

// Live quotes by state + ZIP + ounces. In memory only, so a restart clears it.
const quotes = new Map<string, { cents: number; at: number }>();

export function isUpsGroundDestination(destination?: Destination | null) {
  return destination?.country === "US"
    && UPS_GROUND_STATES.includes(String(destination.province ?? "").toUpperCase());
}

/** UPS Ground price in cents: cached or live from ShipStation, else the last known quote, else the fallback. */
export async function upsGroundPriceCents(destination: Destination, grams: number): Promise<{ cents: number; live: boolean; source: string }> {
  // Shopify sends grams rounded from the product's pounds (13 lb = 5897 g
  // = 208.01 oz). Rounding up made that 209 oz, which UPS bills as 14 lb.
  const ounces = Math.max(1, Math.round(grams / 28.349523125));
  const state = String(destination.province).toUpperCase();
  const zip = String(destination.postal_code ?? "").slice(0, 5);
  const cacheKey = `${state}|${zip}|${ounces}`;
  const cached = quotes.get(cacheKey);
  if (cached && Date.now() - cached.at < FRESH_MS) return { cents: cached.cents, live: true, source: "cache" };

  const fallback = (reason: string) => {
    if (cached && Date.now() - cached.at < STALE_MS) {
      console.error(`[ups-ground] ${reason}; using the last live quote for ${cacheKey}`);
      return { cents: cached.cents, live: false, source: "last-quote" };
    }
    console.error(`[ups-ground] ${reason}; using the fallback price`);
    return { cents: FALLBACK_PRICE_CENTS, live: false, source: "fallback" };
  };

  const key = process.env.SHIPSTATION_API_KEY;
  const secret = process.env.SHIPSTATION_API_SECRET;
  if (!key || !secret) return fallback("SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET missing");

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
    if (!ground) return fallback(`ShipStation returned no UPS Ground rate (${response.status} ${JSON.stringify(rates).slice(0, 200)})`);
    const dollars = Number(ground.shipmentCost ?? 0) + Number(ground.otherCost ?? 0);
    const cents = Math.round(dollars * 100);
    quotes.set(cacheKey, { cents, at: Date.now() });
    return { cents, live: true, source: "shipstation" };
  } catch (error) {
    return fallback(`ShipStation request failed (${error instanceof Error ? error.name : String(error)})`);
  }
}
