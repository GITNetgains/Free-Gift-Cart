// Recent orders for the signed-in storefront customer, for the Help Desk order
// picker. The customer ID comes from the signed app proxy request
// (logged_in_customer_id), so a shopper only ever sees their own orders.
// Uses the orders search (customer_id filter), which needs only the read_orders
// scope, not read_customers; without it (or on any error) the form falls back
// to the orders the theme can see, or a typed order number.
type AdminClient = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };
export type CustomerOrder = {
  name: string; date: string; fulfillment: "fulfilled" | "partial" | null; cancelled: boolean;
  items: { id: string; title: string; variant: string; quantity: number; image: string }[];
};

const ORDERS_QUERY = `#graphql
  query HelpDeskCustomerOrders($query: String!) {
    orders(first: 20, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes {
        name createdAt displayFulfillmentStatus cancelledAt
        lineItems(first: 30) {
          nodes { title variantTitle quantity product { id title } image { url(transform: { maxWidth: 120 }) } }
        }
      }
    }
  }
`;

type OrderNode = {
  name: string; createdAt: string; displayFulfillmentStatus: string; cancelledAt: string | null;
  lineItems: { nodes: { title: string; variantTitle: string | null; quantity: number; product: { id: string; title: string } | null; image: { url: string } | null }[] };
};

export async function customerOrders(admin: AdminClient | undefined, customerId: string | null): Promise<CustomerOrder[] | null> {
  if (!admin || !customerId || !/^\d+$/.test(customerId)) return null;
  try {
    const json = await (await admin.graphql(ORDERS_QUERY, { variables: { query: `customer_id:${customerId}` } })).json();
    const nodes = json.data?.orders?.nodes as OrderNode[] | undefined;
    if (!Array.isArray(nodes)) return null;
    const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
    return nodes.map(order => ({
      name: order.name,
      date: date.format(new Date(order.createdAt)),
      fulfillment: order.displayFulfillmentStatus === "FULFILLED" ? "fulfilled" : order.displayFulfillmentStatus === "PARTIALLY_FULFILLED" ? "partial" : null,
      cancelled: Boolean(order.cancelledAt),
      items: order.lineItems.nodes.map(item => ({
        id: item.product?.id || "",
        title: item.product?.title || item.title,
        variant: item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : "",
        quantity: item.quantity,
        image: item.image?.url || "",
      })),
    }));
  } catch (error) {
    console.error("Help Desk could not load customer orders:", error);
    return null;
  }
}

// Recent orders placed with a ticket's email, for the agent's sidebar.
export type AgentOrder = { id: string; name: string; date: string; total: string; payment: string; fulfillment: string; cancelled: boolean };

const EMAIL_ORDERS_QUERY = `#graphql
  query HelpDeskEmailOrders($query: String!) {
    orders(first: 5, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes {
        legacyResourceId name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

const readable = (value: string | null) => (value || "").toLowerCase().replace(/_/g, " ").replace(/^./, char => char.toUpperCase());

export async function ordersByEmail(admin: AdminClient, email: string): Promise<AgentOrder[] | null> {
  if (!/^[^\s@"\\]+@[^\s@"\\]+$/.test(email)) return [];
  try {
    const json = await (await admin.graphql(EMAIL_ORDERS_QUERY, { variables: { query: `email:"${email}"` } })).json();
    const nodes = json.data?.orders?.nodes as {
      legacyResourceId: string; name: string; createdAt: string; cancelledAt: string | null; displayFinancialStatus: string | null;
      displayFulfillmentStatus: string; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
    }[] | undefined;
    if (!Array.isArray(nodes)) return null;
    const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
    return nodes.map(order => ({
      id: order.legacyResourceId,
      name: order.name,
      date: date.format(new Date(order.createdAt)),
      total: new Intl.NumberFormat("en", { style: "currency", currency: order.totalPriceSet.shopMoney.currencyCode }).format(Number(order.totalPriceSet.shopMoney.amount)),
      payment: readable(order.displayFinancialStatus),
      fulfillment: readable(order.displayFulfillmentStatus),
      cancelled: Boolean(order.cancelledAt),
    }));
  } catch (error) {
    console.error("Help Desk could not load orders for a ticket:", error);
    return null;
  }
}
