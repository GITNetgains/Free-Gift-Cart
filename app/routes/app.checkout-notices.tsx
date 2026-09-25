import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// Checkout UI extensions only allow Shopify's banner tones, not custom colors,
// so the tone is the merchant's colour choice.
const TONES = [
  { value: "warning", label: "Warning (orange)" },
  { value: "info", label: "Info (blue)" },
  { value: "success", label: "Success (green)" },
  { value: "critical", label: "Critical (red)" },
] as const;
const PLACEMENTS = [
  { value: "delivery", label: "Delivery section (above the address)" },
  { value: "shipping", label: "Above shipping methods" },
  { value: "payment", label: "Above payment methods" },
  { value: "block", label: "Custom spot (placed in the checkout editor)" },
] as const;
type Tone = (typeof TONES)[number]["value"];
type Placement = (typeof PLACEMENTS)[number]["value"];
type CheckoutNotice = {
  id: string; enabled: boolean; heading: string; message: string;
  tone: Tone; placement: Placement; countries: string[]; dismissible: boolean;
};

const MAX_NOTICES = 20;
const SETTINGS_QUERY = `#graphql
  query CheckoutNoticeSettings {
    shop {
      id
      shipsToCountries
      metafield(namespace: "free_gift_cart", key: "checkout_notices") { jsonValue }
    }
  }
`;

