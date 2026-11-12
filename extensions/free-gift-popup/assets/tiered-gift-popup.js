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
    document.documentElement.classList.remove("fgc-lock");
    root.querySelector(".fgc-overlay")?.remove();
    root.hidden = true;
  };
  const close = (tier) => { setDismissed(tier.id); hidePopup(); };


  const renderSelector = (tier, offered) => {
    const focused = offered.find((product) => product.id === focusedId) || offered[0];
    const selectedVariant = variantOf(focused);
    const groups = optionGroups(focused);
    const selectedValues = variantValues(selectedVariant);
    // Same markup as free-gift-popup.js. In "all" tiers every card is ticked
    // and the clicked card shows its options.
    const cards = offered.map((product) => {
      const selected = tier.mode === "all" || product.id === focused.id;
      const image = product.id === focused.id ? selectedVariant?.imageUrl || product.imageUrl : product.imageUrl;
      return `
      <button class="fgc-product${selected ? " is-selected" : ""}" type="button" data-product-id="${escapeHtml(product.id)}">
        <span class="fgc-check" aria-hidden="true">${selected ? "✓" : ""}</span>
        ${image ? `<img class="fgc-product-image" src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy">` : ""}
        <strong class="fgc-product-title">${escapeHtml(product.title)}</strong>
        <span class="fgc-free">🎁 FREE</span>
      </button>`;
    }).join("");
    const forTitle = tier.mode === "all" && offered.length > 1 ? ` (${focused.title})` : "";
    const options = groups.map((group, groupIndex) => `
      <fieldset class="fgc-option-group">
        <legend>Choose your ${escapeHtml(group.name.toLowerCase())}${escapeHtml(forTitle)}</legend>
        <div class="fgc-options">${group.values.map((value) =>
          `<button class="fgc-option${selectedValues[groupIndex] === value ? " is-selected" : ""}" type="button" data-option-index="${groupIndex}" data-option-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`
        ).join("")}</div>
      </fieldset>`).join("");

    root.querySelector(".fgc-content").innerHTML = `
      <div class="fgc-products${tier.mode === "all" ? " fgc-products--all" : ""}">${cards}</div>
      ${groups.length ? `<div class="fgc-variant-panel">${options}</div>` : ""}
      <button class="fgc-claim" type="button">🎁 ${escapeHtml(look.buttonLabel || "CLAIM MY FREE GIFT")}</button>
      <p class="fgc-status" aria-live="polite"></p>
      <div class="fgc-benefits"><span>◆&nbsp; Secure Checkout</span><span>▰&nbsp; Fast Shipping</span><span>★&nbsp; Loved by Collectors</span></div>`;

    root.querySelectorAll("[data-product-id]").forEach((card) => card.addEventListener("click", () => {
      focusedId = card.dataset.productId;
      renderSelector(tier, offered);
    }));
    root.querySelectorAll("[data-option-index]").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.optionIndex);
      const wanted = [...variantValues(selectedVariant)];
      wanted[index] = button.dataset.optionValue;
      const next = focused.variants.find((variant) => {
        const values = variantValues(variant);
        return wanted.every((value, optionIndex) => !value || values[optionIndex] === value);
      }) || focused.variants.find((variant) => variantValues(variant)[index] === button.dataset.optionValue) || selectedVariant;
      chosen[focused.id] = next.variantId;
      renderSelector(tier, offered);
    }));
    root.querySelector(".fgc-claim")?.addEventListener("click", async () => {
      const claim = root.querySelector(".fgc-claim");
      const status = root.querySelector(".fgc-status");
      const products = tier.mode === "all" ? offered : [focused];
      claim.disabled = true;
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
        claim.disabled = false;
        busy = false;
      }
    });
  };

  const show = (tier, offered) => {
    if (root.querySelector(".fgc-overlay")) return;
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
    root.querySelector(".fgc-close")?.focus();
    renderSelector(tier, offered);
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
