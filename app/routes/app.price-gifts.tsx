import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import type { DiscountClass as AdminDiscountClass } from "../types/admin.types";
import {
  MAX_TIER_PRODUCTS, MAX_TIERS, PRICE_GIFT_NAMESPACE, baseProductGroups, countProducts, functionSettings,
  newTierId, normalizeSettings, priceGiftsEnabledFor, tierRange,
  type GiftTier, type PriceGiftSettings, type TierGiftProduct,
} from "../services/price-gifts";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

const SETTINGS_QUERY = `#graphql
  query PriceGiftSettings {
    shop {
      id
      metafield(namespace: "tiered_gift", key: "settings") { jsonValue }
    }
  }
`;

// Live title, handle, SKU and stock for every gift and replacement variant.
async function enrichProducts(admin: Admin, settings: PriceGiftSettings) {
  const variantIds = [...new Set(settings.tiers.flatMap((tier) => [
    ...tier.products, ...tier.replacements.flatMap((replacement) => replacement.products),
  ].map((product) => product.variantId)))];
  if (variantIds.length === 0) return settings;
  const response = await admin.graphql(
    `#graphql
      query PriceGiftVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id sku availableForSale inventoryQuantity
            inventoryItem { tracked }
            product { id handle title }
          }
        }
      }
    `,
    { variables: { ids: variantIds } },
  );
  const json = await response.json();
  type Live = { id: string; sku?: string | null; availableForSale: boolean; inventoryQuantity?: number | null;
    inventoryItem: { tracked: boolean }; product: { id: string; handle: string; title: string } };
  const live = new Map<string, Live>(((json.data?.nodes || []) as Array<Live | null>)
    .flatMap((node) => node?.id ? [[node.id, node] as const] : []));
  const refresh = (product: TierGiftProduct): TierGiftProduct => {
    const node = live.get(product.variantId);
    if (!node) return product;
    return {
      ...product,
      productId: node.product.id,
      productTitle: node.product.title,
      productHandle: node.product.handle,
      sku: node.sku || "",
      availableForSale: node.availableForSale,
      inventoryQuantity: node.inventoryQuantity ?? undefined,
      inventoryTracked: node.inventoryItem.tracked,
    };
  };
  return normalizeSettings({
    ...settings,
    tiers: settings.tiers.map((tier) => ({
      ...tier,
      products: tier.products.map(refresh),
      replacements: tier.replacements.map((replacement) => ({ ...replacement, products: replacement.products.map(refresh) })),
    })),
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!priceGiftsEnabledFor(session.shop)) return { allowed: false as const };
  const response = await admin.graphql(SETTINGS_QUERY);
  const result = await response.json();
  return { allowed: true as const, settings: normalizeSettings(result.data?.shop?.metafield?.jsonValue as Partial<PriceGiftSettings>) };
};

async function ensureDiscount(admin: Admin, settings: PriceGiftSettings) {
  const discountInput = {
    title: "Price Gifts (spend tiers)",
    functionHandle: "tiered-gift-discount",
    discountClasses: ["PRODUCT" as AdminDiscountClass],
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
    metafields: [{ namespace: `$app:${PRICE_GIFT_NAMESPACE}`, key: "settings", type: "json", value: functionSettings(settings) }],
  };
  if (settings.discountId) {
    const response = await admin.graphql(
      `#graphql
        mutation UpdatePriceGiftDiscount($id: ID!, $discount: DiscountAutomaticAppInput!) {
          discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
            automaticAppDiscount { discountId }
            userErrors { field message }
          }
        }
      `,
      { variables: { id: settings.discountId, discount: discountInput } },
    );
    const json = await response.json();
    const id = json.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId;
    if (id) return { discountId: id as string };
  }
  const response = await admin.graphql(
    `#graphql
      mutation CreatePriceGiftDiscount($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }
    `,
    { variables: { discount: { ...discountInput, startsAt: new Date().toISOString() } } },
  );
  const json = await response.json();
  const payload = json.data?.discountAutomaticAppCreate;
  const error = payload?.userErrors?.[0]?.message;
  return error ? { warning: `Checkout discount not created: ${error}` } : { discountId: payload?.automaticAppDiscount?.discountId as string | undefined };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!priceGiftsEnabledFor(session.shop)) return { ok: false, error: "Price gifts aren't available on this store." };
  const formData = await request.formData();
  let incoming: PriceGiftSettings;
  try {
    incoming = JSON.parse(String(formData.get("settings"))) as PriceGiftSettings;
  } catch {
    return { ok: false, error: "Your changes couldn't be saved. Reload the page and try again." };
  }
  let settings = normalizeSettings(incoming);
  if (new Set(settings.tiers.map((tier) => tier.minimumSpend)).size !== settings.tiers.length) {
    return { ok: false, error: "Two tiers have the same minimum cart value." };
  }
  if (settings.enabled && (settings.tiers.length === 0 || settings.tiers[0].products.length === 0)) {
    return { ok: false, error: "Choose the Tier 1 gift products before turning price gifts on." };
  }
  settings = await enrichProducts(admin, settings);
  const discount = await ensureDiscount(admin, settings);
  if (discount.discountId) settings.discountId = discount.discountId;

  const shopJson = await (await admin.graphql(SETTINGS_QUERY)).json();
  const saveJson = await (await admin.graphql(
    `#graphql
      mutation SavePriceGiftSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message code }
        }
      }
    `,
    { variables: { metafields: [
      { ownerId: shopJson.data!.shop!.id, namespace: PRICE_GIFT_NAMESPACE, key: "settings", type: "json", value: JSON.stringify(settings) },
    ] } },
  )).json();
  const error = saveJson.data?.metafieldsSet?.userErrors?.[0]?.message;
  if (error) return { ok: false, error };
  return { ok: true, settings, warning: discount.warning };
};

