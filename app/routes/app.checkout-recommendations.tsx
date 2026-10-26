import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// The checkout-recommendations extension reads this shop metafield. A rule
// matches when any trigger product is in the cart; when no rule matches, the
// default source fills the block.
const DEFAULT_SOURCES = [
  { value: "shopify", label: "Shopify's related products (automatic)" },
  { value: "products", label: "Products I choose" },
  { value: "none", label: "Nothing (hide the block)" },
] as const;
type DefaultSource = (typeof DEFAULT_SOURCES)[number]["value"];
type ProductRef = { id: string; title: string; image: string };
type Settings = {
  enabled: boolean; heading: string; maxProducts: number;
  defaultSource: DefaultSource; defaultProducts: ProductRef[];
  // Top up a matching rule's products with the default when it has fewer
  // than maxProducts available.
  fillWithDefault: boolean;
};
type Rule = { id: string; enabled: boolean; name: string; triggers: ProductRef[]; recommendations: ProductRef[] };

const MAX_RULES = 100;
const MAX_TRIGGERS = 50;
const MAX_RECOMMENDATIONS = 10;
const MAX_SHOWN = 6;
// Checkout loads the whole metafield value, so keep it small.
const MAX_PAYLOAD = 120_000;
const DEFAULT_SETTINGS: Settings = {
  enabled: true, heading: "You may also like", maxProducts: 3,
  defaultSource: "shopify", defaultProducts: [], fillWithDefault: false,
};
const SETTINGS_QUERY = `#graphql
  query CheckoutRecommendationSettings {
    shop {
      id
      metafield(namespace: "free_gift_cart", key: "checkout_recommendations") { jsonValue }
    }
  }
`;

