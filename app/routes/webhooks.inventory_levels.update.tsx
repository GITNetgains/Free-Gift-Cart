import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueueInventory } from "../services/inventory-sync-engine.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (topic !== "INVENTORY_LEVELS_UPDATE") return new Response(null, { status: 400 });
  const { inventory_item_id: item, location_id: location } = payload;
  if (!/^\d+$/.test(String(item)) || !/^\d+$/.test(String(location))) return new Response(null, { status: 400 });
  await enqueueInventory(db, shop, `gid://shopify/InventoryItem/${item}`, `gid://shopify/Location/${location}`);
  return new Response(null, { status: 200 });
};
