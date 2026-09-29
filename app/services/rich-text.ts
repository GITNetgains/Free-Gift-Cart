// Checkout notices are edited as HTML in the admin (TinyMCE), but checkout UI
// extensions cannot render HTML. On save the HTML is converted into this small
// rich-text tree, which the checkout-notice extension renders with checkout
// components (see renderRichText in its Checkout.jsx). HTML that checkout has
// no component for (colours, underline, alignment, video) becomes plain text.
export type RichTextLeaf = { type: "text"; value: string; bold?: boolean; italic?: boolean };
export type RichTextInline = RichTextLeaf | { type: "link"; url: string; children: RichTextLeaf[] };
export type RichTextBlock =
  | { type: "paragraph"; children: RichTextInline[] }
  | { type: "heading"; level: number; children: RichTextInline[] }
  | { type: "list"; listType: "ordered" | "unordered"; children: { type: "list-item"; children: RichTextInline[] }[] }
  | { type: "image"; src: string; alt: string }
  | { type: "table"; rows: { header?: boolean; cells: RichTextInline[][] }[] };
export type RichText = { type: "root"; children: RichTextBlock[] };

const MAX_BLOCKS = 80;
const MAX_INLINES = 100;
const MAX_TEXT = 2000;
const MAX_ROWS = 30;
const MAX_COLUMNS = 8;
export const MAX_HTML = 50_000;

export function emptyRichText(): RichText {
  return { type: "root", children: [] };
}

export function safeUrl(value: unknown) {
  const url = String(value || "").trim().slice(0, 500);
  return /^(https?:\/\/|mailto:|tel:|\/)/i.test(url) ? url : "";
}

const safeImageUrl = (value: unknown) => {
  const url = String(value || "").trim().slice(0, 1000);
  return /^https:\/\//i.test(url) ? url : "";
};

type Raw = { [key: string]: unknown } | null | undefined;
const list = (value: unknown) => (Array.isArray(value) ? value as Raw[] : []);

function sanitizeLeaf(node: Raw): RichTextLeaf | null {
  const value = String(node?.value ?? "").slice(0, MAX_TEXT);
  if (!value) return null;
  return { type: "text", value, ...(node?.bold ? { bold: true } : {}), ...(node?.italic ? { italic: true } : {}) };
}

function sanitizeInlines(nodes: unknown): RichTextInline[] {
  return list(nodes).slice(0, MAX_INLINES).flatMap((node): RichTextInline[] => {
    if (node?.type === "link") {
      const children = list(node.children).slice(0, MAX_INLINES).map(sanitizeLeaf).filter(Boolean) as RichTextLeaf[];
      const url = safeUrl(node.url);
      if (!children.length) return [];
      return url ? [{ type: "link", url, children }] : children;
    }
    const leaf = sanitizeLeaf(node);
    return leaf ? [leaf] : [];
  });
}

const hasText = (inlines: RichTextInline[]) => plainInline(inlines).trim().length > 0;

export function sanitizeRichText(value: unknown): RichText | null {
  const root = value as Raw;
  if (root?.type !== "root" || !Array.isArray(root.children)) return null;
  const children = list(root.children).slice(0, MAX_BLOCKS).flatMap((block): RichTextBlock[] => {
    if (block?.type === "list") {
      const items = list(block.children).slice(0, MAX_BLOCKS)
        .map((item) => ({ type: "list-item" as const, children: sanitizeInlines(item?.children) }))
        .filter((item) => hasText(item.children));
      return items.length ? [{ type: "list", listType: block.listType === "ordered" ? "ordered" : "unordered", children: items }] : [];
    }
    if (block?.type === "image") {
      const src = safeImageUrl(block.src);
      return src ? [{ type: "image", src, alt: String(block.alt || "").slice(0, 200) }] : [];
    }
    if (block?.type === "table") {
      const rows = list(block.rows).slice(0, MAX_ROWS).map((row) => ({
        ...(row?.header ? { header: true } : {}),
        cells: list(row?.cells as unknown).slice(0, MAX_COLUMNS).map((cell) => sanitizeInlines(cell)),
      })).filter((row) => row.cells.some(hasText));
      return rows.length ? [{ type: "table", rows }] : [];
    }
    const inlines = sanitizeInlines(block?.children);
    if (!hasText(inlines)) return [];
    if (block?.type === "heading") {
      const level = Math.min(6, Math.max(1, Math.round(Number(block.level) || 2)));
      return [{ type: "heading", level, children: inlines }];
    }
    return [{ type: "paragraph", children: inlines }];
  });
  return { type: "root", children };
}