function sanitizeProducts(value: unknown, limit: number): ProductRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const products: ProductRef[] = [];
  for (const item of value as Partial<ProductRef>[]) {
    const id = String(item?.id || "");
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const image = String(item?.image || "");
    products.push({ id, title: String(item?.title || "").slice(0, 255), image: /^https:\/\//.test(image) ? image.slice(0, 500) : "" });
  }
  return products.slice(0, limit);
}

function sanitizeSettings(value: Partial<Settings> | undefined): Settings {
  const settings = value ?? {};
  return {
    enabled: settings.enabled !== false,
    heading: String(settings.heading ?? DEFAULT_SETTINGS.heading).slice(0, 100),
    maxProducts: Math.min(MAX_SHOWN, Math.max(1, Math.round(Number(settings.maxProducts) || DEFAULT_SETTINGS.maxProducts))),
    defaultSource: DEFAULT_SOURCES.some((source) => source.value === settings.defaultSource)
      ? settings.defaultSource as DefaultSource
      : DEFAULT_SETTINGS.defaultSource,
    defaultProducts: sanitizeProducts(settings.defaultProducts, MAX_RECOMMENDATIONS),
    fillWithDefault: settings.fillWithDefault === true,
  };
}

function sanitizeRule(rule: Partial<Rule>): Rule {
  return {
    id: String(rule.id || crypto.randomUUID()).slice(0, 64),
    enabled: rule.enabled !== false,
    name: String(rule.name || "").slice(0, 100),
    triggers: sanitizeProducts(rule.triggers, MAX_TRIGGERS),
    recommendations: sanitizeProducts(rule.recommendations, MAX_RECOMMENDATIONS),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(SETTINGS_QUERY);
  const json = await response.json();
  const saved = json.data?.shop?.metafield?.jsonValue as { settings?: Partial<Settings>; rules?: Partial<Rule>[] } | undefined;
  return {
    settings: sanitizeSettings(saved?.settings),
    rules: Array.isArray(saved?.rules) ? saved.rules.map(sanitizeRule) : [],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  let settings: Settings;
  let rules: Rule[];
  try {
    settings = sanitizeSettings(JSON.parse(String(formData.get("settings"))));
    const incoming = JSON.parse(String(formData.get("rules"))) as Partial<Rule>[];
    if (!Array.isArray(incoming)) throw new Error();
    rules = incoming.slice(0, MAX_RULES).map(sanitizeRule);
  } catch {
    return { ok: false, error: "Your changes couldn't be saved. Reload the page and try again." };
  }
  const incomplete = rules.find((rule) => rule.enabled && (!rule.triggers.length || !rule.recommendations.length));
  if (incomplete) {
    return { ok: false, error: `"${incomplete.name || "Untitled rule"}" needs at least one cart product and one product to recommend.` };
  }
  if (settings.defaultSource === "products" && !settings.defaultProducts.length) {
    return { ok: false, error: "Choose at least one default product, or pick another default." };
  }
  const value = JSON.stringify({ settings, rules });
  if (value.length > MAX_PAYLOAD) return { ok: false, error: "There are too many rules to save. Remove some unused rules." };

  const shopJson = await (await admin.graphql(SETTINGS_QUERY)).json();
  const saveResponse = await admin.graphql(
    `#graphql
      mutation SaveCheckoutRecommendations($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { message } }
      }
    `,
    {
      variables: {
        metafields: [{
          ownerId: shopJson.data!.shop!.id,
          namespace: "free_gift_cart",
          key: "checkout_recommendations",
          type: "json",
          value,
        }],
      },
    },
  );
  const saveJson = await saveResponse.json();
  const error = saveJson.data?.metafieldsSet?.userErrors?.[0]?.message;
  return error ? { ok: false, error } : { ok: true, settings, rules };
};

function ProductList({ products, empty, onRemove }: { products: ProductRef[]; empty: string; onRemove: (id: string) => void }) {
  if (!products.length) return <s-paragraph color="subdued">{empty}</s-paragraph>;
  return (
    <s-stack gap="small-200">
      {products.map((product) => (
        <s-grid key={product.id} gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
          <s-thumbnail src={product.image || undefined} alt={product.title} size="small" />
          <s-text>{product.title || product.id}</s-text>
          <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel={`Remove ${product.title}`} onClick={() => onRemove(product.id)} />
        </s-grid>
      ))}
    </s-stack>
  );
}

export default function CheckoutRecommendations() {
  const data = useLoaderData<typeof loader>();
  const [settings, setSettings] = useState<Settings>(data.settings);
  const [rules, setRules] = useState<Rule[]>(data.rules);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const editing = rules.find((rule) => rule.id === editingId);
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      if (fetcher.data.settings) setSettings(fetcher.data.settings);
      if (fetcher.data.rules) setRules(fetcher.data.rules);
      setDirty(false);
      shopify.toast.show("Checkout recommendations saved");
    } else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const updateSettings = (changes: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...changes }));
    setDirty(true);
  };
  const updateRule = (id: string, changes: Partial<Rule>) => {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...changes } : rule));
    setDirty(true);
  };
  // Adds the picked products to the list (keeping ones already there) up to
  // the limit; the picker opens with the current list preselected.
  const pickProducts = async (current: ProductRef[], limit: number) => {
    const selection = await shopify.resourcePicker({
      type: "product", multiple: limit, filter: { variants: false },
      selectionIds: current.map((product) => ({ id: product.id })),
    });
    if (!selection) return null;
    const picked = selection.map((product) => ({
      id: product.id,
      title: product.title,
      image: product.images?.[0]?.originalSrc || "",
    }));
    if (picked.length > limit) shopify.toast.show(`Only the first ${limit} products were kept`);
    return picked.slice(0, limit);
  };
  const createRule = () => {
    if (rules.length >= MAX_RULES) return shopify.toast.show(`You can create up to ${MAX_RULES} rules`, { isError: true });
    const rule: Rule = { id: crypto.randomUUID(), enabled: true, name: "", triggers: [], recommendations: [] };
    setRules((current) => [...current, rule]);
    setEditingId(rule.id);
    setDirty(true);
  };
  const removeRule = (id: string) => {
    setRules((current) => current.filter((rule) => rule.id !== id));
    if (editingId === id) setEditingId(null);
    setDirty(true);
  };
  const save = () => fetcher.submit(
    { settings: JSON.stringify(settings), rules: JSON.stringify(rules) },
    { method: "POST", encType: "application/x-www-form-urlencoded" },
  );
  const titles = (products: ProductRef[]) => {
    const names = products.map((product) => product.title);
    return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2} more` : names.join(", ") || "—";
  };

  return (
    <s-page heading="Checkout recommendations">
      <s-button slot="primary-action" variant="primary" icon="save" onClick={save} {...(saving ? { loading: true } : {})}>Save</s-button>
      <s-button slot="secondary-actions" icon="plus" onClick={createRule}>Create rule</s-button>

      {dirty && <s-banner tone="info">You have unsaved changes. Click Save to publish them to checkout.</s-banner>}

      {editing ? (
        <>
          <s-button onClick={() => setEditingId(null)} icon="arrow-left">Back to rules</s-button>
          <s-section heading="Edit rule">
            <s-stack gap="base">
              <s-switch label="Use this rule in checkout" checked={editing.enabled} onChange={(event) => {
                const enabled = event.currentTarget.checked;
                updateRule(editing.id, { enabled });
              }} />
              <s-text-field label="Rule name" value={editing.name} maxLength={100}
                placeholder="e.g. iPhone 16 cases → screen protectors"
                details="Only you see this name." onInput={(event) => {
                  const name = event.currentTarget.value;
                  updateRule(editing.id, { name });
                }} />

              <s-divider />
              <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
                <s-heading>When the cart has any of these products</s-heading>
                <s-button icon="product" onClick={async () => {
                  const triggers = await pickProducts(editing.triggers, MAX_TRIGGERS);
                  if (triggers) updateRule(editing.id, { triggers });
                }}>Choose products</s-button>
              </s-stack>
              <ProductList products={editing.triggers} empty="No products yet. Choose the products that should trigger this rule."
                onRemove={(id) => updateRule(editing.id, { triggers: editing.triggers.filter((product) => product.id !== id) })} />

              <s-divider />
              <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
                <s-heading>Recommend these products</s-heading>
                <s-button icon="product" onClick={async () => {
                  const recommendations = await pickProducts(editing.recommendations, MAX_RECOMMENDATIONS);
                  if (recommendations) updateRule(editing.id, { recommendations });
                }}>Choose products</s-button>
              </s-stack>
              <ProductList products={editing.recommendations} empty={`No products yet. Choose up to ${MAX_RECOMMENDATIONS}; checkout shows them in this order.`}
                onRemove={(id) => updateRule(editing.id, { recommendations: editing.recommendations.filter((product) => product.id !== id) })} />
              <s-paragraph color="subdued">
                {`Checkout shows up to ${settings.maxProducts} of these, skipping any already in the cart or sold out. If several rules match, their products are combined in rule order.`}
              </s-paragraph>

              <s-stack direction="inline" gap="base">
                <s-button variant="primary" onClick={save} {...(saving ? { loading: true } : {})}>Save</s-button>
                <s-button onClick={() => setEditingId(null)}>Close editor</s-button>
              </s-stack>
            </s-stack>
          </s-section>
        </>
      ) : (
        <>
          <s-section heading="Block settings">
            <s-stack gap="base">
              <s-switch label="Show recommendations in checkout" checked={settings.enabled} onChange={(event) => {
                const enabled = event.currentTarget.checked;
                updateSettings({ enabled });
              }} />
              <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                <s-text-field label="Heading" value={settings.heading} maxLength={100} placeholder={DEFAULT_SETTINGS.heading}
                  onInput={(event) => {
                    const heading = event.currentTarget.value;
                    updateSettings({ heading });
                  }} />
                <s-select label="Products to show" value={String(settings.maxProducts)} onChange={(event) => {
                  const maxProducts = Number(event.currentTarget.value);
                  updateSettings({ maxProducts });
                }}>
                  {Array.from({ length: MAX_SHOWN }, (_, index) => index + 1).map((count) => (
                    <s-option key={count} value={String(count)}>{String(count)}</s-option>
                  ))}
                </s-select>
              </s-grid>
              <s-select label="When no rule matches the cart, show" value={settings.defaultSource} onChange={(event) => {
                const defaultSource = event.currentTarget.value as DefaultSource;
                updateSettings({ defaultSource });
              }}>
                {DEFAULT_SOURCES.map((source) => <s-option key={source.value} value={source.value}>{source.label}</s-option>)}
              </s-select>
              {settings.defaultSource === "shopify" && (
                <s-paragraph color="subdued">{"Shopify picks related products for the items in the cart, the same way \"You may also like\" works on product pages."}</s-paragraph>
              )}
              {settings.defaultSource === "products" && (
                <s-stack gap="small-200">
                  <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
                    <s-text type="strong">Default products</s-text>
                    <s-button icon="product" onClick={async () => {
                      const defaultProducts = await pickProducts(settings.defaultProducts, MAX_RECOMMENDATIONS);
                      if (defaultProducts) updateSettings({ defaultProducts });
                    }}>Choose products</s-button>
                  </s-stack>
                  <ProductList products={settings.defaultProducts} empty="No default products yet."
                    onRemove={(id) => updateSettings({ defaultProducts: settings.defaultProducts.filter((product) => product.id !== id) })} />
                </s-stack>
              )}
              {settings.defaultSource !== "none" && (
                <s-checkbox label="Fill empty spots with the default"
                  details={`If a matching rule has fewer than ${settings.maxProducts} products available, the rest come from the default.`}
                  checked={settings.fillWithDefault} onChange={(event) => {
                    const fillWithDefault = event.currentTarget.checked;
                    updateSettings({ fillWithDefault });
                  }} />
              )}
            </s-stack>
          </s-section>

          <s-section heading={`Rules (${rules.length})`}>
            {rules.length === 0 ? (
              <s-stack gap="base">
                <s-paragraph color="subdued">No rules yet. Create one to choose which products checkout recommends when a certain product is in the cart.</s-paragraph>
                <s-button icon="plus" onClick={createRule}>Create rule</s-button>
              </s-stack>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Rule</s-table-header>
                  <s-table-header>When cart has</s-table-header>
                  <s-table-header>Recommend</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header></s-table-header>
                </s-table-header-row>
                <s-table-body>{rules.map((rule) => (
                  <s-table-row key={rule.id}>
                    <s-table-cell><s-text>{rule.name || "Untitled rule"}</s-text></s-table-cell>
                    <s-table-cell>{titles(rule.triggers)}</s-table-cell>
                    <s-table-cell>{titles(rule.recommendations)}</s-table-cell>
                    <s-table-cell><s-badge tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "Active" : "Off"}</s-badge></s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200">
                        <s-button icon="edit" variant="tertiary" accessibilityLabel="Edit rule" onClick={() => setEditingId(rule.id)} />
                        <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel="Delete rule" onClick={() => removeRule(rule.id)} />
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}</s-table-body>
              </s-table>
            )}
          </s-section>
        </>
      )}

      <s-section slot="aside" heading="How it works">
        <s-stack gap="base">
          <s-paragraph>{"A rule matches when any of its products is in the cart, and checkout recommends that rule's products. Products already in the cart or sold out are skipped."}</s-paragraph>
          <s-paragraph>{"When no rule matches, the block shows the default you pick in Block settings, so it works even before you create any rules."}</s-paragraph>
          <s-paragraph>{"Buyers add a recommended product with one tap. Checkout adds its first available variant."}</s-paragraph>
          <s-paragraph>{"One-time setup: in Settings → Checkout → Customize, add the \"Product recommendations\" app block (below the cart items works best) and save."}</s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}
