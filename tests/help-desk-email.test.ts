import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderCustomerEmail, renderEmail, trackingUrl } from "../app/services/help-desk-email.server";

const sample = {
  storeName: "Zion Cases", adminUrl: "https://admin.shopify.com/store/zion/apps/key/app/help-desk?ticket=t1", ticketId: "t1",
  createdAt: new Date("2026-10-15T08:30:00Z"), name: "Rahul Sharma", email: "rahul@example.com", topic: "Returns, Exchanges & Refunds",
  values: {
    phone: "+91 98765 43210", orderNumber: "#1042", orderDetails: "Order #1042 placed on Oct 9, 2026",
    productDetails: "Pokemon Booster Box Case - Clear / Magnetic × 2\nZion Graded Card Case × 1", issue: "Defective product received",
    details: "The magnetic lid on one of the booster box cases is cracked at the corner and does not close properly.", resolution: "Exchange",
  },
  products: [], images: [{ cid: "a@help-desk", name: "lid.jpg" }, { cid: "b@help-desk", name: "corner.jpg" }], skippedImages: 0,
};

describe("help desk notification email", () => {
  it("shows the request with labelled fields, inline images and the admin link", () => {
    const html = renderEmail(sample);
    expect(html).toContain("New Help Desk request");
    expect(html).toContain("Requested resolution");
    expect(html).toContain("Zion Graded Card Case × 1");
    expect(html).toContain("src=\"cid:a@help-desk\"");
    expect(html).toContain(sample.adminUrl.replace(/&/g, "&amp;"));
    // Set HELP_DESK_EMAIL_PREVIEW to a file path to look at the rendered email.
    if (process.env.HELP_DESK_EMAIL_PREVIEW) writeFileSync(process.env.HELP_DESK_EMAIL_PREVIEW, html);
  });

  it("renders customer emails with the tracking button and escaped replies", () => {
    const html = renderCustomerEmail({
      storeName: "Zion Cases", heading: "New reply on request #1001", paragraphs: [], quote: "Hi <b>Rahul</b>\nYour case ships today.",
      buttonUrl: trackingUrl("https://zioncases.com/", "a".repeat(48)), buttonLabel: "View and reply", footer: "Ticket #1001",
    });
    expect(html).toContain(`href="https://zioncases.com/apps/help-desk?ticket=${"a".repeat(48)}"`);
    expect(html).toContain("Hi &lt;b&gt;Rahul&lt;/b&gt;<br>Your case ships today.");
  });

  it("escapes customer-written text", () => {
    const html = renderEmail({ ...sample, name: "<script>alert(1)</script>", values: { details: "<img src=x onerror=alert(1)>" } });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
