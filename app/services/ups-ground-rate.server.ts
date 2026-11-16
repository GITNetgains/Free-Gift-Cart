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
const TIMEOUT_MS = 5000;

type Destination = { country?: string; province?: string; postal_code?: string; city?: string };

export function isUpsGroundDestination(destination?: Destination | null) {
  return destination?.country === "US"
    && UPS_GROUND_STATES.includes(String(destination.province ?? "").toUpperCase());
}

/** UPS Ground price in cents, or the fallback price when ShipStation fails. */
export async function upsGroundPriceCents(destination: Destination, grams: number): Promise<{ cents: number; live: boolean }> {
  const key = process.env.SHIPSTATION_API_KEY;
  const secret = process.env.SHIPSTATION_API_SECRET;
  if (!key || !secret) {
    console.error("[ups-ground] SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET missing, using fallback price");
    return { cents: FALLBACK_PRICE_CENTS, live: false };
  }

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
        toState: String(destination.province).toUpperCase(),
        toPostalCode: destination.postal_code ?? "",
        toCity: destination.city ?? "",
        // Shopify sends grams rounded from the product's pounds (13 lb = 5897 g
        // = 208.01 oz). Rounding up made that 209 oz, which UPS bills as 14 lb.
        weight: { value: Math.max(1, Math.round(grams / 28.349523125)), units: "ounces" },
        residential: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const rates = await response.json().catch(() => null);
    const ground = Array.isArray(rates)
      ? rates.find((rate: { serviceCode?: string }) => rate.serviceCode === SHIPSTATION_SERVICE)
      : null;
    if (!ground) {
      console.error("[ups-ground] ShipStation returned no UPS Ground rate", response.status, JSON.stringify(rates).slice(0, 300));
      return { cents: FALLBACK_PRICE_CENTS, live: false };
    }
    const dollars = Number(ground.shipmentCost ?? 0) + Number(ground.otherCost ?? 0);
    return { cents: Math.round(dollars * 100), live: true };
  } catch (error) {
    console.error("[ups-ground] ShipStation request failed, using fallback price", error);
    return { cents: FALLBACK_PRICE_CENTS, live: false };
  }
}
