import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import type { DiscountClass as AdminDiscountClass } from "../types/admin.types";
import {
  MAX_TIER_PRODUCTS, MAX_TIERS, PRICE_GIFT_NAMESPACE, productGroups, countProducts, functionSettings,
  newTierId, normalizeSettings, priceGiftsEnabledFor, tierRange, tierRangeErrors,
  type GiftTier, type PriceGiftSettings, type TierGiftProduct,
} from "../services/price-gifts";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

const SETTINGS_QUERY = `#graphql
  query PriceGiftSettings {
    shop {
      id
      currencyCode
      metafield(namespace: "tiered_gift", key: "settings") { jsonValue }
    }
  }
`;

// Live title, handle, SKU and stock for every gift variant.
async function enrichProducts(admin: Admin, settings: PriceGiftSettings) {
  const variantIds = [...new Set(settings.tiers.flatMap((tier) => tier.products.map((product) => product.variantId)))];
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
    tiers: settings.tiers.map((tier) => ({ ...tier, products: tier.products.map(refresh) })),
  });
}

// Every current variant of each gift product, for the "shown in the popup"
// checkboxes (the popup offers all of a gift product's variants).
export type GiftVariantChoice = { id: string; title: string; soldOut: boolean };
async function giftProductVariants(admin: Admin, settings: PriceGiftSettings) {
  const productIds = [...new Set(settings.tiers.flatMap((tier) => tier.products.map((product) => product.productId)))];
  if (productIds.length === 0) return {} as Record<string, GiftVariantChoice[]>;
  const response = await admin.graphql(
    `#graphql
      query PriceGiftProductVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            variants(first: 100) { nodes { id title availableForSale } }
          }
        }
      }
    `,
    { variables: { ids: productIds } },
  );
  const json = await response.json();
  type Node = { id: string; variants: { nodes: Array<{ id: string; title: string; availableForSale: boolean }> } };
  return Object.fromEntries(((json.data?.nodes || []) as Array<Node | null>).flatMap((node) => node?.id
    ? [[node.id, node.variants.nodes.map((variant) => ({ id: variant.id, title: variant.title, soldOut: !variant.availableForSale }))]]
    : [])) as Record<string, GiftVariantChoice[]>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!priceGiftsEnabledFor(session.shop)) return { allowed: false as const };
  const response = await admin.graphql(SETTINGS_QUERY);
  const result = await response.json();
  const settings = normalizeSettings(result.data?.shop?.metafield?.jsonValue as Partial<PriceGiftSettings>);
  let variants: Record<string, GiftVariantChoice[]> = {};
  try { variants = await giftProductVariants(admin, settings); } catch { variants = {}; }
  return { allowed: true as const, settings, variants };
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
  const rangeError = tierRangeErrors(settings.tiers)[0];
  if (rangeError) {
    return { ok: false, error: rangeError };
  }
  const tooFew = settings.tiers.findIndex((tier) => tier.mode === "two" && countProducts(tier.products) < 2);
  if (settings.enabled && tooFew >= 0) return { ok: false, error: `Tier ${tooFew + 1}: choose at least two different gift products.` };
  const tierTwoProducts = settings.tiers[1] ? countProducts(settings.tiers[1].products) : 0;
  if (settings.enabled && settings.tiers.length > 1 && tierTwoProducts < 3) {
    return { ok: false, error: "Tier 2: choose three different gift products so shoppers can pick two." };
  }
  const emptyTier = settings.tiers.findIndex((tier) => tier.products.length === 0);
  if (settings.enabled && (settings.tiers.length === 0 || emptyTier >= 0)) {
    return { ok: false, error: `Choose the Tier ${Math.max(emptyTier, 0) + 1} gift products before turning price gifts on.` };
  }
  settings = await enrichProducts(admin, settings);
  const shopJson = await (await admin.graphql(SETTINGS_QUERY)).json();
  settings.shopCurrency = shopJson.data?.shop?.currencyCode;
  const discount = await ensureDiscount(admin, settings);
  if (discount.discountId) settings.discountId = discount.discountId;

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
  let variants: Record<string, GiftVariantChoice[]> = {};
  try { variants = await giftProductVariants(admin, settings); } catch { variants = {}; }
  return { ok: true, settings, variants, warning: discount.warning };
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

