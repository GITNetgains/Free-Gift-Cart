import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { locations, readProductMatches } from "../services/inventory-sync-api.server";
import { changeLink, createLink, createLinksBulk, publicPair } from "../services/inventory-sync-settings.server";
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
    if (intent === "preview-products") {
      const result = await readProductMatches(admin, value("originalProductId"), value("duplicateProductId"), value("locationId"));
      return { ok: true, error: null, message: null, preview: result };
    }
    if (intent === "create-bulk") {
      if (value("acknowledged") !== "true") throw new Error("Confirm that both listings represent the same physical stock.");
      const pairs = JSON.parse(value("pairs")) as Array<{ originalId: string; duplicateId: string }>;
      if (!pairs.length) throw new Error("Select at least one variant pair to link.");
      const result = await createLinksBulk(db, admin, session.shop, pairs, value("locationId"));
      const message = result.failed.length
        ? `Linked ${result.created} of ${pairs.length} variant pairs. ${result.failed.length} could not be linked (likely already linked elsewhere).`
        : `Linked ${result.created} variant pair${result.created === 1 ? "" : "s"}.`;
      return { ok: true, error: null, message, preview: null };
    }
    if (intent === "create") {
      if (value("acknowledged") !== "true") throw new Error("Confirm that both listings represent the same physical stock.");
      await createLink(db, admin, session.shop, value("originalId"), value("duplicateId"), value("locationId"));
      return { ok: true, error: null, message: "Inventory link saved", preview: null };
    }
    await changeLink(db, session.shop, value("id"), intent);
    return { ok: true, error: null, message: intent === "sync" ? "Inventory check queued" : "Inventory link updated", preview: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not update inventory link.", message: null, preview: null };
  }
};

export default function InventorySyncRoute() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const previewFetcher = useFetcher<typeof action>();
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
    onPreview={(originalProductId, duplicateProductId, locationId) => {
      previewFetcher.submit({ intent: "preview-products", originalProductId, duplicateProductId, locationId }, { method: "POST" });
    }}
    previewBusy={previewFetcher.state !== "idle"}
    previewResult={previewFetcher.data?.ok ? previewFetcher.data.preview ?? null : null}
    previewError={previewFetcher.data?.ok === false ? previewFetcher.data.error : null}
    onPickProduct={async () => {
      const selection = await bridge.resourcePicker({ type: "product", multiple: false, action: "select" });
      const product = selection?.[0];
      if (!product) return undefined;
      return { id: product.id, title: product.title, imageUrl: product.images?.[0]?.originalSrc };
    }} />;
}
