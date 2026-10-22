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
const STATUS_TONE: Record<string, Tone> = { Open: "warning", "In progress": "info", Resolved: "success" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const DAY = 86_400_000;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const [json, ticketGroups, recentTickets, pairs, lastFourWeeks, topicGroups] = await Promise.all([
    admin.graphql(DASHBOARD_QUERY).then((response) => response.json()),
    db.helpDeskTicket.groupBy({ by: ["status"], where: { shop: session.shop }, _count: { _all: true } }),
    db.helpDeskTicket.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, name: true, email: true, topic: true, status: true, createdAt: true } }),
    db.inventorySyncPair.findMany({ where: { shop: session.shop }, select: { enabled: true, lastError: true, lastSyncedAt: true } }),
    db.helpDeskTicket.findMany({ where: { shop: session.shop, createdAt: { gte: new Date(today - 27 * DAY) } }, select: { createdAt: true } }),
    db.helpDeskTicket.groupBy({ by: ["topic"], where: { shop: session.shop }, _count: { _all: true } }),
  ]);
  // Requests per UTC day for the last 14 days, plus the 14 days before for comparison.
  const perDay = new Map<number, number>();
  for (const { createdAt } of lastFourWeeks) {
    const day = Math.floor(new Date(createdAt).getTime() / DAY) * DAY;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const activity = Array.from({ length: 14 }, (_, index) => {
    const day = today - (13 - index) * DAY;
    return { date: new Date(day).toISOString(), count: perDay.get(day) ?? 0 };
  });
  const previousTotal = Array.from({ length: 14 }, (_, index) => perDay.get(today - (27 - index) * DAY) ?? 0).reduce((sum, value) => sum + value, 0);
  const shop = json.data?.shop;
  const gift = (shop?.giftSettings?.jsonValue || {}) as GiftSettings;
  const restrictions = (shop?.restrictionSettings?.jsonValue || {}) as RestrictionSettings;
  const notices = ((shop?.noticeSettings?.jsonValue || {}) as NoticeSettings).notices ?? [];
  const variants = Array.isArray(gift.products) ? gift.products : [];
  const tickets = Object.fromEntries(ticketGroups.map((group) => [group.status, group._count._all])) as Record<string, number>;
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
    tickets: { open: tickets.Open ?? 0, inProgress: tickets["In progress"] ?? 0, total: Object.values(tickets).reduce((sum, value) => sum + value, 0) },
    recentTickets,
    activity,
    previousTotal,
    topics: topicGroups.map((group) => ({ topic: group.topic, count: group._count._all })).sort((a, b) => b.count - a.count),
    notices: { active: notices.filter((notice) => notice.enabled !== false && notice.message?.trim()).length, total: notices.length },
    protection: { enabled: Boolean(restrictions.enabled && restrictions.validationId), products: Array.isArray(restrictions.products) ? restrictions.products.length : 0 },
    inventory: { total: pairs.length, active: pairs.filter((pair) => pair.enabled).length, errors: pairs.filter((pair) => pair.enabled && pair.lastError).length, lastSynced: lastSynced ? new Date(lastSynced).toISOString() : null },
  };
};

const BAR = "#2a78d6";
const shortDate = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));

