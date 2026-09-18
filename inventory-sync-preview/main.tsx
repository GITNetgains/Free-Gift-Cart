import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import InventorySyncDashboard, { type PreviewResult, type SelectedProduct, type SyncPairView } from "../app/components/InventorySyncDashboard";

const products = [
  { id: "gid://shopify/Product/1", title: "Slab Case", variants: [
    { id: "gid://shopify/ProductVariant/1", title: "Black" },
    { id: "gid://shopify/ProductVariant/3", title: "Silver" },
  ] },
  { id: "gid://shopify/Product/2", title: "Slab Case - Gift", variants: [
    { id: "gid://shopify/ProductVariant/2", title: "Black" },
    { id: "gid://shopify/ProductVariant/4", title: "Silver" },
  ] },
];
function Preview() {
  const [pairs, setPairs] = useState<SyncPairView[]>([]);
  const [workerEnabled, setWorkerEnabled] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState("Local UI simulation - sample products only. No store connection or live inventory changes.");
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewResult>(null);
  const [previewError, setPreviewError] = useState<string>();
  const picker = useRef<HTMLDialogElement>(null);
  const resolver = useRef<(value: SelectedProduct | undefined) => void>();
  const memberships = useRef(new Map<string, string[]>());
  const choose = (value?: SelectedProduct) => { resolver.current?.(value); resolver.current = undefined; picker.current?.close(); };
  const simulate = (delta: number, label: string) => {
    setPairs((current) => current.map((pair) => pair.enabled && workerEnabled ? { ...pair, quantity: pair.quantity + delta, lastSyncedAt: new Date().toISOString() } : pair));
    setNotice(`${label}. Sample enabled links updated; paused links stay unchanged. This is a UI simulation.`);
  };
  return <>
    <div className="preview-bar"><strong>ZIONCASES / LOCAL PREVIEW</strong><span>Sample data - no Shopify writes</span>
      <button onClick={() => setWorkerEnabled((value) => !value)}>{workerEnabled ? "Turn worker off" : "Turn worker on"}</button>
      <button onClick={() => simulate(-1, "Original sale simulated")}>Original sale -1</button>
      <button onClick={() => simulate(-1, "Duplicate sale simulated")}>Duplicate sale -1</button>
      <button onClick={() => simulate(5, "Restock simulated")}>Restock +5</button>
    </div>
    <InventorySyncDashboard pairs={pairs} locations={[{ id: "main", name: "Main warehouse" }, { id: "retail", name: "Retail store" }]} workerEnabled={workerEnabled} error={error} notice={notice} busy={busy}
      previewBusy={previewBusy} previewResult={previewResult} previewError={previewError}
      onPickProduct={() => new Promise((resolve) => { resolver.current = resolve; picker.current?.showModal(); })}
      onPreview={(originalProductId, duplicateProductId) => {
        setPreviewError(undefined); setPreviewBusy(true);
        window.setTimeout(() => {
          const original = products.find((product) => product.id === originalProductId);
          const duplicate = products.find((product) => product.id === duplicateProductId);
          if (!original || !duplicate) { setPreviewError("Sample product not found."); setPreviewBusy(false); return; }
          const duplicateByTitle = new Map(duplicate.variants.map((variant) => [variant.title, variant]));
          const matches = original.variants.filter((variant) => duplicateByTitle.has(variant.title)).map((variant) => {
            const match = duplicateByTitle.get(variant.title)!;
            return { originalId: variant.id, duplicateId: match.id, originalTitle: `${original.title} / ${variant.title}`, duplicateTitle: `${duplicate.title} / ${match.title}`, originalQuantity: 10, duplicateQuantity: 10 };
          });
          setPreviewResult({ matches, unmatchedOriginal: [], unmatchedDuplicate: [], invalid: [] });
          setPreviewBusy(false);
        }, 200);
      }}
      onAction={(data) => {
        setError(undefined); setBusy(true);
        window.setTimeout(() => {
          if (data.intent === "create-bulk") {
            const requested = JSON.parse(data.pairs) as Array<{ originalId: string; duplicateId: string }>;
            let createdCount = 0;
            for (const { originalId, duplicateId } of requested) {
              const keys = [originalId, duplicateId].map((id) => `${data.locationId}:${id}`);
              if (Array.from(memberships.current.values()).some((ids) => ids.some((id) => keys.includes(id)))) continue;
              const id = crypto.randomUUID(); memberships.current.set(id, keys);
              const findTitle = (variantId: string) => products.flatMap((product) => product.variants.map((variant) => ({ product, variant }))).find((entry) => entry.variant.id === variantId);
              const originalEntry = findTitle(originalId); const duplicateEntry = findTitle(duplicateId);
              if (!originalEntry || !duplicateEntry) continue;
              setPairs((current) => [...current, { id, originalTitle: `${originalEntry.product.title} / ${originalEntry.variant.title}`, duplicateTitle: `${duplicateEntry.product.title} / ${duplicateEntry.variant.title}`, locationName: data.locationId === "main" ? "Main warehouse" : "Retail store", enabled: true, quantity: 10, lastSyncedAt: workerEnabled ? new Date().toISOString() : null, lastError: null, pending: false }]);
              createdCount += 1;
            }
            setNotice(createdCount ? `Linked ${createdCount} sample variant pair${createdCount === 1 ? "" : "s"}.` : "Those variants are already linked at this location.");
          } else if (data.intent === "remove") {
            memberships.current.delete(data.id); setPairs((current) => current.filter((pair) => pair.id !== data.id));
          } else setPairs((current) => current.map((pair) => pair.id === data.id ? { ...pair, enabled: data.intent === "pause" ? false : true, lastSyncedAt: data.intent === "sync" ? new Date().toISOString() : pair.lastSyncedAt } : pair));
          setBusy(false);
        }, 200);
      }} />
    <dialog ref={picker} onCancel={() => choose()}><h2>Select a sample product</h2><p>Local fixtures for reviewing the dashboard.</p>{products.map((product) => <button key={product.id} onClick={() => choose({ id: product.id, title: product.title })}>{product.title}</button>)}<button onClick={() => choose()}>Cancel</button></dialog>
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
