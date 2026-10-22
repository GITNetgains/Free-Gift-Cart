import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCustomerMessage, addStaffMessage, CHAT_TOPIC, readHelpDeskForm, startChat, submitTicket, updateTickets, updateTicketStatus } from "../app/services/help-desk.server";
import { fillMacro, orderTypes, topics } from "../app/services/help-desk";
import { defaultFaqs } from "../app/services/help-desk-bot";
import { answerQuestion, ensureFaqs } from "../app/services/help-desk-chat.server";
import { processEmail, retryEmail } from "../app/services/help-desk-outbox.server";

const temp = mkdtempSync(join(tmpdir(), "help-desk-test-"));
const db = new PrismaClient({ datasourceUrl: `file:${join(temp, "test.sqlite").replaceAll("\\", "/")}` });
const shop = "test.myshopify.com";
function form(overrides: Record<string, string> = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries({ requestKey: crypto.randomUUID(), name: "Customer", email: "customer@example.com", topic: topics[1], existing: "No", query: "Wholesale enquiry", ...overrides })) body.set(key, value);
  return body;
}
beforeAll(async () => {
  for (const migration of readdirSync("prisma/migrations").filter(name => name.includes("help_desk")).sort()) {
    const sql = readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8");
    for (const statement of sql.split(";").filter(value => value.trim())) await db.$executeRawUnsafe(statement);
  }
});
afterAll(async () => { await db.$disconnect(); rmSync(temp, { recursive: true, force: true }); });

