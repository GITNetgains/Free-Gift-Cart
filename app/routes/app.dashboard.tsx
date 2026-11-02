import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type GiftProduct = { productId?: string; variantId?: string; inventoryQuantity?: number; inventoryTracked?: boolean; availableForSale?: boolean };
type GiftSettings = { enabled?: boolean; minimumSpend?: number; products?: GiftProduct[]; discountId?: string };
type RestrictionSettings = { enabled?: boolean; products?: Array<{ id?: string }>; validationId?: string };
type NoticeSettings = { notices?: Array<{ enabled?: boolean; message?: string }> };
type Tone = "success" | "warning" | "critical" | "info" | "neutral" | "caution";

const DASHBOARD_QUERY = `#graphql
  query ZionCasesDashboard {
    shop {
      name
      giftSettings: metafield(namespace: "free_gift_cart", key: "settings") { jsonValue }
      restrictionSettings: metafield(namespace: "free_gift_cart", key: "no_discount_products") { jsonValue }
      noticeSettings: metafield(namespace: "free_gift_cart", key: "checkout_notices") { jsonValue }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [json, pairs] = await Promise.all([
    admin.graphql(DASHBOARD_QUERY).then((response) => response.json()),
    db.inventorySyncPair.findMany({ where: { shop: session.shop }, select: { enabled: true, lastError: true, lastSyncedAt: true } }),
  ]);
  const shop = json.data?.shop;
  const gift = (shop?.giftSettings?.jsonValue || {}) as GiftSettings;
  const restrictions = (shop?.restrictionSettings?.jsonValue || {}) as RestrictionSettings;
  const notices = ((shop?.noticeSettings?.jsonValue || {}) as NoticeSettings).notices ?? [];
  const variants = Array.isArray(gift.products) ? gift.products : [];
  const lastSynced = pairs.reduce<number>((latest, pair) => Math.max(latest, pair.lastSyncedAt ? new Date(pair.lastSyncedAt).getTime() : 0), 0);

  return {
    shopName: shop?.name || "your store",
    gift: {
      enabled: Boolean(gift.enabled),
      minimumSpend: Math.round(Number(gift.minimumSpend || 0) / 100),
      products: new Set(variants.map((product) => product.productId).filter(Boolean)).size,
      unavailable: variants.filter((product) => product.availableForSale === false || (product.inventoryTracked && Number(product.inventoryQuantity) <= 0)).length,
      discountReady: Boolean(gift.discountId),
    },
    notices: { active: notices.filter((notice) => notice.enabled !== false && notice.message?.trim()).length, total: notices.length },
    protection: { enabled: Boolean(restrictions.enabled && restrictions.validationId), products: Array.isArray(restrictions.products) ? restrictions.products.length : 0 },
    inventory: { total: pairs.length, active: pairs.filter((pair) => pair.enabled).length, errors: pairs.filter((pair) => pair.enabled && pair.lastError).length, lastSynced: lastSynced ? new Date(lastSynced).toISOString() : null },
  };
};

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Kpi({ label, value, detail, tone, badge, href }: { label: string; value: string; detail: string; tone: Tone; badge: string; href: string }) {
  const navigate = useNavigate();
  return <s-clickable border="base" borderRadius="base" padding="base" accessibilityLabel={`Open ${label}`} onClick={() => navigate(href)}>
    <s-stack gap="small-200">
      <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="center">
        <s-text color="subdued">{label}</s-text>
        <s-badge tone={tone}>{badge}</s-badge>
      </s-grid>
      <div style={{ fontSize: 26, fontWeight: 650, lineHeight: "32px", letterSpacing: "-0.01em" }}>{value}</div>
      <s-text color="subdued">{detail}</s-text>
    </s-stack>
  </s-clickable>;
}

function Feature({ icon, title, description, tone, status, href }: { icon: string; title: string; description: string; tone: Tone; status: string; href: string }) {
  return <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
    <s-box padding="small-200" background="subdued" borderRadius="base"><s-icon type={icon as "product"} /></s-box>
    <s-stack gap="none">
      <s-link href={href}>{title}</s-link>
      <s-text color="subdued">{description}</s-text>
    </s-stack>
    <s-badge tone={tone}>{status}</s-badge>
  </s-grid>;
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const giftLive = data.gift.enabled && data.gift.products > 0 && data.gift.discountReady;
  const attention = [
    data.gift.enabled && !giftLive && { tone: "warning" as const, text: "The free gift offer is on but setup isn't finished, so shoppers can't see it yet.", action: "Finish setup", href: "/app/free-gift" },
    data.gift.unavailable > 0 && { tone: "info" as const, text: `${data.gift.unavailable} gift variant${data.gift.unavailable === 1 ? " is" : "s are"} out of stock and hidden from shoppers.`, action: "Update gifts", href: "/app/free-gift" },
    data.inventory.errors > 0 && { tone: "critical" as const, text: `${data.inventory.errors} inventory link${data.inventory.errors === 1 ? " has" : "s have"} sync errors.`, action: "Check inventory sync", href: "/app/inventory-sync" },
  ].filter((item): item is { tone: "warning" | "info" | "critical"; text: string; action: string; href: string } => Boolean(item));

  return (
    <s-page heading="Dashboard">
      <s-button slot="primary-action" variant="primary" href="/app/free-gift">Free gift settings</s-button>

      <s-section>
        <s-stack gap="base">
          <s-stack gap="small-100">
            <s-heading>Welcome back to {data.shopName}</s-heading>
            <s-paragraph color="subdued">{"Here's how your free gift offer and checkout tools are doing today."}</s-paragraph>
          </s-stack>
          {attention.length === 0
            ? <s-banner tone="success" heading="All systems running">Nothing needs your attention right now.</s-banner>
            : <s-banner tone={attention.some((item) => item.tone === "critical") ? "critical" : "warning"} heading={`${attention.length} thing${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} your attention`}>
              <s-stack gap="small-200">
                {attention.map((item) => (
                  <s-grid key={item.text} gridTemplateColumns="1fr auto" gap="base" alignItems="center">
                    <s-text>{item.text}</s-text>
                    <s-button variant="tertiary" onClick={() => navigate(item.href)}>{item.action}</s-button>
                  </s-grid>
                ))}
              </s-stack>
            </s-banner>}
        </s-stack>
      </s-section>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          <Kpi label="Free gift offer" value={giftLive ? `$${data.gift.minimumSpend.toLocaleString("en")}+` : data.gift.enabled ? "Incomplete" : "Paused"}
            detail={`${data.gift.products} gift product${data.gift.products === 1 ? "" : "s"}${giftLive ? " · minimum cart value" : ""}`}
            tone={giftLive ? "success" : data.gift.enabled ? "warning" : "neutral"} badge={giftLive ? "Live" : data.gift.enabled ? "Setup" : "Off"} href="/app/free-gift" />
          <Kpi label="Checkout notices" value={`${data.notices.active} active`} detail={`${data.notices.total} block${data.notices.total === 1 ? "" : "s"} configured`}
            tone={data.notices.active ? "success" : "neutral"} badge={data.notices.active ? "Showing" : "None"} href="/app/checkout-notices" />
          <Kpi label="Inventory sync" value={`${data.inventory.active} linked`}
            detail={data.inventory.lastSynced ? `Last sync ${formatDate(data.inventory.lastSynced)}` : "No syncs yet"}
            tone={data.inventory.errors ? "critical" : data.inventory.active ? "success" : "neutral"} badge={data.inventory.errors ? `${data.inventory.errors} errors` : data.inventory.active ? "Healthy" : "Not set up"} href="/app/inventory-sync" />
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Features">
        <s-stack gap="base">
          <Feature icon="gift-card" title="Free gift offer" description="Cart popup and automatic discount" href="/app/free-gift"
            tone={giftLive ? "success" : data.gift.enabled ? "warning" : "neutral"} status={giftLive ? "Live" : data.gift.enabled ? "Setup" : "Off"} />
          <Feature icon="note" title="Checkout notices" description="Country and state messages" href="/app/checkout-notices"
            tone={data.notices.active ? "success" : "neutral"} status={data.notices.active ? `${data.notices.active} active` : "None"} />
          <Feature icon="inventory" title="Inventory sync" description="Shared stock between listings" href="/app/inventory-sync"
            tone={data.inventory.errors ? "critical" : data.inventory.active ? "success" : "neutral"} status={data.inventory.errors ? "Errors" : data.inventory.active ? "On" : "Off"} />
        </s-stack>
      </s-section>
    </s-page>
  );
}
