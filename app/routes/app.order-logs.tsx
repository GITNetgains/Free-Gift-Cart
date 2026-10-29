import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";

// Order logs: who bought what, through which channel and pages, and which
// orders break the free gift rules. Shopify keeps the buyer's visits (landing
// page, referrer, UTM) per order, not which page each item was added from.
// read_orders only reaches the last 60 days of orders.

type GiftSettings = { minimumSpend?: number; products?: Array<{ productId?: string }> };
type Tone = "success" | "warning" | "critical" | "info" | "neutral" | "caution";

// Always treated as free gifts, like the checkout validation function.
const ALWAYS_GIFT_PRODUCT_IDS = ["gid://shopify/Product/8708096557231", "gid://shopify/Product/8431587655855"];
const PAGE_SIZE = 25;
const MAX_PAGES = 8;
const MAX_ROWS = 100;

const VISIT_FIELDS = `occurredAt source sourceType landingPage referrerUrl utmParameters { source medium campaign }`;
const ordersQuery = (withCustomer: boolean) => `#graphql
  query OrderLogs($query: String!, $cursor: String) {
    shop { giftSettings: metafield(namespace: "free_gift_cart", key: "settings") { jsonValue } }
    orders(first: ${PAGE_SIZE}, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        legacyResourceId name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
        sourceName clientIp discountCodes
        ${withCustomer ? "email customer { displayName numberOfOrders }" : ""}
        app { name }
        risk { recommendation }
        customAttributes { key value }
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount currencyCode } }
        customerJourneySummary {
          daysToConversion momentsCount { count }
          firstVisit { ${VISIT_FIELDS} }
          lastVisit { ${VISIT_FIELDS} }
        }
        lineItems(first: 20) {
          nodes {
            title variantTitle sku quantity
            product { id }
            customAttributes { key value }
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

type Visit = {
  occurredAt: string; source: string | null; sourceType: string | null; landingPage: string | null; referrerUrl: string | null;
  utmParameters: { source: string | null; medium: string | null; campaign: string | null } | null;
} | null;
type OrderNode = {
  legacyResourceId: string; name: string; createdAt: string; cancelledAt: string | null;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string;
  sourceName: string | null; clientIp: string | null; discountCodes: string[];
  email?: string | null; customer?: { displayName: string; numberOfOrders: string } | null;
  app: { name: string } | null; risk: { recommendation: string } | null;
  customAttributes: { key: string; value: string | null }[];
  subtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customerJourneySummary: { daysToConversion: number | null; momentsCount: { count: number } | null; firstVisit: Visit; lastVisit: Visit } | null;
  lineItems: { nodes: {
    title: string; variantTitle: string | null; sku: string | null; quantity: number; product: { id: string } | null;
    customAttributes: { key: string; value: string | null }[]; originalUnitPriceSet: { shopMoney: { amount: string } };
  }[] };
};

const readable = (value: string | null | undefined) => (value || "").toLowerCase().replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = [1, 7, 30, 60].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 7;
  const view = ["all", "gift", "flagged"].includes(url.searchParams.get("view") || "") ? url.searchParams.get("view")! : "all";
  const search = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const query = `created_at:>='${since}'${search ? ` ${search}` : ""}`;

  // Customer names and emails are protected customer data; if the app isn't
  // approved for them, load the orders without them.
  let withCustomer = true;
  let cursor: string | null = url.searchParams.get("after");
  let hasNextPage = false;
  let giftSettings: GiftSettings = {};
  const nodes: OrderNode[] = [];
  let error = "";
  // admin.graphql throws when the response carries GraphQL errors.
  const fetchPage = async (customerFields: boolean) => {
    try {
      return await (await admin.graphql(ordersQuery(customerFields), { variables: { query, cursor } })).json();
    } catch (fetchError) {
      console.error("Order logs could not load orders:", fetchError);
      return null;
    }
  };
  for (let page = 0; page < MAX_PAGES && nodes.length < MAX_ROWS; page += 1) {
    let json = await fetchPage(withCustomer);
    if (!json?.data?.orders && withCustomer) {
      withCustomer = false;
      json = await fetchPage(false);
    }
    if (!json?.data?.orders) {
      error = "Orders could not be loaded. Try again, or narrow the search.";
      break;
    }
    giftSettings = (json.data.shop?.giftSettings?.jsonValue || {}) as GiftSettings;
    nodes.push(...json.data.orders.nodes);
    hasNextPage = json.data.orders.pageInfo.hasNextPage;
    cursor = json.data.orders.pageInfo.endCursor;
    if (!hasNextPage) break;
    // Filtered views keep scanning for matching orders; the full view stops at one page batch.
    if (view === "all" && nodes.length >= MAX_ROWS) break;
  }

  const giftProductIds = new Set([
    ...ALWAYS_GIFT_PRODUCT_IDS,
    ...(giftSettings.products || []).map((product) => product.productId).filter((id): id is string => Boolean(id)),
  ]);
  const minimum = Number(giftSettings.minimumSpend || 0) / 100;

  const orders = nodes.map((order) => {
    const items = order.lineItems.nodes.map((item) => {
      const claimed = item.customAttributes.some((attribute) => attribute.key === "_free_gift" && attribute.value === "true");
      const giftProduct = Boolean(item.product && giftProductIds.has(item.product.id));
      return {
        title: item.title,
        variant: item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : "",
        sku: item.sku || "",
        quantity: item.quantity,
        price: Number(item.originalUnitPriceSet.shopMoney.amount),
        claimed,
        gift: claimed || giftProduct,
        // A gift product without the app's marker was added some other way:
        // its product URL, /cart/add.js from the console, or a cart permalink.
        outsideApp: giftProduct && !claimed,
      };
    });
    const giftUnits = items.filter((item) => item.gift).reduce((total, item) => total + item.quantity, 0);
    const paidSubtotal = items.filter((item) => !item.gift).reduce((total, item) => total + item.price * item.quantity, 0);
    const flags: { label: string; tone: Tone }[] = [];
    if (giftUnits > 1) flags.push({ label: `${giftUnits} free gifts`, tone: "critical" });
    if (items.some((item) => item.outsideApp)) flags.push({ label: "Gift added outside the app", tone: "critical" });
    if (giftUnits > 0 && paidSubtotal < minimum) flags.push({ label: "Under gift minimum", tone: "warning" });
    const risk = order.risk?.recommendation;
    if (risk === "CANCEL") flags.push({ label: "High fraud risk", tone: "critical" });
    else if (risk === "INVESTIGATE") flags.push({ label: "Medium fraud risk", tone: "warning" });

    const journey = order.customerJourneySummary;
    const visit = (value: Visit) => value && {
      at: value.occurredAt,
      source: value.source || readable(value.sourceType),
      landingPage: value.landingPage || "",
      referrer: value.referrerUrl || "",
      utm: [value.utmParameters?.source, value.utmParameters?.medium, value.utmParameters?.campaign].filter(Boolean).join(" / "),
    };
    return {
      id: order.legacyResourceId,
      name: order.name,
      createdAt: order.createdAt,
      cancelled: Boolean(order.cancelledAt),
      financial: readable(order.displayFinancialStatus),
      fulfillment: readable(order.displayFulfillmentStatus),
      customer: order.customer?.displayName || "",
      email: order.email || "",
      customerOrders: Number(order.customer?.numberOfOrders || 0),
      channel: order.app?.name || order.sourceName || "Unknown",
      ip: order.clientIp || "",
      landingPage: journey?.lastVisit?.landingPage || "",
      referrer: journey?.lastVisit?.referrerUrl || "",
      firstVisit: visit(journey?.firstVisit ?? null),
      lastVisit: visit(journey?.lastVisit ?? null),
      daysToConversion: journey?.daysToConversion ?? null,
      sessions: journey?.momentsCount?.count ?? null,
      discountCodes: order.discountCodes,
      attributes: order.customAttributes.filter((attribute) => attribute.value),
      subtotal: Number(order.subtotalPriceSet.shopMoney.amount),
      total: Number(order.totalPriceSet.shopMoney.amount),
      currency: order.totalPriceSet.shopMoney.currencyCode,
      items,
      giftUnits,
      flags,
    };
  });

  const visible = orders.filter((order) =>
    view === "gift" ? order.giftUnits > 0 : view === "flagged" ? order.flags.length > 0 : true);
  return {
    days, view, search, error, withCustomer,
    nextCursor: hasNextPage ? cursor : null,
    scanned: orders.length,
    stats: {
      orders: orders.length,
      giftOrders: orders.filter((order) => order.giftUnits > 0).length,
      flagged: orders.filter((order) => order.flags.length > 0).length,
      outsideApp: orders.filter((order) => order.items.some((item) => item.outsideApp)).length,
    },
    orders: visible,
  };
};

type LogOrder = ReturnType<typeof useLoaderData<typeof loader>>["orders"][number];

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
// Store URLs show as their path, so "/products/zion-cases-sling-2-1" reads at a glance.
const shortUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}${parsed.search}`.replace(/^[^/]*zioncases\.com/, "");
  } catch {
    return value;
  }
};

