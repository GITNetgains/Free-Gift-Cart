import type { PrismaClient } from "@prisma/client";
import { defaultFaqs, extractEmail, extractOrderNumber, isOrderStatusQuestion, matchFaq, NO_ANSWER } from "./help-desk-bot";

type AdminClient = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };
export type BotAnswer = { answer: string; result: "faq" | "order" | "none"; faqId?: string; links?: { label: string; url: string }[]; orderNotFound?: boolean };

const ORDER_STATUS_QUERY = `#graphql
  query HelpDeskBotOrders($query: String!, $first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes {
        name createdAt cancelledAt displayFulfillmentStatus
        fulfillments(first: 3) { displayStatus trackingInfo(first: 1) { company number url } }
      }
    }
  }
`;

type OrderNode = {
  name: string; createdAt: string; cancelledAt: string | null; displayFulfillmentStatus: string;
  fulfillments: { displayStatus: string | null; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[];
};

const FULFILLMENT_TEXT: Record<string, string> = {
  FULFILLED: "has shipped", PARTIALLY_FULFILLED: "has partly shipped", UNFULFILLED: "is being prepared for shipping",
  IN_PROGRESS: "is being prepared for shipping", ON_HOLD: "is on hold", SCHEDULED: "is scheduled", OPEN: "is being prepared for shipping",
  PENDING_FULFILLMENT: "is being prepared for shipping", RESTOCKED: "was restocked", REQUEST_DECLINED: "is being reviewed",
};
const DELIVERY_TEXT: Record<string, string> = { DELIVERED: "delivered", OUT_FOR_DELIVERY: "out for delivery", IN_TRANSIT: "in transit", ATTEMPTED_DELIVERY: "a delivery attempt was made", FAILURE: "a delivery problem was reported" };

function describe(order: OrderNode) {
  const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(order.createdAt));
  if (order.cancelledAt) return { text: `Order ${order.name} (placed ${date}) was cancelled.`, links: [] };
  const latest = order.fulfillments.find((fulfillment) => fulfillment.displayStatus) ?? order.fulfillments[0];
  const delivery = latest?.displayStatus ? DELIVERY_TEXT[latest.displayStatus] : "";
  const tracking = order.fulfillments.flatMap((fulfillment) => fulfillment.trackingInfo).find((info) => info.number || info.url);
  const parts = [`Order ${order.name} (placed ${date}) ${FULFILLMENT_TEXT[order.displayFulfillmentStatus] ?? "is being processed"}${delivery ? `, latest update: ${delivery}` : ""}.`];
  if (tracking?.number) parts.push(`Tracking${tracking.company ? ` (${tracking.company})` : ""}: ${tracking.number}.`);
  return { text: parts.join(" "), links: tracking?.url && /^https:\/\//.test(tracking.url) ? [{ label: `Track ${order.name}`, url: tracking.url }] : [] };
}

async function findOrders(admin: AdminClient, query: string, first: number) {
  const json = await (await admin.graphql(ORDER_STATUS_QUERY, { variables: { query, first } })).json();
  const nodes = json.data?.orders?.nodes as OrderNode[] | undefined;
  if (!Array.isArray(nodes)) throw new Error("Orders unavailable");
  return nodes;
}

// Answers a chat question: real order status first (for the signed-in
// customer, or an order number plus the email it was placed with), then the
// store's FAQ, otherwise an offer to talk to a person.
export async function answerQuestion(db: PrismaClient, shop: string, admin: AdminClient | undefined, question: string, customerId = ""): Promise<BotAnswer> {
  const text = question.trim().slice(0, 500);
  let answer: BotAnswer | null = null;
  const orderNumber = extractOrderNumber(text);
  const email = extractEmail(text);
  try {
    if (admin && orderNumber && email && !/["\\]/.test(email)) {
      const [order] = await findOrders(admin, `name:"#${orderNumber}" AND email:"${email}"`, 1);
      if (order) {
        const found = describe(order);
        answer = { answer: found.text, links: found.links, result: "order" };
      } else {
        answer = { answer: `I couldn't find order #${orderNumber} with ${email}. Check the number and use the email from your order confirmation, or tap "Talk to our team".`, result: "order", orderNotFound: true };
      }
    } else if (admin && /^\d+$/.test(customerId) && (isOrderStatusQuestion(text) || orderNumber)) {
      const orders = await findOrders(admin, orderNumber ? `customer_id:${customerId} AND name:"#${orderNumber}"` : `customer_id:${customerId}`, 3);
      if (orders.length) {
        const described = orders.map(describe);
        answer = { answer: (orders.length > 1 ? "Here are your latest orders:\n" : "") + described.map((item) => item.text).join("\n"), links: described.flatMap((item) => item.links), result: "order" };
      } else answer = { answer: orderNumber ? `I couldn't find order #${orderNumber} on your account.` : "I couldn't find any orders on your account yet.", result: "order" };
    } else if (orderNumber && isOrderStatusQuestion(text)) {
      answer = { answer: `I can check order #${orderNumber} for you. Please send it again with the email you used for the order, for example: "Order #${orderNumber}, name@example.com".`, result: "order" };
    }
  } catch (error) {
    console.error("Help Desk chat order lookup failed:", error);
  }
  if (!answer) {
    const faqs = await db.helpDeskFaq.findMany({ where: { shop }, select: { id: true, question: true, keywords: true, answer: true } });
    const faq = matchFaq(text, faqs);
    answer = faq ? { answer: faq.answer, result: "faq", faqId: faq.id } : { answer: NO_ANSWER, result: "none" };
  }
  await db.helpDeskBotQuestion.create({ data: { shop, question: text, result: answer.result, faqId: answer.faqId ?? null } }).catch(() => undefined);
  return answer;
}

// New stores get the starter FAQs once; a store that deletes them keeps its choice.
export async function ensureFaqs(db: PrismaClient, shop: string) {
  const settings = await db.helpDeskSettings.upsert({ where: { shop }, update: {}, create: { shop } });
  if (settings.faqsSeeded) return settings;
  if (!await db.helpDeskFaq.count({ where: { shop } })) await db.helpDeskFaq.createMany({ data: defaultFaqs.map((faq) => ({ shop, ...faq })) });
  return db.helpDeskSettings.update({ where: { shop }, data: { faqsSeeded: true } });
}

export async function chatConfig(db: PrismaClient, shop: string) {
  const settings = await ensureFaqs(db, shop);
  const faqs = await db.helpDeskFaq.findMany({ where: { shop }, orderBy: { createdAt: "asc" }, take: 4, select: { question: true } });
  return {
    enabled: settings.chatEnabled,
    greeting: settings.chatGreeting || "Hi! Ask me anything, like where your order is, or tap a question below.",
    suggestions: faqs.map((faq) => faq.question),
  };
}
