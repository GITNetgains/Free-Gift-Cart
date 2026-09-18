import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { locations } from "../services/inventory-sync-api.server";
import { changeLink, createLink, publicPair } from "../services/inventory-sync-settings.server";
import InventorySyncDashboard from "../components/InventorySyncDashboard";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const pairs = await db.inventorySyncPair.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" } });
  let error: string | null = null;
  let availableLocations: Awaited<ReturnType<typeof locations>> = [];
  try { availableLocations = await locations(admin); }
  catch { error = "Could not load inventory locations. Verify the app has read_inventory, write_inventory and read_locations permissions, then reload."; }
  // eslint-disable-next-line no-undef
  return { pairs: pairs.map(publicPair), locations: availableLocations, workerEnabled: process.env.INVENTORY_SYNC_WORKER_ENABLED === "true", error };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const value = (name: string) => String(form.get(name) || "");
  const intent = value("intent");
  try {
    if (intent === "create") {
      if (value("acknowledged") !== "true") throw new Error("Confirm that both listings represent the same physical stock.");
      await createLink(db, admin, session.shop, value("originalId"), value("duplicateId"), value("locationId"));
    } else {
      await changeLink(db, session.shop, value("id"), intent);
    }
    return { ok: true, error: null, message: intent === "create" ? "Inventory link saved" : intent === "sync" ? "Inventory check queued" : "Inventory link updated" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not update inventory link.", message: null };
  }
};

export default function InventorySyncRoute() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const bridge = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.message) bridge.toast.show(fetcher.data.message);
  }, [fetcher.data, bridge]);
  useEffect(() => {
    if (!data.workerEnabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle" && fetcher.state === "idle") void revalidator.revalidate();
    }, 15_000);
    return () => clearInterval(timer);
  }, [data.workerEnabled, revalidator, fetcher.state]);
  return <InventorySyncDashboard {...data} busy={fetcher.state !== "idle"} error={fetcher.data?.error || data.error}
    onAction={(values) => fetcher.submit(values, { method: "POST" })}
    onPick={async () => {
      const selection = await bridge.resourcePicker({ type: "variant", multiple: false, action: "select" });
      const variant = selection?.[0];
      if (!variant) return undefined;
      return { id: variant.id, title: `${variant.product.title}${variant.title === "Default Title" ? "" : ` / ${variant.title}`}`, imageUrl: variant.image?.originalSrc };
    }} />;
}
