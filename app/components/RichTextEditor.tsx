import { useEffect, useRef, useState } from "react";
import {
  type RichText,
  type RichTextInline,
  type RichTextLeaf,
  plainTextFromRichText,
  richTextFromElement,
  richTextToHtml,
  safeUrl,
} from "../services/rich-text";

type Props = {
  label: string;
  value: RichText;
  onChange: (value: RichText) => void;
  details?: string;
  maxLength?: number;
  placeholder?: string;
};

const STYLES = `
.rte { border: 1px solid #8a8a8a; border-radius: 8px; background: #fff; overflow: hidden; }
.rte:focus-within { outline: 2px solid #005bd3; outline-offset: 1px; }
.rte-toolbar { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px; border-bottom: 1px solid #e3e3e3; background: #f7f7f7; }
.rte-toolbar button { min-width: 30px; height: 28px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: #303030; font: inherit; font-size: 13px; cursor: pointer; }
.rte-toolbar button:hover { background: #e3e3e3; }
.rte-toolbar button[aria-pressed="true"] { background: #d4d4d4; }
.rte-sep { width: 1px; margin: 4px 4px; background: #d4d4d4; }
.rte-area { min-height: 84px; max-height: 320px; overflow-y: auto; padding: 8px 12px; font-size: 13px; line-height: 1.5; outline: none; }
.rte-area:empty::before { content: attr(data-placeholder); color: #8a8a8a; }
.rte-area ul, .rte-area ol { margin: 4px 0; padding-left: 22px; }
.rte-area a { color: #005bd3; text-decoration: underline; }
.rte-link { display: flex; gap: 6px; align-items: center; padding: 6px; border-top: 1px solid #e3e3e3; background: #f7f7f7; }
.rte-link input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid #8a8a8a; border-radius: 6px; font: inherit; font-size: 13px; }
.rte-link button { height: 28px; padding: 0 10px; border: 1px solid #c9c9c9; border-radius: 6px; background: #fff; font: inherit; font-size: 13px; cursor: pointer; }
.rte-link button.primary { background: #303030; border-color: #303030; color: #fff; }
.rte-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 4px; font-size: 12px; color: #616161; }
.rte-meta .over { color: #8e1f0b; }
.rte-label { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 450; color: #303030; }
`;

function PreviewInlines({ nodes }: { nodes: RichTextInline[] }) {
  const leaf = (node: RichTextLeaf, key: number) => {
    let content: React.ReactNode = node.value;
    if (node.italic) content = <i>{content}</i>;
    if (node.bold) content = <b>{content}</b>;
    return <span key={key}>{content}</span>;
  };
  return <>{nodes.map((node, index) => node.type === "link"
    ? <a key={index} href={node.url} target="_blank" rel="noreferrer">{node.children.map(leaf)}</a>
    : leaf(node, index))}</>;
}

// Admin approximation of how checkout renders the message.
export function RichTextPreview({ value }: { value: RichText }) {
  return (
    <s-stack gap="small-200">
      {value.children.map((block, index) => {
        if (block.type === "paragraph") return <s-paragraph key={index}><PreviewInlines nodes={block.children} /></s-paragraph>;
        const items = block.children.map((item, itemIndex) => <li key={itemIndex}><PreviewInlines nodes={item.children} /></li>);
        return block.listType === "ordered"
          ? <ol key={index} style={{ margin: 0, paddingLeft: 20 }}>{items}</ol>
          : <ul key={index} style={{ margin: 0, paddingLeft: 20 }}>{items}</ul>;
      })}
    </s-stack>
  );
}

