import nodemailer from "nodemailer";
import type { PrismaClient } from "@prisma/client";
import { countryName, fieldLabels } from "./help-desk";

// SMTP settings live in the server .env; without them notifications are skipped.
//   SMTP_HOST, SMTP_PORT (default 587; 465 uses TLS), SMTP_USER, SMTP_PASS, SMTP_FROM (defaults to SMTP_USER)
type AdminClient = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };
export type TicketProduct = { id: string; title: string; image: string };

// Most mail providers reject messages over ~20-25 MB, so larger image sets are linked instead.
const MAX_ATTACHED_BYTES = 15 * 1024 * 1024;
const SHOP_QUERY = `#graphql
  query HelpDeskShop { shop { name email primaryDomain { url } } }
`;
const PRODUCTS_QUERY = `#graphql
  query HelpDeskProducts($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { id title featuredImage { url(transform: { maxWidth: 160 }) } } }
  }
`;

export function emailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export async function loadProducts(admin: AdminClient, ids: string[]): Promise<TicketProduct[]> {
  const products = ids.map(id => ({ id, title: id.split("/").pop() || id, image: "" }));
  if (!ids.length) return products;
  try {
    const json = await (await admin.graphql(PRODUCTS_QUERY, { variables: { ids } })).json();
    const found = new Map<string, TicketProduct>();
    for (const node of (json.data?.nodes ?? []) as ({ id: string; title: string; featuredImage?: { url: string } | null } | null)[]) {
      if (node?.id) found.set(node.id, { id: node.id, title: node.title, image: node.featuredImage?.url || "" });
    }
    return products.map(product => found.get(product.id) ?? { ...product, title: `Deleted product (${product.title})` });
  } catch {
    return products;
  }
}

export async function loadShop(admin: AdminClient) {
  const json = await (await admin.graphql(SHOP_QUERY)).json();
  return { name: String(json.data?.shop?.name || ""), email: String(json.data?.shop?.email || ""), url: String(json.data?.shop?.primaryDomain?.url || "") };
}

// The customer's private page for a ticket, served through the app proxy.
export function trackingUrl(storeUrl: string, token: string) {
  return `${storeUrl.replace(/\/$/, "")}/apps/help-desk?ticket=${encodeURIComponent(token)}`;
}

const sender = (storeName: string) => ({ name: `${storeName} Help Desk`, address: process.env.SMTP_FROM || process.env.SMTP_USER! });

