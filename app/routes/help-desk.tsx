import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { countries, countryName, fieldLabels, issues, MAX_MESSAGE_LENGTH, orderTypes, topics, updates } from "../services/help-desk";
import { addCustomerMessage, MAX_REPLY_IMAGES, readHelpDeskForm, startChat, submitTicket } from "../services/help-desk.server";
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

// Escapes HTML and Liquid delimiters: these pages are rendered by the theme as Liquid.
const escape = (value: string) => value.replace(/[&<>"'{}]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "{": "&#123;", "}": "&#125;" })[char]!);
const multiline = (value: string) => escape(value).replace(/\r?\n/g, "<br>");
const date = (value: Date) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(value) + " UTC";
const STATUS_TEXT: Record<string, string> = {
  Open: "We've received your request and will reply soon.",
  "In progress": "Our team is working on your request.",
  "Waiting on customer": "We've replied and are waiting for your response.",
  Resolved: "This request is resolved. Reply below if you still need help and we'll reopen it.",
};

const STYLES = `<style>
.hdt{max-width:760px;margin:clamp(24px,5vw,56px) auto;padding:0 16px;color:#19213d;font-size:16px;line-height:1.55}
.hdt *{box-sizing:border-box}.hdt h1{margin:0 0 6px;font-size:clamp(24px,3.4vw,32px);line-height:1.2}
.hdt-muted{color:#5b6275;font-size:14px;margin:0}.hdt-card{border:1px solid #e4e5ea;border-radius:16px;background:#fff;padding:clamp(18px,3vw,28px);margin-top:20px}
.hdt-status{display:inline-block;padding:3px 12px;border-radius:999px;font-size:13px;font-weight:600;background:#eef0f4}
.hdt-status[data-status="Resolved"]{background:#d9f5e3;color:#0c5132}.hdt-status[data-status="Waiting on customer"]{background:#e3effd;color:#003a80}
.hdt-status[data-status="Open"]{background:#fff1d6;color:#5e4200}.hdt-status[data-status="In progress"]{background:#e3effd;color:#003a80}
.hdt dl{display:grid;grid-template-columns:minmax(120px,30%) 1fr;gap:8px 16px;margin:16px 0 0}.hdt dt{color:#5b6275;font-size:14px}.hdt dd{margin:0;overflow-wrap:anywhere}
.hdt-thread{display:grid;gap:14px;margin-top:20px}.hdt-msg{max-width:88%;padding:14px 16px;border-radius:14px;background:#f4f5f8}
.hdt-msg[data-kind="reply"],.hdt-msg[data-kind="bot"]{justify-self:start;background:#fff;border:1px solid #e4e5ea}.hdt-msg[data-kind="customer"]{justify-self:end;background:#19213d;color:#fff}
.hdt-msg small{display:block;margin-bottom:4px;font-size:12px;opacity:.75}.hdt-msg p{margin:0;overflow-wrap:anywhere}
.hdt label{display:grid;gap:6px;margin-top:12px;font-size:14px;font-weight:600}
.hdt textarea,.hdt input:not([type=file]){width:100%;padding:12px 14px;border:1px solid #d4d6dd;border-radius:10px;font:inherit}.hdt textarea{min-height:120px;resize:vertical}
.hdt button{margin-top:14px;padding:12px 22px;border:0;border-radius:10px;background:#19213d;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.hdt-note{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:14px}.hdt-note[data-tone="success"]{background:#d9f5e3;color:#0c5132}.hdt-note[data-tone="error"]{background:#fee8e7;color:#8e1f0b}
@media (max-width:560px){.hdt dl{grid-template-columns:1fr}.hdt dd{margin-bottom:8px}.hdt-msg{max-width:100%}}
</style>`;

const page = (title: string, body: string, status = 200) => new Response(`{% layout 'theme' %}${STYLES}
<section class="hdt" aria-label="${escape(title)}">${body}</section>`, { status, headers: { ...privateHeaders, "Content-Type": "application/liquid" } });

const note = (state: { sent?: boolean; error?: string }) => state.sent ? `<div class="hdt-note" data-tone="success" role="status">Thanks, your message has been sent to our team.</div>`
  : state.error ? `<div class="hdt-note" data-tone="error" role="alert">${escape(state.error)}</div>` : "";

// Finding a request without its link: ticket number plus email.
function lookupPage(state: { error?: string; number?: string; email?: string } = {}, status = 200) {
  return page("Find your request", `
<h1>Find your request</h1>
<p class="hdt-muted">Enter your request number (from your confirmation email) and the email you used.</p>
<div class="hdt-card">${note(state)}
<form method="post" action="?ticket=">
<input type="hidden" name="intent" value="lookup">
<label>Request number<input name="number" required inputmode="numeric" placeholder="e.g. 1001" value="${escape(state.number ?? "")}"></label>
<label>Email<input name="email" type="email" required autocomplete="email" value="${escape(state.email ?? "")}"></label>
<button type="submit">Find request</button>
</form></div>`, status);
}

// The customer's private request page, rendered inside the store's theme
// (application/liquid) so it shares the store header, footer and fonts.
async function trackingPage(shop: string, token: string, state: { sent?: boolean; error?: string; draft?: string } = {}) {
  if (!token) return lookupPage();
  const ticket = TOKEN.test(token) ? await db.helpDeskTicket.findFirst({
    where: { shop, accessToken: token },
    include: { messages: { where: { kind: { in: PUBLIC_KINDS } }, orderBy: { createdAt: "asc" } }, attachments: { where: { messageId: { not: null } }, select: { messageId: true } } },
  }) : null;
  if (!ticket) return lookupPage({ error: "This link is not valid or the request no longer exists. You can look it up with its number instead." }, 404);
  const values = JSON.parse(ticket.details) as Record<string, string>;
  const chat = ticket.channel === "chat";
  const rows = chat ? "" : Object.keys(fieldLabels).filter(key => values[key])
    .map(key => `<dt>${escape(fieldLabels[key])}</dt><dd>${multiline(key === "country" ? countryName(values[key]) : values[key])}</dd>`).join("");
  const images = new Map<string, number>();
  for (const file of ticket.attachments) images.set(file.messageId!, (images.get(file.messageId!) ?? 0) + 1);
  const thread = [
    ...(chat ? [] : [`<div class="hdt-msg" data-kind="customer"><small>You · ${escape(date(ticket.createdAt))}</small><p>Request submitted: ${escape(ticket.topic)}</p></div>`]),
    ...ticket.messages.map(message => {
      const count = images.get(message.id) ?? 0;
      const who = message.kind === "customer" ? "You" : message.kind === "bot" ? "Assistant" : message.author;
      return `<div class="hdt-msg" data-kind="${message.kind}"><small>${escape(who)} · ${escape(date(message.createdAt))}</small><p>${multiline(message.body)}</p>${count ? `<small style="margin-top:6px">${count} image${count === 1 ? "" : "s"} attached</small>` : ""}</div>`;
    }),
  ].join("");
  return page(`Request #${ticket.number}`, `
<p class="hdt-muted">Request #${ticket.number} · Submitted ${escape(date(ticket.createdAt))}</p>
<h1>${escape(ticket.topic)}</h1>
<span class="hdt-status" data-status="${escape(ticket.status)}">${escape(ticket.status)}</span>
<p class="hdt-muted" style="margin-top:10px">${escape(STATUS_TEXT[ticket.status] ?? "")}</p>
${rows ? `<div class="hdt-card"><strong>Your request</strong><dl>${rows}</dl></div>` : ""}
<div class="hdt-card"><strong>Conversation</strong><div class="hdt-thread">${thread}</div></div>
<div class="hdt-card" id="reply"><strong>Add a message</strong>${note(state)}
<form method="post" action="?ticket=${escape(ticket.accessToken)}#reply" enctype="multipart/form-data">
<input type="hidden" name="intent" value="reply"><input type="hidden" name="token" value="${escape(ticket.accessToken)}">
<label>Your message<textarea name="body" maxlength="${MAX_MESSAGE_LENGTH}">${escape(state.draft ?? "")}</textarea></label>
<label>Add photos (optional, up to ${MAX_REPLY_IMAGES})<input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple></label>
<button type="submit">Send message</button>
</form></div>`);
}
