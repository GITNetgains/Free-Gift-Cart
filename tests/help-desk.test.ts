import { describe, expect, it } from "vitest";
import { countries, imagesRequired, issues, orderTypes, topics, updates, validateHelpDesk } from "../app/services/help-desk";

const contact = { name: "Test Customer", email: "customer@example.com" };
const image = { name: "damage.jpg", size: 1024, type: "image/jpeg" };
describe("Help desk validation", () => {
  it("requires contact information and a known topic, but no phone number", () => {
    expect(Object.keys(validateHelpDesk({}, [], []))).toEqual(["name", "email", "topic"]);
    expect(validateHelpDesk({ ...contact, topic: topics[0], country: "IN", address: "Test address" }, ["product-1"], [])).toEqual({});
  });
  it("requires products, country and address for shipping", () => {
    expect(Object.keys(validateHelpDesk({ ...contact, topic: topics[0] }, [], []))).toEqual(["products", "country", "address"]);
  });
  it.each([topics[1], topics[2]])("handles existing and new partners for %s", topic => {
    expect(validateHelpDesk({ ...contact, topic, existing: "Yes", query: "Help" }, [], [])).toHaveProperty("registeredEmail");
    expect(validateHelpDesk({ ...contact, topic, existing: "Yes", registeredEmail: "registered@example.com", query: "Help" }, [], [])).toEqual({});
    expect(validateHelpDesk({ ...contact, topic, existing: "No", query: "Interested in joining" }, [], [])).toEqual({});
    expect(validateHelpDesk({ ...contact, topic, existing: "Maybe", query: "Help" }, [], [])).toHaveProperty("existing");
  });
  it.each(updates)("requires update details for %s", update => {
    const values = { ...contact, topic: topics[3], orderType: orderTypes[0], orderNumber: "#1001", update };
    expect(validateHelpDesk(values, [], [])).toHaveProperty("details");
    expect(validateHelpDesk({ ...values, details: "Requested change" }, [], [])).toEqual({});
  });
  it.each(issues.slice(0, 3))("enforces the image rule for order issue %s", issue => {
    const values = { ...contact, topic: topics[3], orderType: orderTypes[1], orderNumber: "#1001", details: "Details", issue };
    expect(imagesRequired(values)).toBe(issue !== issues[2]);
    expect(Boolean(validateHelpDesk(values, [], []).images)).toBe(issue !== issues[2]);
    expect(validateHelpDesk(values, [], [image])).toEqual({});
  });
  it.each(issues)("requires images for every return issue: %s", issue => {
    const values = { ...contact, topic: topics[4], orderNumber: "#1001", orderDetails: "Order details", productDetails: "Product", details: "Issue details", issue, resolution: "Refund" };
    expect(validateHelpDesk(values, [], [])).toHaveProperty("images");
    expect(validateHelpDesk(values, [], [image])).toEqual({});
    expect(validateHelpDesk({ ...values, resolution: "Invalid" }, [], [image])).toHaveProperty("resolution");
  });
  it("handles wrongly ordered products without requiring issue images", () => {
    const wrong = { ...contact, topic: topics[3], orderType: orderTypes[2], orderNumber: "#1001", details: "Received the small case instead of the large one" };
    expect(validateHelpDesk(wrong, ["gid://shopify/Product/1"], [{ name: "case.jpg", size: 10, type: "image/jpeg" }], ["gid://shopify/Product/2"])).toEqual({});
    expect(Object.keys(validateHelpDesk({ ...wrong, details: "" }, [], []))).toEqual(["receivedProducts", "products", "images"]);
  });
  it("rejects oversized, empty, unsupported and excessive images", () => {
    const values = { ...contact, topic: topics[3], orderType: orderTypes[1], issue: issues[2], orderNumber: "#1001", details: "Details" };
    for (const files of [[{ ...image, size: 6 * 1024 * 1024 }], [{ ...image, size: 0 }], [{ ...image, type: "image/svg+xml" }], Array(6).fill(image)]) {
      expect(validateHelpDesk(values, [], files)).toHaveProperty("images");
    }
  });
  it("ignores hidden fields and attachments from other topics", () => {
    expect(validateHelpDesk({ ...contact, topic: topics[1], existing: "No", query: "Help", issue: issues[0] }, [], [{ ...image, size: 0 }])).toEqual({});
  });
  it("includes countries and territories with unique codes", () => {
    expect(countries).toHaveLength(249);
    expect(new Set(countries.map(country => country.code)).size).toBe(249);
  });
});