export async function notificationRecipient(db: PrismaClient, shop: string, admin: AdminClient) {
  const settings = await db.helpDeskSettings.findUnique({ where: { shop } });
  if (settings && !settings.notify) return null;
  const store = await loadShop(admin);
  return { to: settings?.notifyEmail || store.email, store };
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const multiline = (value: string) => escape(value).replace(/\r?\n/g, "<br>");

function ticketUrl(shop: string, id: string) {
  return `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/apps/${process.env.SHOPIFY_API_KEY}/app/help-desk?ticket=${encodeURIComponent(id)}`;
}

// Styled like Shopify's own staff notifications: a plain white card, store
// name on top, one dark call-to-action button and label/value rows.
export function renderEmail(input: {
  storeName: string; adminUrl: string; ticketId: string; number?: number; createdAt: Date; name: string; email: string; topic: string;
  values: Record<string, string>; products: TicketProduct[]; receivedProducts?: TicketProduct[]; images: { cid: string; name: string }[]; skippedImages: number;
}) {
  const row = (label: string, value: string) => `<tr><td style="padding:10px 0;border-top:1px solid #ebebeb;width:38%;vertical-align:top;color:#616161;font-size:14px">${escape(label)}</td><td style="padding:10px 0;border-top:1px solid #ebebeb;vertical-align:top;color:#303030;font-size:14px;line-height:20px">${value}</td></tr>`;
  const heading = (text: string) => `<h3 style="margin:28px 0 8px;font-size:15px;font-weight:600;color:#303030">${escape(text)}</h3>`;
  const contact = [
    row("Name", escape(input.name)),
    row("Email", `<a href="mailto:${escape(input.email)}" style="color:#005bd3;text-decoration:none">${escape(input.email)}</a>`),
    ...(input.values.phone ? [row("Phone", `<a href="tel:${escape(input.values.phone.replace(/[^\d+]/g, ""))}" style="color:#005bd3;text-decoration:none">${escape(input.values.phone)}</a>`)] : []),
  ].join("");
  const details = Object.keys(fieldLabels)
    .filter(key => key !== "phone" && input.values[key])
    .map(key => row(fieldLabels[key], key === "country" ? escape(countryName(input.values[key])) : multiline(input.values[key])))
    .join("");
  const productRows = (list: TicketProduct[]) => list.map(product => `<tr>
    <td style="padding:8px 12px 8px 0;border-top:1px solid #ebebeb;width:48px">${product.image
      ? `<img src="${escape(product.image)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #ebebeb">`
      : `<div style="width:48px;height:48px;border-radius:8px;background:#f1f1f1"></div>`}</td>
    <td style="padding:8px 0;border-top:1px solid #ebebeb;font-size:14px;color:#303030">${escape(product.title)}</td></tr>`).join("");
  const received = input.receivedProducts ?? [];
  const productSection = (title: string, list: TicketProduct[]) => list.length
    ? `${heading(`${title} (${list.length})`)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${productRows(list)}</table>` : "";
  const images = input.images.map(image => `<td style="padding:0 8px 8px 0;vertical-align:top"><img src="cid:${image.cid}" width="120" height="120" alt="${escape(image.name)}" style="display:block;width:120px;height:120px;border-radius:8px;object-fit:cover;border:1px solid #ebebeb"></td>`).join("");
  const receivedAt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(input.createdAt) + " UTC";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New Help Desk request</title></head>
<body style="margin:0;padding:0;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,'San Francisco','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#303030">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e3e3">
<tr><td style="padding:32px 32px 0">
  <p style="margin:0 0 24px;font-size:16px;font-weight:600;color:#303030">${escape(input.storeName)}</p>
  <h1 style="margin:0 0 8px;font-size:22px;line-height:28px;font-weight:650;color:#303030">New Help Desk request</h1>
  <p style="margin:0 0 20px;font-size:14px;line-height:20px;color:#616161">${escape(input.name)} sent a request about <strong style="color:#303030">${escape(input.topic)}</strong>.</p>
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#303030">
    <a href="${escape(input.adminUrl)}" style="display:inline-block;padding:11px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">View ticket in Shopify</a>
  </td></tr></table>
</td></tr>
<tr><td style="padding:0 32px 32px">
  ${heading("Customer")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${contact}</table>
  ${details ? `${heading("Request details")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row("Topic", escape(input.topic))}${details}</table>` : ""}
  ${productSection("Received by mistake", received)}
  ${productSection(received.length ? "Wanted instead" : "Products", input.products)}
  ${images ? `${heading(`Images (${input.images.length})`)}<table role="presentation" cellpadding="0" cellspacing="0"><tr>${images}</tr></table>` : ""}
  ${input.skippedImages ? `<p style="margin:8px 0 0;font-size:13px;color:#616161">${input.skippedImages} image${input.skippedImages === 1 ? " is" : "s are"} too large to attach. View ${input.skippedImages === 1 ? "it" : "them"} on the ticket.</p>` : ""}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #ebebeb;font-size:13px;line-height:18px;color:#616161">
  Reply from the ticket in Shopify so the conversation stays in one place.<br>Received ${escape(receivedAt)} · Ticket ${escape(input.number ? `#${input.number}` : input.ticketId)}
</td></tr>
</table></td></tr></table></body></html>`;
}

function renderText(values: Record<string, string>, input: { name: string; email: string; topic: string; adminUrl: string; products: TicketProduct[]; receivedProducts: TicketProduct[] }) {
  const lines = [`New Help Desk request: ${input.topic}`, "", `Name: ${input.name}`, `Email: ${input.email}`];
  for (const key of Object.keys(fieldLabels)) if (values[key]) lines.push(`${fieldLabels[key]}: ${key === "country" ? countryName(values[key]) : values[key]}`);
  if (input.receivedProducts.length) lines.push(`Received by mistake: ${input.receivedProducts.map(product => product.title).join(", ")}`);
  if (input.products.length) lines.push(`${input.receivedProducts.length ? "Wanted instead" : "Products"}: ${input.products.map(product => product.title).join(", ")}`);
  lines.push("", `View ticket: ${input.adminUrl}`);
  return lines.join("\n");
}

// The senders below are run by the email queue (help-desk-outbox.server.ts).
// Each returns "sent", or "skipped" when there's nothing to send (email
// turned off, ticket gone); delivery failures throw so the queue retries.
export type SendResult = "sent" | "skipped";

// Emails the store about a newly created ticket.
export async function notifyTicket(db: PrismaClient, shop: string, admin: AdminClient, ticketId: string): Promise<SendResult> {
  const ticket = await db.helpDeskTicket.findFirst({ where: { id: ticketId, shop }, include: { attachments: { where: { messageId: null } }, messages: { where: { kind: { in: ["customer", "bot"] } }, orderBy: { createdAt: "asc" } } } });
  const recipient = ticket && await notificationRecipient(db, shop, admin);
  if (!ticket || !recipient?.to) return "skipped";
  const values = JSON.parse(ticket.details) as Record<string, string>;
  const [products, receivedProducts] = await Promise.all([
    loadProducts(admin, JSON.parse(ticket.products) as string[]),
    loadProducts(admin, JSON.parse(ticket.receivedProducts) as string[]),
  ]);
  let budget = MAX_ATTACHED_BYTES;
  const attached = ticket.attachments.filter(file => (budget -= file.data.length) >= 0);
  const adminUrl = ticketUrl(shop, ticket.id);
  const storeName = recipient.store.name || shop;
  // A chat ticket's request is its transcript.
  const transcript = ticket.channel === "chat" ? ticket.messages.map(message => `${message.kind === "bot" ? "Assistant" : ticket.name}: ${message.body}`).join("\n\n") : "";
  const shown = transcript ? { transcript } : values;
  await transport().sendMail({
    from: sender(storeName),
    to: recipient.to,
    replyTo: { name: ticket.name, address: ticket.email },
    subject: `[#${ticket.number}] New Help Desk ${ticket.channel === "chat" ? "chat" : "request"}: ${ticket.topic} from ${ticket.name}`,
    html: renderEmail({
      storeName, adminUrl, ticketId: ticket.id, number: ticket.number, createdAt: ticket.createdAt, name: ticket.name, email: ticket.email, topic: ticket.topic,
      values: shown, products, receivedProducts, images: attached.map(file => ({ cid: `${file.id}@help-desk`, name: file.name })), skippedImages: ticket.attachments.length - attached.length,
    }),
    text: renderText(shown, { name: ticket.name, email: ticket.email, topic: ticket.topic, adminUrl, products, receivedProducts }),
    attachments: attached.map(file => ({ filename: file.name, content: Buffer.from(file.data), contentType: file.type, cid: `${file.id}@help-desk` })),
  });
  return "sent";
}

// A short customer-facing message in the same card style: a heading, plain
// paragraphs (escaped, line breaks kept) and a button to the tracking page.
export function renderCustomerEmail(input: { storeName: string; heading: string; paragraphs: string[]; quote?: string; buttonUrl: string; buttonLabel: string; footer: string }) {
  const paragraphs = input.paragraphs.map(text => `<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:#303030">${multiline(text)}</p>`).join("");
  const quote = input.quote ? `<div style="margin:0 0 20px;padding:16px;border-radius:8px;background:#f7f7f7;font-size:15px;line-height:22px;color:#303030">${multiline(input.quote)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,'San Francisco','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#303030">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e3e3">
<tr><td style="padding:32px">
  <p style="margin:0 0 24px;font-size:16px;font-weight:600;color:#303030">${escape(input.storeName)}</p>
  <h1 style="margin:0 0 16px;font-size:22px;line-height:28px;font-weight:650;color:#303030">${escape(input.heading)}</h1>
  ${paragraphs}${quote}
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#303030">
    <a href="${escape(input.buttonUrl)}" style="display:inline-block;padding:11px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${escape(input.buttonLabel)}</a>
  </td></tr></table>
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #ebebeb;font-size:13px;line-height:18px;color:#616161">${multiline(input.footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

async function customerContext(db: PrismaClient, shop: string, admin: AdminClient, ticketId: string) {
  const [ticket, settings] = await Promise.all([db.helpDeskTicket.findFirst({ where: { id: ticketId, shop } }), db.helpDeskSettings.findUnique({ where: { shop } })]);
  if (!ticket) return null;
  const store = await loadShop(admin);
  const storeName = store.name || shop;
  return {
    ticket, settings, storeName, url: trackingUrl(store.url, ticket.accessToken),
    first: ticket.name.trim().split(/\s+/)[0] || ticket.name,
    replyTo: settings?.notifyEmail || store.email || undefined,
  };
}

// Confirms a new ticket to the customer with its number and tracking link.
export async function sendAcknowledgement(db: PrismaClient, shop: string, admin: AdminClient, ticketId: string): Promise<SendResult> {
  const context = await customerContext(db, shop, admin, ticketId);
  if (!context || context.settings?.autoReply === false) return "skipped";
  const { ticket, storeName, url, first, replyTo } = context;
  const chat = ticket.channel === "chat";
  await transport().sendMail({
    from: sender(storeName),
    to: { name: ticket.name, address: ticket.email },
    replyTo,
    subject: `[#${ticket.number}] We've received your ${chat ? "message" : "request"}`,
    html: renderCustomerEmail({
      storeName, heading: `We've received your ${chat ? "message" : "request"} #${ticket.number}`,
      paragraphs: [`Hi ${first},`, chat
        ? `Thanks for chatting with ${storeName}. Our team will reply in the chat, and we'll email you too, so you don't need to keep the page open.`
        : `Thanks for contacting ${storeName}. Your request about "${ticket.topic}" is now with our support team, and we'll get back to you as soon as we can.`,
      "You can check the status of your request or add more information at any time."],
      buttonUrl: url, buttonLabel: "View your request", footer: `Ticket #${ticket.number} · Keep this email to find your request again.`,
    }),
    text: `Hi ${first},\n\nThanks for contacting ${storeName}. We've received your request #${ticket.number} and will get back to you soon.\n\nView your request: ${url}`,
  });
  return "sent";
}

