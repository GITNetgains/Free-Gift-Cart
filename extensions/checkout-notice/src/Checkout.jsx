import '@shopify/ui-extensions/preact';
import {render} from 'preact';

// Notices are managed on the app's "Checkout notices" admin page and saved to
// this shop metafield. Each notice picks one of the placements below.
const NAMESPACE = 'free_gift_cart';
const KEY = 'checkout_notices';
const PLACEMENT_BY_TARGET = {
  'purchase.checkout.delivery-address.render-before': 'delivery',
  'purchase.checkout.shipping-option-list.render-before': 'shipping',
  'purchase.checkout.payment-method-list.render-before': 'payment',
  'purchase.checkout.block.render': 'block',
};
const TONES = new Set(['info', 'success', 'warning', 'critical']);

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const placement = PLACEMENT_BY_TARGET[shopify.extension.target];
  // The checkout country follows the shipping address, so a notice limited to
  // Canada appears as soon as the buyer picks Canada and hides for the US.
  const country = shopify.localization.country.value?.isoCode;
  // The province needs protected customer data access; without it a notice
  // limited to certain states stays hidden rather than showing everywhere.
  const province = shopify.shippingAddress?.value?.provinceCode?.toUpperCase();
  const entry = shopify.appMetafields.value.find(({target, metafield}) =>
    target.type === 'shop' && metafield.namespace === NAMESPACE && metafield.key === KEY);
  const notices = parseNotices(entry?.metafield.value).filter((notice) =>
    notice.enabled &&
    notice.placement === placement &&
    notice.message.trim() &&
    country &&
    notice.countries.includes(country) &&
    (!notice.states[country] || (province && notice.states[country].includes(province))));
  if (!notices.length) return null;

  return (
    <s-stack gap="base">
      {notices.map((notice) => (
        <s-banner
          key={notice.id}
          tone={TONES.has(notice.tone) ? notice.tone : 'info'}
          heading={notice.heading.trim() || undefined}
        >
          <s-stack gap="small-200">
            {notice.richMessage
              ? renderRichText(notice.richMessage)
              : notice.message.split('\n').filter((line) => line.trim()).map((line, index) => (
                <s-text key={index}>{line}</s-text>
              ))}
          </s-stack>
        </s-banner>
      ))}
    </s-stack>
  );
}

// The admin page saves the message as a rich-text tree (see
// app/services/rich-text.ts): paragraphs, headings, lists and tables of text
// and link nodes (text can be bold and/or italic), plus images.
function renderRichText(root) {
  return root.children.map((block, index) => {
    if (block?.type === 'heading') {
      return <s-heading key={index}>{renderInlines(block.children)}</s-heading>;
    }
    if (block?.type === 'image') {
      const src = String(block.src || '');
      return /^https:\/\//i.test(src)
        ? <s-image key={index} src={src} alt={String(block.alt || '')} inlineSize="auto" />
        : null;
    }
    if (block?.type === 'table') {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const columns = Math.max(1, ...rows.map((row) => (row?.cells || []).length));
      return (
        <s-grid key={index} gridTemplateColumns={`repeat(${columns}, auto)`} columnGap="base" rowGap="small-300">
          {rows.flatMap((row, rowIndex) => Array.from({length: columns}, (_, cellIndex) => (
            <s-text key={`${rowIndex}-${cellIndex}`} type={row?.header ? 'strong' : undefined}>
              {renderInlines(row?.cells?.[cellIndex])}
            </s-text>
          )))}
        </s-grid>
      );
    }
    if (block?.type === 'list') {
      const items = (block.children || []).map((item, itemIndex) => (
        <s-list-item key={itemIndex}>{renderInlines(item?.children)}</s-list-item>
      ));
      return block.listType === 'ordered'
        ? <s-ordered-list key={index}>{items}</s-ordered-list>
        : <s-unordered-list key={index}>{items}</s-unordered-list>;
    }
    return <s-paragraph key={index}>{renderInlines(block?.children)}</s-paragraph>;
  });
}

function renderInlines(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    if (node?.type === 'link') {
      const url = String(node.url || '');
      const children = (node.children || []).map(renderLeaf);
      return /^(https?:\/\/|mailto:|tel:|\/)/i.test(url)
        ? <s-link key={index} href={url} target={/^https?:/i.test(url) ? '_blank' : 'auto'}>{children}</s-link>
        : children;
    }
    return renderLeaf(node, index);
  });
}

function renderLeaf(node, index) {
  let content = String(node?.value || '');
  if (node?.italic) content = <s-text type="emphasis">{content}</s-text>;
  if (node?.bold) content = <s-text type="strong">{content}</s-text>;
  return <s-text key={index}>{content}</s-text>;
}

function parseStates(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, codes]) => Array.isArray(codes))
    .map(([country, codes]) => [country, codes.map((code) => String(code).toUpperCase())]));
}

function parseNotices(value) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    const notices = Array.isArray(data?.notices) ? data.notices : [];
    return notices.map((notice) => ({
      id: String(notice?.id || ''),
      enabled: notice?.enabled !== false,
      heading: String(notice?.heading || ''),
      message: String(notice?.message || ''),
      tone: String(notice?.tone || 'info'),
      placement: String(notice?.placement || 'delivery'),
      countries: Array.isArray(notice?.countries) ? notice.countries.map(String) : [],
      states: parseStates(notice?.states),
      richMessage: notice?.richMessage?.type === 'root' && Array.isArray(notice.richMessage.children)
        ? notice.richMessage
        : null,
    }));
  } catch {
    return [];
  }
}