function stockLabel(product: TierGiftProduct): { label: string; tone: "success" | "warning" | "critical" | "neutral" } {
  if (product.availableForSale === false) return { label: "Unavailable", tone: "critical" };
  if (!product.inventoryTracked) return { label: "Not tracked", tone: "neutral" };
  const quantity = Number(product.inventoryQuantity ?? 0);
  if (quantity <= 0) return { label: "Out of stock", tone: "critical" };
  return { label: `${quantity} in stock`, tone: quantity < 5 ? "warning" : "success" };
}

// "FREE GIFT | Zion Cases Short-Sleeve Unisex T-Shirt" -> "Zion Cases Short-Sleeve Unisex T-Shirt"
const shortTitle = (title: string) => title.replace(/^\s*free\s*gift\s*[|:-]\s*/i, "");

// One summary per gift product instead of a row per variant.
function productSummary(variants: TierGiftProduct[]) {
  const skus = variants.filter((variant) => variant.sku).length;
  const unavailable = variants.filter((variant) => stockLabel(variant).tone === "critical").length;
  const tracked = variants.filter((variant) => variant.inventoryTracked);
  const units = tracked.reduce((total, variant) => total + Math.max(0, Number(variant.inventoryQuantity ?? 0)), 0);
  const options = variants.every((variant) => variant.variantTitle === "Default Title")
    ? "No options"
    : `${variants.length} variant${variants.length === 1 ? "" : "s"}`;
  const stock = unavailable
    ? { label: `${unavailable} of ${variants.length} out of stock`, tone: "warning" as const }
    : tracked.length ? { label: `${units} in stock`, tone: "success" as const } : { label: "Not tracked", tone: "neutral" as const };
  return { options, skus: skus ? `${skus} SKU${skus === 1 ? "" : "s"}` : "No SKU", stock };
}

function GiftThumb({ product, size = "small" }: { product: TierGiftProduct; size?: "small" | "small-200" }) {
  return <s-stack direction="inline" gap="small-200" alignItems="center">
    <s-thumbnail src={product.imageUrl || undefined} alt={product.productTitle} size={size} />
    <s-text type="strong">{shortTitle(product.productTitle)}</s-text>
  </s-stack>;
}

