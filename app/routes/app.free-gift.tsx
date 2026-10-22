import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import type { DiscountClass as AdminDiscountClass } from "../types/admin.types";

type GiftProduct = {
  productId: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
  imageUrl: string;
  price: string;
  productHandle?: string;
  availableForSale?: boolean;
  inventoryQuantity?: number;
  inventoryTracked?: boolean;
  optionNames?: string[];
  optionValues?: string[];
};
type GiftSettings = {
  enabled: boolean; minimumSpend: number; heading: string; subheading: string;
  buttonLabel: string; successMessage: string; backgroundColor: string;
  textColor: string; buttonColor: string; buttonTextColor: string;
  overlayColor: string; products: GiftProduct[]; discountId?: string;
};

const DEFAULT_SETTINGS: GiftSettings = {
  enabled: true,
  minimumSpend: 1000,
  heading: "Choose your free gift",
  subheading: "Your cart qualifies. Pick one gift before checkout.",
  buttonLabel: "Add free gift",
  successMessage: "Your free gift was added to the cart.",
  backgroundColor: "#FFFFFF",
  textColor: "#111111",
  buttonColor: "#111111",
  buttonTextColor: "#FFFFFF",
  overlayColor: "#000000B3",
  products: [],
};

const MAX_GIFT_PRODUCTS = 5;

function limitGiftProducts(products: GiftProduct[]) {
  const allowedProductIds = new Set<string>();
  const seenVariantIds = new Set<string>();

  return products.filter((product) => {
    if (!allowedProductIds.has(product.productId)) {
      if (allowedProductIds.size >= MAX_GIFT_PRODUCTS) return false;
      allowedProductIds.add(product.productId);
    }
    if (seenVariantIds.has(product.variantId)) return false;
    seenVariantIds.add(product.variantId);
    return true;
  });
}

function countGiftProducts(products: GiftProduct[]) {
  return new Set(products.map((product) => product.productId)).size;
}

const SETTINGS_QUERY = `#graphql
  query FreeGiftSettings {
    shop {
      id
      metafield(namespace: "free_gift_cart", key: "settings") { jsonValue }
    }
  }
`;

async function enrichGiftProducts(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  products: GiftProduct[],
) {
  if (products.length === 0) return products;
  const response = await admin.graphql(
    `#graphql
      query GiftVariantInventory($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            availableForSale
            inventoryQuantity
            inventoryItem { tracked }
            product { id handle title }
          }
        }
      }
    `,
    { variables: { ids: products.map((product) => product.variantId) } },
  );
  const json = await response.json();
  type LiveVariant = {
    id: string;
    availableForSale: boolean;
    inventoryQuantity?: number | null;
    inventoryItem: { tracked: boolean };
    product: { id: string; handle: string; title: string };
  };
  const nodes = (json.data?.nodes || []) as Array<LiveVariant | null>;
  const inventoryByVariant = new Map<string, LiveVariant>(
    nodes.flatMap((node) => node?.id ? [[node.id, node] as const] : []),
  );
  return products.map((product) => {
    const live = inventoryByVariant.get(product.variantId);
    if (!live) return product;
    return {
      ...product,
      productId: live.product.id,
      productTitle: live.product.title,
      productHandle: live.product.handle,
      availableForSale: live.availableForSale,
      inventoryQuantity: live.inventoryQuantity ?? undefined,
      inventoryTracked: live.inventoryItem.tracked,
    };
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(SETTINGS_QUERY);
  const result = await response.json();
  const saved = result.data?.shop?.metafield?.jsonValue as Partial<GiftSettings> | undefined;
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...saved,
      products: Array.isArray(saved?.products) ? limitGiftProducts(saved.products) : [],
    },
  };
};

