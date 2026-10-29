import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { staffName } from "../services/help-desk-staff.server";

// Order logs: who bought what, through which channel and pages, and which
// orders break the free gift rules. Each order gets a written account of what
// the buyer did, built from Shopify's visit records and the order's items,
// plus a note staff can write. Shopify keeps the buyer's visits (landing
// page, referrer, UTM) per order, not which page each item was added from.
// read_orders only reaches the last 60 days of orders.

type GiftSettings = { minimumSpend?: number; products?: Array<{ productId?: string }> };
type Tone = "success" | "warning" | "critical" | "info" | "neutral" | "caution";

// Always treated as free gifts, like the checkout validation function.
const ALWAYS_GIFT_PRODUCT_IDS = ["gid://shopify/Product/8708096557231", "gid://shopify/Product/8431587655855"];
const PAGE_SIZE = 25;
const MAX_ROWS = 100;
const MAX_NOTE = 2000;

const SETTINGS_QUERY = `#graphql
  query OrderLogsSettings {
    shop { giftSettings: metafield(namespace: "free_gift_cart", key: "settings") { jsonValue } }
  }
`;
const ordersQuery = (withCustomer: boolean) => `#graphql
  query OrderLogs($query: String!, $cursor: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        legacyResourceId name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
        sourceName clientIp discountCodes
        ${withCustomer ? "email customer { displayName numberOfOrders }" : ""}
        app { name }
        risk { recommendation }
        customAttributes { key value }
        totalPriceSet { shopMoney { amount currencyCode } }
        customerJourneySummary {
          daysToConversion momentsCount { count }
          moments(first: 10) {
            nodes {
              occurredAt
              ... on CustomerVisit { source sourceType landingPage referrerUrl utmParameters { source medium campaign } }
            }
          }
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
  occurredAt: string; source?: string | null; sourceType?: string | null; landingPage?: string | null; referrerUrl?: string | null;
  utmParameters?: { source: string | null; medium: string | null; campaign: string | null } | null;
};
type OrderNode = {
  legacyResourceId: string; name: string; createdAt: string; cancelledAt: string | null;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string;
  sourceName: string | null; clientIp: string | null; discountCodes: string[];
  email?: string | null; customer?: { displayName: string; numberOfOrders: string } | null;
  app: { name: string } | null; risk: { recommendation: string } | null;
  customAttributes: { key: string; value: string | null }[];
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customerJourneySummary: { daysToConversion: number | null; momentsCount: { count: number } | null; moments: { nodes: Visit[] } } | null;
  lineItems: { nodes: {
    title: string; variantTitle: string | null; sku: string | null; quantity: number; product: { id: string } | null;
    customAttributes: { key: string; value: string | null }[]; originalUnitPriceSet: { shopMoney: { amount: string } };
  }[] };
};
type Item = { title: string; variant: string; sku: string; quantity: number; price: number; claimed: boolean; gift: boolean; outsideApp: boolean };
type Step = { at: string; text: string; tone: Tone };

const readable = (value: string | null | undefined) => (value || "").toLowerCase().replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
// Store URLs show as their path, so "/products/zion-cases-sling-2-1" reads at a glance.
const shortUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "");
    return host.endsWith("zioncases.com") ? `${parsed.pathname}${parsed.search}` : `${host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return value;
  }
};
const itemLabel = (item: Item) => `${item.title}${item.variant ? ` (${item.variant})` : ""}${item.quantity > 1 ? ` ×${item.quantity}` : ""}`;

