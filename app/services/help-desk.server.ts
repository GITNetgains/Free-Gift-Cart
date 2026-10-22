import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { CHAT_TOPIC, ticketStatuses, countries, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_MESSAGE_LENGTH, orderTypes, priorities, topics, validateHelpDesk, type HelpDeskValues } from "./help-desk";

const fields = ["name", "email", "phone", "topic", "country", "address", "otherDetails", "existing", "registeredEmail", "query", "orderNumber", "orderType", "update", "issue", "details", "orderDetails", "productDetails", "resolution"];
// created is false when a retried submission returns the ticket saved earlier.
export type TicketResult = { errors: Record<string, string>; ticketId?: string; number?: number; token?: string; created?: boolean };

export async function readHelpDeskForm(request: Request) {
  const limit = MAX_IMAGES * MAX_IMAGE_BYTES + 256 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Request too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("Content-Type") || "" } }).formData();
}

export async function submitTicket(db: PrismaClient, shop: string, form: FormData, customerId = ""): Promise<TicketResult> {
  const values: HelpDeskValues = {};
  for (const field of fields) {
    const value = form.get(field);
    if (typeof value === "string") values[field] = value.trim();
  }
  const shipping = values.topic === topics[0];
  const partner = values.topic === topics[1] || values.topic === topics[2];
  const order = values.topic === topics[3];
  const returns = values.topic === topics[4];
  const active = new Set(["name", "email", "phone", "topic",
    ...(shipping ? ["country", "address", "otherDetails"] : []),
    ...(partner ? ["existing", "query", ...(values.existing === "Yes" ? ["registeredEmail"] : [])] : []),
    ...(order || returns ? ["orderNumber", "details"] : []),
    ...(order ? ["orderType", ...(values.orderType === orderTypes[0] ? ["update"] : []), ...(values.orderType === orderTypes[1] ? ["issue"] : [])] : []),
    ...(returns ? ["orderDetails", "productDetails", "issue", "resolution"] : []),
  ]);
  for (const key of Object.keys(values)) if (!active.has(key)) delete values[key];
  const wrongProduct = order && values.orderType === orderTypes[2];
  const products = shipping || wrongProduct ? form.getAll("products").filter((value): value is string => typeof value === "string") : [];
  const receivedProducts = wrongProduct ? form.getAll("receivedProducts").filter((value): value is string => typeof value === "string") : [];
  const files = returns || (order && (values.orderType === orderTypes[1] || wrongProduct))
    ? form.getAll("images").filter((value): value is File => typeof value !== "string" && Boolean(value.name)) : [];
  const errors = validateHelpDesk(values, products, files, receivedProducts);
  for (const [key, value] of Object.entries(values)) if (value.length > 5000) errors[key] = "Use no more than 5,000 characters.";
  if (shipping && values.country && !countries.some(country => country.code === values.country)) errors.country = "Select a valid country.";
  const validIds = (ids: string[]) => ids.length <= 100 && ids.every(id => /^gid:\/\/shopify\/Product\/\d+$/.test(id));
  if (!validIds(products)) errors.products = "Select up to 100 valid products.";
  if (!validIds(receivedProducts)) errors.receivedProducts = "Select up to 100 valid products.";
  const requestKey = form.get("requestKey");
  if (typeof requestKey !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestKey)) errors.form = "Reload the page and try again.";
  if (Object.keys(errors).length) return { errors };
  const existing = await db.helpDeskTicket.findUnique({ where: { shop_requestKey: { shop, requestKey: requestKey as string } }, select: { id: true, number: true, accessToken: true } });
  if (existing) return { errors: {}, ticketId: existing.id, number: existing.number, token: existing.accessToken, created: false };
  const images = await readImages(files);
  if ("error" in images) return { errors: { images: images.error } };
  return createNumberedTicket(db, {
    shop, requestKey: requestKey as string, name: values.name, email: values.email, topic: values.topic, details: JSON.stringify(values),
    products: JSON.stringify([...new Set(products)]), receivedProducts: JSON.stringify([...new Set(receivedProducts)]),
    customerId: /^\d+$/.test(customerId) ? customerId : "", attachments: { create: images.attachments },
  });
}