// The overview card for one tier: range, what the shopper gets, gift pictures.
function TierCard({ tier, index, tiers }: { tier: GiftTier; index: number; tiers: GiftTier[] }) {
  const groups = baseProductGroups(tier.products);
  return <s-box padding="base" border="base" borderRadius="large" background={index === 0 ? "base" : "subdued"}>
    <s-stack gap="small-300">
      <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
        <s-text color="subdued" type="strong">TIER {index + 1}</s-text>
        <s-badge tone={tier.mode === "all" ? "success" : "info"}>{tier.mode === "all" ? "All gifts free" : "Pick 1 gift"}</s-badge>
      </s-stack>
      <s-heading>{tierRange(tiers, index)}</s-heading>
      {groups.length === 0 ? <s-text color="subdued">No gifts yet</s-text> : groups.map((group, groupIndex) => <s-stack key={group.productId} gap="small-300">
        {groupIndex > 0 && <s-text color="subdued">{tier.mode === "all" ? "+" : "or"}</s-text>}
        <GiftThumb product={group.variants[0]} />
      </s-stack>)}
    </s-stack>
  </s-box>;
}

function TierFields({ tier, index, onChange, onRemove }: {
  tier: GiftTier; index: number; onChange: (tier: GiftTier) => void; onRemove?: () => void;
}) {
  return <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base" alignItems="end">
    <s-number-field label="Starts at cart value" prefix="$" inputMode="numeric" min={0} step={1}
      details={index === 0 ? "Paid subtotal, before discounts, gifts excluded." : `Takes over from Tier ${index} at this amount.`}
      value={String(Math.round(tier.minimumSpend / 100))}
      onChange={(event) => onChange({ ...tier, minimumSpend: Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0)) * 100 })} />
    <s-select label="Shopper gets" value={tier.mode}
      onChange={(event) => onChange({ ...tier, mode: event.currentTarget.value === "all" ? "all" : "one" })}>
      <s-option value="one">Pick 1 gift</s-option>
      <s-option value="all">All gifts free</s-option>
    </s-select>
    {onRemove && <s-stack direction="inline" justifyContent="end">
      <s-button icon="delete" tone="critical" variant="tertiary" onClick={onRemove}>Remove tier</s-button>
    </s-stack>}
  </s-grid>;
}

export default function PriceGifts() {
  const data = useLoaderData<typeof loader>();
  if (!data.allowed) {
    return <s-page heading="Price gifts">
      <s-section><s-paragraph>{"This feature isn't available on this store."}</s-paragraph></s-section>
    </s-page>;
  }
  return <PriceGiftsEditor initial={data.settings} />;
}

