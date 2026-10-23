import { describe, expect, it } from "vitest";
import { buildChecks, type PhotoScan } from "../app/components/PhotoReport";
import { issues, orderTypes, suggestTags, topics } from "../app/services/help-desk";
import { renderRequestPage } from "../app/services/help-desk-request-page";

const links = { ticket: (id: string) => `/ticket/${id}`, settings: "/settings" };
const scan = (layers: Partial<PhotoScan["layers"]>, verdict = "uncertain"): PhotoScan => ({
  status: "completed", overallVerdict: verdict, overallConfidence: 0.5, duplicateOfAttachmentId: null, error: null,
  layers: { c2pa: { present: false, checked: true }, watermark: null, exif: null, hash: { match: null }, classifier: null, editing: null, ...layers } as PhotoScan["layers"],
});
const check = (result: ReturnType<typeof buildChecks>, key: string) => result.find((entry) => entry.key === key)!;

describe("Tag suggestions", () => {
  it("suggests tags from what the customer chose and wrote", () => {
    const { fromRequest } = suggestTags({ topic: topics[3], tags: "", details: { orderType: orderTypes[1], issue: issues[0], details: "The case arrived cracked" } }, []);
    expect(fromRequest).toEqual(["product-issue", "defective", "damaged"]);
  });
  it("adds the store's most used tags and skips tags the ticket already has", () => {
    const result = suggestTags({ topic: topics[4], tags: "Return", details: { resolution: "Refund" } }, ["vip, return", "vip", "late"]);
    expect(result.fromRequest).toEqual(["refund"]);
    expect(result.popular).toEqual(["vip", "late"]);
  });
});

describe("Photo check report", () => {
  it("lists all six checks in the order they run", () => {
    expect(buildChecks(scan({}), links).map((entry) => entry.key)).toEqual(["c2pa", "watermark", "metadata", "reuse", "detector", "editing"]);
  });
  it("marks a missing detector key as a setup step, not a pass", () => {
    const detector = check(buildChecks(scan({ classifier: { skipped: true, missingApiKey: true, providerLabel: "Sightengine" } }), links), "detector");
    expect(detector.status).toBe("setup");
    expect(detector.findings[0]).toMatchObject({ title: "AI detector not connected", href: "/settings" });
  });
  it("turns a high detector score into AI evidence and a low one into a pass", () => {
    const high = check(buildChecks(scan({ classifier: { providerLabel: "Sightengine", aiProbability: 92, reasoning: "92% likely AI" } }), links), "detector");
    const low = check(buildChecks(scan({ classifier: { providerLabel: "Sightengine", aiProbability: 8, reasoning: "8% likely AI" } }), links), "detector");
    expect([high.status, high.findings[0].severity]).toEqual(["issue", "critical"]);
    expect(low.status).toBe("clear");
  });
  it("links a photo reused from another ticket", () => {
    const reuse = check(buildChecks(scan({ hash: { match: {
      duplicateOfAttachmentId: "a1", matchType: "exact", distance: 0, ticketId: "t9", ticketNumber: 1009, fileName: "case.jpg",
      uploadedAt: new Date("2026-10-01"), sameTicket: false, previousVerdict: "likely_real",
    } } }, "duplicate"), links), "reuse");
    expect(reuse.status).toBe("warning");
    expect(reuse.findings[0]).toMatchObject({ title: "Already used on ticket #1009", href: "/ticket/t9" });
  });
  it("reports a detector error as couldn't check, with the provider's hint", () => {
    const detector = check(buildChecks(scan({ classifier: { providerLabel: "TruthScan", error: "403", errorTitle: "TruthScan checks used up", errorHint: "Upgrade, then re-scan." } }), links), "detector");
    expect(detector.status).toBe("failed");
    expect(detector.findings[0]).toMatchObject({ title: "TruthScan checks used up", detail: "Upgrade, then re-scan." });
  });
});

describe("Customer request page", () => {
  const ticket = {
    number: 1042, topic: "Order Queries", status: "Waiting on customer", channel: "form", createdAt: new Date("2026-10-20T10:00:00Z"), accessToken: "tok",
    details: JSON.stringify({ orderNumber: "#5001", details: "Wrong case <script>" }),
    messages: [{ id: "m1", kind: "reply", author: "Priya", body: "Could you send a photo?", createdAt: new Date("2026-10-20T11:00:00Z") }],
  };
  const extras = { imageCounts: new Map(), requestImages: 0, products: [], receivedProducts: [], canReply: true, maxImages: 3, maxLength: 5000 };
  it("shows the customer's messages and the team's replies as a chat, escaped", () => {
    const html = renderRequestPage(ticket, extras);
    expect(html).toContain('data-kind="customer"');
    expect(html).toContain('data-kind="reply"');
    expect(html).toContain("Wrong case &lt;script&gt;");
    expect(html).not.toContain("<script>Wrong");
    expect(html).toContain('name="body"');
  });
  it("hides the reply box until the team has replied", () => {
    const html = renderRequestPage({ ...ticket, status: "Open" }, { ...extras, canReply: false });
    expect(html).not.toContain('name="body"');
    expect(html).toContain("Our team will reply soon");
  });
});