function Kpi({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: Tone }) {
  return <s-box border="base" borderRadius="base" padding="base">
    <s-stack gap="small-200">
      <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="center">
        <s-text color="subdued">{label}</s-text>
        {tone !== "neutral" && <s-badge tone={tone}>{value ? "Check" : "None"}</s-badge>}
      </s-grid>
      <div style={{ fontSize: 26, fontWeight: 650, lineHeight: "32px", letterSpacing: "-0.01em" }}>{value}</div>
      <s-text color="subdued">{detail}</s-text>
    </s-stack>
  </s-box>;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <s-grid gridTemplateColumns="minmax(130px, 1fr) 3fr" gap="base">
    <s-text color="subdued">{label}</s-text>
    <s-text>{children}</s-text>
  </s-grid>;
}

function VisitDetails({ title, visit }: { title: string; visit: LogOrder["firstVisit"] }) {
  if (!visit) return null;
  return <s-stack gap="small-200">
    <s-text type="strong">{title}</s-text>
    <Detail label="When"><span suppressHydrationWarning>{formatDate(visit.at)}</span></Detail>
    <Detail label="Source">{visit.source || "Direct"}</Detail>
    <Detail label="Landing page">{visit.landingPage ? shortUrl(visit.landingPage) : "—"}</Detail>
    <Detail label="Referrer">{visit.referrer ? shortUrl(visit.referrer) : "None (typed or bookmarked)"}</Detail>
    {visit.utm && <Detail label="UTM">{visit.utm}</Detail>}
  </s-stack>;
}

