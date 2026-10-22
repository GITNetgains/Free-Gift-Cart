import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { countries, issues, MAX_MESSAGE_LENGTH, orderTypes, topics, updates } from "../services/help-desk";
import { renderLookupPage, renderRequestPage } from "../services/help-desk-request-page";
import { addCustomerMessage, customerCanReply, MAX_REPLY_IMAGES, readHelpDeskForm, submitTicket } from "../services/help-desk.server";
import { customerOrders } from "../services/help-desk-orders.server";
import { loadProducts } from "../services/help-desk-email.server";
import { ensureWorker, queueEmail } from "../services/help-desk-outbox.server";
import { queueTicketScans } from "../services/image-scan/scan.server";
import { blocked, clear, clientKey, hit } from "../services/rate-limit.server";

const headers = { "Cache-Control": "no-store" };
const privateHeaders = { "Cache-Control": "private, no-store" };
const TOKEN = /^[a-f0-9]{48}$/;
const MINUTE = 60_000;
// Customer-visible message kinds; internal notes and the activity log stay private.
const PUBLIC_KINDS = ["customer", "reply", "bot"];

// Records that the storefront form loaded, at most every 10 minutes, so the
// admin can tell whether it's live on the store.
async function markSeen(shop: string, field: "formLastSeenAt") {
  const stale = new Date(Date.now() - 10 * MINUTE);
  try {
    const { count } = await db.helpDeskSettings.updateMany({ where: { shop, OR: [{ [field]: null }, { [field]: { lt: stale } }] }, data: { [field]: new Date() } });
    if (!count && !await db.helpDeskSettings.findUnique({ where: { shop }, select: { shop: true } })) {
      await db.helpDeskSettings.create({ data: { shop, [field]: new Date() } });
    }
  } catch (error) {
    console.error(`Help Desk could not record ${field} for ${shop}:`, error);
  }
}

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

  const token = params.get("ticket");
  if (token !== null) return trackingPage(shop, admin, token);

  void markSeen(shop, "formLastSeenAt");
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
  catch { return json({ errors: { form: "Could not read your request. Upload up to five images of 10 MB each." } }, 400); }
  if (form.get("website")) return json({ errors: { form: "Unable to submit this request." } }, 400);
  const text = (key: string) => String(form.get(key) ?? "");

  switch (form.get("intent")) {
    // A reply on the customer's own ticket, identified by its secret token.
    case "reply": {
      const token = text("token");
      if (!hit(`reply|${client}`, 10, MINUTE)) return wantsJson ? tooMany() : trackingPage(shop, admin, token, { error: "Too many messages. Please wait a minute.", draft: text("body") });
      try {
        const result = await addCustomerMessage(db, shop, token, text("body"), files(form));
        if (result.messageId && result.ticketId) {
          queueEmail(db, { shop, ticketId: result.ticketId, kind: "customer-reply", messageId: result.messageId }, admin);
          void queueTicketScans(db, result.ticketId, result.messageId);
        }
        if (wantsJson) return json(result, result.messageId ? 200 : 400);
        return trackingPage(shop, admin, token, result.messageId ? { sent: true } : { error: Object.values(result.errors)[0], draft: text("body") });
      } catch {
        if (wantsJson) return json({ errors: { form: "Your message could not be sent. Please try again." } }, 500);
        return trackingPage(shop, admin, token, { error: "Your message could not be sent. Please try again.", draft: text("body") });
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
      return trackingPage(shop, admin, ticket.accessToken);
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
type AdminClient = Parameters<typeof loadProducts>[0];
const productIds = (value: string) => { try { const ids = JSON.parse(value); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; } catch { return []; } };

async function trackingPage(shop: string, admin: AdminClient | undefined, token: string, state: { sent?: boolean; error?: string; draft?: string } = {}) {
  if (!token) return lookupPage();
  const ticket = TOKEN.test(token) ? await db.helpDeskTicket.findFirst({
    where: { shop, accessToken: token },
    include: { messages: { where: { kind: { in: PUBLIC_KINDS } }, orderBy: { createdAt: "asc" } }, attachments: { select: { messageId: true } } },
  }) : null;
  if (!ticket) return lookupPage({ error: "This link is not valid or the request no longer exists. You can look it up with its number instead." }, 404);
  const imageCounts = new Map<string, number>();
  let requestImages = 0;
  for (const file of ticket.attachments) {
    if (file.messageId) imageCounts.set(file.messageId, (imageCounts.get(file.messageId) ?? 0) + 1);
    else requestImages++;
  }
  // Product names and pictures for shipping and wrong-item requests.
  const [products, receivedProducts] = admin
    ? await Promise.all([loadProducts(admin, productIds(ticket.products)), loadProducts(admin, productIds(ticket.receivedProducts))])
    : [[], []];
  return liquid(renderRequestPage(ticket, {
    imageCounts, requestImages, products, receivedProducts, canReply: customerCanReply(ticket), maxImages: MAX_REPLY_IMAGES, maxLength: MAX_MESSAGE_LENGTH, state,
  }));
}
