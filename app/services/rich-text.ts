// Checkout notices store their message as a small rich-text tree instead of
// HTML, because checkout UI extensions cannot render HTML. The checkout-notice
// extension renders this same shape (see renderRichText in its Checkout.jsx).
export type RichTextLeaf = { type: "text"; value: string; bold?: boolean; italic?: boolean };
export type RichTextInline = RichTextLeaf | { type: "link"; url: string; children: RichTextLeaf[] };
export type RichTextBlock =
  | { type: "paragraph"; children: RichTextInline[] }
  | { type: "list"; listType: "ordered" | "unordered"; children: { type: "list-item"; children: RichTextInline[] }[] };
export type RichText = { type: "root"; children: RichTextBlock[] };

const MAX_BLOCKS = 50;
const MAX_INLINES = 100;
const MAX_TEXT = 2000;

export function emptyRichText(): RichText {
  return { type: "root", children: [] };
}

export function safeUrl(value: unknown) {
  const url = String(value || "").trim().slice(0, 500);
  return /^(https?:\/\/|mailto:|tel:|\/)/i.test(url) ? url : "";
}

type Raw = { [key: string]: unknown } | null | undefined;

function sanitizeLeaf(node: Raw): RichTextLeaf | null {
  const value = String(node?.value ?? "").slice(0, MAX_TEXT);
  if (!value) return null;
  return { type: "text", value, ...(node?.bold ? { bold: true } : {}), ...(node?.italic ? { italic: true } : {}) };
}

function sanitizeInlines(nodes: unknown): RichTextInline[] {
  if (!Array.isArray(nodes)) return [];
  return (nodes as Raw[]).slice(0, MAX_INLINES).flatMap((node): RichTextInline[] => {
    if (node?.type === "link") {
      const children = (Array.isArray(node.children) ? node.children as Raw[] : []).slice(0, MAX_INLINES).map(sanitizeLeaf).filter(Boolean) as RichTextLeaf[];
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
  const children = (root.children as Raw[]).slice(0, MAX_BLOCKS).flatMap((block): RichTextBlock[] => {
    if (block?.type === "list") {
      const items = (Array.isArray(block.children) ? block.children as Raw[] : []).slice(0, MAX_BLOCKS)
        .map((item) => ({ type: "list-item" as const, children: sanitizeInlines(item?.children) }))
        .filter((item) => hasText(item.children));
      return items.length ? [{ type: "list", listType: block.listType === "ordered" ? "ordered" : "unordered", children: items }] : [];
    }
    const inlines = sanitizeInlines(block?.children);
    return hasText(inlines) ? [{ type: "paragraph", children: inlines }] : [];
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
  return root.children.map((block) => block.type === "list"
    ? block.children.map((item) => plainInline(item.children)).join("\n")
    : plainInline(block.children)).join("\n");
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function leafHtml(leaf: RichTextLeaf) {
  let html = escapeHtml(leaf.value);
  if (leaf.italic) html = `<i>${html}</i>`;
  if (leaf.bold) html = `<b>${html}</b>`;
  return html;
}

function inlineHtml(inlines: RichTextInline[]) {
  return inlines.map((node) => node.type === "link"
    ? `<a href="${escapeHtml(node.url)}">${node.children.map(leafHtml).join("")}</a>`
    : leafHtml(node)).join("");
}

// Seeds the admin editor's contenteditable area.
export function richTextToHtml(root: RichText): string {
  return root.children.map((block) => {
    if (block.type === "paragraph") return `<div>${inlineHtml(block.children)}</div>`;
    const tag = block.listType === "ordered" ? "ol" : "ul";
    return `<${tag}>${block.children.map((item) => `<li>${inlineHtml(item.children)}</li>`).join("")}</${tag}>`;
  }).join("");
}

const BLOCK_TAGS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "PRE", "TABLE", "TR"]);
type Marks = { bold?: boolean; italic?: boolean; url?: string };

// Reads the admin editor's DOM (typed, formatted or pasted content) back into
// the rich-text tree. Anything other than bold, italic, links, lists and line
// breaks is reduced to plain text.
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
  const flush = () => {
    if (hasText(current)) blocks.push({ type: "paragraph", children: current });
    current = [];
  };
  const marksFor = (node: HTMLElement, marks: Marks): Marks => {
    const tag = node.tagName;
    const weight = node.style?.fontWeight;
    const next = { ...marks };
    if (tag === "B" || tag === "STRONG" || /^H[1-6]$/.test(tag) || weight === "bold" || Number(weight) >= 600) next.bold = true;
    if (tag === "I" || tag === "EM" || node.style?.fontStyle === "italic") next.italic = true;
    if (tag === "A") next.url = safeUrl(node.getAttribute("href")) || undefined;
    return next;
  };
  const walkInline = (node: Node, marks: Marks, target: RichTextInline[]) => {
    if (node.nodeType === 3) return pushText(target, (node.textContent || "").replace(/\s+/g, " "), marks);
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") return pushText(target, " ", marks);
    const next = marksFor(el, marks);
    el.childNodes.forEach((child) => walkInline(child, next, target));
  };
  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === 3) return pushText(current, (node.textContent || "").replace(/\s+/g, " "), marks);
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") return;
    if (tag === "BR") return flush();
    if (tag === "UL" || tag === "OL") {
      flush();
      const items: { type: "list-item"; children: RichTextInline[] }[] = [];
      el.querySelectorAll(":scope > li").forEach((li) => {
        const children: RichTextInline[] = [];
        walkInline(li, marksFor(el, marks), children);
        items.push({ type: "list-item", children });
      });
      blocks.push({ type: "list", listType: tag === "OL" ? "ordered" : "unordered", children: items });
      return;
    }
    const next = marksFor(el, marks);
    if (BLOCK_TAGS.has(tag) || tag === "LI") {
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
