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
  const entry = shopify.appMetafields.value.find(({target, metafield}) =>
    target.type === 'shop' && metafield.namespace === NAMESPACE && metafield.key === KEY);
  const notices = parseNotices(entry?.metafield.value).filter((notice) =>
    notice.enabled &&
    notice.placement === placement &&
    notice.message.trim() &&
    country &&
    notice.countries.includes(country));
  if (!notices.length) return null;

  return (
    <s-stack gap="base">
      {notices.map((notice) => (
        <s-banner
          key={notice.id}
          tone={TONES.has(notice.tone) ? notice.tone : 'info'}
          heading={notice.heading.trim() || undefined}
          dismissible={notice.dismissible}
        >
          <s-stack gap="small-200">
            {notice.message.split('\n').filter((line) => line.trim()).map((line, index) => (
              <s-text key={index}>{line}</s-text>
            ))}
          </s-stack>
        </s-banner>
      ))}
    </s-stack>
  );
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
      dismissible: Boolean(notice?.dismissible),
    }));
  } catch {
    return [];
  }
}