// Checks each image's bytes match its declared type, so a renamed file can't pass as an image.
export async function readImages(files: File[]): Promise<{ error: string } | { attachments: { name: string; type: string; data: Uint8Array<ArrayBuffer> }[] }> {
  const attachments = [];
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    const bytes = Buffer.from(data.buffer);
    const valid = file.type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : file.type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : file.type === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid) return { error: "An attachment does not match its image format. Choose JPG, PNG or WebP images." };
    attachments.push({ name: file.name.slice(0, 200), type: file.type, data });
  }
  return { attachments };
}

type NewTicket = Omit<Prisma.HelpDeskTicketUncheckedCreateInput, "number" | "accessToken" | "lastActivityAt"> & { requestKey: string };

// Creates a ticket with the shop's next number and a tracking token. A
// concurrent submission that takes the same number fails the unique index, so
// retry with the next one; a retried request (same requestKey) returns the
// ticket saved first.
async function createNumberedTicket(db: PrismaClient, data: NewTicket): Promise<TicketResult> {
  const { shop, requestKey } = data;
  for (let attempt = 0; ; attempt++) {
    const last = await db.helpDeskTicket.findFirst({ where: { shop }, orderBy: { number: "desc" }, select: { number: true } });
    try {
      const ticket = await db.helpDeskTicket.create({
        data: { ...data, number: Math.max(1000, last?.number ?? 0) + 1, accessToken: randomBytes(24).toString("hex"), lastActivityAt: new Date() },
        select: { id: true, number: true, accessToken: true },
      });
      return { errors: {}, ticketId: ticket.id, number: ticket.number, token: ticket.accessToken, created: true };
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002" || attempt >= 5) throw error;
      const saved = await db.helpDeskTicket.findUnique({ where: { shop_requestKey: { shop, requestKey } }, select: { id: true, number: true, accessToken: true } });
      if (saved) return { errors: {}, ticketId: saved.id, number: saved.number, token: saved.accessToken, created: false };
    }
  }
}

export { CHAT_TOPIC };
export type ChatLine = { from: "customer" | "bot"; text: string };

// Turns a chat-widget conversation into a ticket: the bot transcript is kept
// as the opening messages so agents see what the customer already tried.
export async function startChat(db: PrismaClient, shop: string, input: { name: string; email: string; message: string; transcript: unknown; requestKey: string; customerId?: string }): Promise<TicketResult> {
  const name = input.name.trim().slice(0, 200);
  const email = input.email.trim().slice(0, 200);
  const message = input.message.trim();
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Name is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email address.";
  if (checkBody(message)) errors.body = checkBody(message);
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestKey)) errors.form = "Reload the page and try again.";
  if (Object.keys(errors).length) return { errors };
  const transcript = (Array.isArray(input.transcript) ? input.transcript : [])
    .filter((line): line is ChatLine => (line?.from === "customer" || line?.from === "bot") && typeof line.text === "string" && Boolean(line.text.trim()))
    .slice(-30).map((line) => ({ kind: line.from, author: line.from === "bot" ? "Assistant" : name, body: line.text.trim().slice(0, 2000) }));
  const start = Date.now() - transcript.length - 1;
  return createNumberedTicket(db, {
    shop, requestKey: input.requestKey, name, email, topic: CHAT_TOPIC, channel: "chat", details: JSON.stringify({ details: message }), products: "[]",
    customerId: /^\d+$/.test(input.customerId || "") ? input.customerId : "",
    // Distinct timestamps keep the transcript in order; the new message comes last.
    messages: { create: [...transcript, { kind: "customer", author: name, body: message }].map((line, index) => ({ ...line, createdAt: new Date(start + index) })) },
  });
}

export type TicketChanges = { status?: string; priority?: string; assignee?: string; tags?: string };

