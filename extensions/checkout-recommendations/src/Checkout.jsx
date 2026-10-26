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

const PRODUCT_FIELDS = `
  id
  title
  availableForSale
  featuredImage { url altText }
  variants(first: 25) {
    nodes {
      id
      title
      availableForSale
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
  const rawConfig = entry?.metafield.value;
  const config = parseConfig(rawConfig);
  const cartProductIds = [...new Set(shopify.lines.value
    .map((line) => line.merchandise?.product?.id)
    .filter(Boolean))];
  const cartKey = cartProductIds.join(',');
  const country = shopify.localization.country.value?.isoCode;
  const canAdd = shopify.instructions.value?.lines?.canAddCartLine !== false;

  // null until the first load finishes; later loads keep showing the previous
  // list so adding a product doesn't flash a skeleton.
  const [products, setProducts] = useState(null);
  const [addingId, setAddingId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!config.enabled || !canAdd) return undefined;
    let cancelled = false;
    loadRecommendations(config, cartProductIds, country)
      .then((list) => { if (!cancelled) setProducts(list); })
      .catch(() => { if (!cancelled) setProducts([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, country, rawConfig, canAdd]);

  if (!config.enabled || !canAdd) return null;
  if (products === null) {
    return (
      <s-stack gap="base">
        <s-heading>{config.heading}</s-heading>
        <s-skeleton-paragraph />
      </s-stack>
    );
  }
  const inCart = new Set(cartProductIds);
  const visible = products.filter((product) => !inCart.has(product.id)).slice(0, config.maxProducts);
  if (!visible.length) return null;

  const addToCart = async (product) => {
    setAddingId(product.variantId);
    setError('');
    try {
      const result = await shopify.applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: product.variantId,
        quantity: 1,
      });
      if (result.type === 'error') setError(String(shopify.i18n.translate('addError')));
    } catch {
      setError(String(shopify.i18n.translate('addError')));
    } finally {
      setAddingId('');
    }
  };

  return (
    <s-stack gap="base">
      <s-heading>{config.heading}</s-heading>
      {visible.map((product) => (
        <s-grid key={product.id} gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
          <s-product-thumbnail src={product.image} alt={product.imageAlt || product.title} />
          <s-stack gap="none">
            <s-text type="strong">{product.title}</s-text>
            {product.variantTitle && <s-text color="subdued">{product.variantTitle}</s-text>}
            <s-stack direction="inline" gap="small-200">
              {product.compareAtPrice && (
                <s-text type="redundant" color="subdued">{formatMoney(product.compareAtPrice)}</s-text>
              )}
              <s-text>{formatMoney(product.price)}</s-text>
            </s-stack>
          </s-stack>
          <s-button
            variant="secondary"
            accessibilityLabel={String(shopify.i18n.translate('addLabel', {title: product.title}))}
            loading={addingId === product.variantId}
            disabled={Boolean(addingId) && addingId !== product.variantId}
            onClick={() => addToCart(product)}
          >
            {shopify.i18n.translate('add')}
          </s-button>
        </s-grid>
      ))}
      {error && <s-banner tone="critical">{error}</s-banner>}
    </s-stack>
  );
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

  const products = ruleIds.length ? await fetchProducts(ruleIds, country) : [];
  // A matching rule replaces the default unless the merchant asked to top up
  // the remaining slots with it.
  if (products.length >= config.maxProducts || (ruleIds.length && !config.fillWithDefault)) return products;

  const fallback = config.defaultSource === 'products'
    ? await fetchProducts(config.defaultProducts, country)
    : config.defaultSource === 'shopify'
      ? await fetchShopifyRecommendations(cartProductIds, country)
      : [];
  const seen = new Set(products.map((product) => product.id));
  return [...products, ...fallback.filter((product) => !seen.has(product.id) && !inCart.has(product.id))];
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
  const variant = product.variants?.nodes?.find((item) => item.availableForSale);
  if (!variant) return null;
  const compareAt = Number(variant.compareAtPrice?.amount || 0);
  return {
    id: product.id,
    title: product.title,
    variantId: variant.id,
    variantTitle: variant.title === 'Default Title' ? '' : variant.title,
    image: product.featuredImage?.url || '',
    imageAlt: product.featuredImage?.altText || '',
    price: variant.price,
    compareAtPrice: compareAt > Number(variant.price.amount) ? variant.compareAtPrice : null,
  };
}

function idList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(typeof item === 'object' ? item?.id : item || '')).filter((id) => id.startsWith('gid://shopify/Product/'))
    : [];
}

function parseConfig(value) {
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
    rules: (Array.isArray(data?.rules) ? data.rules : []).map((rule) => ({
      enabled: rule?.enabled !== false,
      triggers: idList(rule?.triggers),
      recommendations: idList(rule?.recommendations),
    })),
  };
}
