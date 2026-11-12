import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import SectionNavigation from "../components/SectionNavigation";
export { shouldRevalidateSections as shouldRevalidate } from "../services/section-navigation";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import type { DiscountClass as AdminDiscountClass } from "../types/admin.types";
import {
  MAX_TIER_PRODUCTS, MAX_TIERS, PRICE_GIFT_NAMESPACE, countProducts, formatDollars, functionSettings,
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
  return {
    ...settings,
    tiers: settings.tiers.map((tier) => ({
      ...tier,
      products: tier.products.map((product) => {
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
      }),
    })),
  };
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
  if (settings.enabled && settings.tiers.some((tier) => tier.products.length === 0)) {
    return { ok: false, error: "Every tier needs at least one gift product." };
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

function TierCard({ tier, index, tiers, onChange, onRemove, onPick }: {
  tier: GiftTier; index: number; tiers: GiftTier[];
  onChange: (tier: GiftTier) => void; onRemove: () => void; onPick: () => void;
}) {
  const productCount = countProducts(tier.products);
  return <s-section heading={`Tier ${index + 1}: ${tierRange(tiers, index)}`}>
    <s-stack gap="base">
      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
        <s-number-field label="Minimum cart value" prefix="$" inputMode="numeric" min={0} step={1}
          details="Paid cart subtotal, before discounts and without gifts. The tier lasts until the next tier's minimum."
          value={String(Math.round(tier.minimumSpend / 100))}
          onChange={(event) => onChange({ ...tier, minimumSpend: Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0)) * 100 })} />
        <s-select label="Shopper gets" value={tier.mode}
          onChange={(event) => onChange({ ...tier, mode: event.currentTarget.value === "all" ? "all" : "one" })}>
          <s-option value="one">One gift of their choice</s-option>
          <s-option value="all">All gifts below</s-option>
        </s-select>
      </s-grid>

      {tier.products.length === 0 ? (
        <s-paragraph color="subdued">No gift products yet.</s-paragraph>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Variant</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header listSlot="secondary">Stock</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>{tier.products.map((product) => {
            const stock = stockLabel(product);
            return <s-table-row key={product.variantId}>
              <s-table-cell>
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-thumbnail src={product.imageUrl || undefined} alt={product.productTitle} size="small" />
                  <s-text>{product.productTitle}</s-text>
                </s-stack>
              </s-table-cell>
              <s-table-cell>{product.variantTitle === "Default Title" ? "—" : product.variantTitle}</s-table-cell>
              <s-table-cell>{product.sku || "—"}</s-table-cell>
              <s-table-cell><s-badge tone={stock.tone}>{stock.label}</s-badge></s-table-cell>
              <s-table-cell>
                <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel={`Remove ${product.productTitle} ${product.variantTitle}`}
                  onClick={() => onChange({ ...tier, products: tier.products.filter((item) => item.variantId !== product.variantId) })} />
              </s-table-cell>
            </s-table-row>;
          })}</s-table-body>
        </s-table>
      )}
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-button icon="product-add" onClick={onPick}>{productCount ? "Add or change products" : "Select products"}</s-button>
        <s-text color="subdued">{productCount}/{MAX_TIER_PRODUCTS} products. Remove variants you don't want to offer.</s-text>
        <s-button icon="delete" tone="critical" variant="tertiary" onClick={onRemove}>Remove tier</s-button>
      </s-stack>
    </s-stack>
  </s-section>;
}