describe("Help desk persistence", () => {
  it("persists tickets, removes inactive fields and deduplicates retries", async () => {
    const body = form({ orderNumber: "hidden", registeredEmail: "hidden@example.com" });
    const first = await submitTicket(db, shop, body);
    expect(first.errors).toEqual({});
    expect((await submitTicket(db, shop, body)).ticketId).toBe(first.ticketId);
    const ticket = await db.helpDeskTicket.findUniqueOrThrow({ where: { id: first.ticketId } });
    expect(ticket.status).toBe("Open");
    expect(JSON.parse(ticket.details)).not.toHaveProperty("orderNumber");
    expect(JSON.parse(ticket.details)).not.toHaveProperty("registeredEmail");
    expect((await submitTicket(db, "other.myshopify.com", body)).ticketId).not.toBe(first.ticketId);
  });
  it("restricts status changes to the owning shop and known statuses", async () => {
    const { ticketId } = await submitTicket(db, shop, form());
    expect(await updateTicketStatus(db, "other.myshopify.com", ticketId!, "Resolved")).toBe(false);
    expect(await updateTicketStatus(db, shop, ticketId!, "Invalid")).toBe(false);
    expect(await updateTicketStatus(db, shop, ticketId!, "Resolved")).toBe(true);
    expect((await db.helpDeskTicket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe("Resolved");
  });
  it("rejects invalid requests without saving", async () => {
    const count = await db.helpDeskTicket.count();
    expect((await submitTicket(db, shop, form({ email: "invalid" }))).errors.email).toBeTruthy();
    expect((await submitTicket(db, shop, form({ query: "x".repeat(5001) }))).errors.query).toBeTruthy();
    const shipping = form({ topic: topics[0], country: "INVALID", address: "Address" });
    shipping.append("products", "not-a-product");
    const result = await submitTicket(db, shop, shipping);
    expect(result.errors.country).toBeTruthy();
    expect(result.errors.products).toBeTruthy();
    expect(await db.helpDeskTicket.count()).toBe(count);
  });
  it("requires return images, rejects forged images and stores valid bytes", async () => {
    const body = form({ topic: topics[4], orderNumber: "1001", orderDetails: "Order", productDetails: "Case", issue: "Defective product received", details: "Broken", resolution: "Exchange" });
    expect((await submitTicket(db, shop, body)).errors.images).toBeTruthy();
    body.set("images", new Blob(["not an image"], { type: "image/png" }), "fake.png");
    expect((await submitTicket(db, shop, body)).errors.images).toBeTruthy();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=", "base64");
    body.set("images", new Blob([bytes], { type: "image/png" }), "photo.png");
    const saved = await submitTicket(db, shop, body);
    expect(saved.errors).toEqual({});
    const image = await db.helpDeskAttachment.findFirstOrThrow({ where: { ticketId: saved.ticketId } });
    expect(Buffer.from(image.data)).toEqual(bytes);
    expect(await db.helpDeskAttachment.findFirst({ where: { id: image.id, ticket: { shop: "other.myshopify.com" } } })).toBeNull();
  });
  it("reads multipart forms and bounds streamed request sizes", async () => {
    const body = form();
    const parsed = await readHelpDeskForm(new Request("https://example.com", { method: "POST", body }));
    expect(parsed.get("query")).toBe("Wholesale enquiry");
    await expect(readHelpDeskForm(new Request("https://example.com", { method: "POST", body: new Uint8Array(26 * 1024 * 1024) }))).rejects.toThrow("Request too large");
  });
  it("stores received and wanted products for a wrong delivery", async () => {
    const body = form({ topic: topics[3], orderType: orderTypes[2], orderNumber: "#1001", existing: "", query: "" });
    body.append("products", "gid://shopify/Product/1");
    body.append("receivedProducts", "gid://shopify/Product/2");
    body.append("images", new File([Buffer.from([255, 216, 255, 0])], "wrong.jpg", { type: "image/jpeg" }));
    const saved = await submitTicket(db, shop, body);
    expect(saved.errors).toEqual({});
    const ticket = await db.helpDeskTicket.findUniqueOrThrow({ where: { id: saved.ticketId } });
    expect(JSON.parse(ticket.products)).toEqual(["gid://shopify/Product/1"]);
    expect(JSON.parse(ticket.receivedProducts)).toEqual(["gid://shopify/Product/2"]);
  });
});

describe("Help desk conversations", () => {
  const numbered = "numbers.myshopify.com";
  it("numbers tickets per shop, issues unique tracking tokens and keeps retries on the same number", async () => {
    const body = form();
    const first = await submitTicket(db, numbered, body, "42");
    const retry = await submitTicket(db, numbered, body);
    const second = await submitTicket(db, numbered, form());
    const other = await submitTicket(db, "numbers-other.myshopify.com", form());
    expect([first.number, retry.number, second.number, other.number]).toEqual([1001, 1001, 1002, 1001]);
    expect(first.token).toMatch(/^[a-f0-9]{48}$/);
    expect(second.token).not.toBe(first.token);
    expect(retry.created).toBe(false);
    expect((await db.helpDeskTicket.findUniqueOrThrow({ where: { id: first.ticketId } })).customerId).toBe("42");
    expect((await db.helpDeskTicket.findUniqueOrThrow({ where: { id: second.ticketId } })).customerId).toBe("");
  });
  it("logs property changes and only touches the owning shop's tickets", async () => {
    const { ticketId } = await submitTicket(db, shop, form());
    expect(await updateTickets(db, "other.myshopify.com", [ticketId!], { priority: "Urgent" })).toBe(0);
    expect(await updateTickets(db, shop, [ticketId!], { priority: "Critical" })).toBe(-1);
    expect(await updateTickets(db, shop, [ticketId!], { priority: "Urgent", assignee: "Priya", tags: "vip, damaged, vip" }, "Rahul")).toBe(1);
    const ticket = await db.helpDeskTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { messages: true } });
    expect(ticket).toMatchObject({ priority: "Urgent", assignee: "Priya", tags: "vip, damaged" });
    expect(ticket.messages.map(message => [message.kind, message.author, message.body])).toEqual([
      ["event", "Rahul", "Priority changed from Normal to Urgent"], ["event", "Rahul", "Assigned to Priya"], ["event", "Rahul", "Tags set to vip, damaged"],
    ]);
  });
  it("records replies and notes, the first response time, and reopens when the customer replies", async () => {
    const { ticketId, token } = await submitTicket(db, shop, form());
    expect((await addStaffMessage(db, "other.myshopify.com", ticketId!, { kind: "reply", body: "Hi", author: "Priya" })).errors.form).toBeTruthy();
    expect((await addStaffMessage(db, shop, ticketId!, { kind: "reply", body: "   ", author: "Priya" })).errors.body).toBeTruthy();
    expect((await addStaffMessage(db, shop, ticketId!, { kind: "note", body: "Check stock", author: "Priya" })).messageId).toBeTruthy();
    let ticket = await db.helpDeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.firstResponseAt).toBeNull();
    expect(ticket.status).toBe("Open");
    await addStaffMessage(db, shop, ticketId!, { kind: "reply", body: "We're on it", author: "Priya" });
    ticket = await db.helpDeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.firstResponseAt).not.toBeNull();
    expect(ticket.status).toBe("Waiting on customer");
    await addStaffMessage(db, shop, ticketId!, { kind: "reply", body: "Done", author: "Priya", status: "Resolved" });
    expect((await db.helpDeskTicket.findUniqueOrThrow({ where: { id: ticketId } })).resolvedAt).not.toBeNull();

    expect((await addCustomerMessage(db, "other.myshopify.com", token!, "Still broken")).errors.form).toBeTruthy();
    expect((await addCustomerMessage(db, shop, "f".repeat(48), "Still broken")).errors.form).toBeTruthy();
    expect((await addCustomerMessage(db, shop, token!, "Still broken")).messageId).toBeTruthy();
    ticket = await db.helpDeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket).toMatchObject({ status: "Open", unread: true, resolvedAt: null });
  });
  it("turns a chat into a numbered ticket that keeps the bot transcript in order", async () => {
    const result = await startChat(db, "chat.myshopify.com", {
      name: "Rahul", email: "r@example.com", message: "I still need help", requestKey: crypto.randomUUID(), customerId: "7",
      transcript: [{ from: "customer", text: "Do you ship to Canada?" }, { from: "bot", text: "Send us a query." }, { from: "staff", text: "forged" }, { from: "bot", text: "  " }],
    });
    expect(result).toMatchObject({ errors: {}, number: 1001, created: true });
    const ticket = await db.helpDeskTicket.findUniqueOrThrow({ where: { id: result.ticketId }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    expect(ticket).toMatchObject({ channel: "chat", topic: CHAT_TOPIC, customerId: "7" });
    expect(ticket.messages.map(message => [message.kind, message.author, message.body])).toEqual([
      ["customer", "Rahul", "Do you ship to Canada?"], ["bot", "Assistant", "Send us a query."], ["customer", "Rahul", "I still need help"],
    ]);
    expect((await startChat(db, shop, { name: "", email: "bad", message: "", transcript: [], requestKey: "short" })).errors).toMatchObject({ name: expect.any(String), email: expect.any(String), body: expect.any(String), form: expect.any(String) });
  });
  it("stores photos sent with a customer reply against that message", async () => {
    const { token, ticketId } = await submitTicket(db, shop, form());
    const png = new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=", "base64")], "proof.png", { type: "image/png" });
    const sent = await addCustomerMessage(db, shop, token!, "", [png]);
    expect(sent.errors).toEqual({});
    const files = await db.helpDeskAttachment.findMany({ where: { ticketId } });
    expect(files).toHaveLength(1);
    expect(files[0].messageId).toBe(sent.messageId);
    expect((await db.helpDeskMessage.findUniqueOrThrow({ where: { id: sent.messageId } })).body).toBe("Sent 1 image");
    const fake = new File(["not an image"], "x.png", { type: "image/png" });
    expect((await addCustomerMessage(db, shop, token!, "see photo", [fake])).errors.images).toBeTruthy();
    expect((await addCustomerMessage(db, shop, token!, "too many", [png, png, png, png])).errors.images).toBeTruthy();
  });
  it("queues emails once, skips them without SMTP, and only retries failed ones", async () => {
    const { ticketId } = await submitTicket(db, shop, form());
    const row = await db.helpDeskEmail.create({ data: { shop, ticketId: ticketId!, kind: "ack" } });
    const smtp = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      await Promise.all([processEmail(db, row.id), processEmail(db, row.id)]);
      const done = await db.helpDeskEmail.findUniqueOrThrow({ where: { id: row.id } });
      expect(done).toMatchObject({ status: "skipped", attempts: 1 });
      expect(await retryEmail(db, "other.myshopify.com", row.id)).toBe(false);
      expect(await retryEmail(db, shop, row.id)).toBe(true);
      expect((await db.helpDeskEmail.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("skipped");
    } finally {
      if (smtp !== undefined) process.env.SMTP_HOST = smtp;
    }
  });
  it("answers from the store's FAQs, logs every question and falls back to a person", async () => {
    const botShop = "bot.myshopify.com";
    await ensureFaqs(db, botShop);
    expect(await db.helpDeskFaq.count({ where: { shop: botShop } })).toBe(defaultFaqs.length);
    await db.helpDeskFaq.deleteMany({ where: { shop: botShop } });
    await ensureFaqs(db, botShop);
    expect(await db.helpDeskFaq.count({ where: { shop: botShop } })).toBe(0);
    await db.helpDeskFaq.create({ data: { shop: botShop, question: "How long does shipping take?", keywords: "delivery time, shipping time", answer: "3-5 days" } });
    expect(await answerQuestion(db, botShop, undefined, "what's the delivery time?")).toMatchObject({ result: "faq", answer: "3-5 days" });
    expect(await answerQuestion(db, botShop, undefined, "where is order #1001")).toMatchObject({ result: "order", answer: expect.stringContaining("email") });
    expect(await answerQuestion(db, botShop, undefined, "do you sell gift cards")).toMatchObject({ result: "none" });
    expect((await db.helpDeskBotQuestion.findMany({ where: { shop: botShop } })).map(row => row.result).sort()).toEqual(["faq", "none", "order"]);
  });
  it("fills saved reply placeholders and leaves unknown ones", () => {
    const text = fillMacro("Hi {{ customer.first_name }}, about {{ticket.number}} / {{ order.number }} from {{ store.name }} {{ unknown }}",
      { name: "Rahul Sharma", number: 1007, topic: "Order Queries", details: { orderNumber: "#1042" } }, "Zion Cases");
    expect(text).toBe("Hi Rahul, about #1007 / #1042 from Zion Cases {{ unknown }}");
  });
});
