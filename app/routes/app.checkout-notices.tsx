import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { RichTextEditor, RichTextPreview } from "../components/RichTextEditor";
import {
  type RichText,
  emptyRichText,
  plainTextFromRichText,
  richTextFromHtml,
  richTextToHtml,
  sanitizeEditorHtml,
  richTextFromPlain,
  sanitizeRichText,
} from "../services/rich-text";

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
  id: string; enabled: boolean; heading: string;
  // html is the editor source; richMessage is what checkout renders (built from
  // the HTML in the browser on edit); message is its plain-text copy for
  // the block list, validation and older extension versions.
  html: string; message: string; richMessage: RichText;
  tone: Tone; placement: Placement; countries: string[];
  // A country listed here shows the block only in these province codes; a
  // country without an entry shows it in all of its states.
  states: Record<string, string[]>;
};
type Province = { code: string; name: string };

const MAX_NOTICES = 20;
const MAX_MESSAGE = 3000;
// Shop metafields of type json are capped, and checkout loads the whole value.
const MAX_PAYLOAD = 120_000;
const SETTINGS_QUERY = `#graphql
  query CheckoutNoticeSettings {
    shop {
      id
      shipsToCountries
      metafield(namespace: "free_gift_cart", key: "checkout_notices") { jsonValue }
    }
  }
`;

// Provinces come from the shop's shipping zones, so they use the same codes
// checkout reports for the shipping address. Shops rarely have more than a
// handful of delivery profiles.
const PROVINCES_QUERY = `#graphql
  query CheckoutNoticeProvinces {
    deliveryProfiles(first: 50) {
      nodes {
        profileLocationGroups {
          countriesInAnyZone { country { code { countryCode } provinces { code name } } }
        }
      }
    }
  }
`;

function sanitizeStates(value: unknown, countries: string[]): Record<string, string[]> {
  const states: Record<string, string[]> = {};
  if (!value || typeof value !== "object") return states;
  for (const country of countries) {
    const codes = (value as Record<string, unknown>)[country];
    if (Array.isArray(codes)) {
      states[country] = [...new Set(codes.map((code) => String(code).toUpperCase()).filter((code) => /^[A-Z0-9-]{1,10}$/.test(code)))];
    }
  }
  return states;
}

function sanitizeNotice(notice: Partial<CheckoutNotice>): CheckoutNotice {
  const richMessage = sanitizeRichText(notice.richMessage) ?? richTextFromPlain(String(notice.message || "").slice(0, MAX_MESSAGE));
  const countries = Array.isArray(notice.countries)
    ? [...new Set(notice.countries.map((code) => String(code).toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)))]
    : [];
  return {
    id: String(notice.id || crypto.randomUUID()).slice(0, 64),
    enabled: notice.enabled !== false,
    heading: String(notice.heading || "").slice(0, 200),
    message: plainTextFromRichText(richMessage),
    richMessage,
    html: sanitizeEditorHtml(notice.html) || richTextToHtml(richMessage),
    tone: TONES.some((tone) => tone.value === notice.tone) ? notice.tone as Tone : "warning",
    placement: PLACEMENTS.some((placement) => placement.value === notice.placement) ? notice.placement as Placement : "delivery",
    countries,
    states: sanitizeStates(notice.states, countries),
  };
}

type ProvincesResponse = { data?: { deliveryProfiles?: { nodes?: {
  profileLocationGroups?: { countriesInAnyZone?: { country?: {
    code?: { countryCode?: string | null }; provinces?: Province[];
  } }[] }[];
}[] } } };

