import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import {
  isUpsGroundDestination,
  upsGroundPriceCents,
  UPS_GROUND_SERVICE_CODE,
  UPS_GROUND_SERVICE_NAME,
} from "../services/ups-ground-rate.server";

// Carrier service callback: Shopify posts the checkout's address and items
// here and shows whatever rates come back. Only Alaska and Hawaii get a rate;
// every other address gets none, so no other zone or state changes.

type RateRequest = {
  rate?: {
    destination?: { country?: string; province?: string; postal_code?: string; city?: string };
    items?: Array<{ name?: string; sku?: string; grams?: number; quantity?: number; requires_shipping?: boolean }>;
    currency?: string;
  };
};

const NO_RATES = { rates: [] };

function validHmac(body: string, header: string | null) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !header) return false;
  const digest = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const loader = () => new Response("Method not allowed", { status: 405 });

export const action = async ({ request }: ActionFunctionArgs) => {
  const body = await request.text();
  if (!validHmac(body, request.headers.get("x-shopify-hmac-sha256"))) {
    console.error("[ups-ground] rejected carrier request with a missing or bad signature", request.headers.get("x-shopify-shop-domain"));
    return Response.json(NO_RATES, { status: 401 });
  }

  let payload: RateRequest;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json(NO_RATES);
  }

  const destination = payload.rate?.destination;
  if (!destination || !isUpsGroundDestination(destination)) return Response.json(NO_RATES);

  const shipped = (payload.rate?.items ?? [])
    .filter((item) => item.requires_shipping !== false)
    .map((item) => ({ grams: item.grams ?? 0, quantity: item.quantity ?? 1 }));
  const grams = shipped.reduce((sum, item) => sum + item.grams * item.quantity, 0);

  const { cents, live, source, packages } = await upsGroundPriceCents(destination, shipped);
  // One line per quote so checkout prices can be compared with ShipStation.
  console.log("[ups-ground] quote", JSON.stringify({
    shop: request.headers.get("x-shopify-shop-domain"),
    to: `${destination.province} ${destination.postal_code}`,
    items: (payload.rate?.items ?? []).map((item) => `${item.quantity}x ${item.name} (${item.grams}g${item.requires_shipping === false ? ", no shipping" : ""})`),
    totalGrams: grams,
    ounces: Math.round(grams / 28.349523125),
    packages: packages.map((ounces) => `${(ounces / 16).toFixed(1)} lb`),
    price: cents === null ? null : (cents / 100).toFixed(2),
    live,
    source,
  }));
  // No trustworthy price: offer nothing, and checkout keeps ShipStation's rates.
  if (cents === null) return Response.json(NO_RATES);
  return Response.json({
    rates: [{
      service_name: UPS_GROUND_SERVICE_NAME,
      service_code: UPS_GROUND_SERVICE_CODE,
      description: "Ground shipping for Alaska and Hawaii",
      total_price: String(cents),
      currency: "USD",
    }],
  });
};
