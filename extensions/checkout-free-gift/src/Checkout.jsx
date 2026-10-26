import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

// Checkout side of the free gift offer. It reads the same shop settings as the
// cart popup (see app/routes/app.free-gift.tsx) and adds the gift with the
// same `_free_gift` line attribute, so the free-gift-discount function makes
// it free. Buyers who cross the minimum in checkout, for example by adding a
// recommended product, can still claim their gift here.
const NAMESPACE = 'free_gift_cart';
const KEY = 'settings';
const GIFT_ATTRIBUTE = '_free_gift';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const entry = shopify.appMetafields.value.find(({target, metafield}) =>
    target.type === 'shop' && metafield.namespace === NAMESPACE && metafield.key === KEY);
  const rawSettings = entry?.metafield.value;
  const settings = parseSettings(rawSettings);
  const lines = shopify.lines.value;
  const country = shopify.localization.country.value?.isoCode;
  const currency = shopify.cost.totalAmount.value?.currencyCode;
  const canAdd = shopify.instructions.value?.lines?.canAddCartLine !== false;
  const canRemove = shopify.instructions.value?.lines?.canRemoveCartLine !== false;

  // Live stock, images and buyer-currency rate; null until loaded.
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState({});
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [removedNotice, setRemovedNotice] = useState(false);
  // The gift list starts folded; the banner row opens it.
  const [open, setOpen] = useState(false);
  // The one gift whose variant picker is showing.
  const [openGiftId, setOpenGiftId] = useState('');

  useEffect(() => {
    if (!settings.enabled || !settings.products.length) return undefined;
    let cancelled = false;
    loadCatalog(settings, country, currency)
      .then((result) => { if (!cancelled) setCatalog(result); })
      .catch(() => { if (!cancelled) setCatalog({rate: 1, products: []}); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSettings, country, currency]);

  const allowedVariantIds = new Set(settings.products.map((product) => product.variantId));
  const giftLines = lines.filter((line) => isGiftLine(line) && allowedVariantIds.has(line.merchandise?.id));
  // Same subtotal as the discount function: paid lines before discounts.
  const paidSubtotal = lines
    .filter((line) => !isGiftLine(line))
    .reduce((total, line) => total + lineSubtotal(line), 0);
  const threshold = catalog ? (settings.minimumSpend / 100) * catalog.rate : null;
  const eligible = threshold !== null && paidSubtotal >= threshold;

  // Below the minimum the gift would be charged at full price, so take it
  // out, as the cart popup does.
  const giftKey = giftLines.map((line) => line.id).join(',');
  useEffect(() => {
    if (threshold === null || eligible || !giftLines.length || !canRemove || busyId) return;
    setBusyId('remove');
    Promise.all(giftLines.map((line) => shopify.applyCartLinesChange({
      type: 'removeCartLine', id: line.id, quantity: line.quantity,
    })))
      .then(() => setRemovedNotice(true))
      .catch(() => {})
      .finally(() => setBusyId(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [giftKey, eligible, threshold]);

  if (!settings.enabled || !catalog || !catalog.products.length || threshold === null) return null;

  // Once the gift is in the cart the block has done its job, so it hides.
  // It still removes the gift above if the order drops under the minimum.
  if (giftLines.length) return null;

  if (!eligible) {
    const remaining = threshold - paidSubtotal;
    // Name the gift so buyers know what they're working towards.
    const titles = catalog.products.map((product) => product.title);
    const progress = String(titles.length === 1
      ? shopify.i18n.translate('progressOne', {amount: formatMoney(remaining, currency), title: titles[0]})
      : shopify.i18n.translate('progress', {amount: formatMoney(remaining, currency)}));
    return (
      <Card>
        {removedNotice && (
          <s-banner tone="warning">
            {shopify.i18n.translate('removed', {amount: formatMoney(threshold, currency)})}
          </s-banner>
        )}
        <s-stack gap="small-200">
          <s-grid gridTemplateColumns="auto 1fr" columnGap="small-200" alignItems="center">
            <s-icon type="gift-card" />
            <s-text type="strong">{progress}</s-text>
          </s-grid>
          <s-progress value={Math.max(0, paidSubtotal)} max={threshold} accessibilityLabel={progress} />
        </s-stack>
        <s-divider />
        {/* The gifts on offer, by name only. */}
        <s-stack gap="small-200">
          <s-text type="small" color="subdued">{shopify.i18n.translate('chooseLabel')}</s-text>
          {catalog.products.map((product, index) => (
            <s-stack key={product.id} gap="small-200">
              {index > 0 && <s-text type="strong">{shopify.i18n.translate('or')}</s-text>}
              <s-grid gridTemplateColumns="1fr auto" columnGap="base" alignItems="center">
                <s-text>{product.title}</s-text>
                <s-badge size="small" tone="critical">{shopify.i18n.translate('free')}</s-badge>
              </s-grid>
            </s-stack>
          ))}
        </s-stack>
      </Card>
    );
  }

  if (!canAdd) return null;

  const variantOf = (product) =>
    product.variants.find((variant) => variant.id === selected[product.id]) || product.variants[0];
  const claim = async (product) => {
    setBusyId(product.id);
    setError('');
    try {
      const result = await shopify.applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: variantOf(product).id,
        quantity: 1,
        attributes: [{key: GIFT_ATTRIBUTE, value: 'true'}],
      });
      if (result.type === 'error') setError(String(shopify.i18n.translate('cartError')));
      else setRemovedNotice(false);
    } catch {
      setError(String(shopify.i18n.translate('cartError')));
    } finally {
      setBusyId('');
    }
  };

  // Checkout can't open a popup on its own. The unlocked offer uses the same
  // warning banner as the checkout notices, with a row that opens the gifts.
  // Inside a banner every box takes the banner colour, so the gift list sits
  // just below it on white.
  return (
    <s-stack gap="small-200">
      <s-banner tone="warning" heading={String(shopify.i18n.translate('unlocked'))}>
        <s-clickable onClick={() => setOpen((current) => !current)}
          accessibilityLabel={String(shopify.i18n.translate(open ? 'hideGifts' : 'showGifts'))}>
          <s-grid gridTemplateColumns="1fr auto" columnGap="small-200" alignItems="center">
            <s-text>{shopify.i18n.translate(open ? 'chooseOne' : 'tapToChoose')}</s-text>
            <s-icon type={open ? 'chevron-up' : 'chevron-down'} size="small" />
          </s-grid>
        </s-clickable>
      </s-banner>
        {open && (
          <s-box background="base" border="base" borderRadius="large" padding="base">
          <s-stack gap="base">
            {catalog.products.map((product, index) => {
              const variant = variantOf(product);
              const busy = busyId === product.id;
              const hasVariants = product.variants.length > 1;
              const showVariants = hasVariants && openGiftId === product.id;
              const details = (
                <s-grid gridTemplateColumns="auto 1fr" columnGap="small-200" alignItems="center">
                    <s-product-thumbnail size="small" src={variant.image || product.image} alt={product.title} />
                    <s-stack gap="small-500">
                      <s-text>{product.title}</s-text>
                      <s-stack direction="inline" gap="small-300" alignItems="center">
                        {/* Gift variants are often $0 products, so only strike a real price. */}
                        {variant.price > 0 && (
                          <s-text type="redundant" color="subdued">{formatMoney(variant.price, currency)}</s-text>
                        )}
                        <s-badge size="small" tone="critical">{shopify.i18n.translate('free')}</s-badge>
                        {hasVariants && <s-text type="small" color="subdued">{variant.title}</s-text>}
                        {hasVariants && <s-icon type={showVariants ? 'chevron-up' : 'chevron-down'} size="small" />}
                      </s-stack>
                    </s-stack>
                </s-grid>
              );
              return (
                <s-stack key={product.id} gap="small-200">
                  {index > 0 && <s-divider />}
                  <s-grid gridTemplateColumns="1fr auto" columnGap="small-200" alignItems="center">
                    {/* Tapping a gift with options shows its variant picker; one at a time. */}
                    {hasVariants ? (
                      <s-clickable onClick={() => setOpenGiftId((current) => (current === product.id ? '' : product.id))}
                        accessibilityLabel={String(shopify.i18n.translate(showVariants ? 'hideOptions' : 'showOptions', {title: product.title}))}>
                        {details}
                      </s-clickable>
                    ) : details}
                    <s-button variant="primary" loading={busy} disabled={Boolean(busyId) && !busy}
                      accessibilityLabel={String(shopify.i18n.translate('claimLabel', {title: product.title}))}
                      onClick={() => claim(product)}>
                      {shopify.i18n.translate('claim')}
                    </s-button>
                  </s-grid>
                  {showVariants && (
                    <s-select
                      label={product.optionLabel || String(shopify.i18n.translate('option'))}
                      value={variant.id}
                      disabled={Boolean(busyId)}
                      onChange={(event) => {
                        const variantId = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
                        setSelected((current) => ({...current, [product.id]: variantId}));
                      }}
                    >
                      {product.variants.map((item) => (
                        <s-option key={item.id} value={item.id}>{item.title}</s-option>
                      ))}
                    </s-select>
                  )}
                </s-stack>
              );
            })}
            {error && <s-banner tone="critical">{error}</s-banner>}
          </s-stack>
          </s-box>
        )}
    </s-stack>
  );
}


function Card({children}) {
  return (
    <s-box border="base" borderRadius="large" padding="base" background="base">
      <s-stack gap="base">{children}</s-stack>
    </s-box>
  );
}

function isGiftLine(line) {
  return line.attributes?.some((attribute) => attribute.key === GIFT_ATTRIBUTE && attribute.value === 'true');
}

// The line's cost before discounts, matching the function's subtotalAmount.
function lineSubtotal(line) {
  const discounts = (line.discountAllocations || [])
    .reduce((total, allocation) => total + Number(allocation.discountedAmount?.amount || 0), 0);
  return Number(line.cost?.totalAmount?.amount || 0) + discounts;
}

function formatMoney(amount, currency) {
  return shopify.i18n.formatCurrency(amount, currency ? {currency} : {});
}

// Groups the saved gift variants by product and keeps the ones the buyer can
// actually buy. The minimum is saved in the shop currency; the rate converts it
// to the buyer's currency, from a gift's saved price and its live price.
async function loadCatalog(settings, country, currency) {
  const ids = settings.products.map((product) => product.variantId);
  const {data} = /** @type {{data?: any}} */ (await shopify.query(
    `query FreeGiftVariants($ids: [ID!]!${country ? ', $country: CountryCode' : ''})
      ${country ? '@inContext(country: $country)' : ''} {
      shop { paymentSettings { currencyCode } }
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          availableForSale
          image { url }
          price { amount currencyCode }
          product { id title featuredImage { url } options(first: 3) { name } }
        }
      }
    }`,
    {variables: {ids, ...(country ? {country} : {})}},
  ));

  let rate = 1;
  const shopCurrency = data?.shop?.paymentSettings?.currencyCode;
  if (currency && shopCurrency && currency !== shopCurrency) {
    const priced = (data?.nodes || []).find((node) => {
      const saved = settings.products.find((product) => product.variantId === node?.id);
      return node?.price && Number(saved?.price) > 0;
    });
    const savedPrice = Number(settings.products.find((product) => product.variantId === priced?.id)?.price);
    if (priced && savedPrice > 0) rate = Number(priced.price.amount) / savedPrice;
  }

  const byProduct = new Map();
  for (const node of data?.nodes || []) {
    if (!node?.id || !node.availableForSale) continue;
    const product = byProduct.get(node.product.id) || {
      id: node.product.id,
      title: node.product.title,
      image: node.product.featuredImage?.url || '',
      optionLabel: (node.product.options || []).map((option) => option.name).filter((name) => name !== 'Title').join(' / '),
      variants: [],
    };
    product.variants.push({
      id: node.id,
      title: node.title === 'Default Title' ? '' : node.title,
      image: node.image?.url || '',
      price: Number(node.price.amount),
    });
    byProduct.set(node.product.id, product);
  }
  return {rate, products: [...byProduct.values()]};
}

function parseSettings(value) {
  let data;
  try {
    data = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    data = null;
  }
  return {
    enabled: Boolean(data?.enabled),
    // Saved in cents of the shop currency.
    minimumSpend: Math.max(0, Number(data?.minimumSpend) || 0),
    products: (Array.isArray(data?.products) ? data.products : [])
      .filter((product) => String(product?.variantId || '').startsWith('gid://shopify/ProductVariant/'))
      .map((product) => ({variantId: String(product.variantId), price: String(product.price || '')})),
  };
}