const cleanTags = (tags: string) => [...new Set(tags.split(",").map(tag => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 20).join(", ");

// Applies property changes to the shop's tickets and logs each change on the
// ticket's timeline. Returns how many tickets were found, or -1 for an invalid value.
export async function updateTickets(db: PrismaClient, shop: string, ids: string[], changes: TicketChanges, author = "Staff") {
  if (changes.status !== undefined && !ticketStatuses.includes(changes.status as typeof ticketStatuses[number])) return -1;
  if (changes.priority !== undefined && !priorities.includes(changes.priority as typeof priorities[number])) return -1;
  if (changes.assignee !== undefined && changes.assignee.length > 80) return -1;
  const tickets = await db.helpDeskTicket.findMany({ where: { shop, id: { in: ids.slice(0, 100) } } });
  for (const ticket of tickets) {
    const data: Prisma.HelpDeskTicketUpdateInput = {};
    const events: string[] = [];
    if (changes.status !== undefined && changes.status !== ticket.status) {
      data.status = changes.status;
      data.resolvedAt = changes.status === "Resolved" ? new Date() : null;
      events.push(`Status changed from ${ticket.status} to ${changes.status}`);
    }
    if (changes.priority !== undefined && changes.priority !== ticket.priority) {
      data.priority = changes.priority;
      events.push(`Priority changed from ${ticket.priority} to ${changes.priority}`);
    }
    if (changes.assignee !== undefined && changes.assignee.trim() !== ticket.assignee) {
      data.assignee = changes.assignee.trim();
      events.push(data.assignee ? `Assigned to ${data.assignee}` : "Unassigned");
    }
    if (changes.tags !== undefined && cleanTags(changes.tags) !== ticket.tags) {
      data.tags = cleanTags(changes.tags);
      events.push(data.tags ? `Tags set to ${data.tags}` : "Tags removed");
    }
    if (!events.length) continue;
    await db.helpDeskTicket.update({
      where: { id: ticket.id },
      data: { ...data, messages: { create: events.map(body => ({ kind: "event", author, body })) } },
    });
  }
  return tickets.length;
}

export async function updateTicketStatus(db: PrismaClient, shop: string, id: string, status: string) {
  return (await updateTickets(db, shop, [id], { status })) === 1;
}

export type MessageResult = { errors: Record<string, string>; messageId?: string; ticketId?: string };

const checkBody = (body: string) => !body ? "Write a message first."
  : body.length > MAX_MESSAGE_LENGTH ? `Use no more than ${MAX_MESSAGE_LENGTH.toLocaleString("en")} characters.` : "";

// Adds a staff reply (visible to the customer) or an internal note. A reply
// counts as the first response and, unless a status is given, moves an
// unresolved ticket to "Waiting on customer".
export async function addStaffMessage(db: PrismaClient, shop: string, id: string, input: { kind: string; body: string; author: string; status?: string }): Promise<MessageResult> {
  const body = input.body.trim();
  if (!["reply", "note"].includes(input.kind)) return { errors: { form: "Choose a reply or an internal note." } };
  if (checkBody(body)) return { errors: { body: checkBody(body) } };
  if (input.status && !ticketStatuses.includes(input.status as typeof ticketStatuses[number])) return { errors: { form: "Select a valid status." } };
  const ticket = await db.helpDeskTicket.findFirst({ where: { id, shop } });
  if (!ticket) return { errors: { form: "This ticket no longer exists." } };
  const author = input.author.trim().slice(0, 80) || "Staff";
  const now = new Date();
  const message = await db.helpDeskMessage.create({ data: { ticketId: ticket.id, kind: input.kind, author, body } });
  if (input.kind === "reply") {
    await db.helpDeskTicket.update({ where: { id: ticket.id }, data: { lastActivityAt: now, unread: false, ...(ticket.firstResponseAt ? {} : { firstResponseAt: now }) } });
  }
  const status = input.status || (input.kind === "reply" && ticket.status !== "Resolved" ? "Waiting on customer" : "");
  if (status) await updateTickets(db, shop, [ticket.id], { status }, author);
  return { errors: {}, messageId: message.id, ticketId: ticket.id };
}

// A customer's reply from their tracking page. Reopens waiting or resolved tickets.
export const MAX_REPLY_IMAGES = 3;

// Form tickets take customer messages only after the team has replied
// (status "Waiting on customer"); live chats stay open so the chat keeps flowing.
export const customerCanReply = (ticket: { channel: string; status: string }) => ticket.channel === "chat" || ticket.status === "Waiting on customer";

export async function addCustomerMessage(db: PrismaClient, shop: string, token: string, text: string, files: File[] = []): Promise<MessageResult> {
  const body = text.trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return { errors: { form: "This link is not valid." } };
  // Photos alone are a valid reply.
  if ((body || !files.length) && checkBody(body)) return { errors: { body: checkBody(body) } };
  if (files.length > MAX_REPLY_IMAGES) return { errors: { images: `Attach up to ${MAX_REPLY_IMAGES} images.` } };
  if (files.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || !file.size || file.size > MAX_IMAGE_BYTES)) {
    return { errors: { images: "Use JPG, PNG or WebP images, up to 5 MB each." } };
  }
  const images = await readImages(files);
  if ("error" in images) return { errors: { images: images.error } };
  const ticket = await db.helpDeskTicket.findFirst({ where: { shop, accessToken: token } });
  if (!ticket) return { errors: { form: "This request could not be found." } };
  if (!customerCanReply(ticket)) return { errors: { form: "You can add a message once our team replies. We'll let you know when they do." } };
  const message = await db.helpDeskMessage.create({
    data: { ticketId: ticket.id, kind: "customer", author: ticket.name, body: body || `Sent ${files.length} image${files.length === 1 ? "" : "s"}` },
  });
  if (images.attachments.length) {
    await db.helpDeskAttachment.createMany({ data: images.attachments.map((image) => ({ ...image, ticketId: ticket.id, messageId: message.id })) });
  }
  await db.helpDeskTicket.update({ where: { id: ticket.id }, data: { lastActivityAt: new Date(), unread: true } });
  if (ticket.status === "Waiting on customer" || ticket.status === "Resolved") await updateTickets(db, shop, [ticket.id], { status: "Open" }, ticket.name);
  return { errors: {}, messageId: message.id, ticketId: ticket.id };
}

// Permanently deletes the shop's tickets. Messages, images, image scans and
// queued emails go with them (cascading relations). Returns how many were deleted.
export async function deleteTickets(db: PrismaClient, shop: string, ids: string[]) {
  const { count } = await db.helpDeskTicket.deleteMany({ where: { shop, id: { in: ids.slice(0, 100) } } });
  return count;
}

// Privacy: a customer asked the store to erase their data (customers/redact).
// Removes every ticket opened with their email or Shopify customer ID.
export async function redactCustomer(db: PrismaClient, shop: string, customer: { email?: string | null; id?: string | number | null }) {
  const email = customer.email?.trim();
  const id = customer.id != null ? String(customer.id) : "";
  const or = [...(email ? [{ email }] : []), ...(/^\d+$/.test(id) ? [{ customerId: id }] : [])];
  if (!or.length) return 0;
  const { count } = await db.helpDeskTicket.deleteMany({ where: { shop, OR: or } });
  return count;
}

// Privacy: the store uninstalled the app 48 hours ago (shop/redact). Erases
// all Help Desk data held for it.
export async function purgeShop(db: PrismaClient, shop: string) {
  await db.$transaction([
    db.helpDeskTicket.deleteMany({ where: { shop } }),
    db.helpDeskFaq.deleteMany({ where: { shop } }),
    db.helpDeskBotQuestion.deleteMany({ where: { shop } }),
    db.helpDeskMacro.deleteMany({ where: { shop } }),
    db.helpDeskSettings.deleteMany({ where: { shop } }),
  ]);
}
