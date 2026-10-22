import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { countries, issues, MAX_MESSAGE_LENGTH, orderTypes, topics, updates } from "../services/help-desk";
import { renderLookupPage, renderRequestPage } from "../services/help-desk-request-page";
import { addCustomerMessage, customerCanReply, MAX_REPLY_IMAGES, readHelpDeskForm, startChat, submitTicket } from "../services/help-desk.server";
import { answerQuestion, chatConfig } from "../services/help-desk-chat.server";
import { customerOrders } from "../services/help-desk-orders.server";
import { ensureWorker, queueEmail } from "../services/help-desk-outbox.server";
import { queueTicketScans } from "../services/image-scan/scan.server";
import { blocked, clear, clientKey, hit } from "../services/rate-limit.server";

const headers = { "Cache-Control": "no-store" };
const privateHeaders = { "Cache-Control": "private, no-store" };
const TOKEN = /^[a-f0-9]{48}$/;
const MINUTE = 60_000;
// Customer-visible message kinds; internal notes and the activity log stay private.
const PUBLIC_KINDS = ["customer", "reply", "bot"];

const json = (body: unknown, status = 200, extra: HeadersInit = headers) => Response.json(body, { status, headers: extra });
const tooMany = () => json({ errors: { form: "Too many requests. Please wait a minute and try again." } }, 429);
const files = (form: FormData) => form.getAll("images").filter((value): value is File => typeof value !== "string" && Boolean(value.name));