// Emails a staff reply to the customer.
export async function sendReplyEmail(db: PrismaClient, shop: string, admin: AdminClient, messageId: string): Promise<SendResult> {
  const message = await db.helpDeskMessage.findFirst({ where: { id: messageId, kind: "reply", ticket: { shop } } });
  const context = message && await customerContext(db, shop, admin, message.ticketId);
  if (!message || !context) return "skipped";
  const { ticket, settings, storeName, url, replyTo } = context;
  const body = [message.body, settings?.signature?.trim()].filter(Boolean).join("\n\n");
  await transport().sendMail({
    from: sender(storeName),
    to: { name: ticket.name, address: ticket.email },
    replyTo,
    subject: `Re: [#${ticket.number}] ${ticket.topic}`,
    html: renderCustomerEmail({
      storeName, heading: `New reply on request #${ticket.number}`, paragraphs: [], quote: body,
      buttonUrl: url, buttonLabel: "View and reply", footer: `${message.author} replied to your request about "${ticket.topic}".\nReply from your request page so we see your message straight away.`,
    }),
    text: `${body}\n\n---\nView and reply to request #${ticket.number}: ${url}`,
  });
  await db.helpDeskMessage.update({ where: { id: message.id }, data: { emailed: true } });
  return "sent";
}

const STATUS_EMAIL: Record<string, { heading: string; text: string }> = {
  "In progress": { heading: "We're working on your request", text: "Our team has started working on your request. We'll update you as soon as there's news." },
  Resolved: { heading: "Your request has been resolved", text: "We've marked your request as resolved. If anything still isn't right, just reply on your request page and we'll pick it up again." },
};