function sanitizeNotice(notice: Partial<CheckoutNotice>): CheckoutNotice {
  return {
    id: String(notice.id || crypto.randomUUID()).slice(0, 64),
    enabled: notice.enabled !== false,
    heading: String(notice.heading || "").slice(0, 200),
    message: String(notice.message || "").slice(0, 1000),
    tone: TONES.some((tone) => tone.value === notice.tone) ? notice.tone as Tone : "warning",
    placement: PLACEMENTS.some((placement) => placement.value === notice.placement) ? notice.placement as Placement : "delivery",
    countries: Array.isArray(notice.countries)
      ? [...new Set(notice.countries.map((code) => String(code).toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)))]
      : [],
    dismissible: Boolean(notice.dismissible),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(SETTINGS_QUERY);
  const json = await response.json();
  const saved = json.data?.shop?.metafield?.jsonValue as { notices?: Partial<CheckoutNotice>[] } | undefined;
  return {
    notices: Array.isArray(saved?.notices) ? saved.notices.map(sanitizeNotice) : [],
    countries: (json.data?.shop?.shipsToCountries ?? []) as string[],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  let notices: CheckoutNotice[];
  try {
    const incoming = JSON.parse(String(formData.get("notices"))) as Partial<CheckoutNotice>[];
    if (!Array.isArray(incoming)) throw new Error();
    notices = incoming.slice(0, MAX_NOTICES).map(sanitizeNotice);
  } catch {
    return { ok: false, error: "Notices payload is invalid." };
  }
  const blank = notices.find((notice) => notice.enabled && !notice.message.trim());
  if (blank) return { ok: false, error: "Every active block needs a message." };
  const noCountry = notices.find((notice) => notice.enabled && notice.countries.length === 0);
  if (noCountry) return { ok: false, error: "Every active block needs at least one country." };

  const shopResponse = await admin.graphql(SETTINGS_QUERY);
  const shopJson = await shopResponse.json();
  const saveResponse = await admin.graphql(
    `#graphql
      mutation SaveCheckoutNotices($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { message } }
      }
    `,
    {
      variables: {
        metafields: [{
          ownerId: shopJson.data!.shop!.id,
          namespace: "free_gift_cart",
          key: "checkout_notices",
          type: "json",
          value: JSON.stringify({ notices }),
        }],
      },
    },
  );
  const saveJson = await saveResponse.json();
  const error = saveJson.data?.metafieldsSet?.userErrors?.[0]?.message;
  return error ? { ok: false, error } : { ok: true, notices };
};

export default function CheckoutNotices() {
  const data = useLoaderData<typeof loader>();
  const [notices, setNotices] = useState<CheckoutNotice[]>(data.notices);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const regionNames = useMemo(() => new Intl.DisplayNames(["en"], { type: "region" }), []);
  const countryName = (code: string) => regionNames.of(code) || code;
  const shipCountries = useMemo(
    () => [...data.countries].sort((a, b) => countryName(a).localeCompare(countryName(b))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.countries],
  );
  const editing = notices.find((notice) => notice.id === editingId);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      if (fetcher.data.notices) setNotices(fetcher.data.notices);
      setDirty(false);
      shopify.toast.show("Checkout notices saved");
    } else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const update = (id: string, changes: Partial<CheckoutNotice>) => {
    setNotices((current) => current.map((notice) => notice.id === id ? { ...notice, ...changes } : notice));
    setDirty(true);
  };
  const createNotice = () => {
    if (notices.length >= MAX_NOTICES) return shopify.toast.show(`You can create up to ${MAX_NOTICES} blocks`, { isError: true });
    const notice: CheckoutNotice = {
      id: crypto.randomUUID(),
      enabled: true,
      heading: "",
      message: "",
      tone: "warning",
      placement: "delivery",
      countries: data.countries.includes("CA") ? ["CA"] : [],
      dismissible: false,
    };
    setNotices((current) => [...current, notice]);
    setEditingId(notice.id);
    setDirty(true);
  };
  const removeNotice = (id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
    if (editingId === id) setEditingId(null);
    setDirty(true);
  };
  const save = () => fetcher.submit({ notices: JSON.stringify(notices) }, { method: "POST", encType: "application/x-www-form-urlencoded" });
  const placementLabel = (value: Placement) => PLACEMENTS.find((placement) => placement.value === value)?.label || value;

  return (
    <s-page heading="Checkout notices">
      <s-button slot="primary-action" variant="primary" icon="save" onClick={save} {...(fetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button>
      <s-button slot="secondary-actions" icon="plus" onClick={createNotice}>Create block</s-button>

      {dirty && <s-banner tone="info">You have unsaved changes. Click Save to publish them to checkout.</s-banner>}

      <s-section heading={`Blocks (${notices.length})`}>
        <s-stack gap="base">
          {notices.length === 0 ? (
            <s-stack gap="base">
              <s-paragraph color="subdued">No checkout blocks yet. Create one to show a message in checkout for the countries you choose.</s-paragraph>
              <s-button icon="plus" onClick={createNotice}>Create block</s-button>
            </s-stack>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Message</s-table-header>
                <s-table-header>Countries</s-table-header>
                <s-table-header>Placement</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>{notices.map((notice) => (
                <s-table-row key={notice.id}>
                  <s-table-cell><s-text>{notice.heading || notice.message.slice(0, 60) || "Untitled block"}</s-text></s-table-cell>
                  <s-table-cell>{notice.countries.map(countryName).join(", ") || "—"}</s-table-cell>
                  <s-table-cell>{placementLabel(notice.placement)}</s-table-cell>
                  <s-table-cell><s-badge tone={notice.enabled ? "success" : "neutral"}>{notice.enabled ? "Active" : "Off"}</s-badge></s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button icon="edit" variant="tertiary" accessibilityLabel="Edit block" onClick={() => setEditingId(notice.id)} />
                      <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel="Delete block" onClick={() => removeNotice(notice.id)} />
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}</s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      {editing && (
        <s-section heading="Edit block">
          <s-stack gap="base">
            <s-switch label="Show this block in checkout" checked={editing.enabled} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              update(editing.id, { enabled });
            }} />
            <s-text-field label="Heading (optional)" value={editing.heading} maxLength={200} onInput={(event) => {
              const heading = event.currentTarget.value;
              update(editing.id, { heading });
            }} />
            <s-text-area label="Message" rows={3} maxLength={1000} value={editing.message}
              details="Line breaks are kept." onInput={(event) => {
                const message = event.currentTarget.value;
                update(editing.id, { message });
              }} />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select label="Colour" value={editing.tone} onChange={(event) => {
                const tone = event.currentTarget.value as Tone;
                update(editing.id, { tone });
              }}>
                {TONES.map((tone) => <s-option key={tone.value} value={tone.value}>{tone.label}</s-option>)}
              </s-select>
              <s-select label="Placement" value={editing.placement} onChange={(event) => {
                const placement = event.currentTarget.value as Placement;
                update(editing.id, { placement });
              }}>
                {PLACEMENTS.map((placement) => <s-option key={placement.value} value={placement.value}>{placement.label}</s-option>)}
              </s-select>
            </s-grid>

            <s-stack gap="small-200">
              <s-select label="Show for countries" value="" onChange={(event) => {
                const code = event.currentTarget.value;
                if (code && !editing.countries.includes(code)) update(editing.id, { countries: [...editing.countries, code] });
              }}>
                <s-option value="">Add a country…</s-option>
                {shipCountries.filter((code) => !editing.countries.includes(code)).map((code) => (
                  <s-option key={code} value={code}>{countryName(code)}</s-option>
                ))}
              </s-select>
              {editing.countries.length === 0
                ? <s-paragraph color="subdued">Pick at least one country. The block shows only when the checkout shipping country matches.</s-paragraph>
                : (
                  <s-stack direction="inline" gap="small-200">
                    {editing.countries.map((code) => (
                      <s-clickable-chip key={code} removable accessibilityLabel={`Remove ${countryName(code)}`}
                        onRemove={() => update(editing.id, { countries: editing.countries.filter((item) => item !== code) })}>
                        {countryName(code)}
                      </s-clickable-chip>
                    ))}
                  </s-stack>
                )}
            </s-stack>

            <s-checkbox label="Let customers close this block" checked={editing.dismissible} onChange={(event) => {
              const dismissible = event.currentTarget.checked;
              update(editing.id, { dismissible });
            }} />

            <s-divider />
            <s-heading>Preview</s-heading>
            <s-banner tone={editing.tone} heading={editing.heading || undefined} dismissible={editing.dismissible}>
              {editing.message.trim() ? editing.message.split("\n").filter((line) => line.trim()).map((line, index) => (
                <s-paragraph key={index}>{line}</s-paragraph>
              )) : <s-paragraph color="subdued">Your message will appear here.</s-paragraph>}
            </s-banner>
            <s-paragraph color="subdued">{"Checkout uses your store's checkout branding for the exact shade of this colour."}</s-paragraph>

            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={save} {...(fetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button>
              <s-button onClick={() => setEditingId(null)}>Close editor</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="How it works">
        <s-stack gap="base">
          <s-paragraph>{"Each block shows only when the buyer's shipping country in checkout is one of the block's countries. For example, a Canada block appears when Canada is selected and stays hidden for the United States."}</s-paragraph>
          <s-paragraph>{"One-time setup: in Settings → Checkout → Customize, add the \"Checkout notices\" app block to each placement you use."}</s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}