// Only Shopify-signed proxy requests from an installed store reach these
// endpoints, and the shop always comes from the signature, never the request.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Help desk is unavailable." }, 403);
  const { shop } = session;
  ensureWorker(db);
  const params = new URL(request.url).searchParams;
  // Signed by Shopify, so this is the shopper's own customer ID (empty when logged out).
  const customerId = params.get("logged_in_customer_id") || "";

  // Live chat: the widget polls its conversation with the ticket's secret token.
  const chat = params.get("chat");
  if (chat !== null) {
    if (!hit(`poll|${clientKey(request, shop)}`, 30, MINUTE)) return tooMany();
    const ticket = TOKEN.test(chat) ? await db.helpDeskTicket.findFirst({
      where: { shop, accessToken: chat },
      include: { messages: { where: { kind: { in: PUBLIC_KINDS } }, orderBy: { createdAt: "asc" }, take: 200 }, attachments: { where: { messageId: { not: null } }, select: { messageId: true } } },
    }) : null;
    if (!ticket) return json({ error: "This conversation could not be found." }, 404);
    const images = new Map<string, number>();
    for (const file of ticket.attachments) images.set(file.messageId!, (images.get(file.messageId!) ?? 0) + 1);
    return json({
      ticket: { number: ticket.number, status: ticket.status, topic: ticket.topic },
      messages: ticket.messages.map(({ id, kind, author, body, createdAt }) => ({ id, kind, author: kind === "customer" ? "You" : author, body, createdAt, images: images.get(id) ?? 0 })),
    }, 200, privateHeaders);
  }
  if (params.get("view") === "chat") return json(await chatConfig(db, shop), 200, privateHeaders);

  const token = params.get("ticket");
  if (token !== null) return trackingPage(shop, token);

  const [orders, tickets] = await Promise.all([
    customerOrders(admin, customerId),
    /^\d+$/.test(customerId) ? db.helpDeskTicket.findMany({
      where: { shop, customerId }, orderBy: { createdAt: "desc" }, take: 20,
      select: { number: true, topic: true, status: true, createdAt: true, lastActivityAt: true, accessToken: true },
    }) : null,
  ]);
  return json({
    countries, issues, orderTypes, topics, updates, orders,
    tickets: tickets && tickets.map(({ accessToken, lastActivityAt, ...ticket }) => ({ ...ticket, updatedAt: lastActivityAt ?? ticket.createdAt, token: accessToken })),
  }, 200, privateHeaders);
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ errors: { form: "Help desk is unavailable." } }, 403);
  if (request.method !== "POST") return json({ errors: { form: "Method not allowed." } }, 405);
  const { shop } = session;
  const client = clientKey(request, shop);
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || "";
  const wantsJson = request.headers.get("Accept")?.includes("application/json");
  let form: FormData;
  try { form = await readHelpDeskForm(request); }
  catch { return json({ errors: { form: "Could not read your request. Upload up to five images of 5 MB each." } }, 400); }
  if (form.get("website")) return json({ errors: { form: "Unable to submit this request." } }, 400);
  const text = (key: string) => String(form.get(key) ?? "");

  switch (form.get("intent")) {
    // The chat bot: FAQ answers and order status. Nothing is saved but the question log.
    case "ask": {
      if (!hit(`ask|${client}`, 20, MINUTE)) return tooMany();
      // Order lookups by number and email lock out after repeated misses, like a login.
      if (blocked(`lookup-miss|${client}`, 5)) return json({ answer: "Too many order lookups didn't match. Please try again in 15 minutes, or tap \"Talk to our team\".", result: "none" });
      const question = text("question").trim();
      if (!question) return json({ errors: { question: "Type a question first." } }, 400);
      const answer = await answerQuestion(db, shop, admin, question.slice(0, 500), customerId);
      if (answer.orderNotFound) hit(`lookup-miss|${client}`, 5, 15 * MINUTE);
      return json({ answer: answer.answer, result: answer.result, links: answer.links ?? [] });
    }
    // "Talk to our team": the chat becomes a ticket, transcript included.
    case "chat-start": {
      if (!hit(`ticket|${client}`, 5, MINUTE)) return tooMany();
      let transcript: unknown = [];
      try { transcript = JSON.parse(text("transcript") || "[]"); } catch { transcript = []; }
      try {
        const result = await startChat(db, shop, { name: text("name"), email: text("email"), message: text("body"), transcript, requestKey: text("requestKey"), customerId });
        if (result.created && result.ticketId) {
          queueEmail(db, { shop, ticketId: result.ticketId, kind: "new-ticket" }, admin);
          queueEmail(db, { shop, ticketId: result.ticketId, kind: "ack" }, admin);
        }
        return json(result, result.ticketId ? 200 : 400);
      } catch {
        return json({ errors: { form: "Your message could not be sent. Please try again." } }, 500);
      }
    }
    // A reply on the customer's own ticket, identified by its secret token.
    case "reply": {
      const token = text("token");
      if (!hit(`reply|${client}`, 10, MINUTE)) return wantsJson ? tooMany() : trackingPage(shop, token, { error: "Too many messages. Please wait a minute.", draft: text("body") });
      try {
        const result = await addCustomerMessage(db, shop, token, text("body"), files(form));
        if (result.messageId && result.ticketId) {
          queueEmail(db, { shop, ticketId: result.ticketId, kind: "customer-reply", messageId: result.messageId }, admin);
          void queueTicketScans(db, result.ticketId, result.messageId);
        }
        if (wantsJson) return json(result, result.messageId ? 200 : 400);
        return trackingPage(shop, token, result.messageId ? { sent: true } : { error: Object.values(result.errors)[0], draft: text("body") });
      } catch {
        if (wantsJson) return json({ errors: { form: "Your message could not be sent. Please try again." } }, 500);
        return trackingPage(shop, token, { error: "Your message could not be sent. Please try again.", draft: text("body") });
      }
    }
    // Lost the link? Ticket number plus the email it was opened with finds it.
    case "lookup": {
      const key = `lookup-miss|${client}`;
      if (blocked(key, 5) || !hit(`lookup|${client}`, 10, MINUTE)) return lookupPage({ error: "Too many attempts. Please try again in 15 minutes." }, 429);
      const number = Number(text("number").replace(/^#/, "").trim());
      const email = text("email").trim().toLowerCase();
      const ticket = Number.isInteger(number) && number > 0 && email
        ? await db.helpDeskTicket.findFirst({ where: { shop, number }, select: { email: true, accessToken: true } }) : null;
      if (!ticket || ticket.email.toLowerCase() !== email) {
        hit(key, 5, 15 * MINUTE);
        return lookupPage({ error: "We couldn't find a request with that number and email.", number: text("number"), email: text("email") }, 404);
      }
      clear(key);
      return trackingPage(shop, ticket.accessToken);
    }
    case null:
    case undefined:
      break;
    // A customer cannot update ticket statuses or choose the store owning a ticket.
    default:
      return json({ errors: { form: "Invalid request." } }, 400);
  }

  if (!hit(`ticket|${client}`, 5, MINUTE)) return tooMany();
  try {
    const result = await submitTicket(db, shop, form, customerId);
    if (result.created && result.ticketId) {
      queueEmail(db, { shop, ticketId: result.ticketId, kind: "new-ticket" }, admin);
      queueEmail(db, { shop, ticketId: result.ticketId, kind: "ack" }, admin);
      // Photos are checked for AI generation and reuse in the background.
      void queueTicketScans(db, result.ticketId);
    }
    return json(result, Object.keys(result.errors).length ? 400 : 200);
  } catch {
    return json({ errors: { form: "Your request could not be saved. Please try again." } }, 500);
  }
}

const liquid = (html: string, status = 200) => new Response(html, { status, headers: { ...privateHeaders, "Content-Type": "application/liquid" } });

// Finding a request without its link: ticket number plus email.
const lookupPage = (state: { error?: string; number?: string; email?: string } = {}, status = 200) => liquid(renderLookupPage(state), status);

// The customer's private request page.
async function trackingPage(shop: string, token: string, state: { sent?: boolean; error?: string; draft?: string } = {}) {
  if (!token) return lookupPage();
  const ticket = TOKEN.test(token) ? await db.helpDeskTicket.findFirst({
    where: { shop, accessToken: token },
    include: { messages: { where: { kind: { in: PUBLIC_KINDS } }, orderBy: { createdAt: "asc" } }, attachments: { where: { messageId: { not: null } }, select: { messageId: true } } },
  }) : null;
  if (!ticket) return lookupPage({ error: "This link is not valid or the request no longer exists. You can look it up with its number instead." }, 404);
  const images = new Map<string, number>();
  for (const file of ticket.attachments) images.set(file.messageId!, (images.get(file.messageId!) ?? 0) + 1);
  return liquid(renderRequestPage(ticket, images, { canReply: customerCanReply(ticket), maxImages: MAX_REPLY_IMAGES, maxLength: MAX_MESSAGE_LENGTH, state }));
}
