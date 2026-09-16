import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

type GiftProduct = { productId?: string; variantId?: string; inventoryQuantity?: number; inventoryTracked?: boolean };
type GiftSettings = { enabled?: boolean; minimumSpend?: number; products?: GiftProduct[]; discountId?: string };
type RestrictionSettings = { enabled?: boolean; products?: Array<{ id?: string }>; validationId?: string };

const DASHBOARD_QUERY = `#graphql
  query ZionCasesDashboard {
    shop {
      name
      giftSettings: metafield(namespace: "free_gift_cart", key: "settings") { jsonValue }
      restrictionSettings: metafield(namespace: "free_gift_cart", key: "no_discount_products") { jsonValue }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(DASHBOARD_QUERY);
  const json = await response.json();
  const shop = json.data?.shop;
  const gift = (shop?.giftSettings?.jsonValue || {}) as GiftSettings;
  const restrictions = (shop?.restrictionSettings?.jsonValue || {}) as RestrictionSettings;
  const variants = Array.isArray(gift.products) ? gift.products : [];
  const uniqueProducts = new Set(variants.map((product) => product.productId).filter(Boolean)).size;
  const outOfStockVariants = variants.filter((product) => product.inventoryTracked && Number(product.inventoryQuantity) <= 0).length;
  const restrictedProducts = Array.isArray(restrictions.products) ? restrictions.products.length : 0;

  return {
    shopName: shop?.name || "ZionCases",
    offerEnabled: Boolean(gift.enabled),
    minimumSpend: Math.round(Number(gift.minimumSpend || 0) / 100),
    giftProducts: uniqueProducts,
    giftVariants: variants.length,
    outOfStockVariants,
    automaticDiscountReady: Boolean(gift.discountId),
    protectionEnabled: Boolean(restrictions.enabled && restrictions.validationId),
    restrictedProducts,
  };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const setupComplete = data.offerEnabled && data.giftProducts > 0 && data.automaticDiscountReady;

  return (
    <s-page heading={`${data.shopName} Free Gift Dashboard`} inlineSize="base">
      <s-button slot="primary-action" variant="primary" href="/app">Manage free gifts</s-button>

      <s-section>
        <s-box padding="base" background="subdued" border="base" borderRadius="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-stack gap="small-300">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="product-add" size="base"></s-icon>
                <s-heading>ZionCases Gift Experience</s-heading>
                <s-badge tone={data.offerEnabled ? "success" : "neutral"}>{data.offerEnabled ? "Live" : "Paused"}</s-badge>
              </s-stack>
              <s-paragraph color="subdued">Control free gifts, product-page widgets, inventory visibility, and checkout discount protection from one place.</s-paragraph>
            </s-stack>
            <s-button href="/app" variant="secondary">Open settings</s-button>
          </s-grid>
        </s-box>
      </s-section>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(4, minmax(0, 1fr))" gap="base">
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack gap="small-200"><s-paragraph color="subdued">Minimum spend</s-paragraph><s-heading>${data.minimumSpend}</s-heading><s-badge tone="info">USD threshold</s-badge></s-stack>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack gap="small-200"><s-paragraph color="subdued">Gift products</s-paragraph><s-heading>{data.giftProducts}</s-heading><s-paragraph color="subdued">{data.giftVariants} variants</s-paragraph></s-stack>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack gap="small-200"><s-paragraph color="subdued">Out of stock</s-paragraph><s-heading>{data.outOfStockVariants}</s-heading><s-badge tone={data.outOfStockVariants > 0 ? "warning" : "success"}>{data.outOfStockVariants > 0 ? "Hidden automatically" : "Inventory healthy"}</s-badge></s-stack>
          </s-box>
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack gap="small-200"><s-paragraph color="subdued">Protected products</s-paragraph><s-heading>{data.restrictedProducts}</s-heading><s-badge tone={data.protectionEnabled ? "success" : "neutral"}>{data.protectionEnabled ? "Protection active" : "Not configured"}</s-badge></s-stack>
          </s-box>
        </s-grid>
      </s-section>

      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-section heading="Quick actions">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-clickable href="/app" padding="base" background="subdued" borderRadius="base" accessibilityLabel="Manage free gift offer">
              <s-stack gap="small-200"><s-icon type="product-add"></s-icon><s-heading>Free gift offer</s-heading><s-paragraph color="subdued">Products, threshold, popup content, colors, and widget settings.</s-paragraph></s-stack>
            </s-clickable>
            <s-clickable href="/app/no-discounts" padding="base" background="subdued" borderRadius="base" accessibilityLabel="Manage no-discount products">
              <s-stack gap="small-200"><s-icon type="discount-code"></s-icon><s-heading>Discount protection</s-heading><s-paragraph color="subdued">Block Shopify, affiliate, automatic, and app discounts on selected products.</s-paragraph></s-stack>
            </s-clickable>
          </s-grid>
        </s-section>

        <s-section heading="Setup status">
          <s-stack gap="base">
            <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center"><s-icon type={data.offerEnabled ? "check-circle" : "circle-dashed"}></s-icon><s-text>Offer enabled</s-text><s-badge tone={data.offerEnabled ? "success" : "neutral"}>{data.offerEnabled ? "Done" : "Required"}</s-badge></s-grid>
            <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center"><s-icon type={data.giftProducts > 0 ? "check-circle" : "circle-dashed"}></s-icon><s-text>Gift products selected</s-text><s-badge tone={data.giftProducts > 0 ? "success" : "neutral"}>{data.giftProducts > 0 ? "Done" : "Required"}</s-badge></s-grid>
            <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center"><s-icon type={data.automaticDiscountReady ? "check-circle" : "circle-dashed"}></s-icon><s-text>Automatic discount</s-text><s-badge tone={data.automaticDiscountReady ? "success" : "neutral"}>{data.automaticDiscountReady ? "Ready" : "Save settings"}</s-badge></s-grid>
            <s-banner heading={setupComplete ? "Storefront is ready" : "Finish setup"} tone={setupComplete ? "success" : "warning"}>{setupComplete ? "Your gift experience is configured and ready for shoppers." : "Complete the required steps before testing the storefront."}</s-banner>
          </s-stack>
        </s-section>
      </s-grid>
    </s-page>
  );
}
