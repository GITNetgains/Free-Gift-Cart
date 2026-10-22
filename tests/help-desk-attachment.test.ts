import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), findFirst: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: mocks.authenticate } }));
vi.mock("../app/db.server", () => ({ default: { helpDeskAttachment: { findFirst: mocks.findFirst } } }));
import { loader } from "../app/routes/app.help-desk-attachment";
const args = () => ({ request: new Request("https://app.example/app/help-desk-attachment?id=image-1"), params: {}, context: {}, url: new URL("https://app.example/app/help-desk-attachment?id=image-1"), pattern: "/app/help-desk-attachment" });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ session: { shop: "owner.myshopify.com" } });
});
describe("Help desk attachments", () => {
  it("authenticates before accessing attachment storage", async () => {
    const failure = new Response(null, { status: 401 });
    mocks.authenticate.mockRejectedValue(failure);
    await expect(loader(args())).rejects.toBe(failure);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
  it("restricts image lookup to the authenticated shop and prevents caching", async () => {
    mocks.findFirst.mockResolvedValue({ name: "photo.png", type: "image/png", data: Buffer.from("image") });
    const result = await loader(args());
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: "image-1", ticket: { shop: "owner.myshopify.com" } } });
    expect(result.data).toEqual({ name: "photo.png", url: "data:image/png;base64,aW1hZ2U=" });
    expect(result.init?.headers).toEqual({ "Cache-Control": "private, no-store" });
  });
  it("returns an inline error for missing or inaccessible attachments", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const result = await loader(args());
    expect(result.init?.status).toBe(404);
    expect(result.data).toEqual({ error: "This attachment is no longer available." });
    expect(result.init?.headers).toEqual({ "Cache-Control": "private, no-store" });
  });
});