async function ensureAutomaticDiscount(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  settings: GiftSettings,
  existingDiscountId?: string,
) {
  const discountInput = {
    title: "Free Gift Cart",
    functionHandle: "free-gift-discount",
    discountClasses: ["PRODUCT" as AdminDiscountClass],
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
    metafields: [{
      namespace: "$app:free_gift_cart",
      key: "settings",
      type: "json",
      value: JSON.stringify(settings),
    }],
  };

  if (existingDiscountId) {
    const updateResponse = await admin.graphql(
      `#graphql
        mutation UpdateFreeGiftDiscount($id: ID!, $discount: DiscountAutomaticAppInput!) {
          discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
            automaticAppDiscount { discountId }
            userErrors { field message }
          }
        }
      `,
      { variables: { id: existingDiscountId, discount: discountInput } },
    );
    const updateJson = await updateResponse.json();
    const updated = updateJson.data?.discountAutomaticAppUpdate;
    if (updated?.automaticAppDiscount?.discountId) {
      return { discountId: updated.automaticAppDiscount.discountId as string };
    }
  }

  const response = await admin.graphql(
    `#graphql
      mutation CreateFreeGiftDiscount($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        discount: { ...discountInput, startsAt: new Date().toISOString() },
      },
    },
  );
  const json = await response.json();
  const payload = json.data?.discountAutomaticAppCreate;
  const error = payload?.userErrors?.[0]?.message;
  return error ? { warning: error } : { discountId: payload?.automaticAppDiscount?.discountId as string | undefined };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  let incoming: GiftSettings;
  try {
    incoming = JSON.parse(String(formData.get("settings"))) as GiftSettings;
  } catch {
    return { ok: false, error: "Your changes couldn't be saved. Reload the page and try again." };
  }
  const settings: GiftSettings = {
    ...DEFAULT_SETTINGS,
    ...incoming,
    enabled: Boolean(incoming.enabled),
    minimumSpend: Math.max(0, Math.round(Number(incoming.minimumSpend) || 0)),
    products: Array.isArray(incoming.products) ? limitGiftProducts(incoming.products) : [],
  };
  if (settings.products.some((product) => !product.variantId)) {
    return { ok: false, error: "Every gift must have a selected variant." };
  }
  settings.products = await enrichGiftProducts(admin, settings.products);

  const discount = await ensureAutomaticDiscount(admin, settings, settings.discountId);
  if (discount.discountId) settings.discountId = discount.discountId;
  const shopResponse = await admin.graphql(SETTINGS_QUERY);
  const shopJson = await shopResponse.json();
  const saveResponse = await admin.graphql(
    `#graphql
      mutation SaveFreeGiftSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message code }
        }
      }
    `,
    { variables: { metafields: [{ ownerId: shopJson.data!.shop!.id, namespace: "free_gift_cart", key: "settings", type: "json", value: JSON.stringify(settings) }] } },
  );
  const saveJson = await saveResponse.json();
  const error = saveJson.data?.metafieldsSet?.userErrors?.[0]?.message;
  if (error) return { ok: false, error };
  return { ok: true, settings, warning: discount.warning };
};

type StockState = { label: string; tone: "success" | "warning" | "critical" | "neutral" };

function stockState(product: GiftProduct): StockState {
  if (product.availableForSale === false) return { label: "Unavailable", tone: "critical" };
  if (!product.inventoryTracked) return { label: "Not tracked", tone: "neutral" };
  const quantity = Number(product.inventoryQuantity ?? 0);
  if (quantity <= 0) return { label: "Out of stock", tone: "critical" };
  return { label: `${quantity} in stock`, tone: quantity < 5 ? "warning" : "success" };
}

function Metric({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return <s-box padding="base" border="base" borderRadius="base">
    <s-stack gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
      {children}
    </s-stack>
  </s-box>;
}

// A scaled-down copy of the storefront popup so colour and copy changes can be judged before saving.
function PopupPreview({ settings }: { settings: GiftSettings }) {
  const gifts = Array.from(new Map(settings.products.map((product) => [product.productId, product])).values()).slice(0, 3);
  return <div style={{ background: settings.overlayColor, borderRadius: 12, padding: 16 }}>
    <div style={{ background: settings.backgroundColor, color: settings.textColor, borderRadius: 12, padding: 16, boxShadow: "0 8px 24px rgba(0,0,0,.18)", fontFamily: "inherit" }}>
      <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.3 }}>{settings.heading || "Choose your free gift"}</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{settings.subheading}</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, gifts.length)}, 1fr)`, gap: 8, marginTop: 12 }}>
        {(gifts.length ? gifts : [null]).map((gift, index) => (
          <div key={gift?.productId ?? index} style={{ border: `${index === 0 ? 2 : 1}px solid ${index === 0 ? settings.buttonColor : "rgba(127,127,127,.3)"}`, borderRadius: 8, padding: 6, textAlign: "center" }}>
            <div style={{ aspectRatio: "1", borderRadius: 6, background: "rgba(127,127,127,.12)", overflow: "hidden" }}>
              {gift?.imageUrl && <img src={gift.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gift?.productTitle ?? "Gift product"}</div>
            <div style={{ fontSize: 10, fontWeight: 700, marginTop: 2 }}>FREE</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, background: settings.buttonColor, color: settings.buttonTextColor, borderRadius: 8, padding: "9px 12px", textAlign: "center", fontSize: 13, fontWeight: 600 }}>
        {settings.buttonLabel || "Add free gift"}
      </div>
    </div>
  </div>;
}

function SetupStep({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return <s-grid gridTemplateColumns="auto 1fr" gap="small-200" alignItems="start">
    <s-icon type={done ? "check-circle" : "circle-dashed"} tone={done ? "success" : "neutral"} />
    <s-stack gap="small-100">
      <s-text type={done ? undefined : "strong"}>{title}</s-text>
      {children}
    </s-stack>
  </s-grid>;
}

export default function Index() {
  const initial = useLoaderData<typeof loader>().settings;
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [saved, setSaved] = useState<GiftSettings>(initial);
  const [settings, setSettings] = useState<GiftSettings>(initial);
  const saving = fetcher.state !== "idle";
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      if (fetcher.data.settings) { setSettings(fetcher.data.settings); setSaved(fetcher.data.settings); }
      shopify.toast.show(fetcher.data.warning || "Free gift settings saved");
    } else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const selectedIds = useMemo(() => Array.from(
    new Set(settings.products.map((product) => product.productId)),
    (id) => ({ id }),
  ), [settings.products]);
  const selectedProductCount = useMemo(() => countGiftProducts(settings.products), [settings.products]);
  const outOfStock = settings.products.filter((product) => stockState(product).tone === "critical").length;
  const discountReady = Boolean(saved.discountId);
  const live = saved.enabled && countGiftProducts(saved.products) > 0 && discountReady;
  const update = <K extends keyof GiftSettings>(key: K, value: GiftSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const chooseProducts = async () => {
    const selection = await shopify.resourcePicker({ type: "product", multiple: MAX_GIFT_PRODUCTS, selectionIds: selectedIds, filter: { variants: false } });
    if (!selection) return;
    const products: GiftProduct[] = selection.flatMap((product) => (product.variants || [])
      .filter((variant) => Boolean(variant.id))
      .map((variant) => ({
      productId: product.id,
      productTitle: product.title,
      variantId: variant.id!,
      variantTitle: variant.title || "Default Title",
      imageUrl: variant.image?.originalSrc || product.images?.[0]?.originalSrc || "",
      price: variant.price || "0.00",
      productHandle: product.handle,
      availableForSale: variant.availableForSale !== false,
      inventoryQuantity: variant.inventoryQuantity ?? undefined,
      inventoryTracked: Boolean(variant.inventoryManagement),
      optionNames: (product.options || []).map((option) => option.name),
      optionValues: (variant.selectedOptions || []).map((option) => option.value || ""),
    })));
    setSettings((current) => {
      const selectedProductIds = new Set(products.map((product) => product.productId));
      const unchangedProducts = current.products.filter((product) => !selectedProductIds.has(product.productId));
      return { ...current, products: limitGiftProducts([...unchangedProducts, ...products]) };
    });
    if (countGiftProducts(products) > MAX_GIFT_PRODUCTS) shopify.toast.show("Only the first 5 products were kept");
  };
  const submit = () => fetcher.submit({ settings: JSON.stringify(settings) }, { method: "POST", encType: "application/x-www-form-urlencoded" });

  return (
    <s-page heading="Free gift settings">
      <SaveBar id="free-gift-save-bar" open={dirty || saving}>
        <button variant="primary" onClick={submit} {...(saving ? { loading: "" } : {})}>Save</button>
        <button onClick={() => setSettings(saved)} disabled={saving}>Discard</button>
      </SaveBar>
      <s-button slot="primary-action" variant="primary" icon="save" disabled={!dirty} onClick={submit} {...(saving ? { loading: true } : {})}>Save</s-button>
      <s-button slot="secondary-actions" icon="external" href="shopify://admin/themes/current/editor?context=apps" target="_blank">Theme app embeds</s-button>

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>Gift offer</s-heading>
            <s-badge tone={live ? "success" : saved.enabled ? "warning" : "neutral"} icon={live ? "check-circle" : undefined}>
              {live ? "Live on storefront" : saved.enabled ? "Setup incomplete" : "Paused"}
            </s-badge>
          </s-stack>
          <s-paragraph color="subdued">Shoppers whose cart reaches the minimum value choose one free gift on the cart page. The gift is discounted to $0 automatically at checkout.</s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
            <Metric label="Minimum cart value" value={`$${Math.round(saved.minimumSpend / 100).toLocaleString("en")}`} />
            <Metric label="Gift products" value={`${countGiftProducts(saved.products)} / ${MAX_GIFT_PRODUCTS}`}>
              <s-text color="subdued">{saved.products.length} variant{saved.products.length === 1 ? "" : "s"}</s-text>
            </Metric>
            <Metric label="Stock" value={outOfStock ? `${outOfStock} unavailable` : "All in stock"}>
              <s-badge tone={outOfStock ? "warning" : "success"}>{outOfStock ? "Hidden from shoppers" : "Healthy"}</s-badge>
            </Metric>
            <Metric label="Checkout discount" value={discountReady ? "Active" : "Not created"}>
              <s-badge tone={discountReady ? "success" : "caution"}>{discountReady ? "Automatic" : "Save to create"}</s-badge>
            </Metric>
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Offer">
        <s-stack gap="base">
          <s-switch label="Enable free gift offer" details="Turn off to pause the popup and the checkout discount without losing your settings." checked={settings.enabled}
            onChange={(event) => update("enabled", event.currentTarget.checked ?? false)} />
          <s-number-field label="Minimum cart value" name="minimumSpend" prefix="$" inputMode="numeric" min={0} step={1}
            details="The popup appears when the cart subtotal, excluding the gift, reaches this amount. Shoppers paying in other currencies see the converted value."
            value={String(Math.round(settings.minimumSpend / 100))} onInput={(event) => {
              const wholeDollars = Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0));
              if (event.currentTarget.value !== String(wholeDollars)) event.currentTarget.value = String(wholeDollars);
              update("minimumSpend", wholeDollars * 100);
            }} />
        </s-stack>
      </s-section>

      <s-section heading={`Gift products (${selectedProductCount}/${MAX_GIFT_PRODUCTS})`}>
        {settings.products.length === 0 ? (
          <s-box padding="large-200">
            <s-stack gap="base" alignItems="center">
              <s-icon type="gift-card" size="base" />
              <s-heading>Add your first gift</s-heading>
              <s-paragraph color="subdued">Choose up to {MAX_GIFT_PRODUCTS} products. Shoppers pick one of their variants in the popup.</s-paragraph>
              <s-button variant="primary" icon="product-add" onClick={chooseProducts}>Select products</s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-stack gap="base">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>Variant</s-table-header>
                <s-table-header format="currency">Price</s-table-header>
                <s-table-header listSlot="secondary">Stock</s-table-header>
                <s-table-header></s-table-header>
              </s-table-header-row>
              <s-table-body>{settings.products.map((product) => {
                const stock = stockState(product);
                return <s-table-row key={product.variantId}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-thumbnail src={product.imageUrl || undefined} alt={product.productTitle} size="small" />
                      <s-link href={`shopify://admin/products/${product.productId.split("/").pop()}`} target="_blank">{product.productTitle}</s-link>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{product.variantTitle === "Default Title" ? "—" : product.variantTitle}</s-table-cell>
                  <s-table-cell>${product.price}</s-table-cell>
                  <s-table-cell><s-badge tone={stock.tone}>{stock.label}</s-badge></s-table-cell>
                  <s-table-cell>
                    <s-button icon="delete" variant="tertiary" tone="critical" accessibilityLabel={`Remove ${product.productTitle}`}
                      onClick={() => update("products", settings.products.filter((item) => item.productId !== product.productId))} />
                  </s-table-cell>
                </s-table-row>;
              })}</s-table-body>
            </s-table>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button icon="product-add" onClick={chooseProducts}>{selectedProductCount >= MAX_GIFT_PRODUCTS ? "Change products" : "Add or change products"}</s-button>
              {outOfStock > 0 && <s-text color="subdued">{"Unavailable variants are hidden from shoppers until they're back in stock."}</s-text>}
            </s-stack>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Popup content">
        <s-stack gap="base">
          <s-text-field label="Heading" value={settings.heading} onInput={(event) => update("heading", event.currentTarget.value ?? "")} />
          <s-text-field label="Supporting text" value={settings.subheading} onInput={(event) => update("subheading", event.currentTarget.value ?? "")} />
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field label="Button label" value={settings.buttonLabel} onInput={(event) => update("buttonLabel", event.currentTarget.value ?? "")} />
            <s-text-field label="Success message" details="Shown after the gift is added to the cart." value={settings.successMessage} onInput={(event) => update("successMessage", event.currentTarget.value ?? "")} />
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

      <s-section slot="aside" heading="Preview">
        <s-stack gap="small-200">
          <PopupPreview settings={settings} />
          <s-text color="subdued">{"Updates as you edit. Your theme's fonts are used on the storefront."}</s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Setup checklist">
        <s-stack gap="base">
          <SetupStep done={saved.enabled} title="Turn on the offer" />
          <SetupStep done={countGiftProducts(saved.products) > 0} title="Choose gift products" />
          <SetupStep done={discountReady} title="Save to create the checkout discount" />
          <SetupStep done={false} title="Enable the app embed in your theme">
            <s-text color="subdued">In the theme editor, open App embeds and turn on “Free Gift App (Master)”.</s-text>
            <s-link href="shopify://admin/themes/current/editor?context=apps" target="_blank">Open theme editor</s-link>
          </SetupStep>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
