import { describe, expect, test } from "vitest";
import { plainTextFromRichText, richTextFromPlain, richTextToHtml, sanitizeRichText } from "../app/services/rich-text";

describe("checkout notice rich text", () => {
  test("plain messages from before rich text become one paragraph per line", () => {
    const root = richTextFromPlain("Duties apply\n\nShips in 5 days");
    expect(root.children).toHaveLength(2);
    expect(plainTextFromRichText(root)).toBe("Duties apply\nShips in 5 days");
  });

  test("sanitizing drops unsafe links, unknown fields and empty blocks", () => {
    const root = sanitizeRichText({ type: "root", children: [
      { type: "paragraph", children: [
        { type: "text", value: "Read ", bold: true, style: "color:red" },
        { type: "link", url: "javascript:alert(1)", children: [{ type: "text", value: "this" }] },
        { type: "link", url: "https://example.com", children: [{ type: "text", value: " policy", italic: true }] },
      ] },
      { type: "paragraph", children: [{ type: "text", value: "   " }] },
      { type: "list", listType: "ordered", children: [{ type: "list-item", children: [{ type: "text", value: "One" }] }] },
    ] });
    expect(root).toEqual({ type: "root", children: [
      { type: "paragraph", children: [
        { type: "text", value: "Read ", bold: true },
        { type: "text", value: "this" },
        { type: "link", url: "https://example.com", children: [{ type: "text", value: " policy", italic: true }] },
      ] },
      { type: "list", listType: "ordered", children: [{ type: "list-item", children: [{ type: "text", value: "One" }] }] },
    ] });
    expect(sanitizeRichText("<b>html</b>")).toBeNull();
  });

  test("editor HTML escapes text and link urls", () => {
    const html = richTextToHtml({ type: "root", children: [{ type: "paragraph", children: [
      { type: "link", url: 'https://x.com/"><script>', children: [{ type: "text", value: "<b>hi</b>", bold: true }] },
    ] }] });
    expect(html).toBe('<div><a href="https://x.com/&quot;&gt;&lt;script&gt;"><b>&lt;b&gt;hi&lt;/b&gt;</b></a></div>');
  });
});