function Preview({ settings }: { settings: PriceGiftSettings }) {
  return <div style={{ background: settings.overlayColor, borderRadius: 12, padding: 16 }}>
    <div style={{ background: settings.backgroundColor, color: settings.textColor, borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{settings.heading}</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{settings.subheading}</div>
      <div style={{ marginTop: 12, background: settings.buttonColor, color: settings.buttonTextColor, borderRadius: 8, padding: "9px 12px", textAlign: "center", fontSize: 13, fontWeight: 600 }}>
        {settings.buttonLabel}
      </div>
    </div>
  </div>;
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
  const [params] = useSearchParams();
  const requested = params.get("section") || "tiers";
  const section = ["tiers", "content", "setup"].includes(requested) ? requested : "tiers";
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

  const update = <K extends keyof PriceGiftSettings>(key: K, value: PriceGiftSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const updateTier = (id: string, tier: GiftTier) =>
    setSettings((current) => ({ ...current, tiers: current.tiers.map((item) => item.id === id ? tier : item) }));
  const sortedTiers = useMemo(() => [...settings.tiers].sort((a, b) => a.minimumSpend - b.minimumSpend), [settings.tiers]);

  const addTier = () => {
    const highest = sortedTiers.at(-1)?.minimumSpend ?? 0;
    update("tiers", [...settings.tiers, { id: newTierId(), minimumSpend: highest + 10000, mode: "one", products: [] }]);
  };

  const pickProducts = async (tier: GiftTier) => {
    const selection = await shopify.resourcePicker({
      type: "product", multiple: MAX_TIER_PRODUCTS, filter: { variants: true },
      selectionIds: Array.from(tier.products.reduce((map, product) => {
        const entry = map.get(product.productId) || { id: product.productId, variants: [] as Array<{ id: string }> };
        entry.variants.push({ id: product.variantId });
        return map.set(product.productId, entry);
      }, new Map<string, { id: string; variants: Array<{ id: string }> }>()).values()),
    });
    if (!selection) return;
    const products: TierGiftProduct[] = selection.flatMap((product) => (product.variants || [])
      .filter((variant) => Boolean(variant.id))
      .map((variant) => ({
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
    updateTier(tier.id, { ...tier, products: normalizeSettings({ tiers: [{ ...tier, products }] }).tiers[0].products });
  };

  const submit = () => fetcher.submit({ settings: JSON.stringify(settings) }, { method: "POST", encType: "application/x-www-form-urlencoded" });
  const discountReady = Boolean(saved.discountId);
  const savedReady = saved.tiers.length > 0 && saved.tiers.every((tier) => tier.products.length > 0);
  const live = saved.enabled && savedReady && discountReady;

  return (
    <s-page heading="Price gifts">
      <SaveBar id="price-gifts-save-bar" open={dirty || saving}>
        <button variant="primary" onClick={submit} {...(saving ? { loading: "" } : {})}>Save</button>
        <button onClick={() => setSettings(saved)} disabled={saving}>Discard</button>
      </SaveBar>
      <s-button slot="primary-action" variant="primary" icon="save" disabled={!dirty} onClick={submit} {...(saving ? { loading: true } : {})}>Save</s-button>
      <s-button slot="secondary-actions" icon="external" href="shopify://admin/themes/current/editor?context=apps" target="_blank">Theme app embeds</s-button>

      <SectionNavigation label="Price gift sections" current={section} items={[
        { id: "tiers", label: "Spend tiers", href: "/app/price-gifts" },
        { id: "content", label: "Popup text & colors", href: "/app/price-gifts?section=content" },
        { id: "setup", label: "Status & setup", href: "/app/price-gifts?section=setup" },
      ]} />

      {section === "tiers" && <>
        <s-section>
          <s-stack gap="base">
            <s-switch label="Enable price gifts" details="Separate from the Free gift settings. Turn off to pause the popup and the checkout discount."
              checked={settings.enabled} onChange={(event) => update("enabled", event.currentTarget.checked ?? false)} />
            <s-paragraph color="subdued">
              The cart's paid subtotal picks one tier: the highest tier whose minimum it reaches. Example: Tier 1 at $120 gives one of Sling 2.0 or T-shirt; Tier 2 at $300 gives Sling 3.0 and T-shirt.
            </s-paragraph>
          </s-stack>
        </s-section>
        {sortedTiers.map((tier, index) => <TierCard key={tier.id} tier={tier} index={index} tiers={sortedTiers}
          onChange={(next) => updateTier(tier.id, next)}
          onRemove={() => update("tiers", settings.tiers.filter((item) => item.id !== tier.id))}
          onPick={() => pickProducts(tier)} />)}
        {settings.tiers.length < MAX_TIERS && <s-section>
          <s-button icon="plus" onClick={addTier}>Add tier</s-button>
        </s-section>}
      </>}

      {section === "content" && <>
        <s-section heading="Popup text">
          <s-stack gap="base">
            <s-text-field label="Heading" value={settings.heading} onInput={(event) => update("heading", event.currentTarget.value ?? "")} />
            <s-text-field label="Supporting text" value={settings.subheading} onInput={(event) => update("subheading", event.currentTarget.value ?? "")} />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field label="Button label" value={settings.buttonLabel} onInput={(event) => update("buttonLabel", event.currentTarget.value ?? "")} />
              <s-text-field label="Success message" value={settings.successMessage} onInput={(event) => update("successMessage", event.currentTarget.value ?? "")} />
            </s-grid>
          </s-stack>
        </s-section>
        <s-section heading="Popup colors">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-color-field label="Background" value={settings.backgroundColor} onInput={(event) => update("backgroundColor", event.currentTarget.value)} />
            <s-color-field label="Text" value={settings.textColor} onInput={(event) => update("textColor", event.currentTarget.value)} />
            <s-color-field label="Button background" value={settings.buttonColor} onInput={(event) => update("buttonColor", event.currentTarget.value)} />
            <s-color-field label="Button text" value={settings.buttonTextColor} onInput={(event) => update("buttonTextColor", event.currentTarget.value)} />
            <s-color-field label="Page overlay" value={settings.overlayColor} alpha onInput={(event) => update("overlayColor", event.currentTarget.value)} />
          </s-grid>
        </s-section>
        <s-section slot="aside" heading="Preview"><Preview settings={settings} /></s-section>
      </>}

      {section === "setup" && <s-section heading="Status & setup">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>Price gifts</s-heading>
            <s-badge tone={live ? "success" : saved.enabled ? "warning" : "neutral"}>{live ? "Live on storefront" : saved.enabled ? "Setup incomplete" : "Paused"}</s-badge>
          </s-stack>
          {saved.tiers.map((tier, index) => <s-text key={tier.id}>
            {tierRange(saved.tiers, index)}: {tier.mode === "all" ? "all of" : "one of"} {[...new Set(tier.products.map((product) => product.productTitle))].join(", ") || "no products"}
          </s-text>)}
          <s-text>Checkout discount: {discountReady ? "Active" : "Save to create"}</s-text>
          <s-text>Theme: in the theme editor, open App embeds and turn on “Price Gifts”. Turn off “Free Gift App (Master)” while testing so the two popups don't both show.</s-text>
          <s-link href="shopify://admin/themes/current/editor?context=apps" target="_blank">Open theme editor</s-link>
          <s-text color="subdued">Lowest tier: {saved.tiers[0] ? formatDollars(saved.tiers[0].minimumSpend) : "—"}</s-text>
        </s-stack>
      </s-section>}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
