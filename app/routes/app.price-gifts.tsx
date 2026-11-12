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

const variantText = (variants: TierGiftProduct[]) => variants
  .map((variant) => variant.variantTitle === "Default Title" ? "Default" : variant.variantTitle).join(", ");
const skuText = (variants: TierGiftProduct[]) => variants.map((variant) => variant.sku).filter(Boolean).join(", ") || "—";

function GiftThumb({ product }: { product: TierGiftProduct }) {
  return <s-stack direction="inline" gap="base" alignItems="center">
    <s-thumbnail src={product.imageUrl || undefined} alt={product.productTitle} size="small" />
    <s-text>{product.productTitle}</s-text>
  </s-stack>;
}

function TierHeader({ tier, index, tiers, onChange, onRemove }: {
  tier: GiftTier; index: number; tiers: GiftTier[]; onChange: (tier: GiftTier) => void; onRemove?: () => void;
}) {
  return <s-grid gridTemplateColumns="1fr 1fr auto" gap="base" alignItems="end">
    <s-number-field label="Minimum cart value" prefix="$" inputMode="numeric" min={0} step={1}
      details={index === 0 ? "Paid cart subtotal, before discounts and without gifts." : `Replaces Tier ${index} from this amount.`}
      value={String(Math.round(tier.minimumSpend / 100))}
      onChange={(event) => onChange({ ...tier, minimumSpend: Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0)) * 100 })} />
    <s-select label="Shopper gets" value={tier.mode}
      onChange={(event) => onChange({ ...tier, mode: event.currentTarget.value === "all" ? "all" : "one" })}>
      <s-option value="one">One gift of their choice</s-option>
      <s-option value="all">All gifts, free</s-option>
    </s-select>
    {onRemove ? <s-button icon="delete" tone="critical" variant="tertiary" onClick={onRemove}>Remove tier</s-button> : <span />}
  </s-grid>;
}

export default function PriceGifts() {
  const data = useLoaderData<typeof loader>();
  if (!data.allowed) {
    return <s-page heading="Price gifts">
      <s-section><s-paragraph>This feature isn't available on this store.</s-paragraph></s-section>
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
    <s-page heading="Price gifts">
      <SaveBar id="price-gifts-save-bar" open={dirty || saving}>
        <button variant="primary" onClick={submit} {...(saving ? { loading: "" } : {})}>Save</button>
        <button onClick={() => setSettings(saved)} disabled={saving}>Discard</button>
      </SaveBar>
      <s-button slot="primary-action" variant="primary" icon="save" disabled={!dirty} onClick={submit} {...(saving ? { loading: true } : {})}>Save</s-button>

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>Spend tiers</s-heading>
            <s-badge tone={live ? "success" : saved.enabled ? "warning" : "neutral"}>{live ? "Live on storefront" : saved.enabled ? "Setup incomplete" : "Paused"}</s-badge>
          </s-stack>
          <s-switch label="Enable price gifts"
            details="While on, the Free Gift App (Master) popup on the cart page offers these tier gifts instead of the Free gift settings products. Popup text and colors still come from Free gift settings."
            checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.currentTarget.checked ?? false }))} />
          {view.tiers.map((tier, index) => <s-text key={tier.id}>
            Tier {index + 1} ({tierRange(view.tiers, index)}): {tier.mode === "all" ? "all of" : "one of"} {
              [...new Set(tier.products.map((product) => product.productTitle))].join(tier.mode === "all" ? " + " : " or ") || "no products yet"}
          </s-text>)}
        </s-stack>
      </s-section>

      {base && <s-section heading={`Tier 1: ${tierRange(view.tiers, 0)}`}>
        <s-stack gap="base">
          <TierHeader tier={base} index={0} tiers={view.tiers} onChange={updateTier}
            onRemove={view.tiers.length === 1 ? () => setTiers([]) : undefined} />
          {base.products.length > 0 && <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Gift product</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header listSlot="secondary">Stock</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>{base.products.map((product) => {
              const stock = stockLabel(product);
              return <s-table-row key={product.variantId}>
                <s-table-cell><GiftThumb product={product} /></s-table-cell>
                <s-table-cell>{product.variantTitle === "Default Title" ? "—" : product.variantTitle}</s-table-cell>
                <s-table-cell>{product.sku || "—"}</s-table-cell>
                <s-table-cell><s-badge tone={stock.tone}>{stock.label}</s-badge></s-table-cell>
                <s-table-cell>
                  <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel={`Remove ${product.productTitle} ${product.variantTitle}`}
                    onClick={() => updateTier({ ...base, products: base.products.filter((item) => item.variantId !== product.variantId) })} />
                </s-table-cell>
              </s-table-row>;
            })}</s-table-body>
          </s-table>}
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button icon="product-add" onClick={pickBaseProducts}>{base.products.length ? "Add or change gift products" : "Select gift products"}</s-button>
            <s-text color="subdued">{countProducts(base.products)}/{MAX_TIER_PRODUCTS} products</s-text>
          </s-stack>
        </s-stack>
      </s-section>}

      {view.tiers.slice(1).map((tier, offset) => {
        const index = offset + 1;
        return <s-section key={tier.id} heading={`Tier ${index + 1}: ${tierRange(view.tiers, index)}`}>
          <s-stack gap="base">
            <TierHeader tier={tier} index={index} tiers={view.tiers} onChange={updateTier}
              onRemove={() => setTiers(view.tiers.filter((item) => item.id !== tier.id))} />
            {baseGroups.length === 0 ? <s-paragraph color="subdued">Choose the Tier 1 gift products first.</s-paragraph> : <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Tier 1 gift</s-table-header>
                <s-table-header>In this tier</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>{baseGroups.map((group) => {
                const replacement = tier.replacements.find((item) => item.fromProductId === group.productId);
                const shown = replacement?.products || group.variants;
                return <s-table-row key={group.productId}>
                  <s-table-cell><GiftThumb product={group.variants[0]} /></s-table-cell>
                  <s-table-cell>
                    {replacement
                      ? <s-stack gap="small-100"><GiftThumb product={replacement.products[0]} /><s-text color="subdued">{variantText(replacement.products)}</s-text></s-stack>
                      : <s-text color="subdued">Same product</s-text>}
                  </s-table-cell>
                  <s-table-cell>{skuText(shown)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button onClick={() => pickReplacement(tier, group.productId)}>{replacement ? "Change" : "Replace with…"}</s-button>
                      {replacement && <s-button variant="tertiary" onClick={() => clearReplacement(tier, group.productId)}>Use same</s-button>}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>;
              })}</s-table-body>
            </s-table>}
          </s-stack>
        </s-section>;
      })}

      <s-section>
        <s-stack gap="base">
          {view.tiers.length < MAX_TIERS && <s-stack direction="inline">
            <s-button icon="plus" onClick={addTier}>{view.tiers.length ? "Add higher tier" : "Add Tier 1"}</s-button>
          </s-stack>}
          <s-text color="subdued">
            Example: Tier 1 from $120, one of Sling 2.0 or T-shirt. Tier 2 from $300, all gifts free, with Sling 2.0 replaced by Sling 3.0, so the shopper gets Sling 3.0 + T-shirt.
          </s-text>
          <s-text color="subdued">Storefront: keep the “Free Gift App (Master)” app embed on in the theme editor.</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
