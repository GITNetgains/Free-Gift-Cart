import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
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
  existingDiscountId?: string,
) {
  const discountInput = {
    title: "Free Gift Cart",
    functionHandle: "free-gift-discount",
    discountClasses: ["PRODUCT" as AdminDiscountClass],
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
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
    return { ok: false, error: "Settings payload is invalid." };
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

  const discount = await ensureAutomaticDiscount(admin, settings.discountId);
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

export default function Index() {
  const initial = useLoaderData<typeof loader>().settings;
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [settings, setSettings] = useState<GiftSettings>(initial);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      if (fetcher.data.settings) setSettings(fetcher.data.settings);
      shopify.toast.show(fetcher.data.warning || "Free gift settings saved");
    } else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const selectedIds = useMemo(() => Array.from(
    new Set(settings.products.map((product) => product.productId)),
    (id) => ({ id }),
  ), [settings.products]);
  const selectedProductCount = useMemo(() => countGiftProducts(settings.products), [settings.products]);
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
    <s-page heading="Free Gift Cart">
      <s-button slot="primary-action" variant="primary" icon="save" onClick={submit} {...(fetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button>
      <s-section heading="Offer settings">
        <s-stack gap="base">
          <s-switch label="Enable free gift offer" checked={settings.enabled} onChange={(event) => {
            const enabled = event.currentTarget.checked;
            setSettings((current) => ({ ...current, enabled }));
          }} />
          <s-number-field label="Minimum cart value" name="minimumSpend" prefix="$" inputMode="numeric" min={0} step={1} value={String(Math.round(settings.minimumSpend / 100))} onInput={(event) => {
            const wholeDollars = Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0));
            if (event.currentTarget.value !== String(wholeDollars)) event.currentTarget.value = String(wholeDollars);
            const minimumSpend = wholeDollars * 100;
            setSettings((current) => ({ ...current, minimumSpend }));
          }} />
          <s-paragraph color="subdued">The popup appears on the cart page when the paid cart subtotal reaches this amount.</s-paragraph>
        </s-stack>
      </s-section>
      <s-section heading={`Gift products (${selectedProductCount}/${MAX_GIFT_PRODUCTS})`}>
        <s-stack gap="base">
          <s-button icon="product-add" onClick={chooseProducts}>Select product variants</s-button>
          {settings.products.length === 0 ? <s-paragraph color="subdued">No gifts selected yet.</s-paragraph> : (
            <s-table>
              <s-table-header-row><s-table-header listSlot="primary">Product</s-table-header><s-table-header>Variant</s-table-header><s-table-header></s-table-header></s-table-header-row>
              <s-table-body>{settings.products.map((product) => (
                <s-table-row key={product.variantId}>
                  <s-table-cell><s-stack direction="inline" gap="base" alignItems="center">{product.imageUrl && <s-thumbnail src={product.imageUrl} alt={product.productTitle} size="small" />}<s-text>{product.productTitle}</s-text></s-stack></s-table-cell>
                  <s-table-cell>{product.variantTitle}</s-table-cell>
                  <s-table-cell><s-button icon="x" variant="tertiary" accessibilityLabel={`Remove ${product.productTitle}`} onClick={() => setSettings((current) => ({ ...current, products: current.products.filter((item) => item.productId !== product.productId) }))} /></s-table-cell>
                </s-table-row>
              ))}</s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
      <s-section heading="Popup content">
        <s-stack gap="base">
          <s-text-field label="Heading" value={settings.heading} onInput={(event) => {
            const heading = event.currentTarget.value;
            setSettings((current) => ({ ...current, heading }));
          }} />
          <s-text-field label="Supporting text" value={settings.subheading} onInput={(event) => {
            const subheading = event.currentTarget.value;
            setSettings((current) => ({ ...current, subheading }));
          }} />
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field label="Button label" value={settings.buttonLabel} onInput={(event) => {
              const buttonLabel = event.currentTarget.value;
              setSettings((current) => ({ ...current, buttonLabel }));
            }} />
            <s-text-field label="Success message" value={settings.successMessage} onInput={(event) => {
              const successMessage = event.currentTarget.value;
              setSettings((current) => ({ ...current, successMessage }));
            }} />
          </s-grid>
        </s-stack>
      </s-section>
      <s-section heading="Popup colors">
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-color-field label="Background" value={settings.backgroundColor} onInput={(event) => {
            const backgroundColor = event.currentTarget.value;
            setSettings((current) => ({ ...current, backgroundColor }));
          }} />
          <s-color-field label="Text" value={settings.textColor} onInput={(event) => {
            const textColor = event.currentTarget.value;
            setSettings((current) => ({ ...current, textColor }));
          }} />
          <s-color-field label="Button background" value={settings.buttonColor} onInput={(event) => {
            const buttonColor = event.currentTarget.value;
            setSettings((current) => ({ ...current, buttonColor }));
          }} />
          <s-color-field label="Button text" value={settings.buttonTextColor} onInput={(event) => {
            const buttonTextColor = event.currentTarget.value;
            setSettings((current) => ({ ...current, buttonTextColor }));
          }} />
          <s-color-field label="Page overlay" value={settings.overlayColor} alpha onInput={(event) => {
            const overlayColor = event.currentTarget.value;
            setSettings((current) => ({ ...current, overlayColor }));
          }} />
        </s-grid>
      </s-section>
      <s-section slot="aside" heading="Storefront setup">
        <s-stack gap="base">
          <s-badge tone={settings.enabled ? "success" : "neutral"}>{settings.enabled ? "Offer enabled" : "Offer disabled"}</s-badge>
          <s-paragraph>Enable the “Free Gift Popup” app embed in Online Store &gt; Themes &gt; Customize &gt; App embeds. The popup only appears on the cart page.</s-paragraph>
          <s-paragraph color="subdued">A shopper can select one gift. The discount function validates the configured variant and threshold before applying a 100% discount.</s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
