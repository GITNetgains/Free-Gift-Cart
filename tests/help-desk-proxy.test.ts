import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), submit: vi.fn(), read: vi.fn(), reply: vi.fn(), startChat: vi.fn(), ask: vi.fn(), queue: vi.fn(),
  db: { helpDeskTicket: { findMany: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("../app/shopify.server", () => ({ authenticate: { public: { appProxy: mocks.authenticate } } }));
vi.mock("../app/db.server", () => ({ default: mocks.db }));
vi.mock("../app/services/help-desk.server", () => ({
  readHelpDeskForm: mocks.read, submitTicket: mocks.submit, addCustomerMessage: mocks.reply, startChat: mocks.startChat, MAX_REPLY_IMAGES: 3,
  customerCanReply: (ticket: { channel: string; status: string }) => ticket.channel === "chat" || ticket.status === "Waiting on customer",
}));
vi.mock("../app/services/help-desk-chat.server", () => ({ answerQuestion: mocks.ask, chatConfig: vi.fn() }));
vi.mock("../app/services/help-desk-outbox.server", () => ({ queueEmail: mocks.queue, ensureWorker: vi.fn() }));
vi.mock("../app/services/image-scan/scan.server", () => ({ queueTicketScans: vi.fn() }));
import { action, loader } from "../app/routes/help-desk";
import { resetRateLimits } from "../app/services/rate-limit.server";
const args = (method = "POST") => ({ request: new Request("https://app.example/help-desk?shop=forged.myshopify.com", { method }), params: {}, context: {}, url: new URL("https://app.example/help-desk"), pattern: "/help-desk" });
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  mocks.read.mockResolvedValue(form);
  return action({ ...args(), request: new Request("https://app.example/help-desk", { method: "POST", headers: { "x-forwarded-for": "203.0.113.7", ...headers } }) });
};
beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  mocks.authenticate.mockResolvedValue({ session: { shop: "verified.myshopify.com" } });
  mocks.read.mockResolvedValue(new FormData());
  mocks.submit.mockResolvedValue({ errors: {}, ticketId: "ticket-1" });
});
describe("Storefront help desk endpoint", () => {
  it("uses the authenticated shop, never a customer supplied shop", async () => {
    const response = await action(args());
    expect(await response.json()).toEqual({ errors: {}, ticketId: "ticket-1" });
    expect(mocks.submit).toHaveBeenCalledWith(mocks.db, "verified.myshopify.com", expect.any(FormData), "");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects invalid proxy signatures before reading a body", async () => {
    const failure = new Response(null, { status: 400 });
    mocks.authenticate.mockRejectedValue(failure);
    await expect(action(args())).rejects.toBe(failure);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects stores without an installation", async () => {
    mocks.authenticate.mockResolvedValue({ session: undefined });
    expect((await action(args())).status).toBe(403);
    expect((await loader(args("GET"))).status).toBe(403);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("exposes only form choices to logged-out shoppers, never tickets", async () => {
    const data = await (await loader(args("GET"))).json();
    expect(data.topics).toHaveLength(5);
    expect(Object.keys(data).sort()).toEqual(["countries", "issues", "orderTypes", "orders", "tickets", "topics", "updates"]);
    // Orders and tickets are only looked up for a signed-in shopper (logged_in_customer_id).
    expect(data.orders).toBeNull();
    expect(data.tickets).toBeNull();
    expect(mocks.db.helpDeskTicket.findMany).not.toHaveBeenCalled();
  });
  it("lists only the signed-in shopper's own tickets in the verified shop", async () => {
    mocks.db.helpDeskTicket.findMany.mockResolvedValue([{ number: 1001, topic: "Order Queries", status: "Open", createdAt: new Date(), lastActivityAt: null, accessToken: "a".repeat(48) }]);
    const request = new Request("https://app.example/help-desk?shop=forged.myshopify.com&logged_in_customer_id=42");
    const data = await (await loader({ ...args("GET"), request })).json();
    expect(mocks.db.helpDeskTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shop: "verified.myshopify.com", customerId: "42" } }));
    expect(data.tickets[0]).toMatchObject({ number: 1001, token: "a".repeat(48) });
  });
  it("renders the request page as Liquid, escaping customer text, and 404s unknown links", async () => {
    const page = (token: string) => loader({ ...args("GET"), request: new Request(`https://app.example/help-desk?ticket=${token}`) });
    const missing = await page("not-a-token");
    expect(missing.status).toBe(404);
    expect(mocks.db.helpDeskTicket.findFirst).not.toHaveBeenCalled();
    mocks.db.helpDeskTicket.findFirst.mockResolvedValue({
      number: 1001, topic: "Order Queries", status: "Waiting on customer", createdAt: new Date(), accessToken: "b".repeat(48),
      details: JSON.stringify({ details: "{{ shop.secret }} <script>x</script>" }),
      messages: [{ id: "m1", kind: "reply", author: "Priya", body: "Hello {% raw %}", createdAt: new Date() }], attachments: [], channel: "form",
    });
    const response = await page("b".repeat(48));
    expect(response.headers.get("Content-Type")).toBe("application/liquid");
    expect(mocks.db.helpDeskTicket.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { shop: "verified.myshopify.com", accessToken: "b".repeat(48) } }));
    const html = await response.text();
    expect(html).toContain("Request #1001");
    expect(html).not.toContain("{{ shop.secret }}");
    expect(html).not.toContain("{% raw %}");
    expect(html).not.toContain("<script>x");
  });
  it("accepts customer replies only through the ticket's secret link", async () => {
    const form = new FormData(); form.set("intent", "reply"); form.set("token", "c".repeat(48)); form.set("body", "Any update?");
    mocks.read.mockResolvedValue(form);
    mocks.reply.mockResolvedValue({ errors: {}, messageId: "m1", ticketId: "t1" });
    const request = new Request("https://app.example/help-desk", { method: "POST", headers: { Accept: "application/json" } });
    const response = await action({ ...args(), request });
    expect(response.status).toBe(200);
    expect(mocks.reply).toHaveBeenCalledWith(mocks.db, "verified.myshopify.com", "c".repeat(48), "Any update?", []);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each(["intent", "website"])("rejects public %s requests", async key => {
    const form = new FormData(); form.set(key, "status");
    mocks.read.mockResolvedValue(form);
    expect((await action(args())).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("returns validation errors without claiming success", async () => {
    mocks.submit.mockResolvedValue({ errors: { images: "Upload an image." } });
    const response = await action(args());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { images: "Upload an image." } });
  });
  it("handles oversized bodies and storage failures", async () => {
    mocks.read.mockRejectedValueOnce(new Error("Request too large"));
    expect((await action(args())).status).toBe(400);
    mocks.submit.mockRejectedValue(new Error("Database unavailable"));
    expect((await action(args())).status).toBe(500);
  });
});

describe("Storefront chat and request lookup", () => {
  it("answers chat questions for the verified shop and rate limits each shopper", async () => {
    mocks.ask.mockResolvedValue({ answer: "Order #1001 has shipped.", result: "order", links: [] });
    const response = await post({ intent: "ask", question: "where is order #1001 a@b.co" });
    expect(await response.json()).toEqual({ answer: "Order #1001 has shipped.", result: "order", links: [] });
    expect(mocks.ask).toHaveBeenCalledWith(mocks.db, "verified.myshopify.com", undefined, "where is order #1001 a@b.co", "");
    for (let index = 0; index < 19; index++) await post({ intent: "ask", question: "hi" });
    expect((await post({ intent: "ask", question: "hi" })).status).toBe(429);
    // Another shopper is unaffected.
    expect((await post({ intent: "ask", question: "hi" }, { "x-forwarded-for": "198.51.100.2" })).status).toBe(200);
  });
  it("locks order lookups after repeated misses", async () => {
    mocks.ask.mockResolvedValue({ answer: "Not found", result: "order", orderNotFound: true });
    for (let index = 0; index < 5; index++) await post({ intent: "ask", question: "order #1 x@y.co" });
    const locked = await (await post({ intent: "ask", question: "order #2 x@y.co" })).json();
    expect(locked.answer).toMatch(/Too many order lookups/);
    expect(mocks.ask).toHaveBeenCalledTimes(5);
  });
  it("turns a chat into a ticket and queues the store alert and confirmation", async () => {
    mocks.startChat.mockResolvedValue({ errors: {}, ticketId: "t1", number: 1001, token: "a".repeat(48), created: true });
    const transcript = JSON.stringify([{ from: "customer", text: "Do you ship to Canada?" }, { from: "bot", text: "..." }]);
    const response = await post({ intent: "chat-start", name: "Rahul", email: "r@example.com", body: "Still need help", requestKey: "k".repeat(20), transcript });
    expect(response.status).toBe(200);
    expect(mocks.startChat).toHaveBeenCalledWith(mocks.db, "verified.myshopify.com", expect.objectContaining({ name: "Rahul", transcript: JSON.parse(transcript) }));
    expect(mocks.queue.mock.calls.map(([, input]) => input.kind)).toEqual(["new-ticket", "ack"]);
  });
  it("returns only customer-visible chat messages for a valid token", async () => {
    expect((await loader({ ...args("GET"), request: new Request("https://app.example/help-desk?chat=nope") })).status).toBe(404);
    mocks.db.helpDeskTicket.findFirst.mockResolvedValue({
      number: 1001, status: "Open", topic: "Live chat", attachments: [{ messageId: "m2" }],
      messages: [{ id: "m1", kind: "customer", author: "Rahul", body: "Hi", createdAt: new Date() }, { id: "m2", kind: "reply", author: "Priya", body: "Hello", createdAt: new Date() }],
    });
    const data = await (await loader({ ...args("GET"), request: new Request(`https://app.example/help-desk?chat=${"d".repeat(48)}`) })).json();
    expect(mocks.db.helpDeskTicket.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { shop: "verified.myshopify.com", accessToken: "d".repeat(48) },
      include: expect.objectContaining({ messages: expect.objectContaining({ where: { kind: { in: ["customer", "reply", "bot"] } } }) }),
    }));
    expect(data.messages.map((message: { author: string; images: number }) => [message.author, message.images])).toEqual([["You", 0], ["Priya", 1]]);
  });
  it("finds a request by number and email, and locks out guessing", async () => {
    mocks.db.helpDeskTicket.findFirst.mockResolvedValue({ email: "Rahul@Example.com", accessToken: "e".repeat(48) });
    const wrong = await post({ intent: "lookup", number: "1001", email: "someone@else.com" });
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toContain("couldn&#39;t find");
    mocks.db.helpDeskTicket.findFirst.mockResolvedValueOnce({ email: "Rahul@Example.com", accessToken: "e".repeat(48) })
      .mockResolvedValueOnce({ number: 1001, topic: "Order Queries", status: "Open", channel: "form", createdAt: new Date(), accessToken: "e".repeat(48), details: "{}", messages: [], attachments: [] });
    const found = await post({ intent: "lookup", number: "#1001", email: "rahul@example.com" });
    expect(found.status).toBe(200);
    expect(await found.text()).toContain("Request #1001");
    for (let index = 0; index < 5; index++) await post({ intent: "lookup", number: "1", email: "x@y.co" });
    expect((await post({ intent: "lookup", number: "1001", email: "rahul@example.com" })).status).toBe(429);
  });
});