function OrderDetails({ order }: { order: LogOrder }) {
  return <s-section heading={`${order.name} details`}>
    <s-stack gap="base">
      {order.flags.length > 0 && <s-banner tone={order.flags.some((flag) => flag.tone === "critical") ? "critical" : "warning"} heading="Free gift or risk issues">
        {order.flags.map((flag) => flag.label).join(" · ")}
      </s-banner>}
      <s-stack gap="small-200">
        <Detail label="Customer">{order.customer || order.email ? `${order.customer}${order.email ? ` (${order.email})` : ""}` : "Not available"}</Detail>
        {order.customerOrders > 0 && <Detail label="Orders by customer">{order.customerOrders}</Detail>}
        <Detail label="Channel">{order.channel}</Detail>
        <Detail label="IP address">{order.ip || "—"}</Detail>
        <Detail label="Payment">{`${order.financial}${order.cancelled ? " · Cancelled" : ""} · ${order.fulfillment}`}</Detail>
        <Detail label="Discount codes">{order.discountCodes.length ? order.discountCodes.join(", ") : "None"}</Detail>
        {order.daysToConversion !== null && <Detail label="Days to buy">{`${order.daysToConversion} day${order.daysToConversion === 1 ? "" : "s"} over ${order.sessions ?? "?"} visit${order.sessions === 1 ? "" : "s"}`}</Detail>}
        {order.attributes.map((attribute) => <Detail key={attribute.key} label={`Cart: ${attribute.key}`}>{attribute.value}</Detail>)}
      </s-stack>
      <s-divider />
      <VisitDetails title="First visit" visit={order.firstVisit} />
      <VisitDetails title="Visit that placed the order" visit={order.lastVisit} />
      {!order.firstVisit && !order.lastVisit && <s-paragraph color="subdued">Shopify has no visit data for this order (for example, it came from a marketplace, the Shop app or a draft order).</s-paragraph>}
      <s-divider />
      <s-stack gap="small-200">
        <s-text type="strong">Items</s-text>
        {order.items.map((item, index) => (
          <s-grid key={index} gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-stack gap="none">
              <s-text>{item.title}</s-text>
              <s-text color="subdued">{[item.variant, item.sku].filter(Boolean).join(" · ")}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {item.outsideApp ? <s-badge tone="critical">Gift, added outside app</s-badge> : item.gift && <s-badge tone="success">Free gift</s-badge>}
              <s-text>{`${money(item.price, order.currency)} × ${item.quantity}`}</s-text>
            </s-stack>
          </s-grid>
        ))}
        <Detail label="Total">{money(order.total, order.currency)}</Detail>
      </s-stack>
      <s-link href={`shopify://admin/orders/${order.id}`} target="_blank">Open order in Shopify</s-link>
    </s-stack>
  </s-section>;
}