// Minimal rich-text field for checkout notices: bold, italic, links and lists,
// which are exactly what the checkout extension can render.
export function RichTextEditor({ label, value, onChange, details, maxLength, placeholder }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<Range | null>(null);
  const [active, setActive] = useState({ bold: false, italic: false });
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const length = plainTextFromRichText(value).length;

  // The parent remounts the editor (via key) when a different notice is edited,
  // so the initial value only needs to be written once.
  useEffect(() => {
    if (areaRef.current) areaRef.current.innerHTML = richTextToHtml(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = document.getSelection();
      const area = areaRef.current;
      if (!selection?.rangeCount || !area || !area.contains(selection.anchorNode)) return;
      rangeRef.current = selection.getRangeAt(0).cloneRange();
      setActive({ bold: document.queryCommandState("bold"), italic: document.queryCommandState("italic") });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const emit = () => {
    if (areaRef.current) onChange(richTextFromElement(areaRef.current));
  };
  const restoreSelection = () => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    const range = rangeRef.current;
    const selection = document.getSelection();
    if (range && selection && area.contains(range.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };
  const run = (command: string, argument?: string) => {
    restoreSelection();
    document.execCommand(command, false, argument);
    emit();
  };
  const openLink = () => {
    const anchor = (rangeRef.current?.commonAncestorContainer as HTMLElement | undefined);
    const existing = (anchor?.nodeType === 1 ? anchor : anchor?.parentElement)?.closest?.("a");
    setLinkUrl(existing?.getAttribute("href") || "https://");
    setLinkOpen(true);
  };
  const applyLink = () => {
    const url = safeUrl(linkUrl);
    setLinkOpen(false);
    if (!url) return;
    restoreSelection();
    const selection = document.getSelection();
    if (selection?.isCollapsed) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.textContent = url;
      document.execCommand("insertHTML", false, anchor.outerHTML);
    } else document.execCommand("createLink", false, url);
    emit();
  };
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    const container = document.createElement("div");
    if (html) container.append(...new DOMParser().parseFromString(html, "text/html").body.childNodes);
    else text.split(/\r?\n/).forEach((line) => {
      const row = document.createElement("div");
      row.textContent = line;
      container.append(row);
    });
    document.execCommand("insertHTML", false, richTextToHtml(richTextFromElement(container)));
    emit();
  };
  const keep = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div>
      <style>{STYLES}</style>
      <span className="rte-label">{label}</span>
      <div className="rte">
        <div className="rte-toolbar" role="toolbar" aria-label={`${label} formatting`}>
          <button type="button" title="Bold" aria-pressed={active.bold} onMouseDown={keep} onClick={() => run("bold")}><b>B</b></button>
          <button type="button" title="Italic" aria-pressed={active.italic} onMouseDown={keep} onClick={() => run("italic")}><i>I</i></button>
          <span className="rte-sep" />
          <button type="button" title="Bulleted list" onMouseDown={keep} onClick={() => run("insertUnorderedList")}>• List</button>
          <button type="button" title="Numbered list" onMouseDown={keep} onClick={() => run("insertOrderedList")}>1. List</button>
          <span className="rte-sep" />
          <button type="button" title="Add link" onMouseDown={keep} onClick={openLink}>Link</button>
          <button type="button" title="Remove link" onMouseDown={keep} onClick={() => run("unlink")}>Unlink</button>
          <button type="button" title="Clear formatting" onMouseDown={keep} onClick={() => { run("removeFormat"); run("unlink"); }}>Clear</button>
        </div>
        <div
          ref={areaRef}
          className="rte-area"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          data-placeholder={placeholder || ""}
          onInput={emit}
          onPaste={onPaste}
        />
        {linkOpen && (
          <div className="rte-link">
            <input
              type="url"
              value={linkUrl}
              ref={(input) => input?.focus()}
              aria-label="Link URL"
              placeholder="https://example.com"
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); applyLink(); }
                if (event.key === "Escape") setLinkOpen(false);
              }}
            />
            <button type="button" className="primary" onClick={applyLink}>Apply</button>
            <button type="button" onClick={() => setLinkOpen(false)}>Cancel</button>
          </div>
        )}
      </div>
      <div className="rte-meta">
        <span>{details}</span>
        {maxLength ? <span className={length > maxLength ? "over" : undefined}>{length}/{maxLength}</span> : null}
      </div>
    </div>
  );
}
