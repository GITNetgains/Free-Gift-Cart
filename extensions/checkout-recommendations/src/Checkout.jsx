import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';

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
// These products are never recommended, and can be in the order only once
// however they were added (the free gift block or checkout's own quantity
// field). Keep in sync with checkout-free-gift.
const SINGLE_QUANTITY_PRODUCT_IDS = new Set([
  'gid://shopify/Product/8708096557231',
  'gid://shopify/Product/8431587655855',
]);

const PRODUCT_FIELDS = `
  id
  title
  availableForSale
  isGiftCard
  descriptionHtml
  featuredImage { url altText }
  images(first: 6) { nodes { url altText } }
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

// Price gifts (spend tiers): their gift products, while the offer is on.
// The free gift block (checkout-free-gift) keeps the gift lines in line with
// the tiers then, so this block leaves gift lines alone and never sells
// the gift products.
function tierGiftProductIds() {
  const entry = shopify.appMetafields.value.find(({target, metafield}) =>
    target.type === 'shop' && metafield.namespace === 'tiered_gift' && metafield.key === 'function_settings');
  let data = null;
  try {
    const raw = entry?.metafield.value;
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    data = null;
  }
  if (!data?.enabled || !Array.isArray(data.tiers) || !data.tiers.length) return null;
  return [...new Set(data.tiers.flatMap((tier) => (Array.isArray(tier?.products) ? tier.products : [])
    .map((product) => String(product?.productId || ''))
    .filter((id) => id.startsWith('gid://shopify/Product/'))))];
}

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
  const tierGiftIds = tierGiftProductIds();
  if (tierGiftIds) config.giftProductIds = tierGiftIds;
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
  // The list starts open; the header folds it down to the first product.
  const [expanded, setExpanded] = useState(true);
  // The one product whose options (variant, quantity) are showing.
  const [openId, setOpenId] = useState('');
  const [error, setError] = useState('');
  // The product shown in the "View details" popup, and its photo.
  const [detailsId, setDetailsId] = useState('');
  const [detailsImage, setDetailsImage] = useState('');

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

  // Only one free gift in the whole order: keep one unit, preferring the line
  // claimed through the app, and remove every other gift product line.
  // Not with price gifts: Tier 2 allows two, and the free gift block
  // handles their lines.
  const giftProductIds = new Set([...SINGLE_QUANTITY_PRODUCT_IDS, ...config.giftProductIds]);
  const giftKey = tierGiftIds ? '' : lines
    .filter((line) => giftProductIds.has(line.merchandise?.product?.id))
    .map((line) => `${line.id}:${line.quantity}`)
    .join(',');
  useEffect(() => {
    if (!giftKey) return;
    applyChanges(oneGiftChanges(lines, giftProductIds, canUpdate, canRemove));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [giftKey]);

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
    .filter((product) => !SINGLE_QUANTITY_PRODUCT_IDS.has(product.id))
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
        const isOpen = openId === product.id;
        // Products start folded; the corner arrow (or tapping the product) opens
        // its variant, quantity and Add controls, one product at a time.
        const actionButton = isAdded ? (
          canRemove && (
            <SmallButton label={label} loading={busy}
              disabled={Boolean(busyId) && !busy} onClick={() => removeFromCart(product)}>
              {shopify.i18n.translate('remove')}
            </SmallButton>
          )
        ) : (
          <SmallButton label={label} loading={busy}
            disabled={Boolean(busyId) && !busy} onClick={() => addToCart(product)}>
            {shopify.i18n.translate('add')}
          </SmallButton>
        );
        return (
          <s-stack key={product.id} gap="base">
            {index > 0 && <s-divider />}
            {/* Tapping the product opens its options (variant and quantity)
                below; only one product is open at a time. The small Add
                button on the right adds it straight away. */}
            <s-grid gridTemplateColumns="1fr auto" columnGap="base" alignItems="start">
            <s-grid gridTemplateColumns="auto 1fr" columnGap="base" alignItems="center">
              <s-clickable onClick={() => setOpenId((current) => (current === product.id ? '' : product.id))}
                accessibilityLabel={String(shopify.i18n.translate(isOpen ? 'hideOptions' : 'showOptions', {title: product.title}))}>
                <s-product-thumbnail size="small" src={variant.image || product.image} alt={product.imageAlt || product.title} />
              </s-clickable>
              <s-stack gap="small-500">
              <s-clickable onClick={() => setOpenId((current) => (current === product.id ? '' : product.id))}
                accessibilityLabel={String(shopify.i18n.translate(isOpen ? 'hideOptions' : 'showOptions', {title: product.title}))}>
              <s-stack gap="small-500">
                <s-text>{product.title}</s-text>
                {(isAdded || product.variants.length === 1) && variant.title && (
                  <s-text type="small" color="subdued">{variant.title}</s-text>
                )}
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">{formatMoney(variant.price)}</s-text>
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
              </s-clickable>
                {/* Opens the product details popup (ProductDetails). */}
                <s-link commandFor={DETAILS_MODAL_ID} command="--show" tone="neutral"
                  accessibilityLabel={String(shopify.i18n.translate('viewDetailsLabel', {title: product.title}))}
                  onClick={() => { setDetailsId(product.id); setDetailsImage(''); }}>
                  <s-text type="small" color="subdued">{shopify.i18n.translate('viewDetails')}</s-text>
                </s-link>
              </s-stack>
            </s-grid>
              <s-clickable onClick={() => setOpenId((current) => (current === product.id ? '' : product.id))} padding="small-200"
                accessibilityLabel={String(shopify.i18n.translate(isOpen ? 'hideOptions' : 'showOptions', {title: product.title}))}>
                <s-icon type={isOpen ? 'chevron-up' : 'chevron-down'} size="small" />
              </s-clickable>
            </s-grid>
            {isOpen && showVariants && (
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
            {isOpen && (
              <s-grid gridTemplateColumns="112px auto" columnGap="base" alignItems="center" justifyContent="start">
                <QuantityStepper
                  value={quantity}
                  title={product.title}
                  disabled={Boolean(busyId) || (isAdded && !canUpdate)}
                  onChange={(value) => changeQuantity(product, value)}
                />
                {actionButton}
              </s-grid>
            )}
          </s-stack>
        );
      })}
      <ProductDetails
        product={visible.find((product) => product.id === detailsId) || null}
        image={detailsImage}
        onImage={setDetailsImage}
        variantOf={(product) => product.variants.find((item) => item.id === lineOf(product)?.merchandise?.id) || variantOf(product)}
        isAdded={(product) => inCart.has(product.id)}
        busy={Boolean(busyId)}
        quantity={(product) => (inCart.has(product.id) ? lineOf(product)?.quantity || 1 : quantities[product.id] || 1)}
        onSelect={(product, variantId) => setSelected((current) => ({...current, [product.id]: variantId}))}
        onQuantity={changeQuantity}
        onAdd={addToCart}
        canUpdate={canUpdate}
      />
      {/* Closes the list off from the discount field below. */}
      <s-divider />
      {error && <s-banner tone="critical">{error}</s-banner>}
    </Card>
  );
}

const DETAILS_MODAL_ID = 'recommendation-details';

// "View details" popup: photos, price, options, description and Add, without
// leaving checkout. One popup for the list; the link picks the product.
function ProductDetails({product, image, onImage, variantOf, isAdded, busy, quantity, onSelect, onQuantity, onAdd, canUpdate}) {
  const modalRef = useRef(null);
  const [fullText, setFullText] = useState(false);
  useEffect(() => { setFullText(false); }, [product?.id]);
  if (!product) {
    return <s-modal id={DETAILS_MODAL_ID} ref={modalRef} heading={String(shopify.i18n.translate('viewDetails'))} />;
  }
  const variant = variantOf(product);
  const added = isAdded(product);
  const shown = image || variant.image || product.image;
  const photos = [...new Set([variant.image, ...product.images].filter(Boolean))];
  const changeVariant = (event) => {
    onSelect(product, /** @type {HTMLSelectElement} */ (event.currentTarget).value);
    onImage('');
  };
  return (
    <s-modal id={DETAILS_MODAL_ID} ref={modalRef} heading={product.title} size="large">
      <s-stack gap="large">
        {/* Photos left, buying details right; stacked on phones. */}
        <s-query-container>
          <s-grid gridTemplateColumns="@container (inline-size > 520px) 1fr 1fr, 1fr" gap="large" alignItems="start">
            <s-stack gap="small-200">
              {shown && (
                <s-box border="base" borderRadius="large" padding="small-200" background="base">
                  <s-image src={shown} alt={product.imageAlt || product.title} aspectRatio="1" objectFit="contain" borderRadius="base" />
                </s-box>
              )}
              {photos.length > 1 && (
                <s-stack direction="inline" gap="small-200">
                  {photos.slice(0, 6).map((url) => (
                    <s-clickable key={url} onClick={() => onImage(url)} borderRadius="base"
                      border={url === shown ? 'large' : 'none'} accessibilityLabel={product.title}>
                      <s-product-thumbnail size="small" src={url} alt={product.title} />
                    </s-clickable>
                  ))}
                </s-stack>
              )}
            </s-stack>
            <s-stack gap="base">
              <s-stack gap="small-300">
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-heading>{formatMoney(variant.price)}</s-heading>
                  {variant.compareAtPrice && (
                    <s-text type="redundant" color="subdued">{formatMoney(variant.compareAtPrice)}</s-text>
                  )}
                </s-stack>
                <s-stack direction="inline" gap="small-300">
                  {variant.compareAtPrice && (
                    <s-badge tone="critical" size="small">{shopify.i18n.translate('save', {percent: savePercent(variant)})}</s-badge>
                  )}
                  {added && <s-badge size="small" icon="check">{shopify.i18n.translate('added')}</s-badge>}
                </s-stack>
              </s-stack>
              {!added && product.variants.length > 1 && (
                <s-select label={product.optionLabel || String(shopify.i18n.translate('option'))} value={variant.id} disabled={busy}
                  onChange={changeVariant}>
                  {product.variants.map((item) => <s-option key={item.id} value={item.id}>{item.title}</s-option>)}
                </s-select>
              )}
              {(added || product.variants.length === 1) && variant.title && (
                <s-text color="subdued">{product.optionLabel ? `${product.optionLabel}: ` : ''}{variant.title}</s-text>
              )}
              <s-stack gap="small-200">
                <s-text type="small" color="subdued">{shopify.i18n.translate('quantity')}</s-text>
                <s-grid gridTemplateColumns="112px" justifyContent="start">
                  <QuantityStepper value={quantity(product)} title={product.title}
                    disabled={busy || (added && !canUpdate)} onChange={(value) => onQuantity(product, value)} />
                </s-grid>
              </s-stack>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="check-circle" size="small" tone="success" />
                <s-text type="small" color="subdued">{shopify.i18n.translate('inStock')}</s-text>
              </s-stack>
            </s-stack>
          </s-grid>
        </s-query-container>
        <Description blocks={product.description} full={fullText} onMore={() => setFullText(true)} />
      </s-stack>
      {!added && (
        <s-button slot="primary-action" variant="primary" loading={busy}
          onClick={async () => { await onAdd(product); modalRef.current?.hideOverlay?.(); }}>
          {shopify.i18n.translate('addToOrder', {price: formatMoney({amount: Number(variant.price.amount) * quantity(product), currencyCode: variant.price.currencyCode})})}
        </s-button>
      )}
      <s-button slot="secondary-actions" variant="secondary" commandFor={DETAILS_MODAL_ID} command="--hide">
        {shopify.i18n.translate('close')}
      </s-button>
    </s-modal>
  );
}

// Short descriptions show in full; longer ones show this many blocks first.
const DESCRIPTION_PREVIEW = 4;

// The product description as headings, paragraphs and bullet lists, with a
// bold lead-in ("TSA-Approved Security: ...") kept bold.
function Description({blocks, full, onMore}) {
  if (!blocks.length) return null;
  const longText = blocks.length > DESCRIPTION_PREVIEW + 1;
  const shown = full || !longText ? blocks : blocks.slice(0, DESCRIPTION_PREVIEW);
  const line = (block) => (block.lead
    ? <><s-text type="strong">{block.lead}</s-text>{block.text ? ` ${block.text}` : ''}</>
    : block.text);
  return (
    <s-stack gap="base">
      <s-divider />
      <s-text type="strong">{shopify.i18n.translate('description')}</s-text>
      {shown.map((block, index) => {
        if (block.type === 'heading') return <s-text key={index} type="strong">{block.text}</s-text>;
        if (block.type === 'list') {
          return (
            <s-unordered-list key={index}>
              {block.items.map((item, itemIndex) => <s-list-item key={itemIndex}>{line(item)}</s-list-item>)}
            </s-unordered-list>
          );
        }
        return <s-paragraph key={index}>{line(block)}</s-paragraph>;
      })}
      {!full && longText && (
        <s-link onClick={onMore}>{shopify.i18n.translate('readMore')}</s-link>
      )}
    </s-stack>
  );
}

function decodeEntities(text) {
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018',
    rdquo: '\u201d', ldquo: '\u201c', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', trade: '\u2122', reg: '\u00ae', copy: '\u00a9', deg: '\u00b0', times: '\u00d7'};
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

// One block of inline HTML to {lead, text}: a leading <strong>/<b> becomes
// the bold lead-in, other tags are dropped.
function inline(html) {
  const clean = (value) => decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  const bold = /^\s*(?:<(?:span|em|i)[^>]*>\s*)*<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>([\s\S]*)$/i.exec(html);
  if (bold) {
    const lead = clean(bold[2]);
    const text = clean(bold[3]);
    if (lead) return {lead, text};
  }
  return {lead: '', text: clean(html)};
}

// Shopify's descriptionHtml to display blocks. Checkout can't render HTML,
// so headings, paragraphs and list items are rebuilt with checkout components.
export function descriptionBlocks(html) {
  const source = String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const blocks = [];
  const pattern = /<(h[1-6]|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let last = 0;
  const addText = (chunk) => {
    // Paragraphs, divs and line breaks split the text into blocks.
    chunk.split(/<\/?(?:p|div|section|article|table|tr|td|th|tbody|thead)\b[^>]*>|<br\s*\/?>/i)
      .map(inline)
      .filter((block) => block.lead || block.text)
      .forEach((block) => {
        // A bold line on its own ("Key Features & Highlights:") reads as a heading.
        if (block.lead && !block.text && block.lead.length <= 60) blocks.push({type: 'heading', text: block.lead.replace(/:$/, '')});
        else blocks.push({type: 'paragraph', ...block});
      });
  };
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    addText(source.slice(last, match.index));
    last = pattern.lastIndex;
    const tag = match[1].toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const items = [...match[2].matchAll(/<li\b[^>]*>([\s\S]*?)(?=<li\b|$)/gi)]
        .map((item) => inline(item[1].replace(/<\/li>/gi, '')))
        .filter((item) => item.lead || item.text);
      if (items.length) blocks.push({type: 'list', items});
    } else {
      const text = inline(match[2]);
      const title = [text.lead, text.text].filter(Boolean).join(' ');
      if (title) blocks.push({type: 'heading', text: title.replace(/:$/, '')});
    }
  }
  addText(source.slice(last));
  return blocks;
}

// The cart changes that leave a single unit of a single gift product. Keep in
// sync with checkout-free-gift.
function oneGiftChanges(lines, giftProductIds, canUpdate, canRemove) {
  const giftLines = lines.filter((line) => giftProductIds.has(line.merchandise?.product?.id));
  if (!giftLines.length) return [];
  const keep = giftLines.find((line) => line.attributes?.some((attribute) =>
    attribute.key === '_free_gift' && attribute.value === 'true')) || giftLines[0];
  const changes = [];
  if (keep.quantity > 1 && canUpdate) changes.push({type: 'updateCartLine', id: keep.id, quantity: 1});
  if (canRemove) {
    giftLines
      .filter((line) => line !== keep)
      .forEach((line) => changes.push({type: 'removeCartLine', id: line.id, quantity: line.quantity}));
  }
  return changes;
}

// One change at a time, so checkout doesn't reject overlapping updates.
function applyChanges(changes) {
  return changes.reduce((previous, change) => previous
    .then(() => shopify.applyCartLinesChange(change))
    .catch(() => {}), Promise.resolve());
}

// Checkout buttons come in one fixed size, so compact actions are a small
// bordered clickable instead.
function SmallButton({label, loading, disabled, onClick, children}) {
  return (
    <s-clickable border="base" borderRadius="base" background="base" paddingBlock="small-200" paddingInline="base"
      accessibilityLabel={label} loading={loading} disabled={disabled} onClick={onClick}>
      <s-text type="strong">{children}</s-text>
    </s-clickable>
  );
}


const MAX_QUANTITY = 99;

// A [ − 1 + ] box like the quantity selector on a product page.
function QuantityStepper({value, title, disabled, onChange}) {
  const step = (change) => onChange(Math.min(MAX_QUANTITY, Math.max(1, value + change)));
  return (
    <s-box border="base" borderRadius="base" background="base">
      <s-grid gridTemplateColumns="auto 1fr auto" alignItems="center">
        <s-clickable padding="small-200" disabled={disabled || value <= 1} onClick={() => step(-1)}
          accessibilityLabel={String(shopify.i18n.translate('decrease', {title}))}>
          <s-icon type="minus" size="small" />
        </s-clickable>
        <s-stack alignItems="center">
          <s-text type="strong">{value}</s-text>
        </s-stack>
        <s-clickable padding="small-200" disabled={disabled || value >= MAX_QUANTITY} onClick={() => step(1)}
          accessibilityLabel={String(shopify.i18n.translate('increase', {title}))}>
          <s-icon type="plus" size="small" />
        </s-clickable>
      </s-grid>
    </s-box>
  );
}

// The block sits flat in the order summary, without its own border.
// With more than one product, the header folds the list down to the first
// product (previewing the rest) and opens it again, like the free gift block.
function Card({heading, children, hidden = [], expanded = false, onToggle = undefined}) {
  if (!onToggle) {
    return (
      <s-box>
        <s-stack gap="base">
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
    <s-box>
      <s-stack gap="base">
        <s-clickable onClick={onToggle} borderRadius="base" accessibilityLabel={`${heading}. ${subtitle}`}>
          <s-grid gridTemplateColumns="1fr auto" columnGap="small-200" alignItems="center">
            <s-stack gap="small-500">
              <s-text type="strong">{heading}</s-text>
              {!expanded && <s-text type="small" color="subdued">{subtitle}</s-text>}
            </s-stack>
            <s-icon type={expanded ? 'minus' : 'plus'} size="small" />
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
  // Free gift products, single-quantity products and $0 items are never sold
  // here either.
  const allowed = (product) => !config.excludedProducts.includes(product.id) &&
    !SINGLE_QUANTITY_PRODUCT_IDS.has(product.id) &&
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
    // For the "View details" popup.
    description: descriptionBlocks(product.descriptionHtml),
    images: [...new Set([product.featuredImage?.url, ...(product.images?.nodes || []).map((image) => image?.url)].filter(Boolean))],
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