async function loadProvinces(admin: { graphql: (query: string) => Promise<Response> }) {
  const byCountry = new Map<string, Map<string, string>>();
  try {
    const json = await (await admin.graphql(PROVINCES_QUERY)).json() as ProvincesResponse;
    for (const profile of json.data?.deliveryProfiles?.nodes ?? []) {
      for (const group of profile.profileLocationGroups ?? []) {
        for (const { country } of group.countriesInAnyZone ?? []) {
          const code = country?.code?.countryCode;
          if (!code) continue;
          const provinces = byCountry.get(code) ?? new Map<string, string>();
          for (const province of country?.provinces ?? []) provinces.set(province.code.toUpperCase(), province.name);
          byCountry.set(code, provinces);
        }
      }
    }
  } catch {
    // Without the read_shipping scope (not yet approved) the page still works;
    // countries just offer "All states" only.
  }
  return Object.fromEntries([...byCountry].map(([country, provinces]) => [
    country,
    [...provinces].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name)),
  ])) as Record<string, Province[]>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(SETTINGS_QUERY);
  const json = await response.json();
  const saved = json.data?.shop?.metafield?.jsonValue as { notices?: Partial<CheckoutNotice>[] } | undefined;
  return {
    notices: Array.isArray(saved?.notices) ? saved.notices.map(sanitizeNotice) : [],
    countries: (json.data?.shop?.shipsToCountries ?? []) as string[],
    provinces: await loadProvinces(admin),
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
    return { ok: false, error: "Your changes couldn't be saved. Reload the page and try again." };
  }
  const tooLong = notices.find((notice) => notice.message.length > MAX_MESSAGE);
  if (tooLong) return { ok: false, error: `Messages can be up to ${MAX_MESSAGE} characters.` };
  const blank = notices.find((notice) => notice.enabled && !notice.richMessage.children.length);
  if (blank) return { ok: false, error: "Every active block needs a message." };
  if (JSON.stringify({ notices }).length > MAX_PAYLOAD) {
    return { ok: false, error: "The blocks are too large to save. Shorten some messages or remove unused blocks." };
  }
  const noCountry = notices.find((notice) => notice.enabled && notice.countries.length === 0);
  if (noCountry) return { ok: false, error: "Every active block needs at least one country." };
  const noState = notices.find((notice) => notice.enabled && Object.values(notice.states).some((codes) => codes.length === 0));
  if (noState) return { ok: false, error: "Pick at least one state, or choose \"All states\", for every country set to \"Select states\"." };

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
  const provinceName = (country: string, code: string) =>
    data.provinces[country]?.find((province) => province.code === code)?.name || code;
  const regionLabel = (notice: CheckoutNotice, country: string) => notice.states[country]
    ? `${countryName(country)} (${notice.states[country].map((code) => provinceName(country, code)).join(", ") || "no states"})`
    : countryName(country);
  const withoutKey = (states: Record<string, string[]>, key: string) =>
    Object.fromEntries(Object.entries(states).filter(([country]) => country !== key));

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
      richMessage: emptyRichText(),
      html: "",
      tone: "warning",
      placement: "delivery",
      countries: data.countries.includes("CA") ? ["CA"] : [],
      states: {},
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
                  <s-table-cell>{notice.countries.map((country) => regionLabel(notice, country)).join(", ") || "—"}</s-table-cell>
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
            <RichTextEditor key={editing.id} label="Message" initialHtml={editing.html}
              placeholder="Write the message buyers see in checkout"
              details="Checkout shows headings, bold, italic, links, lists, images and tables. Colors, underline, alignment and videos show as plain text."
              counter={`${editing.message.length}/${MAX_MESSAGE}`}
              counterOver={editing.message.length > MAX_MESSAGE}
              onChange={(html) => {
                const richMessage = richTextFromHtml(html);
                update(editing.id, { html, richMessage, message: plainTextFromRichText(richMessage) });
              }} />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-select label="Color" value={editing.tone} onChange={(event) => {
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
                        onRemove={() => update(editing.id, {
                          countries: editing.countries.filter((item) => item !== code),
                          states: withoutKey(editing.states, code),
                        })}>
                        {countryName(code)}
                      </s-clickable-chip>
                    ))}
                  </s-stack>
                )}
            </s-stack>

            {editing.countries.map((country) => {
              const provinces = data.provinces[country] ?? [];
              const selected = editing.states[country];
              return (
                <s-stack key={country} gap="small-200">
                  <s-select label={`States in ${countryName(country)}`} value={selected ? "selected" : "all"}
                    details={provinces.length ? undefined : "No states found in your shipping zones for this country, so the block shows in all of it."}
                    onChange={(event) => {
                      const states = event.currentTarget.value === "selected"
                        ? { ...editing.states, [country]: [] }
                        : withoutKey(editing.states, country);
                      update(editing.id, { states });
                    }}>
                    <s-option value="all">All states</s-option>
                    <s-option value="selected" disabled={!provinces.length}>Select states</s-option>
                  </s-select>
                  {selected && (
                    <>
                      <s-select label={`Show in these states of ${countryName(country)}`} value="" onChange={(event) => {
                        const code = event.currentTarget.value;
                        if (code && !selected.includes(code)) update(editing.id, { states: { ...editing.states, [country]: [...selected, code] } });
                      }}>
                        <s-option value="">Add a state…</s-option>
                        {provinces.filter((province) => !selected.includes(province.code)).map((province) => (
                          <s-option key={province.code} value={province.code}>{province.name}</s-option>
                        ))}
                      </s-select>
                      {selected.length === 0
                        ? <s-paragraph color="subdued">Pick at least one state. The block shows only when the checkout shipping address is in one of them.</s-paragraph>
                        : (
                          <s-stack direction="inline" gap="small-200">
                            {selected.map((code) => (
                              <s-clickable-chip key={code} removable accessibilityLabel={`Remove ${provinceName(country, code)}`}
                                onRemove={() => update(editing.id, { states: { ...editing.states, [country]: selected.filter((item) => item !== code) } })}>
                                {provinceName(country, code)}
                              </s-clickable-chip>
                            ))}
                          </s-stack>
                        )}
                    </>
                  )}
                </s-stack>
              );
            })}

            <s-divider />
            <s-heading>Preview</s-heading>
            <s-banner tone={editing.tone} heading={editing.heading || undefined}>
              {editing.richMessage.children.length
                ? <RichTextPreview value={editing.richMessage} />
                : <s-paragraph color="subdued">Your message will appear here.</s-paragraph>}
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
          <s-paragraph>{"Set a country to \"Select states\" to narrow it further: a block for Ontario and Quebec shows only when the shipping address is in one of those provinces."}</s-paragraph>
          <s-paragraph>{"One-time setup: in Settings → Checkout → Customize, add the \"Checkout notices\" app block to each placement you use."}</s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}
