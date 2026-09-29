import { useEffect, useState } from "react";
import { Editor } from "@tinymce/tinymce-react";
import type { RichText, RichTextInline, RichTextLeaf } from "../services/rich-text";

type Props = {
  label: string;
  // Editor HTML. The parent remounts the editor (via key) to load another value.
  initialHtml: string;
  onChange: (html: string) => void;
  details?: string;
  counter?: string;
  counterOver?: boolean;
  placeholder?: string;
};

const CONTENT_STYLE = `
body { font-family: -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif; font-size: 14px; line-height: 1.5; color: #303030; margin: 12px 14px; }
p { margin: 0 0 12px; }
a { color: #005bd3; }
ul, ol { padding-left: 24px; }
table { border-collapse: collapse; }
td, th { border: 1px solid #d4d4d4; padding: 4px 8px; }
img { max-width: 100%; height: auto; }
`;

// Shopify-style HTML editor (the same toolbar merchants know from product
// descriptions), with a source view for editing the HTML directly.
export function RichTextEditor({ label, initialHtml, onChange, details, counter, counterOver, placeholder }: Props) {
  const [ready, setReady] = useState(false);

  // TinyMCE needs the browser, so it is only loaded on the client.
  useEffect(() => {
    let cancelled = false;
    import("./tinymce.client").then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  return (
    <s-stack gap="small-200">
      <s-text>{label}</s-text>
      {ready ? (
        <Editor
          licenseKey="gpl"
          initialValue={initialHtml}
          // Skip the normalisation TinyMCE does on load, so opening a block does
          // not mark it as changed.
          onEditorChange={(html, editor) => { if (editor.isDirty()) onChange(html); }}
          init={{
            height: 340,
            menubar: false,
            branding: false,
            promotion: false,
            statusbar: true,
            elementpath: false,
            resize: true,
            placeholder,
            plugins: "autolink code image link lists media table",
            toolbar: "blocks | bold italic underline forecolor | align | link image media table | bullist numlist | removeformat | code",
            toolbar_mode: "sliding",
            block_formats: "Paragraph=p; Heading 1=h1; Heading 2=h2; Heading 3=h3; Heading 4=h4; Heading 5=h5; Heading 6=h6; Blockquote=blockquote",
            link_default_target: "_blank",
            link_title: false,
            image_uploadtab: false,
            image_description: true,
            paste_data_images: false,
            convert_urls: false,
            content_style: CONTENT_STYLE,
          }}
        />
      ) : (
        <s-box padding="base" border="base" borderRadius="base" minBlockSize="340px">
          <s-spinner accessibilityLabel="Loading editor" size="base" />
        </s-box>
      )}
      <s-grid gridTemplateColumns="1fr auto" gap="base">
        <s-text color="subdued">{details}</s-text>
        {counter ? <s-text tone={counterOver ? "critical" : undefined} color={counterOver ? undefined : "subdued"}>{counter}</s-text> : <span />}
      </s-grid>
    </s-stack>
  );
}

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

// Admin approximation of how checkout renders the message: only what checkout
// components support (headings, bold, italic, links, lists, images, tables).
export function RichTextPreview({ value }: { value: RichText }) {
  return (
    <s-stack gap="small-200">
      {value.children.map((block, index) => {
        if (block.type === "paragraph") return <s-paragraph key={index}><PreviewInlines nodes={block.children} /></s-paragraph>;
        if (block.type === "heading") return <s-heading key={index}><PreviewInlines nodes={block.children} /></s-heading>;
        if (block.type === "image") return <img key={index} src={block.src} alt={block.alt} style={{ maxWidth: "100%", height: "auto" }} />;
        if (block.type === "table") {
          return (
            <table key={index} style={{ borderCollapse: "collapse" }}>
              <tbody>{block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.cells.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ padding: "2px 12px 2px 0", fontWeight: row.header ? 650 : undefined }}><PreviewInlines nodes={cell} /></td>
                ))}</tr>
              ))}</tbody>
            </table>
          );
        }
        const items = block.children.map((item, itemIndex) => <li key={itemIndex}><PreviewInlines nodes={item.children} /></li>);
        return block.listType === "ordered"
          ? <ol key={index} style={{ margin: 0, paddingLeft: 20 }}>{items}</ol>
          : <ul key={index} style={{ margin: 0, paddingLeft: 20 }}>{items}</ul>;
      })}
    </s-stack>
  );
}
