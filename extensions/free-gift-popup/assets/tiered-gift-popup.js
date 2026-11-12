// Price gifts (spend tiers) in the Free Gift App (Master) popup. The embed
// loads this instead of free-gift-popup.js only while price gift settings are
// on (app/routes/app.price-gifts.tsx). It draws the same popup with the same
// classes and CSS (tiered-gift-popup.css only shows "+" instead of "OR"
// between gifts in all-gift tiers). The
// tiered-gift-discount function makes claimed lines free; they carry
// `_tier_gift: <tier id>`.
//
// It runs on every page: the popup opens as soon as the cart crosses a tier's
// minimum, whether the item was added from a product page, a cart drawer or
// the cart page.
(() => {
  const root = document.getElementById("free-gift-cart-root");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";
  const cartPath = (root.dataset.cartPath || "/cart").replace(/\/$/, "");
  const onCartPage = window.location.pathname.replace(/\/$/, "") === cartPath;

  const readJson = (selector) => {
    try { return JSON.parse(root.querySelector(selector)?.textContent || "{}") || {}; } catch { return null; }
  };
  const tierSettings = readJson("[data-tiered-gift-settings]");
  if (!tierSettings?.enabled || !Array.isArray(tierSettings.tiers)) return;
  // Popup text and colors from the Free gift settings.
  const look = readJson("[data-free-gift-settings]") || {};
  const live = readJson("[data-tiered-gift-inventory]") || {};

  const nativeFetch = window.fetch.bind(window);
  // Tier minimums are US dollars, as the admin page shows them. A USD cart
  // compares directly; a USD store converts to the buyer's currency with the
  // storefront rate. Otherwise (e.g. an INR store showing "$") the numbers
  // compare as they are. Same rule as the tiered-gift-discount function.
  const shopCurrency = root.dataset.shopCurrency || "";
  const thresholdRate = (cartCurrency) => {
    if (cartCurrency === "USD") return 1;
    if (shopCurrency === "USD") return Number(window.Shopify?.currency?.rate) || 1;
    return 1;
  };
  const basePath = window.Shopify?.routes?.root || "/";
  const numericId = (gid) => Number(String(gid || "").split("/").pop());
  const escapeHtml = (value) => {
    const element = document.createElement("div");
    element.textContent = String(value ?? "");
    return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  const inStock = (variant) => {
    const state = live[variant.variantId];
    if (state) return state.available === true;
    if (variant.inventoryTracked && Number(variant.inventoryQuantity) <= 0) return false;
    return variant.availableForSale !== false;
  };

  // Tiers low to high, each with its gift products grouped from variants.
  const tiers = tierSettings.tiers.map((tier) => {
    const products = new Map();
    (tier.products || []).forEach((variant) => {
      if (!products.has(variant.productId)) products.set(variant.productId, {
        id: variant.productId, title: variant.productTitle,
        imageUrl: live[variant.variantId]?.productImage || variant.imageUrl,
        variants: [], variantIds: new Set(),
      });
      const product = products.get(variant.productId);
      product.variantIds.add(numericId(variant.variantId));
      if (inStock(variant)) product.variants.push({ ...variant, imageUrl: live[variant.variantId]?.image || variant.imageUrl });
    });
    return {
      id: tier.id, mode: tier.mode === "all" ? "all" : "one",
      minimum: Number(tier.minimumSpend || 0),
      allProducts: [...products.values()],
      products: [...products.values()].filter((product) => product.variants.length),
    };
  }).sort((a, b) => a.minimum - b.minimum);

  // Always-gift products (their variants are $0), as in free-gift-popup.js.
  const alwaysGiftProductIds = new Set([8708096557231, 8431587655855]);
  // Every tier gift variant. A $0 line of one, added from its product page
  // rather than the popup, is a gift too; a paid line of it is a purchase.
  const tierVariantIds = new Set(tiers.flatMap((tier) => tier.allProducts.flatMap((product) => [...product.variantIds])));
  const isTierGift = (item) => Boolean(item.properties?._tier_gift);
  const isFreeTierVariant = (item) => !isTierGift(item) && tierVariantIds.has(item.variant_id) && Number(item.original_price) === 0;
  const isGiftItem = (item) => isTierGift(item) || isFreeTierVariant(item) || item.properties?._free_gift === "true" || alwaysGiftProductIds.has(item.product_id);
  // Before discounts, like the discount function.
  const paidSubtotal = (cart) => cart.items.reduce((total, item) => isGiftItem(item) ? total : total + item.original_line_price, 0);
  const tierFor = (subtotal, cartCurrency) => {
    const rate = thresholdRate(cartCurrency);
    return [...tiers].reverse().find((tier) => subtotal >= Math.round(tier.minimum * rate)) || null;
  };

  const variantValues = (variant) => {
    if (Array.isArray(variant.optionValues) && variant.optionValues.length) return variant.optionValues;
    if (!variant.variantTitle || variant.variantTitle === "Default Title") return [];
    return variant.variantTitle.split(" / ");
  };
  const inferredOptionName = (values, index) => {
    const sizes = new Set(["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]);
    if (values.every((value) => sizes.has(String(value).toUpperCase()))) return "Size";
    const colors = ["black", "white", "gray", "grey", "navy", "blue", "red", "green", "yellow", "pink", "purple", "brown", "orange"];
    if (values.every((value) => colors.some((color) => String(value).toLowerCase().includes(color)))) return "Color";
    return `Option ${index + 1}`;
  };
  const optionGroups = (product) => {
    const count = Math.max(0, ...product.variants.map((variant) => variantValues(variant).length));
    return Array.from({ length: count }, (_, index) => {
      const values = [...new Set(product.variants.map((variant) => variantValues(variant)[index]).filter(Boolean))];
      const name = product.variants.find((variant) => variant.optionNames?.[index])?.optionNames[index];
      return { name: name || inferredOptionName(values, index), values };
    });
  };

  let busy = false;
  let pending = false;
  // The card whose options are showing (in "one" tiers, also the chosen
  // gift) and the chosen variant per product.
  let focusedId = "";
  const chosen = {};
  const variantOf = (product) => product.variants.find((variant) => variant.variantId === chosen[product.id]) || product.variants[0];

  // Closing the popup hides it for that tier until the cart drops below it
  // or reaches another tier.
  const DISMISS_KEY = "fgc-tier-dismissed";
  const dismissedTier = () => { try { return sessionStorage.getItem(DISMISS_KEY) || ""; } catch { return ""; } };
  const setDismissed = (value) => { try { value ? sessionStorage.setItem(DISMISS_KEY, value) : sessionStorage.removeItem(DISMISS_KEY); } catch { /* blocked */ } };

  const hidePopup = () => {
    openKey = "";
    document.documentElement.classList.remove("fgc-lock");
    root.querySelector(".fgc-overlay")?.remove();
    root.hidden = true;
  };
  const close = (tier) => { setDismissed(tier.id); hidePopup(); };

  // Best variant for a click: it must have the clicked value, and keeps as
  // many of the other current choices as possible (so picking a size keeps
  // the colour when that combination exists).
  const pickVariant = (product, index, value) => {
    const current = variantValues(variantOf(product));
    let best = null;
    let bestScore = -1;
    product.variants.forEach((variant) => {
      const values = variantValues(variant);
      if (values[index] !== value) return;
      const score = values.reduce((total, item, optionIndex) => total + (optionIndex !== index && item === current[optionIndex] ? 1 : 0), 0);
      if (score > bestScore) { best = variant; bestScore = score; }
    });
    return best || variantOf(product);
  };
  // A value is shown as available when a variant has it together with the
  // other current choices; otherwise it is dimmed (a click still works and
  // switches the other option to one that exists).
  const comboExists = (product, index, value) => {
    const current = variantValues(variantOf(product));
    return product.variants.some((variant) => variantValues(variant).every((item, optionIndex) =>
      optionIndex === index ? item === value : item === current[optionIndex]));
  };

  // Options for one product. In "all" tiers every gift gets its own block,
  // titled with the product, so it is clear which gift each choice is for.
  const optionsHtml = (product, titled) => {
    const groups = optionGroups(product);
    if (!groups.length) return "";
    const selected = variantValues(variantOf(product));
    return `<div class="fgc-tier-options" data-options-for="${escapeHtml(product.id)}">
      ${titled ? `<p class="fgc-tier-options-title">${escapeHtml(product.title)}</p>` : ""}
      ${groups.map((group, groupIndex) => `
      <fieldset class="fgc-option-group">
        <legend>Choose your ${escapeHtml(group.name.toLowerCase())}</legend>
        <div class="fgc-options">${group.values.map((value) => {
          const isSelected = selected[groupIndex] === value;
          const exists = isSelected || comboExists(product, groupIndex, value);
          return `<button class="fgc-option${isSelected ? " is-selected" : ""}${exists ? "" : " is-unavailable"}" type="button" aria-pressed="${isSelected}" data-product="${escapeHtml(product.id)}" data-option-index="${groupIndex}" data-option-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`;
        }).join("")}</div>
      </fieldset>`).join("")}
    </div>`;
  };

  // Draws the gift cards once, then updates them in place on every choice,
  // so images don't reload and the popup doesn't jump.
  const renderSelector = (tier, offered) => {
    const focused = () => offered.find((product) => product.id === focusedId) || offered[0];
    const isSelected = (product) => tier.mode === "all" || product.id === focused().id;
    const imageFor = (product) => (isSelected(product) ? variantOf(product)?.imageUrl : "") || product.imageUrl;
    const content = root.querySelector(".fgc-content");
    content.innerHTML = `
      <div class="fgc-products${tier.mode === "all" ? " fgc-products--all" : ""}">${offered.map((product) => `
        <button class="fgc-product" type="button" data-product-id="${escapeHtml(product.id)}"${tier.mode === "all" ? ' tabindex="-1"' : ""}>
          <span class="fgc-check" aria-hidden="true"></span>
          <img class="fgc-product-image" src="${escapeHtml(imageFor(product))}" alt="${escapeHtml(product.title)}" loading="lazy"${imageFor(product) ? "" : " hidden"}>
          <strong class="fgc-product-title">${escapeHtml(product.title)}</strong>
          <span class="fgc-free">🎁 FREE</span>
        </button>`).join("")}
      </div>
      <div class="fgc-variant-panel"></div>
      <button class="fgc-claim" type="button">🎁 ${escapeHtml(look.buttonLabel || "CLAIM MY FREE GIFT")}</button>
      <p class="fgc-status" aria-live="polite"></p>
      <div class="fgc-benefits"><span>◆&nbsp; Secure Checkout</span><span>▰&nbsp; Fast Shipping</span><span>★&nbsp; Loved by Collectors</span></div>`;
    const panel = content.querySelector(".fgc-variant-panel");

    const refresh = () => {
      content.querySelectorAll("[data-product-id]").forEach((card) => {
        const product = offered.find((item) => item.id === card.dataset.productId);
        const selected = isSelected(product);
        card.classList.toggle("is-selected", selected);
        card.setAttribute("aria-pressed", String(selected));
        card.querySelector(".fgc-check").textContent = selected ? "✓" : "";
        const image = card.querySelector("img");
        const src = imageFor(product);
        if (src && image.getAttribute("src") !== src) image.setAttribute("src", src);
        image.hidden = !src;
      });
      const shown = tier.mode === "all" ? offered : [focused()];
      panel.innerHTML = shown.map((product) => optionsHtml(product, tier.mode === "all" && offered.length > 1)).join("");
      panel.hidden = !panel.innerHTML.trim();
    };

    content.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const option = target?.closest("[data-option-index]");
      if (option) {
        const product = offered.find((item) => item.id === option.dataset.product);
        if (!product) return;
        chosen[product.id] = pickVariant(product, Number(option.dataset.optionIndex), option.dataset.optionValue).variantId;
        refresh();
        return;
      }
      const card = target?.closest("[data-product-id]");
      if (card && tier.mode === "one" && card.dataset.productId !== focusedId) {
        focusedId = card.dataset.productId;
        refresh();
        return;
      }
      if (target?.closest(".fgc-claim")) claim(tier, tier.mode === "all" ? offered : [focused()]);
    });
    refresh();
  };

  const claim = async (tier, products) => {
    const button = root.querySelector(".fgc-claim");
    const status = root.querySelector(".fgc-status");
    if (!button || button.disabled) return;
    button.disabled = true;
    busy = true;
    try {
      const response = await nativeFetch(`${basePath}cart/add.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: products.map((product) => ({
          id: numericId(variantOf(product).variantId), quantity: 1, properties: { _tier_gift: tier.id },
        })) }),
      });
      if (!response.ok) throw new Error("Gift could not be added. Please try another option.");
      status.textContent = look.successMessage || "Free gift added.";
      // Reload so the theme's cart (page, drawer, count) shows the gift.
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Gift could not be added.";
      button.disabled = false;
      busy = false;
    }
  };

  // What the open popup offers, so a cart change that alters it redraws it.
  let openKey = "";
  const offerKey = (tier, offered) => `${tier.id}:${offered.map((product) => product.id).join(",")}`;

  const show = (tier, offered) => {
    const key = offerKey(tier, offered);
    if (root.querySelector(".fgc-overlay")) {
      if (openKey === key) return;
      hidePopup();
    }
    openKey = key;
    if (!offered.some((product) => product.id === focusedId)) focusedId = offered[0].id;
    const several = tier.mode === "all" && offered.length > 1;
    const subheading = tier.mode === "all"
      ? `${several ? "All gifts below are" : "The gift below is"} free with your order. Choose your options and add ${several ? "them" : "it"} to your cart.`
      : look.subheading || "Choose 1 gift below and add it to your cart.";
    root.style.setProperty("--fgc-background", look.backgroundColor || "#FFFFFF");
    root.style.setProperty("--fgc-text", look.textColor || "#111827");
    root.style.setProperty("--fgc-button", look.buttonColor || "#EF0B18");
    root.style.setProperty("--fgc-button-text", look.buttonTextColor || "#FFFFFF");
    root.style.setProperty("--fgc-overlay", look.overlayColor || "#111827B3");
    root.insertAdjacentHTML("beforeend", `<div class="fgc-overlay" role="presentation">
      <section class="fgc-dialog" role="dialog" aria-modal="true" aria-labelledby="fgc-heading">
        <button class="fgc-close" type="button" aria-label="Close">&times;</button>
        <div class="fgc-header"><span class="fgc-gift">🎁</span><h2 class="fgc-heading" id="fgc-heading">${several ? "YOU’VE UNLOCKED FREE GIFTS!" : "YOU’VE UNLOCKED A FREE GIFT!"}</h2></div>
        <p class="fgc-subheading">${escapeHtml(subheading)}</p>
        <p class="fgc-urgency">◷ &nbsp; Limited quantities available. Claim yours while supplies last.</p>
        <div class="fgc-content"></div>
        <p class="fgc-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </section></div>`);
    root.hidden = false;
    document.documentElement.classList.add("fgc-lock");
    root.querySelector(".fgc-close")?.addEventListener("click", () => close(tier));
    root.querySelector(".fgc-overlay")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) close(tier); });
    root.onkeydown = (event) => { if (event.key === "Escape" && !root.hidden) close(tier); };
    renderSelector(tier, offered);
    root.querySelector(".fgc-close")?.focus({ preventScroll: true });
  };

  const checkCart = async () => {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const response = await nativeFetch(`${basePath}cart.js`, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const cart = await response.json();
      const subtotal = paidSubtotal(cart);
      const tier = tierFor(subtotal, cart.currency);

      // Keep only this tier's gifts: one unit per gift product, and a single
      // gift in "one" tiers. Lower-tier gifts, other gifts and extra units go.
      // The newest gift wins, so adding another gift replaces the earlier
      // one. cart.js lists the most recently added line first.
      const updates = {};
      const kept = new Set();
      cart.items.filter(isGiftItem).forEach((item) => {
        const product = tier && (item.properties?._tier_gift === tier.id || isFreeTierVariant(item))
          ? tier.allProducts.find((candidate) => candidate.variantIds.has(item.variant_id)) : null;
        if (!product || kept.has(product.id) || (tier.mode === "one" && kept.size > 0)) { updates[item.key] = 0; return; }
        kept.add(product.id);
        if (item.quantity > 1) updates[item.key] = 1;
      });
      if (Object.keys(updates).length) {
        hidePopup();
        const update = await nativeFetch(`${basePath}cart/update.js`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ updates }),
        });
        // Reload the cart page only when the cart changed, so a refused
        // update can't loop. Other pages keep their place.
        const updated = update.ok ? await update.json() : null;
        const shape = (items) => JSON.stringify(items.map((item) => [item.key, item.quantity]));
        if (onCartPage && updated && shape(updated.items) !== shape(cart.items)) { window.location.reload(); return; }
      }

      if (!tier) { hidePopup(); setDismissed(""); return; }
      const offered = tier.mode === "all"
        ? tier.products.filter((product) => !kept.has(product.id))
        : (kept.size ? [] : tier.products);
      if (!offered.length) { hidePopup(); return; }
      if (dismissedTier() !== tier.id) show(tier, offered);
    } catch {
      // The next check retries network failures.
    } finally {
      busy = false;
      if (pending) { pending = false; window.setTimeout(checkCart, 100); }
    }
  };

  // Re-check right after the theme changes the cart (fetch or XHR to
  // /cart/add, /cart/change, /cart/update, /cart/clear).
  const CART_CHANGE = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  const afterCartChange = () => window.setTimeout(checkCart, 350);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const result = nativeFetch(input, init);
    if (CART_CHANGE.test(url)) result.then(afterCartChange, () => {});
    return result;
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (CART_CHANGE.test(String(url))) this.addEventListener("loadend", afterCartChange);
    return nativeOpen.call(this, method, url, ...rest);
  };
  // Classic (non-AJAX) add-to-cart forms land on the cart page or reload,
  // which the first check covers.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkCart(); });

  checkCart();
  // The cart page's own quantity controls vary by theme, so it also polls.
  if (onCartPage) window.setInterval(checkCart, 1000);
})();
