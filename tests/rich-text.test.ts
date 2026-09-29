import { describe, expect, test } from "vitest";
import { plainTextFromRichText, richTextFromPlain, richTextToHtml, sanitizeEditorHtml, sanitizeRichText } from "../app/services/rich-text";

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
    expect(html).toBe('<p><a href="https://x.com/&quot;&gt;&lt;script&gt;"><strong>&lt;b&gt;hi&lt;/b&gt;</strong></a></p>');
  });
});

describe("checkout notice editor HTML", () => {
  test("keeps headings, images and tables and drops unsafe ones", () => {
    const root = sanitizeRichText({ type: "root", children: [
      { type: "heading", level: 9, children: [{ type: "text", value: "SPECS" }] },
      { type: "image", src: "https://cdn.shopify.com/a.png", alt: "Case" },
      { type: "image", src: "http://insecure.example/a.png", alt: "" },
      { type: "table", rows: [{ header: true, cells: [[{ type: "text", value: "Pack" }], [{ type: "text", value: "Off" }]] }, { cells: [[], []] }] },
    ] });
    expect(root?.children).toEqual([
      { type: "heading", level: 6, children: [{ type: "text", value: "SPECS" }] },
      { type: "image", src: "https://cdn.shopify.com/a.png", alt: "Case" },
      { type: "table", rows: [{ header: true, cells: [[{ type: "text", value: "Pack" }], [{ type: "text", value: "Off" }]] }] },
    ]);
    expect(plainTextFromRichText(root!)).toBe("SPECS\nPack | Off");
  });

  test("strips scripts, event handlers and javascript urls from stored HTML", () => {
    const html = sanitizeEditorHtml('<p onclick="x()">Hi<script>alert(1)</script><a href="javascript:alert(1)">a</a><img src=x onerror=alert(1)></p>');
    expect(html).toBe('<p>Hi<a href="#">a</a><img src=x></p>');
  });
});
