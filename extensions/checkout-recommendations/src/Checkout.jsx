import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

// Rules are managed on the app's "Checkout recommendations" admin page and
// saved to this shop metafield. A rule matches when any of its trigger
// products is in the cart; when no rule matches, the default source is used.
const NAMESPACE = 'free_gift_cart';
const KEY = 'checkout_recommendations';
const MAX_PRODUCTS = 6;
// Shopify's own recommendations are looked up for the first few cart products.
const MAX_SEED_PRODUCTS = 3;
// Marks cart lines added from this block, so after checkout reloads the block
// still knows them and keeps showing their Remove button.
const REC_ATTRIBUTE = '_recommendation';

const PRODUCT_FIELDS = `
  id
  title
  availableForSale
  isGiftCard
  featuredImage { url altText }
  options(first: 3) { name }
  variants(first: 25) {
    nodes {
      id
      title
      availableForSale
      requiresShipping
      image { url altText }
      price { amount currencyCode }
      compareAtPrice { amount currencyCode }
    }
  }
`;

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const entry = shopify.appMetafields.value.find(({target, metafield}) =>
    target.type === 'shop' && metafield.namespace === NAMESPACE && metafield.key === KEY);
  const giftEntry = shopify.appMetafields.value.find(({target, metafield}) =>
    target.type === 'shop' && metafield.namespace === NAMESPACE && metafield.key === 'settings');
  // The free gift settings change the exclusions too, so reload on either.
  const rawConfig = `${entry?.metafield.value ?? ''}|${giftEntry?.metafield.value ?? ''}`;
  const config = parseConfig(entry?.metafield.value, giftEntry?.metafield.value);
  const lines = shopify.lines.value;
  const country = shopify.localization.country.value?.isoCode;
  const canAdd = shopify.instructions.value?.lines?.canAddCartLine !== false;
  const canRemove = shopify.instructions.value?.lines?.canRemoveCartLine !== false;
  const canUpdate = shopify.instructions.value?.lines?.canUpdateCartLine !== false;

  // null until the first load finishes; later loads keep showing the previous
  // list so a cart change doesn't flash a skeleton.
  const [products, setProducts] = useState(null);
  // Variant picked in each product's dropdown, by product id.
  const [selected, setSelected] = useState({});
  // Quantity to add for products not in the cart yet, by product id.
  const [quantities, setQuantities] = useState({});
  // Products the buyer added from this block (until the tagged line shows up
  // in the cart). They stay in the list with a Remove button and don't count
  // as cart products when picking recommendations, so the list doesn't reshuffle.
  const [added, setAdded] = useState({});
  const [busyId, setBusyId] = useState('');
  // Only the first product shows until the buyer expands the list.
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');

  const cartProductIds = [...new Set(lines
    .map((line) => line.merchandise?.product?.id)
    .filter(Boolean))];
  const addedIds = new Set([
    ...Object.keys(added),
    ...lines.filter(isRecommendationLine).map((line) => line.merchandise?.product?.id).filter(Boolean),
  ]);
  const seedProductIds = cartProductIds.filter((id) => !addedIds.has(id));
  const seedKey = seedProductIds.join(',');
  const addedKey = [...addedIds].sort().join(',');

  useEffect(() => {
    if (!config.enabled || !canAdd) return undefined;
    let cancelled = false;
    loadRecommendations(config, seedProductIds, country)
      .then(async (list) => {
        // Keep products added from this block listed even if the new
        // recommendations no longer include them.
        const missing = [...addedIds].filter((id) => !list.some((product) => product.id === id));
        const extra = missing.length ? await fetchProducts(missing, country) : [];
        if (!cancelled) setProducts([...extra, ...list]);
      })
      .catch(() => { if (!cancelled) setProducts([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, addedKey, country, rawConfig, canAdd]);

  if (!config.enabled || !canAdd) return null;
  if (products === null) {
    return (
      <Card heading={config.heading}>
        <s-skeleton-paragraph />
      </Card>
    );
  }
  const inCart = new Set(cartProductIds);
  const visible = products
    .filter((product) => !inCart.has(product.id) || addedIds.has(product.id))
    .slice(0, config.maxProducts);
  if (!visible.length) return null;

  const variantOf = (product) =>
    product.variants.find((variant) => variant.id === selected[product.id]) || product.variants[0];
  const changeCart = async (productId, change, onSuccess) => {
    setBusyId(productId);
    setError('');
    try {
      const result = await shopify.applyCartLinesChange(change);
      if (result.type === 'error') setError(String(shopify.i18n.translate('cartError')));
      else onSuccess();
    } catch {
      setError(String(shopify.i18n.translate('cartError')));
    } finally {
      setBusyId('');
    }
  };
  const addToCart = (product) => changeCart(
    product.id,
    {
      type: 'addCartLine',
      merchandiseId: variantOf(product).id,
      quantity: quantities[product.id] || 1,
      attributes: [{key: REC_ATTRIBUTE, value: 'true'}],
    },
    () => setAdded((current) => ({...current, [product.id]: true})),
  );
  const lineOf = (product) => {
    const productLines = lines.filter((item) => item.merchandise?.product?.id === product.id);
    return productLines.find(isRecommendationLine) || productLines[0];
  };
  const changeQuantity = (product, quantity) => {
    if (!inCart.has(product.id)) {
      setQuantities((current) => ({...current, [product.id]: quantity}));
      return;
    }
    const line = lineOf(product);
    if (line && line.quantity !== quantity) {
      changeCart(product.id, {type: 'updateCartLine', id: line.id, quantity}, () => {});
    }
  };
  const removeFromCart = (product) => {
    const line = lineOf(product);
    if (!line) return undefined;
    return changeCart(
      product.id,
      {type: 'removeCartLine', id: line.id, quantity: line.quantity},
      () => setAdded((current) => {
        const next = {...current};
        delete next[product.id];
        return next;
      }),
    );
  };

  return (
    <Card heading={config.heading} hidden={visible.slice(1)} expanded={expanded}
      onToggle={visible.length > 1 ? () => setExpanded((current) => !current) : undefined}>
      {(expanded ? visible : visible.slice(0, 1)).map((product, index) => {
        const isAdded = inCart.has(product.id);
        // Once added, show the variant that is actually in the cart.
        const cartLine = isAdded ? lineOf(product) : null;
        const cartVariantId = cartLine?.merchandise?.id;
        const quantity = cartLine ? cartLine.quantity : quantities[product.id] || 1;
        const showVariants = !isAdded && product.variants.length > 1;
        const variant = product.variants.find((item) => item.id === cartVariantId) || variantOf(product);
        const busy = busyId === product.id;
        const label = String(shopify.i18n.translate(isAdded ? 'removeLabel' : 'addLabel', {title: product.title}));
        return (
          <s-stack key={product.id} gap="small-200">
            {index > 0 && <s-divider />}
            {/* Photo with name and price; the controls sit below at full width
                so long names and variant titles never get squeezed. */}
            <s-grid gridTemplateColumns="auto 1fr" columnGap="small-200" alignItems="center">
              <s-product-thumbnail size="small" src={variant.image || product.image} alt={product.imageAlt || product.title} />
              <s-stack gap="small-500">
                <s-text type="strong">{product.title}</s-text>
                {(isAdded || product.variants.length === 1) && variant.title && (
                  <s-text type="small" color="subdued">{variant.title}</s-text>
                )}
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text>{formatMoney(variant.price)}</s-text>
                  {variant.compareAtPrice && (
                    <>
                      <s-text type="redundant" color="subdued">{formatMoney(variant.compareAtPrice)}</s-text>
                      <s-badge tone="critical" size="small">
                        {shopify.i18n.translate('save', {percent: savePercent(variant)})}
                      </s-badge>
                    </>
                  )}
                  {isAdded && <s-badge size="small" icon="check">{shopify.i18n.translate('added')}</s-badge>}
                </s-stack>
              </s-stack>
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
            <s-grid gridTemplateColumns="1fr 1fr" columnGap="small-200" alignItems="center">
              <QuantityStepper
                value={quantity}
                title={product.title}
                disabled={Boolean(busyId) || (isAdded && !canUpdate)}
                onChange={(value) => changeQuantity(product, value)}
              />
              {isAdded ? (
                canRemove && (
                  <s-button variant="secondary" inlineSize="fill" accessibilityLabel={label} loading={busy}
                    disabled={Boolean(busyId) && !busy} onClick={() => removeFromCart(product)}>
                    {shopify.i18n.translate('remove')}
                  </s-button>
                )
              ) : (
                <s-button variant="primary" inlineSize="fill" accessibilityLabel={label} loading={busy}
                  disabled={Boolean(busyId) && !busy} onClick={() => addToCart(product)}>
                  {shopify.i18n.translate('add')}
                </s-button>
              )}
            </s-grid>
          </s-stack>
        );
      })}
      {error && <s-banner tone="critical">{error}</s-banner>}
    </Card>
  );
}

const MAX_QUANTITY = 99;

// A [ − 1 + ] box like the quantity selector on a product page.
function QuantityStepper({value, title, disabled, onChange}) {
  const step = (change) => onChange(Math.min(MAX_QUANTITY, Math.max(1, value + change)));
  return (
    <s-box border="base" borderRadius="base" background="base">
      <s-grid gridTemplateColumns="auto 1fr auto" alignItems="center">
        <s-clickable padding="base" disabled={disabled || value <= 1} onClick={() => step(-1)}
          accessibilityLabel={String(shopify.i18n.translate('decrease', {title}))}>
          <s-icon type="minus" size="small" />
        </s-clickable>
        <s-stack alignItems="center">
          <s-text type="strong">{value}</s-text>
        </s-stack>
        <s-clickable padding="base" disabled={disabled || value >= MAX_QUANTITY} onClick={() => step(1)}
          accessibilityLabel={String(shopify.i18n.translate('increase', {title}))}>
          <s-icon type="plus" size="small" />
        </s-clickable>
      </s-grid>
    </s-box>
  );
}

// A white bordered card stands out from the order summary's grey background.
// With more than one product, the header folds the list down to the first
// product (previewing the rest) and opens it again, like the free gift block.
function Card({heading, children, hidden = [], expanded = false, onToggle = undefined}) {
  if (!onToggle) {
    return (
      <s-box border="base" borderRadius="large" padding="small" background="base">
        <s-stack gap="small-200">
          <s-text type="strong">{heading}</s-text>
          {children}
        </s-stack>
      </s-box>
    );
  }
  const lowest = hidden
    .flatMap((product) => product.variants.map((variant) => variant.price))
    .reduce((min, price) => (Number(price.amount) < Number(min.amount) ? price : min));
  const subtitle = expanded
    ? String(shopify.i18n.translate('showLess'))
    : String(shopify.i18n.translate('showMore', {count: hidden.length, price: formatMoney(lowest)}));
  return (
    <s-box border="base" borderRadius="large" padding="small" background="base">
      <s-stack gap="small-200">
        <s-clickable onClick={onToggle} borderRadius="base" accessibilityLabel={`${heading}. ${subtitle}`}>
          <s-grid gridTemplateColumns="1fr auto" columnGap="small-200" alignItems="center">
            <s-stack gap="small-500">
              <s-text type="strong">{heading}</s-text>
              <s-text type="small" color="subdued">{subtitle}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="small-300" alignItems="center">
              {!expanded && hidden.slice(0, 3).map((product) => (
                <s-product-thumbnail key={product.id} size="small-100" src={product.image} alt={product.title} />
              ))}
              <s-icon type={expanded ? 'chevron-up' : 'chevron-down'} size="small" />
            </s-stack>
          </s-grid>
        </s-clickable>
        <s-divider />
        {children}
      </s-stack>
    </s-box>
  );
}

function savePercent(variant) {
  const compareAt = Number(variant.compareAtPrice.amount);
  return Math.round(((compareAt - Number(variant.price.amount)) / compareAt) * 100);
}

function isRecommendationLine(line) {
  return line.attributes?.some((attribute) => attribute.key === REC_ATTRIBUTE && attribute.value === 'true');
}

function formatMoney(money) {
  return shopify.i18n.formatCurrency(Number(money.amount), {currency: money.currencyCode});
}

async function loadRecommendations(config, cartProductIds, country) {
  const inCart = new Set(cartProductIds);
  const ruleIds = [];
  for (const rule of config.rules) {
    if (!rule.enabled || !rule.triggers.some((id) => inCart.has(id))) continue;
    for (const id of rule.recommendations) {
      if (!inCart.has(id) && !ruleIds.includes(id)) ruleIds.push(id);
    }
  }

  // Excluded products (and, when the merchant asks, ones that never ship, like
  // shipping protection or gift cards) are never recommended.
  // Free gift products and $0 items are never sold here either.
  const allowed = (product) => !config.excludedProducts.includes(product.id) &&
    !config.giftProductIds.includes(product.id) &&
    product.variants.some((variant) => Number(variant.price.amount) > 0) &&
    !product.isGiftCard && (!config.hideNonShipping || product.requiresShipping);
  const products = (ruleIds.length ? await fetchProducts(ruleIds, country) : []).filter(allowed);
  // A matching rule replaces the default unless the merchant asked to top up
  // the remaining slots with it.
  if (products.length >= config.maxProducts || (ruleIds.length && !config.fillWithDefault)) return products;

  const fallback = config.defaultSource === 'products'
    ? await fetchProducts(config.defaultProducts, country)
    : config.defaultSource === 'shopify'
      ? await fetchShopifyRecommendations(cartProductIds, country)
      : [];
  const seen = new Set(products.map((product) => product.id));
  return [...products, ...fallback.filter((product) => allowed(product) && !seen.has(product.id) && !inCart.has(product.id))];
}

async function fetchProducts(ids, country) {
  if (!ids.length) return [];
  const {data} = /** @type {{data?: any}} */ (await shopify.query(
    `query RecommendationProducts($ids: [ID!]!${country ? ', $country: CountryCode' : ''})
      ${country ? '@inContext(country: $country)' : ''} {
      nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } }
    }`,
    {variables: {ids, ...(country ? {country} : {})}},
  ));
  return (data?.nodes || []).map(toCard).filter(Boolean);
}

async function fetchShopifyRecommendations(cartProductIds, country) {
  const seeds = cartProductIds.slice(0, MAX_SEED_PRODUCTS);
  const results = await Promise.all(seeds.map(async (productId) => {
    const {data} = /** @type {{data?: any}} */ (await shopify.query(
      `query ShopifyRecommendations($productId: ID!${country ? ', $country: CountryCode' : ''})
        ${country ? '@inContext(country: $country)' : ''} {
        productRecommendations(productId: $productId, intent: RELATED) { ${PRODUCT_FIELDS} }
      }`,
      {variables: {productId, ...(country ? {country} : {})}},
    ));
    return data?.productRecommendations || [];
  }));
  // Interleave so each cart product contributes its best matches first.
  const merged = [];
  const seen = new Set();
  for (let index = 0; results.some((list) => index < list.length); index++) {
    for (const list of results) {
      const card = list[index] && toCard(list[index]);
      if (card && !seen.has(card.id)) {
        seen.add(card.id);
        merged.push(card);
      }
    }
  }
  return merged;
}

// Products that can't be bought (unpublished, sold out or not sold in the
// buyer's market) come back as null or without an available variant.
function toCard(product) {
  if (!product?.id || product.availableForSale === false) return null;
  const variants = (product.variants?.nodes || [])
    .filter((variant) => variant.availableForSale)
    .map((variant) => {
      const compareAt = Number(variant.compareAtPrice?.amount || 0);
      return {
        id: variant.id,
        title: variant.title === 'Default Title' ? '' : variant.title,
        image: variant.image?.url || '',
        requiresShipping: variant.requiresShipping !== false,
        price: variant.price,
        compareAtPrice: compareAt > Number(variant.price.amount) ? variant.compareAtPrice : null,
      };
    });
  if (!variants.length) return null;
  return {
    id: product.id,
    title: product.title,
    image: product.featuredImage?.url || '',
    imageAlt: product.featuredImage?.altText || '',
    isGiftCard: product.isGiftCard === true,
    requiresShipping: variants.some((variant) => variant.requiresShipping),
    // Single-variant products have a lone "Title" option.
    optionLabel: (product.options || []).map((option) => option.name).filter((name) => name !== 'Title').join(' / '),
    variants,
  };
}

function idList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(typeof item === 'object' ? item?.id : item || '')).filter((id) => id.startsWith('gid://shopify/Product/'))
    : [];
}

function parseConfig(value, giftValue) {
  let gift;
  try {
    gift = typeof giftValue === 'string' ? JSON.parse(giftValue) : giftValue;
  } catch {
    gift = null;
  }
  let data;
  try {
    data = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    data = null;
  }
  const settings = data?.settings || {};
  const maxProducts = Math.round(Number(settings.maxProducts) || 3);
  return {
    // Nothing saved yet still shows Shopify's recommendations.
    enabled: settings.enabled !== false,
    heading: String(settings.heading || '').trim() || String(shopify.i18n.translate('defaultHeading')),
    maxProducts: Math.min(MAX_PRODUCTS, Math.max(1, maxProducts)),
    defaultSource: ['shopify', 'products', 'none'].includes(settings.defaultSource) ? settings.defaultSource : 'shopify',
    defaultProducts: idList(settings.defaultProducts),
    fillWithDefault: settings.fillWithDefault === true,
    excludedProducts: idList(settings.excludedProducts),
    hideNonShipping: settings.hideNonShipping !== false,
    giftProductIds: (Array.isArray(gift?.products) ? gift.products : [])
      .map((product) => String(product?.productId || ''))
      .filter((id) => id.startsWith('gid://shopify/Product/')),
    rules: (Array.isArray(data?.rules) ? data.rules : []).map((rule) => ({
      enabled: rule?.enabled !== false,
      triggers: idList(rule?.triggers),
      recommendations: idList(rule?.recommendations),
    })),
  };
}