export default function OrderLogs() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(data.search);
  const [selectedId, setSelectedId] = useState("");
  const selected = data.orders.find((order) => order.id === selectedId);
  const loading = navigation.state !== "idle";

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    next.delete("after");
    setSelectedId("");
    setSearchParams(next);
  };

  return (
    <s-page heading="Order logs">
      <s-section>
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Every order with the customer, what they bought, how they reached the store (channel, landing page, referrer, UTM) and its IP.
            Orders that break the free gift rules are flagged. Shopify records visits, not the page each item was added from.
          </s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base" alignItems="end">
            <s-select label="Period" value={String(data.days)} onChange={(event) => update({ days: (event.currentTarget as HTMLSelectElement).value })}>
              <s-option value="1">Last 24 hours</s-option>
              <s-option value="7">Last 7 days</s-option>
              <s-option value="30">Last 30 days</s-option>
              <s-option value="60">Last 60 days</s-option>
            </s-select>
            <s-select label="Show" value={data.view} onChange={(event) => update({ view: (event.currentTarget as HTMLSelectElement).value })}>
              <s-option value="all">All orders</s-option>
              <s-option value="gift">Orders with a free gift</s-option>
              <s-option value="flagged">Flagged orders only</s-option>
            </s-select>
            <form onSubmit={(event) => { event.preventDefault(); update({ q: search }); }}>
              <s-search-field label="Search" placeholder="Order number, email or customer name" value={search}
                onInput={(event) => setSearch((event.currentTarget as unknown as { value: string }).value)} />
            </form>
          </s-grid>
          {data.error && <s-banner tone="critical">{data.error}</s-banner>}
          {!data.withCustomer && <s-banner tone="info">Customer names and emails aren&apos;t available to the app, so they&apos;re hidden. Open an order in Shopify to see them.</s-banner>}
        </s-stack>
      </s-section>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
          <Kpi label="Orders" value={data.stats.orders} detail={`Loaded for the last ${data.days === 1 ? "24 hours" : `${data.days} days`}`} tone="neutral" />
          <Kpi label="With a free gift" value={data.stats.giftOrders} detail="Sling or t-shirt in the order" tone="neutral" />
          <Kpi label="Flagged" value={data.stats.flagged} detail="Extra gifts, under minimum or fraud risk" tone={data.stats.flagged ? "critical" : "success"} />
          <Kpi label="Gift added outside app" value={data.stats.outsideApp} detail="Product URL, console or cart link" tone={data.stats.outsideApp ? "critical" : "success"} />
        </s-grid>
      </s-section>

      {selected && <OrderDetails order={selected} />}

      <s-section heading={`Orders (${data.orders.length})`} padding="none">
        {data.orders.length === 0 ? (
          <s-box padding="base"><s-paragraph color="subdued">{loading ? "Loading orders…" : "No orders match these filters."}</s-paragraph></s-box>
        ) : (
          <s-table loading={loading}>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>How they came</s-table-header>
              <s-table-header>Items</s-table-header>
              <s-table-header listSlot="secondary">Flags</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.orders.map((order) => (
                <s-table-row key={order.id} clickDelegate={`order-${order.id}`}>
                  <s-table-cell>
                    <s-stack gap="none">
                      <s-link id={`order-${order.id}`} onClick={() => setSelectedId((current) => (current === order.id ? "" : order.id))}>{order.name}</s-link>
                      <s-text color="subdued"><span suppressHydrationWarning>{formatDate(order.createdAt)}</span></s-text>
                      <s-text color="subdued">{money(order.total, order.currency)}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="none">
                      <s-text>{order.customer || "—"}</s-text>
                      {order.email && <s-text color="subdued">{order.email}</s-text>}
                      {order.ip && <s-text color="subdued">{`IP ${order.ip}`}</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="none">
                      <s-text>{order.channel}</s-text>
                      {order.landingPage && <s-text color="subdued">{`Landed: ${shortUrl(order.landingPage)}`}</s-text>}
                      <s-text color="subdued">{order.referrer ? `From: ${shortUrl(order.referrer)}` : "From: direct"}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="none">
                      {order.items.map((item, index) => (
                        <s-text key={index} color={item.gift ? undefined : "subdued"}>
                          {`${item.quantity} × ${item.title}${item.variant ? ` (${item.variant})` : ""}${item.outsideApp ? " ⚠ gift outside app" : item.gift ? " 🎁" : ""}`}
                        </s-text>
                      ))}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-100">
                      {order.flags.length === 0
                        ? <s-badge tone="success">OK</s-badge>
                        : order.flags.map((flag) => <s-badge key={flag.label} tone={flag.tone}>{flag.label}</s-badge>)}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {data.nextCursor && <s-box padding="base">
          <s-button onClick={() => { const next = new URLSearchParams(searchParams); next.set("after", data.nextCursor!); setSelectedId(""); setSearchParams(next); }}>
            Older orders
          </s-button>
        </s-box>}
      </s-section>
    </s-page>
  );
}