// Notices saved before rich text only had a plain message; each line became a paragraph.
export function richTextFromPlain(text: string): RichText {
  return {
    type: "root",
    children: String(text || "").split("\n").filter((line) => line.trim())
      .map((line) => ({ type: "paragraph", children: [{ type: "text", value: line }] })),
  };
}

function plainInline(inlines: RichTextInline[]): string {
  return inlines.map((node) => node.type === "link" ? node.children.map((leaf) => leaf.value).join("") : node.value).join("");
}

export function plainTextFromRichText(root: RichText): string {
  return root.children.map((block) => {
    if (block.type === "list") return block.children.map((item) => plainInline(item.children)).join("\n");
    if (block.type === "image") return "";
    if (block.type === "table") return block.rows.map((row) => row.cells.map(plainInline).join(" | ")).join("\n");
    return plainInline(block.children);
  }).filter(Boolean).join("\n");
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function leafHtml(leaf: RichTextLeaf) {
  let html = escapeHtml(leaf.value);
  if (leaf.italic) html = `<em>${html}</em>`;
  if (leaf.bold) html = `<strong>${html}</strong>`;
  return html;
}

function inlineHtml(inlines: RichTextInline[]) {
  return inlines.map((node) => node.type === "link"
    ? `<a href="${escapeHtml(node.url)}">${node.children.map(leafHtml).join("")}</a>`
    : leafHtml(node)).join("");
}

// HTML for notices saved before the HTML editor existed.
export function richTextToHtml(root: RichText): string {
  return root.children.map((block) => {
    if (block.type === "paragraph") return `<p>${inlineHtml(block.children)}</p>`;
    if (block.type === "heading") return `<h${block.level}>${inlineHtml(block.children)}</h${block.level}>`;
    if (block.type === "image") return `<p><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}"></p>`;
    if (block.type === "table") {
      return `<table><tbody>${block.rows.map((row) => `<tr>${row.cells.map((cell) => {
        const tag = row.header ? "th" : "td";
        return `<${tag}>${inlineHtml(cell)}</${tag}>`;
      }).join("")}</tr>`).join("")}</tbody></table>`;
    }
    const tag = block.listType === "ordered" ? "ol" : "ul";
    return `<${tag}>${block.children.map((item) => `<li>${inlineHtml(item.children)}</li>`).join("")}</${tag}>`;
  }).join("");
}

// Defence in depth for the stored editor HTML. It is only ever loaded back into
// TinyMCE (which filters it again) and never rendered raw, in admin or checkout.
export function sanitizeEditorHtml(value: unknown): string {
  return String(value || "")
    .slice(0, MAX_HTML)
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|vbscript|data):[^"']*\2/gi, "$1=$2#$2");
}

const BLOCK_TAGS = new Set(["DIV", "P", "BLOCKQUOTE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "PRE", "FIGURE", "FIGCAPTION", "LI", "ADDRESS"]);
type Marks = { bold?: boolean; italic?: boolean; url?: string };

// Converts the editor's HTML (a DOM element holding it) into the rich-text tree
// checkout renders. Runs in the browser, where the DOM is available.
export function richTextFromElement(element: HTMLElement): RichText {
  const blocks: RichTextBlock[] = [];
  let current: RichTextInline[] = [];

  const pushText = (target: RichTextInline[], value: string, marks: Marks) => {
    if (!value) return;
    const leaf: RichTextLeaf = { type: "text", value, ...(marks.bold ? { bold: true } : {}), ...(marks.italic ? { italic: true } : {}) };
    const last = target[target.length - 1];
    if (marks.url) {
      if (last?.type === "link" && last.url === marks.url) last.children.push(leaf);
      else target.push({ type: "link", url: marks.url, children: [leaf] });
    } else if (last?.type === "text" && !last.bold === !leaf.bold && !last.italic === !leaf.italic) last.value += value;
    else target.push(leaf);
  };
  const trimmed = (inlines: RichTextInline[]) => {
    const first = inlines[0];
    const last = inlines[inlines.length - 1];
    if (first?.type === "text") first.value = first.value.replace(/^\s+/, "");
    if (last?.type === "text") last.value = last.value.replace(/\s+$/, "");
    return inlines.filter((node) => node.type !== "text" || node.value);
  };
  const flush = () => {
    if (hasText(current)) blocks.push({ type: "paragraph", children: trimmed(current) });
    current = [];
  };
  const marksFor = (node: HTMLElement, marks: Marks): Marks => {
    const tag = node.tagName;
    const weight = node.style?.fontWeight;
    const next = { ...marks };
    if (tag === "B" || tag === "STRONG" || tag === "TH" || weight === "bold" || Number(weight) >= 600) next.bold = true;
    if (tag === "I" || tag === "EM" || node.style?.fontStyle === "italic") next.italic = true;
    if (tag === "A") next.url = safeUrl(node.getAttribute("href")) || undefined;
    return next;
  };
  const walkInline = (node: Node, marks: Marks, target: RichTextInline[]) => {
    if (node.nodeType === 3) return pushText(target, (node.textContent || "").replace(/\s+/g, " "), marks);
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    if (el.tagName === "BR") return pushText(target, " ", marks);
    const next = marksFor(el, marks);
    el.childNodes.forEach((child) => walkInline(child, next, target));
  };
  const inlinesOf = (el: Element, marks: Marks) => {
    const children: RichTextInline[] = [];
    walkInline(el, marks, children);
    return trimmed(children);
  };
  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === 3) return pushText(current, (node.textContent || "").replace(/\s+/g, " "), marks);
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "IFRAME" || tag === "VIDEO") return;
    if (tag === "BR") return flush();
    if (tag === "IMG") {
      flush();
      const src = safeImageUrl(el.getAttribute("src"));
      if (src) blocks.push({ type: "image", src, alt: el.getAttribute("alt") || "" });
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      flush();
      const children = inlinesOf(el, marks);
      if (hasText(children)) blocks.push({ type: "heading", level: Number(tag[1]), children });
      return;
    }
    if (tag === "UL" || tag === "OL") {
      flush();
      const items: { type: "list-item"; children: RichTextInline[] }[] = [];
      el.querySelectorAll(":scope > li").forEach((li) => items.push({ type: "list-item", children: inlinesOf(li, marks) }));
      blocks.push({ type: "list", listType: tag === "OL" ? "ordered" : "unordered", children: items });
      return;
    }
    if (tag === "TABLE") {
      flush();
      const rows = [...el.querySelectorAll("tr")].filter((row) => row.closest("table") === el).map((row) => {
        const cells = [...row.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH");
        return {
          ...(cells.length && cells.every((cell) => cell.tagName === "TH") ? { header: true } : {}),
          cells: cells.map((cell) => inlinesOf(cell, marks)),
        };
      });
      blocks.push({ type: "table", rows });
      return;
    }
    const next = marksFor(el, marks);
    if (BLOCK_TAGS.has(tag)) {
      flush();
      el.childNodes.forEach((child) => walk(child, next));
      flush();
      return;
    }
    el.childNodes.forEach((child) => walk(child, next));
  };

  element.childNodes.forEach((child) => walk(child, {}));
  flush();
  return sanitizeRichText({ type: "root", children: blocks }) ?? emptyRichText();
}

export function richTextFromHtml(html: string): RichText {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return richTextFromElement(doc.body);
}
