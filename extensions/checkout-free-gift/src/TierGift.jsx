import {useEffect, useState} from 'preact/hooks';

// Checkout side of Price gifts (spend tiers, app/routes/app.price-gifts.tsx).
// Same rules as the cart popup, the tiered-gift-discount function and the
// checkout validation: paid lines (gift lines left out) against the tier
// minimums in US dollars; Tier 1 allows 1 gift, Tier 2 allows 2 different
// gifts (a Tier 1 gift counts as one of them), below Tier 1 none. Gifts are
// added with the `_tier_gift` attribute, which the discount makes free.
export const TIER_NAMESPACE = 'tiered_gift';
export const TIER_KEY = 'function_settings';
const TIER_ATTRIBUTE = '_tier_gift';

// The small settings copy the app saves for functions and checkout.
export function readTierSettings() {
  const entry = shopify.appMetafields.value.find(({target, metafield}) =>
    target.type === 'shop' && metafield.namespace === TIER_NAMESPACE && metafield.key === TIER_KEY);
  const raw = entry?.metafield.value;
  let data = null;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    data = null;
  }
  if (!data?.enabled || !Array.isArray(data.tiers) || !data.tiers.length) return null;
  const tiers = data.tiers
    .map((tier) => ({
      id: String(tier?.id || ''),
      minimum: Math.max(0, Number(tier?.minimumSpend) || 0),
      maximum: tier?.maximumSpend == null ? null : Number(tier.maximumSpend),
      products: (Array.isArray(tier?.products) ? tier.products : [])
        .filter((product) => String(product?.variantId || '').startsWith('gid://shopify/ProductVariant/'))
        .map((product) => ({productId: String(product.productId || ''), variantId: String(product.variantId)})),
    }))
    .sort((a, b) => a.minimum - b.minimum);
  return {
    raw: String(typeof raw === 'string' ? raw : JSON.stringify(raw)),
    shopCurrency: String(data.shopCurrency || ''),
    hidden: new Set(Array.isArray(data.hiddenVariantIds) ? data.hiddenVariantIds : []),
    tiers,
  };
}

export function isTierGiftLine(line) {
  return Boolean(line.attributes?.some((attribute) => attribute.key === TIER_ATTRIBUTE && attribute.value));
}

const isOldGiftLine = (line) =>
  Boolean(line.attributes?.some((attribute) => attribute.key === '_free_gift' && attribute.value === 'true'));

// The line's cost after its discounts (sale prices, product discounts).
// Order discounts are taken off the total in TierGift.
function lineSubtotal(line) {
  return Number(line.cost?.totalAmount?.amount || 0);
}

const shortTitle = (title) => String(title || '').replace(/^\s*free\s+gift\s*[|:\-–]\s*/i, '');
const formatMoney = (amount, currency) => shopify.i18n.formatCurrency(amount, currency ? {currency} : {});

// Live titles, photos, stock and the buyer-currency rate (the same rate the
// discount function uses: a USD cart compares directly; a USD store
// converts; otherwise the numbers compare as they are).
async function loadCatalog(settings, country, currency) {
  const ids = [...new Set(settings.tiers.flatMap((tier) => tier.products.map((product) => product.variantId)))]
    .filter((id) => !settings.hidden.has(id));
  const query = (withCountry) => shopify.query(
    `query TierGiftVariants($ids: [ID!]!${withCountry ? ', $country: CountryCode' : ''})
      ${withCountry ? '@inContext(country: $country)' : ''} {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id title availableForSale
          image { url }
          price { amount currencyCode }
          product { id title featuredImage { url } options(first: 3) { name } }
        }
      }
    }`,
    {variables: {ids, ...(withCountry ? {country} : {})}},
  );
  const local = /** @type {{data?: any}} */ (await query(Boolean(country)));
  const nodes = (local.data?.nodes || []).filter(Boolean);

  let rate = 1;
  if (currency && currency !== 'USD' && settings.shopCurrency === 'USD' && country) {
    const base = /** @type {{data?: any}} */ (await query(false));
    const basePrice = new Map((base.data?.nodes || []).filter(Boolean).map((node) => [node.id, Number(node.price?.amount)]));
    const priced = nodes.find((node) => node.price?.currencyCode === currency && basePrice.get(node.id) > 0);
    if (priced) rate = Number(priced.price.amount) / basePrice.get(priced.id);
  }

  const products = new Map();
  for (const node of nodes) {
    if (!node.availableForSale) continue;
    const product = products.get(node.product.id) || {
      id: node.product.id,
      title: shortTitle(node.product.title),
      image: node.product.featuredImage?.url || '',
      optionLabel: (node.product.options || []).map((option) => option.name).filter((name) => name !== 'Title').join(' / '),
      variants: [],
    };
    product.variants.push({
      id: node.id,
      title: node.title === 'Default Title' ? '' : node.title,
      image: node.image?.url || '',
      price: Number(node.price?.amount || 0),
    });
    products.set(node.product.id, product);
  }
  return {rate, products};
}