// Tells the customer their ticket moved to In progress or Resolved.
export async function sendStatusEmail(db: PrismaClient, shop: string, admin: AdminClient, ticketId: string): Promise<SendResult> {
  const context = await customerContext(db, shop, admin, ticketId);
  const copy = context && STATUS_EMAIL[context.ticket.status];
  if (!context || !copy || context.settings?.statusEmails === false) return "skipped";
  const { ticket, storeName, url, first, replyTo } = context;
  await transport().sendMail({
    from: sender(storeName),
    to: { name: ticket.name, address: ticket.email },
    replyTo,
    subject: `[#${ticket.number}] ${copy.heading}`,
    html: renderCustomerEmail({
      storeName, heading: copy.heading, paragraphs: [`Hi ${first},`, copy.text],
      buttonUrl: url, buttonLabel: "View your request", footer: `Ticket #${ticket.number} · ${ticket.topic}`,
    }),
    text: `Hi ${first},\n\n${copy.text}\n\nView your request #${ticket.number}: ${url}`,
  });
  return "sent";
}

// Tells the store a customer added a message to their ticket.
export async function notifyCustomerReply(db: PrismaClient, shop: string, admin: AdminClient, messageId: string): Promise<SendResult> {
  const message = await db.helpDeskMessage.findFirst({ where: { id: messageId, kind: "customer", ticket: { shop } }, include: { ticket: true } });
  const recipient = message && await notificationRecipient(db, shop, admin);
  if (!message || !recipient?.to) return "skipped";
  const { ticket } = message;
  const storeName = recipient.store.name || shop;
  const adminUrl = ticketUrl(shop, ticket.id);
  await transport().sendMail({
    from: sender(storeName),
    to: recipient.to,
    replyTo: { name: ticket.name, address: ticket.email },
    subject: `Re: [#${ticket.number}] ${ticket.name} replied`,
    html: renderCustomerEmail({
      storeName, heading: `${ticket.name} replied to #${ticket.number}`, paragraphs: [`About: ${ticket.topic}`], quote: message.body,
      buttonUrl: adminUrl, buttonLabel: "Open ticket in Shopify", footer: `Ticket #${ticket.number} · ${ticket.email}`,
    }),
    text: `${ticket.name} replied to #${ticket.number}:\n\n${message.body}\n\nOpen ticket: ${adminUrl}`,
  });
  return "sent";
}

export async function sendTestEmail(shop: string, admin: AdminClient, to: string) {
  const store = await loadShop(admin);
  const storeName = store.name || shop;
  const values = { phone: "+1 555 0100", orderNumber: "#1001", issue: "Defective product received", details: "This is a sample request so you can preview Help Desk notifications." };
  await transport().sendMail({
    from: sender(storeName),
    to,
    subject: "Test: New Help Desk request",
    html: renderEmail({
      storeName, adminUrl: ticketUrl(shop, "test"), ticketId: "test", createdAt: new Date(), name: "Sample Customer", email: "customer@example.com",
      topic: "Returns, Exchanges & Refunds", values, products: [], images: [], skippedImages: 0,
    }),
  });
}