// Tier title with its Remove button, then the cart value range and gift rule.
// Tier 2 lets shoppers choose two gifts from three options.
function TierFields({ tier, index, tiers, onChange, onRemove }: {
  tier: GiftTier; index: number; tiers: GiftTier[]; onChange: (tier: GiftTier) => void; onRemove?: () => void;
}) {
  const next = tiers[index + 1];
  // This tier's own range problems, shown under its fields.
  const errors = tierRangeErrors(tiers).filter((error) => error.startsWith(`Tier ${index + 1}:`) || error.startsWith(`Tier ${index + 1} `));
  return <s-stack gap="base">
    <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-heading>Tier {index + 1}</s-heading>
        <s-badge>{tierRange(tiers, index)}</s-badge>
        <s-badge tone="info">{tier.mode === "all" ? "All gifts free" : tier.mode === "two" ? "Pick 2 gifts" : "Pick 1 gift"}</s-badge>
      </s-stack>
      {onRemove ? <s-button icon="delete" tone="critical" variant="tertiary" onClick={onRemove}>Remove tier</s-button> : <span />}
    </s-grid>
    <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base" alignItems="start">
      <s-number-field label="Min cart value" prefix="$" inputMode="numeric" min={0} step={1}
        details={index === 0 ? "Paid subtotal, before discounts, gifts excluded." : `From here this tier's gifts replace Tier ${index}'s.`}
        value={String(Math.round(tier.minimumSpend / 100))}
        onChange={(event) => onChange({ ...tier, minimumSpend: Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0)) * 100 })} />
      <s-number-field label="Max cart value" prefix="$" inputMode="numeric" min={0} step={1}
        placeholder={next ? String(Math.round(next.minimumSpend / 100) - 1) : "No limit"}
        details={next ? `Leave empty to run until Tier ${index + 2} starts.` : "Leave empty for no upper limit."}
        value={tier.maximumSpend == null ? "" : String(Math.round(tier.maximumSpend / 100))}
        onChange={(event) => {
          const raw = String(event.currentTarget.value ?? "").trim();
          onChange({ ...tier, maximumSpend: raw === "" ? null : Math.max(0, Math.trunc(Number(raw) || 0)) * 100 });
        }} />
      <s-select label="Gift rule" value={tier.mode} disabled
        details={tier.mode === "all" ? "The shopper gets every gift below." : tier.mode === "two" ? "The shopper chooses two different gifts below." : "The shopper chooses one gift below."}
        onChange={(event) => onChange({ ...tier, mode: event.currentTarget.value === "all" ? "all" : event.currentTarget.value === "two" ? "two" : "one" })}>
        <s-option value="one">Pick 1 gift</s-option>
        <s-option value="two">Pick 2 gifts</s-option>


      </s-select>
    </s-grid>
    {errors.map((error) => <s-text key={error} tone="critical">{error}</s-text>)}
  </s-stack>;
}

export default function PriceGifts() {
  const data = useLoaderData<typeof loader>();
  if (!data.allowed) {
    return <s-page heading="Price gifts">
      <s-section><s-paragraph>{"This feature isn't available on this store."}</s-paragraph></s-section>
    </s-page>;
  }
  return <PriceGiftsEditor initial={data.settings} initialVariants={data.variants} />;
}