// Requests per day, last 14 days. One series, so no legend; each column has a
// hover tooltip and the busiest day carries a direct label.
function ActivityChart({ days }: { days: { date: string; count: number }[] }) {
  const width = 560, height = 150, top = 18, bottom = 22, slot = width / days.length, barWidth = Math.min(24, slot - 6);
  const max = Math.max(1, ...days.map((day) => day.count));
  const peak = days.reduce((best, day, index) => (day.count > days[best].count ? index : best), 0);
  const plot = height - top - bottom;
  return <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Help Desk requests per day for the last 14 days" style={{ display: "block", overflow: "visible" }}>
    <line x1={0} x2={width} y1={top} y2={top} stroke="#e1e0d9" strokeWidth={1} />
    {days.map((day, index) => {
      const h = day.count ? Math.max(4, (day.count / max) * plot) : 0;
      const x = index * slot + (slot - barWidth) / 2;
      const y = top + plot - h;
      const r = Math.min(4, h / 2);
      return <g key={day.date}>
        <title>{`${shortDate(day.date)}: ${day.count} request${day.count === 1 ? "" : "s"}`}</title>
        <rect x={index * slot} y={top} width={slot} height={plot} fill="transparent" />
        {h > 0 && <path d={`M${x},${top + plot} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${top + plot} Z`} fill={BAR} />}
        {index === peak && day.count > 0 && <text x={x + barWidth / 2} y={y - 5} textAnchor="middle" fontSize={11} fontWeight={600} fill="#303030">{day.count}</text>}
        {(days.length - 1 - index) % 3 === 0 && <text x={index * slot + slot / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="#898781">{index === days.length - 1 ? "Today" : shortDate(day.date)}</text>}
      </g>;
    })}
    <line x1={0} x2={width} y1={top + plot} y2={top + plot} stroke="#c3c2b7" strokeWidth={1} />
  </svg>;
}

function TopicBreakdown({ topics }: { topics: { topic: string; count: number }[] }) {
  const max = Math.max(1, ...topics.map((entry) => entry.count));
  return <s-stack gap="small-200">
    {topics.map((entry) => (
      <s-stack key={entry.topic} gap="small-100">
        <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small-200" alignItems="center">
          <s-text>{entry.topic}</s-text>
          <s-text type="strong">{entry.count}</s-text>
        </s-grid>
        <div style={{ height: 8, borderRadius: 4, background: "#eef3fb" }} title={`${entry.topic}: ${entry.count}`}>
          <div style={{ width: `${(entry.count / max) * 100}%`, height: "100%", borderRadius: 4, background: BAR }} />
        </div>
      </s-stack>
    ))}
  </s-stack>;
}

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
    data.tickets.open > 0 && { tone: "warning" as const, text: `${data.tickets.open} Help Desk request${data.tickets.open === 1 ? " is" : "s are"} waiting for a reply.`, action: "Review requests", href: "/app/help-desk?status=Open" },
    data.gift.enabled && !giftLive && { tone: "warning" as const, text: "The free gift offer is on but setup isn't finished, so shoppers can't see it yet.", action: "Finish setup", href: "/app/free-gift" },
    data.gift.unavailable > 0 && { tone: "info" as const, text: `${data.gift.unavailable} gift variant${data.gift.unavailable === 1 ? " is" : "s are"} out of stock and hidden from shoppers.`, action: "Update gifts", href: "/app/free-gift" },
    data.inventory.errors > 0 && { tone: "critical" as const, text: `${data.inventory.errors} inventory link${data.inventory.errors === 1 ? " has" : "s have"} sync errors.`, action: "Check inventory sync", href: "/app/inventory-sync" },
  ].filter((item): item is { tone: "warning" | "info" | "critical"; text: string; action: string; href: string } => Boolean(item));

  return (
    <s-page heading="Dashboard">
      <s-button slot="primary-action" variant="primary" icon="chat" href="/app/help-desk">Open Help Desk</s-button>
      <s-button slot="secondary-actions" href="/app/free-gift">Free gift settings</s-button>

      <s-section>
        <s-stack gap="base">
          <s-stack gap="small-100">
            <s-heading>Welcome back to {data.shopName}</s-heading>
            <s-paragraph color="subdued">{"Here's how your free gift offer, customer requests and checkout tools are doing today."}</s-paragraph>
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
          <Kpi label="Help Desk" value={`${data.tickets.open} open`} detail={`${data.tickets.inProgress} in progress · ${data.tickets.total} total`}
            tone={data.tickets.open ? "warning" : "success"} badge={data.tickets.open ? "Needs reply" : "Up to date"} href="/app/help-desk" />
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

      <s-section heading="Help Desk activity">
        {data.tickets.total === 0 ? (
          <s-paragraph color="subdued">Charts appear here once customers start sending requests.</s-paragraph>
        ) : (() => {
          const recent = data.activity.reduce((sum, day) => sum + day.count, 0);
          const change = data.previousTotal ? Math.round(((recent - data.previousTotal) / data.previousTotal) * 100) : null;
          return <s-stack gap="large">
            <s-stack gap="small-200">
              <s-stack direction="inline" gap="small-200" alignItems="end">
                <div style={{ fontSize: 26, fontWeight: 650, lineHeight: "32px" }}>{recent}</div>
                <s-text color="subdued">requests in the last 14 days</s-text>
                {change !== null && <s-badge tone={change > 0 ? "info" : "neutral"}>{`${change > 0 ? "+" : ""}${change}% vs previous 14 days`}</s-badge>}
              </s-stack>
              <ActivityChart days={data.activity} />
            </s-stack>
            <s-divider />
            <s-stack gap="small-200">
              <s-text type="strong">Requests by topic</s-text>
              <TopicBreakdown topics={data.topics} />
            </s-stack>
          </s-stack>;
        })()}
      </s-section>

      <s-section heading="Recent Help Desk requests" padding="none">
        {data.recentTickets.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">No customer requests yet. Add the Help Desk form block to a page in your theme to start receiving them.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header>Topic</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>Received</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.recentTickets.map((ticket) => (
                <s-table-row key={ticket.id} clickDelegate={`recent-${ticket.id}`}>
                  <s-table-cell>
                    <s-stack gap="none">
                      <s-link id={`recent-${ticket.id}`} href={`/app/help-desk?ticket=${encodeURIComponent(ticket.id)}`}>{ticket.name}</s-link>
                      <s-text color="subdued">{ticket.email}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{ticket.topic}</s-table-cell>
                  <s-table-cell><s-badge tone={STATUS_TONE[ticket.status] ?? "neutral"}>{ticket.status}</s-badge></s-table-cell>
                  <s-table-cell><span suppressHydrationWarning>{formatDate(ticket.createdAt)}</span></s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {data.tickets.total > data.recentTickets.length && <s-box padding="base">
          <s-link href="/app/help-desk">View all {data.tickets.total} requests</s-link>
        </s-box>}
      </s-section>

      <s-section slot="aside" heading="Features">
        <s-stack gap="base">
          <Feature icon="gift-card" title="Free gift offer" description="Cart popup and automatic discount" href="/app/free-gift"
            tone={giftLive ? "success" : data.gift.enabled ? "warning" : "neutral"} status={giftLive ? "Live" : data.gift.enabled ? "Setup" : "Off"} />
          <Feature icon="chat" title="Help Desk" description="Storefront support form" href="/app/help-desk"
            tone={data.tickets.open ? "warning" : "success"} status={data.tickets.open ? `${data.tickets.open} open` : "Up to date"} />
          <Feature icon="note" title="Checkout notices" description="Country and state messages" href="/app/checkout-notices"
            tone={data.notices.active ? "success" : "neutral"} status={data.notices.active ? `${data.notices.active} active` : "None"} />
          <Feature icon="inventory" title="Inventory sync" description="Shared stock between listings" href="/app/inventory-sync"
            tone={data.inventory.errors ? "critical" : data.inventory.active ? "success" : "neutral"} status={data.inventory.errors ? "Errors" : data.inventory.active ? "On" : "Off"} />
        </s-stack>
      </s-section>
    </s-page>
  );
}