// "101910" or "#101910" is an order number; anything else (email, name, SKU)
// goes to Shopify's order search as typed.
const searchTerm = (value: string) => {
  const number = value.match(/^#?(\d{3,})$/);
  return number ? `name:#${number[1]}` : value.replace(/[()]/g, " ");
};

function pageName(url: string) {
  const path = shortUrl(url);
  if (path === "/" || path === "") return "the homepage";
  if (path.startsWith("/cart")) return "the cart page";
  if (path.startsWith("/checkouts") || path.includes("/checkouts/")) return "checkout";
  if (path.startsWith("/products/")) return `the product page ${path}`;
  if (path.startsWith("/collections/")) return `the collection ${path}`;
  return path;
}

function visitSource(visit: Visit) {
  const utm = visit.utmParameters;
  if (utm?.medium === "product_sync") return "a free Google Shopping listing";
  if (utm?.source || utm?.medium) return `a tagged link (${[utm.source, utm.medium, utm.campaign].filter(Boolean).join(" / ")})`;
  const referrer = visit.referrerUrl ? shortUrl(visit.referrerUrl) : "";
  if (referrer.startsWith("/")) return "a store page that was already open in the browser";
  if (/google\./.test(referrer)) return "a Google search";
  if (/facebook\.|instagram\.|fb\./.test(referrer)) return "Facebook or Instagram";
  if (referrer) return referrer;
  return "a typed address, bookmark or app (direct)";
}

// A plain-language account of the order, step by step, from Shopify's visit
// records and the order's items.
function buildStory(order: OrderNode, items: Item[], minimum: number, currency: string) {
  const steps: Step[] = [];
  const visits = order.customerJourneySummary?.moments.nodes.filter((visit) => "landingPage" in visit) ?? [];
  const totalVisits = order.customerJourneySummary?.momentsCount?.count ?? visits.length;
  visits.forEach((visit, index) => {
    steps.push({
      at: visit.occurredAt,
      text: `Visit ${index + 1}${totalVisits > 1 ? ` of ${totalVisits}` : ""}: came from ${visitSource(visit)} and landed on ${visit.landingPage ? pageName(visit.landingPage) : "an unknown page"}.`,
      tone: "neutral",
    });
  });
  if (totalVisits > visits.length) {
    steps.push({ at: "", text: `${plural(totalVisits - visits.length, "more visit")} not shown.`, tone: "neutral" });
  }

  const paid = items.filter((item) => !item.gift);
  const paidSubtotal = paid.reduce((total, item) => total + item.price * item.quantity, 0);
  if (paid.length) {
    steps.push({ at: "", text: `Put ${plural(paid.reduce((total, item) => total + item.quantity, 0), "paid item")} in the cart: ${paid.map(itemLabel).join(", ")}, ${money(paidSubtotal, currency)} before discounts.`, tone: "neutral" });
  }
  const claimed = items.filter((item) => item.claimed);
  if (claimed.length) {
    steps.push({ at: "", text: `Claimed ${claimed.map(itemLabel).join(", ")} as the free gift through the app (cart popup, cart banner or checkout block).`, tone: "success" });
  }
  const outside = items.filter((item) => item.outsideApp);
  const outsideUnits = outside.reduce((total, item) => total + item.quantity, 0);
  if (outside.length) {
    steps.push({
      at: "",
      text: `Added ${plural(outsideUnits, "more free gift unit")} without the app: ${outside.map(itemLabel).join(", ")}. ` +
        "Gifts claimed through the app carry a hidden marker and these don't, so they were added from the gift's product page, the browser console or a cart link. " +
        "Their price is $0, so they cost nothing.",
      tone: "critical",
    });
  }
  const giftUnits = items.filter((item) => item.gift).reduce((total, item) => total + item.quantity, 0);
  if (giftUnits > 0 && paidSubtotal < minimum) {
    steps.push({ at: "", text: `The paid items came to ${money(paidSubtotal, currency)}, under the ${money(minimum, currency)} gift minimum, so no gift was due.`, tone: "warning" });
  }
  if (order.discountCodes.length) {
    steps.push({ at: "", text: `Used discount code${order.discountCodes.length > 1 ? "s" : ""} ${order.discountCodes.join(", ")}.`, tone: "neutral" });
  }
  const days = order.customerJourneySummary?.daysToConversion;
  steps.push({
    at: order.createdAt,
    text: `Placed the order on ${order.app?.name || order.sourceName || "an unknown channel"}${order.clientIp ? ` from IP ${order.clientIp}` : ""}` +
      `${typeof days === "number" && totalVisits > 1 ? `, ${plural(days, "day")} and ${plural(totalVisits, "visit")} after first coming to the store` : ""}. ` +
      `Payment: ${readable(order.displayFinancialStatus).toLowerCase() || "unknown"}; ${readable(order.displayFulfillmentStatus).toLowerCase()}.` +
      `${order.cancelledAt ? " The order was later cancelled." : ""}`,
    tone: "info",
  });
  const risk = order.risk?.recommendation;
  if (risk && risk !== "NONE" && risk !== "PENDING") {
    const level = risk === "CANCEL" ? "high" : risk === "INVESTIGATE" ? "medium" : "low";
    steps.push({ at: "", text: `Shopify's fraud check rated the order ${level} risk.`, tone: level === "high" ? "critical" : level === "medium" ? "warning" : "neutral" });
  }

  let summary = "Normal order with no free gift.";
  let tone: Tone = "neutral";
  if (giftUnits > 1 && outsideUnits) {
    summary = `Took ${giftUnits} free gifts instead of 1; ${outsideUnits} of them were added outside the app.`;
    tone = "critical";
  } else if (giftUnits > 1) {
    summary = `Took ${giftUnits} free gifts instead of 1.`;
    tone = "critical";
  } else if (outsideUnits) {
    summary = "Took a free gift without using the app.";
    tone = "critical";
  } else if (giftUnits > 0 && paidSubtotal < minimum) {
    summary = `Got a free gift without reaching the ${money(minimum, currency)} minimum.`;
    tone = "warning";
  } else if (giftUnits === 1) {
    summary = "Claimed one free gift the normal way.";
    tone = "success";
  }
  if (risk === "CANCEL") {
    summary += " Shopify rates it high fraud risk.";
    tone = "critical";
  }
  return { summary, tone, steps, firstVisit: visits[0] ?? null, lastVisit: visits[visits.length - 1] ?? null, totalVisits };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = [1, 7, 30, 60].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 7;
  const view = ["all", "gift", "flagged"].includes(url.searchParams.get("view") || "") ? url.searchParams.get("view")! : "all";
  const search = (url.searchParams.get("q") || "").trim().slice(0, 100);

  let giftSettings: GiftSettings = {};
  try {
    const json = await (await admin.graphql(SETTINGS_QUERY)).json();
    giftSettings = (json.data?.shop?.giftSettings?.jsonValue || {}) as GiftSettings;
  } catch (settingsError) {
    console.error("Order logs could not load gift settings:", settingsError);
  }
  const giftProductIds = new Set([
    ...ALWAYS_GIFT_PRODUCT_IDS,
    ...(giftSettings.products || []).map((product) => product.productId).filter((id): id is string => Boolean(id)),
  ]);
  const minimum = Number(giftSettings.minimumSpend || 0) / 100;

  // The gift and flagged views ask Shopify for the matching orders directly,
  // so they aren't limited to the latest page of orders. A search looks
  // through every order the app can read, whatever the period.
  const giftFilter = [...giftProductIds].map((id) => `product_id:${id.split("/").pop()}`);
  const viewFilter = view === "gift" ? giftFilter : view === "flagged" ? [...giftFilter, "risk_level:high", "risk_level:medium"] : [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const query = [
    search ? searchTerm(search) : `created_at:>='${since}'`,
    viewFilter.length ? `(${viewFilter.join(" OR ")})` : "",
  ].filter(Boolean).join(" ");

  // Customer names and emails are protected customer data; if the app isn't
  // approved for them, load the orders without them.
  let withCustomer = true;
  let cursor: string | null = url.searchParams.get("after");
  let hasNextPage = false;
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
  while (nodes.length < MAX_ROWS) {
    let json = await fetchPage(withCustomer);
    if (!json?.data?.orders && withCustomer) {
      withCustomer = false;
      json = await fetchPage(false);
    }
    if (!json?.data?.orders) {
      error = "Orders could not be loaded. Try again, or change the search.";
      break;
    }
    nodes.push(...json.data.orders.nodes);
    hasNextPage = json.data.orders.pageInfo.hasNextPage;
    cursor = json.data.orders.pageInfo.endCursor;
    if (!hasNextPage) break;
  }

  const notes = nodes.length ? await db.orderLogNote.findMany({
    where: { shop: session.shop, orderId: { in: nodes.map((order) => order.legacyResourceId) } },
  }) : [];
  const noteByOrder = new Map(notes.map((note) => [note.orderId, note]));

  const orders = nodes.map((order) => {
    const currency = order.totalPriceSet.shopMoney.currencyCode;
    const items: Item[] = order.lineItems.nodes.map((item) => {
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
    if (items.some((item) => item.outsideApp)) flags.push({ label: "Gift added outside app", tone: "critical" });
    if (giftUnits > 0 && paidSubtotal < minimum) flags.push({ label: "Under gift minimum", tone: "warning" });
    const risk = order.risk?.recommendation;
    if (risk === "CANCEL") flags.push({ label: "High fraud risk", tone: "critical" });
    else if (risk === "INVESTIGATE") flags.push({ label: "Medium fraud risk", tone: "warning" });

    const story = buildStory(order, items, minimum, currency);
    const note = noteByOrder.get(order.legacyResourceId);
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
      lastVisit: story.lastVisit && {
        landingPage: story.lastVisit.landingPage || "",
        referrer: story.lastVisit.referrerUrl || "",
      },
      daysToConversion: order.customerJourneySummary?.daysToConversion ?? null,
      sessions: story.totalVisits,
      discountCodes: order.discountCodes,
      attributes: order.customAttributes.filter((attribute) => attribute.value),
      total: Number(order.totalPriceSet.shopMoney.amount),
      currency,
      items,
      giftUnits,
      flags,
      summary: story.summary,
      summaryTone: story.tone,
      steps: story.steps,
      note: note ? { text: note.note, author: note.author, updatedAt: note.updatedAt.toISOString() } : null,
    };
  });

  const visible = view === "flagged" ? orders.filter((order) => order.flags.length > 0) : orders;
  return {
    days, view, search, error, withCustomer,
    nextCursor: hasNextPage ? cursor : null,
    stats: {
      orders: orders.length,
      more: hasNextPage,
      giftOrders: orders.filter((order) => order.giftUnits > 0).length,
      flagged: orders.filter((order) => order.flags.length > 0).length,
      outsideApp: orders.filter((order) => order.items.some((item) => item.outsideApp)).length,
    },
    orders: visible,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const orderId = String(form.get("orderId") || "");
  const note = String(form.get("note") || "").trim().slice(0, MAX_NOTE);
  if (!/^\d+$/.test(orderId)) return { ok: false, error: "Unknown order." };
  const user = session.onlineAccessInfo?.associated_user;
  const author = user ? staffName(user).slice(0, 60) : "";
  if (!note) {
    await db.orderLogNote.deleteMany({ where: { shop: session.shop, orderId } });
    return { ok: true, message: "Note removed" };
  }
  await db.orderLogNote.upsert({
    where: { shop_orderId: { shop: session.shop, orderId } },
    create: { shop: session.shop, orderId, note, author },
    update: { note, author },
  });
  return { ok: true, message: "Note saved" };
};

type LogOrder = ReturnType<typeof useLoaderData<typeof loader>>["orders"][number];

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

// Order, customer, visit and status share one grid so header and rows line up.
const COLUMNS = "minmax(150px, 1fr) minmax(0, 1.3fr) minmax(0, 1.6fr) minmax(170px, 1fr)";
const DOT: Record<Tone, string> = {
  critical: "#c70a24", warning: "#b98900", success: "#0c8a4f", info: "#2463eb", caution: "#b98900", neutral: "#8a8a8a",
};

function Kpi({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: Tone }) {
  return <s-box border="base" borderRadius="base" padding="base" background="base">
    <s-stack gap="small-200">
      <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="center">
        <s-text color="subdued">{label}</s-text>
        {tone && <s-badge tone={tone}>{tone === "success" ? "Clear" : "Review"}</s-badge>}
      </s-grid>
      <div style={{ fontSize: 26, fontWeight: 650, lineHeight: "32px", letterSpacing: "-0.01em" }}>{value}</div>
      <s-text color="subdued">{detail}</s-text>
    </s-stack>
  </s-box>;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <s-grid gridTemplateColumns="minmax(110px, 1fr) 2fr" gap="base">
    <s-text color="subdued">{label}</s-text>
    <s-text>{children}</s-text>
  </s-grid>;
}

function Card({ heading, children }: { heading: string; children: React.ReactNode }) {
  return <s-box border="base" borderRadius="base" padding="base" background="base">
    <s-stack gap="base">
      <s-text type="strong">{heading}</s-text>
      {children}
    </s-stack>
  </s-box>;
}

// The written account as plain text, for pasting into an email or a note.
function storyText(order: LogOrder) {
  return [
    `${order.name}: ${order.summary}`,
    ...order.steps.map((step, index) => `${index + 1}. ${step.at ? `${formatDate(step.at)}: ` : ""}${step.text}`),
  ].join("\n");
}

function Timeline({ steps }: { steps: LogOrder["steps"] }) {
  return <s-stack gap="none">
    {steps.map((step, index) => (
      <div key={index} style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr)", columnGap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ width: 10, height: 10, marginTop: 5, borderRadius: "50%", background: DOT[step.tone], flex: "none" }} />
          {index < steps.length - 1 && <div style={{ width: 2, flex: 1, minHeight: 12, background: "#e3e3e3", margin: "4px 0" }} />}
        </div>
        <div style={{ paddingBottom: index < steps.length - 1 ? 14 : 0 }}>
          <s-stack gap="none">
            {step.at && <s-text color="subdued"><span suppressHydrationWarning>{formatDate(step.at)}</span></s-text>}
            <s-text tone={step.tone === "critical" ? "critical" : undefined}>{step.text}</s-text>
          </s-stack>
        </div>
      </div>
    ))}
  </s-stack>;
}

function NoteEditor({ order }: { order: LogOrder }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [text, setText] = useState(order.note?.text || "");
  useEffect(() => { setText(order.note?.text || ""); }, [order.note?.text]);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show(fetcher.data.message || "Saved");
    else shopify.toast.show(fetcher.data.error || "The note could not be saved.", { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);
  const saving = fetcher.state !== "idle";
  const changed = text.trim() !== (order.note?.text || "");
  return <Card heading="Your notes">
    <s-text-area label="Notes about this order" labelAccessibilityVisibility="exclusive" rows={4} maxLength={MAX_NOTE}
      placeholder="What you found or did, e.g. “Emailed the customer about the 4 extra slings on Oct 29.”"
      value={text} onInput={(event) => setText((event.currentTarget as unknown as { value: string }).value)} />
    <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="base" alignItems="center">
      <s-text color="subdued">
        {order.note ? <span suppressHydrationWarning>{`Saved ${formatDate(order.note.updatedAt)}${order.note.author ? ` by ${order.note.author}` : ""}`}</span> : "Only staff see these notes."}
      </s-text>
      <s-button variant="primary" disabled={!changed} {...(saving ? { loading: true } : {})}
        onClick={() => fetcher.submit({ orderId: order.id, note: text }, { method: "POST" })}>
        Save note
      </s-button>
    </s-grid>
  </Card>;
}

function OrderDetails({ order }: { order: LogOrder }) {
  const shopify = useAppBridge();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(storyText(order));
      shopify.toast.show("Description copied");
    } catch {
      shopify.toast.show("Copying isn't allowed here. Select the text instead.", { isError: true });
    }
  };
  return <s-box background="subdued" borderRadius="base" padding="base">
    <s-stack gap="base">
      <s-banner tone={order.summaryTone === "neutral" ? "info" : order.summaryTone} heading={order.summary}>
        {order.flags.length > 0 ? order.flags.map((flag) => flag.label).join(" · ") : "Nothing unusual in this order."}
      </s-banner>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(320px, 1fr))" gap="base" alignItems="start">
        <s-stack gap="base">
          <Card heading="What happened">
            <Timeline steps={order.steps} />
            <s-stack direction="inline" gap="small-200">
              <s-button icon="clipboard" onClick={copy}>Copy description</s-button>
              <s-button href={`shopify://admin/orders/${order.id}`} target="_blank" icon="external">Open in Shopify</s-button>
            </s-stack>
          </Card>
          <NoteEditor order={order} />
        </s-stack>
        <s-stack gap="base">
          <Card heading="Order">
            <s-stack gap="small-200">
              <Detail label="Customer">{order.customer || order.email ? [order.customer, order.email].filter(Boolean).join(" · ") : "Hidden by Shopify"}</Detail>
              {order.customerOrders > 0 && <Detail label="Their orders">{order.customerOrders}</Detail>}
              <Detail label="Channel">{order.channel}</Detail>
              <Detail label="IP address">{order.ip || "—"}</Detail>
              <Detail label="Status">{[order.financial, order.cancelled && "Cancelled", order.fulfillment].filter(Boolean).join(" · ")}</Detail>
              <Detail label="Discount codes">{order.discountCodes.length ? order.discountCodes.join(", ") : "None"}</Detail>
              {order.daysToConversion !== null && <Detail label="Time to buy">{`${order.daysToConversion} day${order.daysToConversion === 1 ? "" : "s"}, ${order.sessions} visit${order.sessions === 1 ? "" : "s"}`}</Detail>}
              {order.attributes.map((attribute) => <Detail key={attribute.key} label={attribute.key}>{attribute.value}</Detail>)}
            </s-stack>
          </Card>
          <Card heading="Items">
            <s-stack gap="small-200">
              {order.items.map((item, index) => (
                <s-grid key={index} gridTemplateColumns="minmax(0, 1fr) auto" gap="base" alignItems="center">
                  <s-stack gap="none">
                    <s-text>{item.title}</s-text>
                    <s-text color="subdued">{[item.variant, item.sku].filter(Boolean).join(" · ")}</s-text>
                  </s-stack>
                  <s-stack gap="none" alignItems="end">
                    <s-text>{`${new Intl.NumberFormat("en", { style: "currency", currency: order.currency }).format(item.price)} × ${item.quantity}`}</s-text>
                    {item.outsideApp ? <s-badge tone="critical">Outside app</s-badge> : item.gift && <s-badge tone="success">Free gift</s-badge>}
                  </s-stack>
                </s-grid>
              ))}
              <s-divider />
              <s-grid gridTemplateColumns="1fr auto" gap="base">
                <s-text type="strong">Total</s-text>
                <s-text type="strong">{new Intl.NumberFormat("en", { style: "currency", currency: order.currency }).format(order.total)}</s-text>
              </s-grid>
            </s-stack>
          </Card>
        </s-stack>
      </s-grid>
    </s-stack>
  </s-box>;
}

function OrderRow({ order, open, onToggle }: { order: LogOrder; open: boolean; onToggle: () => void }) {
  const visit = order.lastVisit;
  return <s-stack gap="small-200">
    <s-clickable onClick={onToggle} padding="base" borderRadius="base" background={open ? "subdued" : undefined}
      accessibilityLabel={`${open ? "Hide" : "Show"} details for ${order.name}`}>
      <s-grid gridTemplateColumns={COLUMNS} gap="base" alignItems="start">
        <s-stack gap="none">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{order.name}</s-text>
            <s-icon type={open ? "chevron-up" : "chevron-down"} size="small" />
          </s-stack>
          <s-text color="subdued"><span suppressHydrationWarning>{formatDate(order.createdAt)}</span></s-text>
          <s-text>{new Intl.NumberFormat("en", { style: "currency", currency: order.currency }).format(order.total)}</s-text>
        </s-stack>
        <s-stack gap="none">
          <s-text>{order.customer || order.email || "Hidden"}</s-text>
          {order.customer && order.email && <s-text color="subdued">{order.email}</s-text>}
          {order.ip && <s-text color="subdued">{order.ip}</s-text>}
        </s-stack>
        <s-stack gap="none">
          <s-text>{order.channel}</s-text>
          <s-text color="subdued">{visit?.referrer ? `From ${shortUrl(visit.referrer)}` : visit ? "Direct" : "No visit data"}</s-text>
          {visit?.landingPage && <s-text color="subdued">{`Landed on ${shortUrl(visit.landingPage)}`}</s-text>}
        </s-stack>
        <s-stack gap="small-100">
          {order.flags.length === 0
            ? <s-badge tone="success">{order.giftUnits ? "1 free gift · OK" : "OK"}</s-badge>
            : order.flags.map((flag) => <s-badge key={flag.label} tone={flag.tone}>{flag.label}</s-badge>)}
          {order.note && <s-badge tone="info" icon="note">Note</s-badge>}
        </s-stack>
      </s-grid>
    </s-clickable>
    {open && <OrderDetails order={order} />}
  </s-stack>;
}

export default function OrderLogs() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(data.search);
  const [openId, setOpenId] = useState("");
  const loading = navigation.state === "loading";
  useEffect(() => { setSearch(data.search); }, [data.search]);
  // A search for one order opens it straight away.
  useEffect(() => {
    if (data.search && data.orders.length === 1) setOpenId(data.orders[0].id);
  }, [data.search, data.orders]);

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    next.delete("after");
    setOpenId("");
    setSearchParams(next);
  };
  const runSearch = () => update({ q: search.trim() });
  const period = data.days === 1 ? "24 hours" : `${data.days} days`;
  const scope = data.search ? `matching “${data.search}”` : `in the last ${period}`;
  const count = `${data.stats.orders}${data.stats.more ? "+" : ""}`;

  return (
    <s-page heading="Order logs" inlineSize="large">
      <s-section>
        <s-stack gap="base">
          <s-grid gridTemplateColumns="minmax(0, 2fr) minmax(160px, 1fr) minmax(180px, 1fr)" gap="base" alignItems="end">
            <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small-200" alignItems="end">
              {/* s-search-field doesn't submit a form, so Enter is caught here; the Search button is the clickable path. */}
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
              <div onKeyDown={(event) => { if (event.key === "Enter") runSearch(); }}>
                <s-search-field label="Search orders" placeholder="Order number, email, customer name or SKU" value={search}
                  onInput={(event) => setSearch((event.currentTarget as unknown as { value: string }).value)} />
              </div>
              <s-stack direction="inline" gap="small-200">
                <s-button variant="primary" onClick={runSearch} {...(loading ? { loading: true } : {})}>Search</s-button>
                {data.search && <s-button onClick={() => { setSearch(""); update({ q: "" }); }}>Clear</s-button>}
              </s-stack>
            </s-grid>
            <s-select label="Period" value={String(data.days)} disabled={Boolean(data.search)}
              onChange={(event) => update({ days: (event.currentTarget as HTMLSelectElement).value })}>
              <s-option value="1">Last 24 hours</s-option>
              <s-option value="7">Last 7 days</s-option>
              <s-option value="30">Last 30 days</s-option>
              <s-option value="60">Last 60 days</s-option>
            </s-select>
            <s-select label="Show" value={data.view} onChange={(event) => update({ view: (event.currentTarget as HTMLSelectElement).value })}>
              <s-option value="all">All orders</s-option>
              <s-option value="gift">Orders with a free gift</s-option>
              <s-option value="flagged">Flagged orders</s-option>
            </s-select>
          </s-grid>
          {data.search && <s-text color="subdued">Search looks through every order from the last 60 days, so the period is ignored.</s-text>}
          {data.error && <s-banner tone="critical">{data.error}</s-banner>}
          {!data.withCustomer && <s-banner tone="info" heading="Customer names and emails are hidden">
            Shopify only shares them with apps approved for protected customer data. Request access for name and email in the
            Partner Dashboard (API access → Protected customer data), or open the order in Shopify to see the customer.
          </s-banner>}
        </s-stack>
      </s-section>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        <Kpi label={data.view === "all" ? "Orders" : data.view === "gift" ? "Gift orders" : "Checked orders"} value={count} detail={`Latest ${scope}`} />
        <Kpi label="With a free gift" value={String(data.stats.giftOrders)} detail="Sling or t-shirt in the order" />
        <Kpi label="Flagged" value={String(data.stats.flagged)} detail="Extra gifts, under minimum or fraud risk" tone={data.stats.flagged ? "critical" : "success"} />
        <Kpi label="Gift added outside app" value={String(data.stats.outsideApp)} detail="Product URL, console or cart link" tone={data.stats.outsideApp ? "critical" : "success"} />
      </s-grid>

      <s-section heading={`Orders (${data.orders.length}${data.stats.more && data.view !== "flagged" ? "+" : ""})`}>
        {data.orders.length === 0 ? (
          <s-paragraph color="subdued">{loading ? "Loading orders…" : `No orders ${scope}.`}</s-paragraph>
        ) : (
          <s-stack gap="small-200">
            <s-text color="subdued">Click an order to read what the customer did, step by step, and add your notes.</s-text>
            <s-box paddingInline="base">
              <s-grid gridTemplateColumns={COLUMNS} gap="base">
                {["Order", "Customer", "How they came", "Status"].map((heading) => (
                  <s-text key={heading} type="strong" color="subdued">{heading}</s-text>
                ))}
              </s-grid>
            </s-box>
            {data.orders.map((order, index) => (
              <s-stack key={order.id} gap="small-200">
                {index > 0 && <s-divider />}
                <OrderRow order={order} open={openId === order.id} onToggle={() => setOpenId((current) => (current === order.id ? "" : order.id))} />
              </s-stack>
            ))}
          </s-stack>
        )}
        {data.nextCursor && <s-box paddingBlockStart="base">
          <s-button onClick={() => { const next = new URLSearchParams(searchParams); next.set("after", data.nextCursor!); setOpenId(""); setSearchParams(next); }}>
            Older orders
          </s-button>
        </s-box>}
      </s-section>
    </s-page>
  );
}