function PriceGiftsEditor({ initial, initialVariants }: { initial: PriceGiftSettings; initialVariants: Record<string, GiftVariantChoice[]> }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [saved, setSaved] = useState<PriceGiftSettings>(initial);
  const [settings, setSettings] = useState<PriceGiftSettings>(initial);
  const [variantChoices, setVariantChoices] = useState<Record<string, GiftVariantChoice[]>>(initialVariants);
  const saving = fetcher.state !== "idle";
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok && "settings" in fetcher.data && fetcher.data.settings) {
      setSettings(fetcher.data.settings); setSaved(fetcher.data.settings);
      if ("variants" in fetcher.data && fetcher.data.variants) setVariantChoices(fetcher.data.variants);
      shopify.toast.show(fetcher.data.warning || "Price gift settings saved");
    } else if ("error" in fetcher.data && fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  // Always shown normalized: tiers sorted low to high.
  const view = useMemo(() => normalizeSettings(settings), [settings]);
  const setTiers = (tiers: GiftTier[]) => setSettings((current) => ({ ...current, tiers }));
  const updateTier = (next: GiftTier) => setSettings((current) => ({
    ...current,
    tiers: normalizeSettings(current).tiers.map((tier) => tier.id === next.id
      ? { ...tier, ...next, products: next.products.map((product) => ({ ...product })) }
      : tier),
  }));
  const updateTierProducts = (tierId: string, products: TierGiftProduct[]) => setSettings((current) => ({
    ...current,
    tiers: normalizeSettings(current).tiers.map((tier) => tier.id === tierId
      ? { ...tier, products: products.map((product) => ({ ...product })) }
      : tier),
  }));

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

  const pickProducts = async (tier: GiftTier) => {
    const products = await pick(MAX_TIER_PRODUCTS, tier.products);
    if (products) updateTierProducts(tier.id, products);
  };

  // Start the next tier with a copy of the previous tier's choices, so
  // changing the higher-tier products never edits the lower tier's list.
  const addTier = () => {
    const id = newTierId();
    setSettings((current) => {
      const tiers = normalizeSettings(current).tiers;
      const previous = tiers.at(-1);
      return { ...current, tiers: [...tiers, {
        id,
        minimumSpend: previous ? previous.minimumSpend + 20000 : 15000,
        mode: "one",
        products: previous ? previous.products.map((product) => ({ ...product })) : [],
      }] };
    });
  };

  const submit = () => fetcher.submit({ settings: JSON.stringify(view) }, { method: "POST", encType: "application/x-www-form-urlencoded" });
  const live = saved.enabled && saved.tiers.length > 0 && saved.tiers.every((tier) => tier.products.length > 0) && Boolean(saved.discountId);

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
            onChange={(event) => { const enabled = Boolean(event.currentTarget?.checked); setSettings((current) => ({ ...current, enabled })); }} />
        </s-grid>
      </s-section>

      {view.tiers.length === 0 && <s-section>
        <s-stack gap="base" alignItems="center">
          <s-icon type="gift-card" />
          <s-heading>Set up your first tier</s-heading>
          <s-text color="subdued">Example: from $150 the shopper picks 1 gift; from $350 they pick 2 of 3 gifts.</s-text>
          <s-button variant="primary" icon="plus" onClick={addTier}>Add Tier 1</s-button>
        </s-stack>
      </s-section>}

      {/* One section per tier: range, gift rule and its own gift products. */}
      {view.tiers.map((tier, index) => {
        const groups = productGroups(tier.products);
        return <s-section key={tier.id}>
          <s-stack gap="base">
            <TierFields tier={tier} index={index} tiers={view.tiers} onChange={updateTier}
              onRemove={() => setTiers(view.tiers.filter((item) => item.id !== tier.id))} />
            <s-divider />
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text type="strong">Gift products ({countProducts(tier.products)}/{MAX_TIER_PRODUCTS})</s-text>
              <s-button icon="product-add" onClick={() => pickProducts(tier)}>{tier.products.length ? "Add or change" : "Select products"}</s-button>
            </s-stack>
            {groups.length === 0
              ? <s-text color="subdued">Choose the products shoppers get in this tier.</s-text>
              : <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header>Variants</s-table-header>
                  <s-table-header>SKU</s-table-header>
                  <s-table-header listSlot="secondary">Stock</s-table-header>
                  <s-table-header></s-table-header>
                </s-table-header-row>
                <s-table-body>{groups.map((group) => {
                  const summary = productSummary(group.variants);
                  return <s-table-row key={group.productId}>
                    <s-table-cell><GiftThumb product={group.variants[0]} /></s-table-cell>
                    <s-table-cell>{summary.options}</s-table-cell>
                    <s-table-cell>{summary.skus}</s-table-cell>
                    <s-table-cell><s-badge tone={summary.stock.tone}>{summary.stock.label}</s-badge></s-table-cell>
                    <s-table-cell>
                      <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel={`Remove ${group.title}`}
                        onClick={() => updateTier({ ...tier, products: tier.products.filter((item) => item.productId !== group.productId) })} />
                    </s-table-cell>
                  </s-table-row>;
                })}</s-table-body>
              </s-table>}
          </s-stack>
        </s-section>;
      })}

      {/* Per gift product: is its page open, and which variants the popup offers. */}
      {(() => {
        const products = productGroups(view.tiers.flatMap((tier) => tier.products));
        if (products.length === 0) return null;
        const hidden = new Set(view.hiddenVariantIds || []);
        const allowed = new Set(view.allowProductPageIds || []);
        const setHidden = (variantId: string, hide: boolean) => setSettings((current) => {
          const next = new Set(current.hiddenVariantIds || []);
          if (hide) next.add(variantId); else next.delete(variantId);
          return { ...current, hiddenVariantIds: [...next] };
        });
        const setPageOpen = (productId: string, open: boolean) => setSettings((current) => {
          const next = new Set(current.allowProductPageIds || []);
          if (open) next.add(productId); else next.delete(productId);
          return { ...current, allowProductPageIds: [...next] };
        });
        return <s-section heading="Gift product pages and variants">
          <s-stack gap="base">
            <s-text color="subdued">Gift product pages send shoppers to the cart, so gifts are only claimed in the popup. Untick a variant to keep it out of the popup; sold-out variants never show.</s-text>
            {products.map((group, index) => {
              const choices = variantChoices[group.productId];
              return <s-stack key={group.productId} gap="small-300">
                {index > 0 && <s-divider />}
                <GiftThumb product={group.variants[0]} />
                <s-checkbox label="Send shoppers to the cart when they open this product's page"
                  details="Untick if this product is also sold on its own."
                  checked={!allowed.has(group.productId)}
                  onChange={(event) => setPageOpen(group.productId, !event.currentTarget.checked)} />
                <s-text type="strong">Shown in the gift popup</s-text>
                {!choices
                  ? <s-text color="subdued">Save to load this product&apos;s variants.</s-text>
                  : choices.length <= 1 && (choices[0]?.title === "Default Title")
                    ? <s-text color="subdued">No variants: the product itself is offered.</s-text>
                    : <s-grid gridTemplateColumns="repeat(auto-fill, minmax(180px, 1fr))" gap="small-200">
                      {choices.map((variant) => <s-checkbox key={variant.id}
                        label={variant.soldOut ? `${variant.title} (sold out)` : variant.title}
                        disabled={variant.soldOut}
                        checked={!variant.soldOut && !hidden.has(variant.id)}
                        onChange={(event) => setHidden(variant.id, !event.currentTarget.checked)} />)}
                    </s-grid>}
              </s-stack>;
            })}
          </s-stack>
        </s-section>;
      })()}

      {view.tiers.length > 0 && view.tiers.length < MAX_TIERS && <s-section>
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">Tier 2 unlocks 2 gifts from 3 options. A previously claimed Tier 1 gift counts as one of the two when it is also offered in Tier 2.</s-text>
          <s-button icon="plus" onClick={addTier}>Add higher tier</s-button>
        </s-stack>
      </s-section>}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