function PriceGiftsEditor({ initial }: { initial: PriceGiftSettings }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [saved, setSaved] = useState<PriceGiftSettings>(initial);
  const [settings, setSettings] = useState<PriceGiftSettings>(initial);
  const saving = fetcher.state !== "idle";
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok && "settings" in fetcher.data && fetcher.data.settings) {
      setSettings(fetcher.data.settings); setSaved(fetcher.data.settings);
      shopify.toast.show(fetcher.data.warning || "Price gift settings saved");
    } else if ("error" in fetcher.data && fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  // Always shown normalized: sorted tiers, higher tiers rebuilt from Tier 1.
  const view = useMemo(() => normalizeSettings(settings), [settings]);
  const base = view.tiers[0];
  const baseGroups = base ? baseProductGroups(base.products) : [];
  const setTiers = (tiers: GiftTier[]) => setSettings((current) => ({ ...current, tiers }));
  const updateTier = (next: GiftTier) => setTiers(view.tiers.map((tier) => tier.id === next.id ? next : tier));

  const pick = async (multiple: number | false, current: TierGiftProduct[]) => {
    const selection = await shopify.resourcePicker({
      type: "product", multiple: multiple === false ? false : multiple, filter: { variants: true },
      selectionIds: Array.from(current.reduce((map, product) => {
        const entry = map.get(product.productId) || { id: product.productId, variants: [] as Array<{ id: string }> };
        entry.variants.push({ id: product.variantId });
        return map.set(product.productId, entry);
      }, new Map<string, { id: string; variants: Array<{ id: string }> }>()).values()),
    });
    if (!selection) return null;
    return selection.flatMap((product) => (product.variants || [])
      .filter((variant) => Boolean(variant.id))
      .map((variant): TierGiftProduct => ({
        productId: product.id,
        productTitle: product.title,
        productHandle: product.handle,
        variantId: variant.id!,
        variantTitle: variant.title || "Default Title",
        sku: variant.sku || "",
        imageUrl: variant.image?.originalSrc || product.images?.[0]?.originalSrc || "",
        price: variant.price || "0.00",
        availableForSale: variant.availableForSale !== false,
        inventoryQuantity: variant.inventoryQuantity ?? undefined,
        inventoryTracked: Boolean(variant.inventoryManagement),
        optionNames: (product.options || []).map((option) => option.name),
        optionValues: (variant.selectedOptions || []).map((option) => option.value || ""),
      })));
  };

  const pickBaseProducts = async () => {
    if (!base) return;
    const products = await pick(MAX_TIER_PRODUCTS, base.products);
    if (products) updateTier({ ...base, products });
  };
  const pickReplacement = async (tier: GiftTier, fromProductId: string) => {
    const current = tier.replacements.find((replacement) => replacement.fromProductId === fromProductId)?.products || [];
    const products = await pick(false, current);
    if (!products?.length) return;
    updateTier({ ...tier, replacements: [
      ...tier.replacements.filter((replacement) => replacement.fromProductId !== fromProductId),
      { fromProductId, products },
    ] });
  };
  const clearReplacement = (tier: GiftTier, fromProductId: string) => updateTier({
    ...tier, replacements: tier.replacements.filter((replacement) => replacement.fromProductId !== fromProductId),
  });

  const addTier = () => {
    const highest = view.tiers.at(-1)?.minimumSpend ?? 0;
    setTiers([...view.tiers, {
      id: newTierId(),
      minimumSpend: view.tiers.length ? highest + 10000 : 12000,
      mode: view.tiers.length ? "all" : "one",
      products: [], replacements: [],
    }]);
  };

  const submit = () => fetcher.submit({ settings: JSON.stringify(view) }, { method: "POST", encType: "application/x-www-form-urlencoded" });
  const live = saved.enabled && Boolean(saved.tiers[0]?.products.length) && Boolean(saved.discountId);

  return (
    <s-page heading="Price gifts" inlineSize="large">
      <SaveBar id="price-gifts-save-bar" open={dirty || saving}>
        <button variant="primary" onClick={submit} {...(saving ? { loading: "" } : {})}>Save</button>
        <button onClick={() => setSettings(saved)} disabled={saving}>Discard</button>
      </SaveBar>
      <s-button slot="primary-action" variant="primary" icon="save" disabled={!dirty} onClick={submit} {...(saving ? { loading: true } : {})}>Save</s-button>

      {/* Status */}
      <s-section>
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-stack gap="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-heading>Gifts by cart value</s-heading>
              <s-badge tone={live ? "success" : saved.enabled ? "warning" : "neutral"} icon={live ? "check-circle" : undefined}>
                {live ? "Live" : saved.enabled ? "Setup incomplete" : "Off"}
              </s-badge>
            </s-stack>
            <s-text color="subdued">{"Shoppers get the gifts of their cart's tier in the cart page popup. Popup text and colors come from Free gift settings."}</s-text>
          </s-stack>
          <s-switch label="Enabled" labelAccessibilityVisibility="exclusive" checked={settings.enabled}
            onChange={(event) => setSettings((current) => ({ ...current, enabled: event.currentTarget.checked ?? false }))} />
        </s-grid>
      </s-section>

      {/* Overview */}
      {view.tiers.length > 0 && <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          {view.tiers.map((tier, index) => <TierCard key={tier.id} tier={tier} index={index} tiers={view.tiers} />)}
        </s-grid>
      </s-section>}

      {/* Tier 1 */}
      {base ? <s-section heading={`Tier 1 · ${tierRange(view.tiers, 0)}`}>
        <s-stack gap="base">
          <TierFields tier={base} index={0} onChange={updateTier} onRemove={view.tiers.length === 1 ? () => setTiers([]) : undefined} />
          <s-divider />
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-text type="strong">Gift products ({countProducts(base.products)}/{MAX_TIER_PRODUCTS})</s-text>
            <s-button icon="product-add" onClick={pickBaseProducts}>{base.products.length ? "Add or change" : "Select products"}</s-button>
          </s-stack>
          {baseGroups.length === 0
            ? <s-text color="subdued">Choose the products shoppers can get in this tier.</s-text>
            : <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>Variants</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header listSlot="secondary">Stock</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>{baseGroups.map((group) => {
                const summary = productSummary(group.variants);
                return <s-table-row key={group.productId}>
                  <s-table-cell><GiftThumb product={group.variants[0]} /></s-table-cell>
                  <s-table-cell>{summary.options}</s-table-cell>
                  <s-table-cell>{summary.skus}</s-table-cell>
                  <s-table-cell><s-badge tone={summary.stock.tone}>{summary.stock.label}</s-badge></s-table-cell>
                  <s-table-cell>
                    <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel={`Remove ${group.title}`}
                      onClick={() => updateTier({ ...base, products: base.products.filter((item) => item.productId !== group.productId) })} />
                  </s-table-cell>
                </s-table-row>;
              })}</s-table-body>
            </s-table>}
        </s-stack>
      </s-section> : <s-section>
        <s-stack gap="base" alignItems="center">
          <s-icon type="gift-card" />
          <s-heading>Set up your first tier</s-heading>
          <s-text color="subdued">Example: from $120 the shopper picks Sling 2.0 or a T-shirt.</s-text>
          <s-button variant="primary" icon="plus" onClick={addTier}>Add Tier 1</s-button>
        </s-stack>
      </s-section>}

      {/* Higher tiers */}
      {view.tiers.slice(1).map((tier, offset) => {
        const index = offset + 1;
        return <s-section key={tier.id} heading={`Tier ${index + 1} · ${tierRange(view.tiers, index)}`}>
          <s-stack gap="base">
            <TierFields tier={tier} index={index} onChange={updateTier} onRemove={() => setTiers(view.tiers.filter((item) => item.id !== tier.id))} />
            <s-divider />
            <s-stack gap="small-100">
              <s-text type="strong">Replace Tier 1 gifts</s-text>
              <s-text color="subdued">{`For each Tier 1 gift, choose what the shopper gets in Tier ${index + 1}. Leave "Same product" to keep it.`}</s-text>
            </s-stack>
            {baseGroups.length === 0 ? <s-text color="subdued">Choose the Tier 1 gift products first.</s-text> : <s-stack gap="small-300">
              {baseGroups.map((group) => {
                const replacement = tier.replacements.find((item) => item.fromProductId === group.productId);
                const summary = productSummary(replacement?.products || group.variants);
                return <s-box key={group.productId} padding="small-200" border="base" borderRadius="base">
                  <s-grid gridTemplateColumns="minmax(0, 1fr) auto minmax(0, 1fr) auto" gap="base" alignItems="center">
                    <s-stack gap="small-100">
                      <s-text color="subdued">Tier 1 gift</s-text>
                      <GiftThumb product={group.variants[0]} />
                    </s-stack>
                    <s-icon type="arrow-right" tone={replacement ? "success" : "neutral"} />
                    <s-stack gap="small-100">
                      <s-text color="subdued">{`In Tier ${index + 1}`}</s-text>
                      {replacement
                        ? <s-stack direction="inline" gap="small-200" alignItems="center"><GiftThumb product={replacement.products[0]} /><s-badge tone="success">Replaced</s-badge></s-stack>
                        : <s-stack direction="inline" gap="small-200" alignItems="center"><GiftThumb product={group.variants[0]} /><s-badge>Same product</s-badge></s-stack>}
                      <s-text color="subdued">{summary.options} · {summary.skus}</s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="small-200">
                      {replacement && <s-button variant="tertiary" onClick={() => clearReplacement(tier, group.productId)}>Keep same</s-button>}
                      <s-button variant={replacement ? "secondary" : "primary"} icon="replace" onClick={() => pickReplacement(tier, group.productId)}>
                        {replacement ? "Change" : "Replace with…"}
                      </s-button>
                    </s-stack>
                  </s-grid>
                </s-box>;
              })}
            </s-stack>}
          </s-stack>
        </s-section>;
      })}

      {base && view.tiers.length < MAX_TIERS && <s-section>
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">Add a higher cart value with bigger gifts, e.g. from $300 Sling 3.0 + T-shirt.</s-text>
          <s-button icon="plus" onClick={addTier}>Add higher tier</s-button>
        </s-stack>
      </s-section>}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
