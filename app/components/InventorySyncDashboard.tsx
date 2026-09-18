import { useState } from "react";

export type SelectedVariant = { id: string; title: string; imageUrl?: string };
export type SyncPairView = {
  id: string; originalTitle: string; duplicateTitle: string; locationName: string;
  enabled: boolean; quantity: number; lastSyncedAt: string | null; lastError: string | null; pending: boolean;
};
type Props = {
  pairs: SyncPairView[]; locations: Array<{ id: string; name: string }>;
  workerEnabled: boolean; busy: boolean; error?: string | null; notice?: string;
  onPick: () => Promise<SelectedVariant | undefined>;
  onAction: (data: Record<string, string>) => void;
};

export default function InventorySyncDashboard({ pairs, locations, workerEnabled, busy, error, notice, onPick, onAction }: Props) {
  const [original, setOriginal] = useState<SelectedVariant>();
  const [duplicate, setDuplicate] = useState<SelectedVariant>();
  const [locationId, setLocationId] = useState("");
  const [pickError, setPickError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const location = locationId || locations[0]?.id || "";
  const active = pairs.filter((pair) => pair.enabled).length;
  const errors = pairs.filter((pair) => pair.lastError).length;
  const pick = async (side: "original" | "duplicate") => {
    setPicking(true);
    setPickError(undefined);
    try {
      const selected = await onPick();
      if (!selected) return;
      if (selected.id === (side === "original" ? duplicate : original)?.id) {
        setPickError("Choose different variants for the original and duplicate.");
        return;
      }
      (side === "original" ? setOriginal : setDuplicate)(selected);
      setAcknowledged(false);
    } catch {
      setPickError("Product picker could not open. Please try again.");
    } finally {
      setPicking(false);
    }
  };
  return (
    <s-page heading="Inventory sync" inlineSize="large">
      <s-button slot="secondary-actions" href="/app/dashboard">Back to dashboard</s-button>
      {notice && <s-banner heading="Inventory sync" tone="info">{notice}</s-banner>}
      {!workerEnabled && <s-banner heading="Sync worker is off" tone="warning">Links can be saved, but inventory will not change until the server&apos;s inventory sync worker is enabled.</s-banner>}
      {(error || pickError) && <s-banner heading="Please check" tone="critical">{error || pickError}</s-banner>}
      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-heading>One stock count. Two product listings.</s-heading>
            <s-badge tone={workerEnabled ? "success" : "neutral"}>{workerEnabled ? "Worker enabled" : "Setup mode"}</s-badge>
          </s-stack>
          <s-paragraph color="subdued">Link an original product variant to its duplicate. Sales, gifts, restocks and restocked returns on either listing update the linked available quantity.</s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
            <s-box padding="base" background="subdued" borderRadius="base"><s-stack gap="small"><s-text>Linked pairs</s-text><s-heading>{pairs.length}</s-heading></s-stack></s-box>
            <s-box padding="base" background="subdued" borderRadius="base"><s-stack gap="small"><s-text>Enabled links</s-text><s-heading>{active}</s-heading></s-stack></s-box>
            <s-box padding="base" background="subdued" borderRadius="base"><s-stack gap="small"><s-text>Needs attention</s-text><s-heading>{errors}</s-heading></s-stack></s-box>
          </s-grid>
        </s-stack>
      </s-section>
      <s-section heading="Create an inventory link">
        <s-stack gap="base">
          <s-paragraph color="subdued">Select one variant from each product. Add a separate link for each size, color or location.</s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
            {(["original", "duplicate"] as const).map((side) => {
              const selected = side === "original" ? original : duplicate;
              return <s-box key={side} padding="base" border="base" borderRadius="base">
                <s-stack gap="base">
                  <s-heading>{side === "original" ? "Original product" : "Duplicate product"}</s-heading>
                  <s-paragraph color="subdued">{side === "original" ? "Its available stock sets the starting quantity." : "Choose an existing duplicate listing."}</s-paragraph>
                  {selected && <s-stack direction="inline" gap="small" alignItems="center">{selected.imageUrl && <s-thumbnail src={selected.imageUrl} alt={selected.title} />}<s-text type="strong">{selected.title}</s-text></s-stack>}
                  <s-button disabled={busy || picking} onClick={() => void pick(side)}>{selected ? "Change" : "Select"} {side} variant</s-button>
                </s-stack>
              </s-box>;
            })}
          </s-grid>
          <s-select label="Inventory location" value={location} disabled={busy || !locations.length} onChange={(event) => { setLocationId(event.currentTarget.value); setAcknowledged(false); }}>
            {!locations.length && <s-option value="">No available locations</s-option>}
            {locations.map((entry) => <s-option key={entry.id} value={entry.id}>{entry.name}</s-option>)}
          </s-select>
          <s-checkbox label="Both listings represent the same physical stock. Replace the duplicate's starting available quantity with the original's quantity when sync runs." checked={acknowledged} onChange={(event) => setAcknowledged(event.currentTarget.checked)} />
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" disabled={busy || picking || !original || !duplicate || !location || !acknowledged} loading={busy} onClick={() => {
              if (original && duplicate) onAction({ intent: "create", originalId: original.id, duplicateId: duplicate.id, locationId: location, acknowledged: "true" });
            }}>Save inventory link</s-button>
          </s-stack>
        </s-stack>
      </s-section>
      <s-section heading="Linked inventory">
        {!pairs.length ? <s-box padding="large"><s-stack gap="base" alignItems="center"><s-heading>No inventory links yet</s-heading><s-paragraph color="subdued">Choose an original and duplicate above to set up your first link.</s-paragraph></s-stack></s-box> :
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Products</s-table-header><s-table-header listSlot="secondary">Location</s-table-header><s-table-header format="numeric">Last shared stock</s-table-header><s-table-header>Status</s-table-header><s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>{pairs.map((pair) => <s-table-row key={pair.id}>
              <s-table-cell><s-stack gap="small"><s-text type="strong">{pair.originalTitle}</s-text><s-text color="subdued">Linked to {pair.duplicateTitle}</s-text></s-stack></s-table-cell>
              <s-table-cell>{pair.locationName}</s-table-cell>
              <s-table-cell>{pair.quantity}</s-table-cell>
              <s-table-cell><s-stack gap="small">
                <s-badge tone={pair.lastError ? "critical" : !pair.enabled || !workerEnabled ? "neutral" : pair.lastSyncedAt ? "success" : "info"}>{pair.lastError ? "Needs attention" : !pair.enabled ? "Paused" : !workerEnabled ? "Worker off" : pair.lastSyncedAt ? "Sync enabled" : "Queued"}</s-badge>
                <s-text color="subdued">{pair.lastSyncedAt ? `Last checked ${new Date(pair.lastSyncedAt).toLocaleString()}` : "Awaiting first sync"}</s-text>
                {pair.lastError && <s-text tone="critical">{pair.lastError}</s-text>}
              </s-stack></s-table-cell>
              <s-table-cell><s-stack direction="inline" gap="small">
                <s-button disabled={busy || !pair.enabled || !workerEnabled} onClick={() => onAction({ intent: "sync", id: pair.id })}>Sync now</s-button>
                <s-button disabled={busy} onClick={() => onAction({ intent: pair.enabled ? "pause" : "resume", id: pair.id })}>{pair.enabled ? "Pause" : "Resume"}</s-button>
                {!pair.enabled && <s-button tone="critical" disabled={busy || pair.pending} onClick={() => onAction({ intent: "remove", id: pair.id })}>Remove</s-button>}
              </s-stack></s-table-cell>
            </s-table-row>)}</s-table-body>
          </s-table>}
      </s-section>
      <s-section heading="How syncing works">
        <s-stack gap="base">
          <s-paragraph>Updates run in the background after Shopify reports an inventory change. A periodic check also catches missed notifications. The dashboard can stay closed.</s-paragraph>
          <s-paragraph>Update physical stock on one listing only, normally the original. Changing both listings counts as two separate adjustments. Pausing keeps the link&apos;s stock history; resuming includes changes made while paused.</s-paragraph>
          <s-paragraph color="subdued">Sync is near real-time, not instantaneous. Simultaneous checkouts can still oversell. Only available stock at the selected location is linked; prices, product details and other inventory states remain separate.</s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