// One change at a time, so checkout doesn't reject overlapping updates.
function applyChanges(changes) {
  return changes.reduce((previous, change) => previous
    .then(() => shopify.applyCartLinesChange(change))
    .catch(() => {}), Promise.resolve());
}

export function TierGift({settings}) {
  const lines = shopify.lines.value;
  const country = shopify.localization.country.value?.isoCode;
  const currency = shopify.cost.totalAmount.value?.currencyCode;
  const canAdd = shopify.instructions.value?.lines?.canAddCartLine !== false;
  const canRemove = shopify.instructions.value?.lines?.canRemoveCartLine !== false;
  const canUpdate = shopify.instructions.value?.lines?.canUpdateCartLine !== false;

  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState({});
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [openGiftId, setOpenGiftId] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadCatalog(settings, country, currency)
      .then((result) => { if (!cancelled) setCatalog(result); })
      .catch(() => { if (!cancelled) setCatalog({rate: 1, products: new Map()}); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.raw, country, currency]);

  const rate = catalog?.rate || 1;
  const tiers = settings.tiers;
  // After discounts, as in the cart popup: paid lines at their discounted
  // cost, less order discounts (discount codes, automatic order discounts).
  const orderDiscounts = (shopify.discountAllocations?.value || [])
    .reduce((total, allocation) => total + Number(allocation.discountedAmount?.amount || 0), 0);
  const paid = Math.max(0, lines
    .filter((line) => !isTierGiftLine(line) && !isOldGiftLine(line))
    .reduce((total, line) => total + lineSubtotal(line), 0) - orderDiscounts);
  const thresholds = tiers.map((tier) => (tier.minimum / 100) * rate);
  const reached = thresholds.reduce((index, threshold, tierIndex) => (paid >= threshold ? tierIndex : index), -1);
  const tier = tiers[reached];
  const pastMaximum = Boolean(tier && tier.maximum != null && paid >= ((tier.maximum + 100) / 100) * rate);
  const limit = !tier || pastMaximum ? 0 : reached === 1 ? 2 : 1;
  // Tier 2 offers the Tier 1 and Tier 2 gifts together.
  const pool = !tier || pastMaximum ? [] : reached === 1 ? tiers.slice(0, 2) : [tier];
  const poolProductIds = new Set(pool.flatMap((candidate) => candidate.products.map((product) => product.productId)));

  // The gift lines this tier allows: one unit of each different gift product,
  // up to the limit, oldest first. Everything else is taken out, as the cart
  // popup does (e.g. a cart that drops under $350 keeps one gift).
  const giftLines = lines.filter(isTierGiftLine);
  const keptProducts = new Set();
  const changes = [];
  for (const line of giftLines) {
    const productId = line.merchandise?.product?.id;
    if (poolProductIds.has(productId) && !keptProducts.has(productId) && keptProducts.size < limit) {
      keptProducts.add(productId);
      if (line.quantity > 1 && canUpdate) changes.push({type: 'updateCartLine', id: line.id, quantity: 1});
    } else if (canRemove) {
      changes.push({type: 'removeCartLine', id: line.id, quantity: line.quantity});
    }
  }
  const changeKey = catalog ? changes.map((change) => `${change.type}:${change.id}`).join(',') : '';
  useEffect(() => {
    if (!changeKey || busyId) return;
    setBusyId('fix');
    applyChanges(changes).finally(() => setBusyId(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeKey]);

  if (!catalog) return null;

  const remainingPicks = Math.max(0, limit - keptProducts.size);
  const offered = [...poolProductIds]
    .filter((id) => !keptProducts.has(id))
    .map((id) => catalog.products.get(id))
    .filter(Boolean);
  const next = reached + 1 < tiers.length ? reached + 1 : -1;
  const nextText = next < 0 ? '' : next === 1
    ? `Spend ${formatMoney(thresholds[next] - paid, currency)} more to choose any 2 FREE gifts.`
    : `Spend ${formatMoney(thresholds[next] - paid, currency)} more to choose 1 FREE gift.`;
  const showChoice = canAdd && remainingPicks > 0 && offered.length > 0 && !changeKey;
  if (!showChoice && !nextText) return null;

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
        attributes: [{key: TIER_ATTRIBUTE, value: tier.id}],
      });
      if (result.type === 'error') setError('This gift couldn’t be added. Please try again.');
    } catch {
      setError('This gift couldn’t be added. Please try again.');
    } finally {
      setBusyId('');
    }
  };

  const heading = limit === 2
    ? (keptProducts.size ? 'You’ve unlocked a 2nd FREE gift!' : 'You’ve unlocked 2 FREE gifts!')
    : 'You’ve unlocked a FREE gift!';
  const subheading = remainingPicks === 1 ? 'Choose 1 gift below.' : 'Choose any 2 gifts below.';

  return (
    <s-box background="subdued" border="base" borderRadius="large" padding="base">
      <s-stack gap="base">
        {showChoice && (
          <s-clickable onClick={() => setOpen((current) => !current)}
            accessibilityLabel={open ? 'Hide free gifts' : 'Show free gifts'}>
            <s-grid gridTemplateColumns="auto 1fr auto" columnGap="base" alignItems="center">
              <s-box background="base" borderRadius="max" padding="small-200">
                <s-icon type="gift-card" tone="info" />
              </s-box>
              <s-stack gap="small-500">
                <s-text type="strong">{heading}</s-text>
                <s-text type="small" color="subdued">{subheading}</s-text>
              </s-stack>
              <s-icon type={open ? 'chevron-up' : 'chevron-down'} size="small" />
            </s-grid>
          </s-clickable>
        )}
        {showChoice && open && offered.map((product) => {
          const variant = variantOf(product);
          const busy = busyId === product.id;
          const hasVariants = product.variants.length > 1;
          const showVariants = hasVariants && openGiftId === product.id;
          return (
            <s-box key={product.id} background="base" borderRadius="large" padding="small">
              <s-stack gap="small-200">
                <s-grid gridTemplateColumns="auto 1fr auto" columnGap="small-200" alignItems="center">
                  <s-product-thumbnail size="small" src={variant.image || product.image} alt={product.title} />
                  <s-stack gap="small-300">
                    <s-text>{product.title}</s-text>
                    <s-stack direction="inline" gap="small-300" alignItems="center">
                      {variant.price > 0 && (
                        <s-text type="redundant" color="subdued">{formatMoney(variant.price, currency)}</s-text>
                      )}
                      <s-badge size="small" tone="critical">FREE</s-badge>
                      {hasVariants && (
                        <s-clickable border="base" borderRadius="base" paddingInline="small-200" paddingBlock="small-500"
                          onClick={() => setOpenGiftId((current) => (current === product.id ? '' : product.id))}
                          accessibilityLabel={`${showVariants ? 'Hide' : 'Show'} options for ${product.title}`}>
                          <s-stack direction="inline" gap="small-400" alignItems="center">
                            <s-text type="small">{variant.title}</s-text>
                            <s-icon type={showVariants ? 'chevron-up' : 'chevron-down'} size="small-100" />
                          </s-stack>
                        </s-clickable>
                      )}
                    </s-stack>
                  </s-stack>
                  <s-button variant="primary" loading={busy} disabled={Boolean(busyId) && !busy}
                    accessibilityLabel={`Claim ${product.title}`} onClick={() => claim(product)}>
                    Claim
                  </s-button>
                </s-grid>
                {showVariants && (
                  <s-select
                    label={product.optionLabel || 'Option'}
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
            </s-box>
          );
        })}
        {nextText && (
          <s-grid gridTemplateColumns="auto 1fr" columnGap="small-200" alignItems="center">
            <s-icon type="gift-card" />
            <s-text type="strong">{nextText}</s-text>
          </s-grid>
        )}
        {nextText && (
          <s-progress value={Math.max(0, paid)} max={thresholds[next]} accessibilityLabel={nextText} />
        )}
        {error && <s-banner tone="critical">{error}</s-banner>}
      </s-stack>
    </s-box>
  );
}
