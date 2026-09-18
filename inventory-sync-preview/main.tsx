import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import InventorySyncDashboard, { type SelectedVariant, type SyncPairView } from "../app/components/InventorySyncDashboard";

const variants = [
  { id: "gid://shopify/ProductVariant/1", title: "Slab Case / Black" },
  { id: "gid://shopify/ProductVariant/2", title: "Slab Case - Gift / Black" },
  { id: "gid://shopify/ProductVariant/3", title: "Slab Case / Silver" },
  { id: "gid://shopify/ProductVariant/4", title: "Slab Case - Gift / Silver" },
];
function Preview() {
  const [pairs, setPairs] = useState<SyncPairView[]>([]);
  const [workerEnabled, setWorkerEnabled] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState("Local UI simulation - sample products only. No store connection or live inventory changes.");
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLDialogElement>(null);
  const resolver = useRef<(value: SelectedVariant | undefined) => void>();
  const memberships = useRef(new Map<string, string[]>());
  const choose = (value?: SelectedVariant) => { resolver.current?.(value); resolver.current = undefined; picker.current?.close(); };
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
      onPick={() => new Promise((resolve) => { resolver.current = resolve; picker.current?.showModal(); })}
      onAction={(data) => {
        setError(undefined); setBusy(true);
        window.setTimeout(() => {
          if (data.intent === "create") {
            const keys = [data.originalId, data.duplicateId].map((id) => `${data.locationId}:${id}`);
            if (Array.from(memberships.current.values()).some((ids) => ids.some((id) => keys.includes(id)))) setError("One of these variants is already linked at this location. Remove its existing link first.");
            else {
              const id = crypto.randomUUID(); memberships.current.set(id, keys);
              setPairs((current) => [...current, { id, originalTitle: variants.find((v) => v.id === data.originalId)!.title, duplicateTitle: variants.find((v) => v.id === data.duplicateId)!.title, locationName: data.locationId === "main" ? "Main warehouse" : "Retail store", enabled: true, quantity: 10, lastSyncedAt: workerEnabled ? new Date().toISOString() : null, lastError: null, pending: false }]);
              setNotice("Sample inventory link saved. Use the simulation controls above to preview stock changes.");
            }
          } else if (data.intent === "remove") {
            memberships.current.delete(data.id); setPairs((current) => current.filter((pair) => pair.id !== data.id));
          } else setPairs((current) => current.map((pair) => pair.id === data.id ? { ...pair, enabled: data.intent === "pause" ? false : true, lastSyncedAt: data.intent === "sync" ? new Date().toISOString() : pair.lastSyncedAt } : pair));
          setBusy(false);
        }, 200);
      }} />
    <dialog ref={picker} onCancel={() => choose()}><h2>Select a sample variant</h2><p>Local fixtures for reviewing the dashboard.</p>{variants.map((variant) => <button key={variant.id} onClick={() => choose(variant)}>{variant.title}</button>)}<button onClick={() => choose()}>Cancel</button></dialog>
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
