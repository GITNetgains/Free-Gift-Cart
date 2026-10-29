(() => {
  const root = document.getElementById("free-gift-cart-root");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";
  const cartPath = root.dataset.cartPath || "/cart";
  if (window.location.pathname.replace(/\/$/, "") !== cartPath.replace(/\/$/, "")) return;
  const settingsNode = root.querySelector("[data-free-gift-settings]");
  if (!settingsNode) return;

  let settings;
  try { settings = JSON.parse(settingsNode.textContent || "{}"); } catch { return; }
  let liveInventory = {};
  try { liveInventory = JSON.parse(root.querySelector("[data-free-gift-inventory]")?.textContent || "{}"); } catch { liveInventory = {}; }
  // Current product/variant images from Liquid (keyed by product and variant
  // GID), so image changes in Shopify admin show up without re-saving settings.
  let liveImages = {};
  try { liveImages = JSON.parse(root.querySelector("[data-free-gift-images]")?.textContent || "{}"); } catch { liveImages = {}; }
  const variants = Array.isArray(settings.products) ? settings.products.filter((variant) => {
    if (Object.prototype.hasOwnProperty.call(liveInventory, variant.variantId)) return liveInventory[variant.variantId] === true;
    if (variant.inventoryTracked && Number(variant.inventoryQuantity) <= 0) return false;
    return variant.availableForSale !== false;
  }).map((variant) => ({
    ...variant, imageUrl: liveImages[variant.variantId] || liveImages[variant.productId] || variant.imageUrl,
  })) : [];
  // Out-of-stock gifts aren't offered, but the one-gift limit below still runs.
  if (!settings.enabled) return;

  // minimumSpend is saved in the shop currency (USD) while cart.js amounts are in
  // the buyer's currency, so convert it with the storefront's active rate.
  const threshold = Math.round(Number(settings.minimumSpend || 0) * (Number(window.Shopify?.currency?.rate) || 1));

  const escapeHtml = (value) => {
    const element = document.createElement("div");
    element.textContent = String(value || "");
    return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  const products = Array.from(variants.reduce((map, variant) => {
    if (!map.has(variant.productId)) map.set(variant.productId, {
      id: variant.productId, title: variant.productTitle,
      imageUrl: liveImages[variant.productId] || variant.imageUrl, variants: [],
    });
    map.get(variant.productId).variants.push(variant);
    return map;
  }, new Map()).values());
  // Gift products by numeric product id, as cart.js reports them. Their
  // variants are $0, so anyone can add more from the product URL, the console
  // or a cart permalink; only one unit of one gift may stay in the cart.
  // The two below are always gifts (keep in sync with the checkout blocks).
  const giftProductIds = new Set([
    8708096557231,
    8431587655855,
    ...(Array.isArray(settings.products) ? settings.products : [])
      .map((variant) => Number(String(variant.productId || "").split("/").pop()))
      .filter(Boolean),
  ]);
  const isGiftItem = (item) => item.properties?._free_gift === "true" || giftProductIds.has(item.product_id);
  let selectedProduct = products[0];
  let selectedVariant = selectedProduct?.variants[0];
  let cartCheckInProgress = false;
  let giftRemovalInProgress = false;

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
  const cartSignature = (cart) => cart.items
    .filter((item) => item.properties?._free_gift !== "true")
    .map((item) => `${item.variant_id}:${item.quantity}`).sort().join("|");
  const close = (signature) => {
    sessionStorage.setItem("fgc-dismissed-cart", signature);
    document.documentElement.classList.remove("fgc-lock");
    root.hidden = true;
    root.replaceChildren(settingsNode);
  };
  const hidePopup = () => {
    document.documentElement.classList.remove("fgc-lock");
    root.querySelector(".fgc-overlay")?.remove();
    root.hidden = true;
  };

  const renderSelector = (signature) => {
    const groups = optionGroups(selectedProduct);
    const selectedValues = variantValues(selectedVariant);
    const cards = products.map((product) => {
      // Unselected cards show the product's featured image; the selected card
      // follows the chosen variant's own image.
      const displayedImage = product.id === selectedProduct.id
        ? selectedVariant?.imageUrl || product.imageUrl
        : product.imageUrl;
      return `
      <button class="fgc-product${product.id === selectedProduct.id ? " is-selected" : ""}" type="button" data-product-id="${escapeHtml(product.id)}">
        <span class="fgc-check" aria-hidden="true">${product.id === selectedProduct.id ? "✓" : ""}</span>
        ${displayedImage ? `<img class="fgc-product-image" src="${escapeHtml(displayedImage)}" alt="${escapeHtml(product.title)}" loading="lazy">` : ""}
        <strong class="fgc-product-title">${escapeHtml(product.title)}</strong>
        <span class="fgc-free">🎁 FREE</span>
      </button>`;
    }).join("");
    const options = groups.map((group, groupIndex) => `
      <fieldset class="fgc-option-group">
        <legend>Choose your ${escapeHtml(group.name.toLowerCase())}</legend>
        <div class="fgc-options">${group.values.map((value) =>
          `<button class="fgc-option${selectedValues[groupIndex] === value ? " is-selected" : ""}" type="button" data-option-index="${groupIndex}" data-option-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`
        ).join("")}</div>
      </fieldset>`).join("");

    root.querySelector(".fgc-content").innerHTML = `
      <div class="fgc-products">${cards}</div>
      ${groups.length ? `<div class="fgc-variant-panel">${options}</div>` : ""}
      <button class="fgc-claim" type="button">🎁 ${escapeHtml(settings.buttonLabel || "CLAIM MY FREE GIFT")}</button>
      <p class="fgc-status" aria-live="polite"></p>
      <div class="fgc-benefits"><span>◆&nbsp; Secure Checkout</span><span>▰&nbsp; Fast Shipping</span><span>★&nbsp; Loved by Collectors</span></div>`;

    root.querySelectorAll("[data-product-id]").forEach((card) => card.addEventListener("click", () => {
      selectedProduct = products.find((product) => product.id === card.dataset.productId) || products[0];
      selectedVariant = selectedProduct.variants[0];
      renderSelector(signature);
    }));
    root.querySelectorAll("[data-option-index]").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.optionIndex);
      const wanted = [...variantValues(selectedVariant)];
      wanted[index] = button.dataset.optionValue;
      selectedVariant = selectedProduct.variants.find((variant) => {
        const values = variantValues(variant);
        return wanted.every((value, optionIndex) => !value || values[optionIndex] === value);
      }) || selectedProduct.variants.find((variant) => variantValues(variant)[index] === button.dataset.optionValue) || selectedVariant;
      renderSelector(signature);
    }));
    root.querySelector(".fgc-claim")?.addEventListener("click", async () => {
      const claim = root.querySelector(".fgc-claim");
      const status = root.querySelector(".fgc-status");
      claim.disabled = true;
      try {
        const formData = new URLSearchParams({
          id: String(Number(selectedVariant.variantId.split("/").pop())),
          quantity: "1",
          "properties[_free_gift]": "true",
        });
        const response = await fetch(`${window.Shopify?.routes?.root || "/"}cart/add.js`, {
          method: "POST", headers: { Accept: "application/json" }, body: formData,
        });
        if (!response.ok) throw new Error("Gift could not be added. Please try another option.");
        status.textContent = settings.successMessage || "Free gift added.";
        window.setTimeout(() => window.location.reload(), 650);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Gift could not be added.";
        claim.disabled = false;
      }
    });
  };

  const show = (cart) => {
    const signature = cartSignature(cart);
    const paidSubtotal = cart.items.reduce((total, item) => isGiftItem(item) ? total : total + item.original_line_price, 0);
    const alreadyHasGift = cart.items.some(isGiftItem);
    if (!products.length || paidSubtotal < threshold || alreadyHasGift || sessionStorage.getItem("fgc-dismissed-cart") === signature) return;
    if (root.querySelector(".fgc-overlay")) return;

    root.style.setProperty("--fgc-background", settings.backgroundColor || "#FFFFFF");
    root.style.setProperty("--fgc-text", settings.textColor || "#111827");
    root.style.setProperty("--fgc-button", settings.buttonColor || "#EF0B18");
    root.style.setProperty("--fgc-button-text", settings.buttonTextColor || "#FFFFFF");
    root.style.setProperty("--fgc-overlay", settings.overlayColor || "#111827B3");
    root.insertAdjacentHTML("beforeend", `<div class="fgc-overlay" role="presentation">
      <section class="fgc-dialog" role="dialog" aria-modal="true" aria-labelledby="fgc-heading">
        <button class="fgc-close" type="button" aria-label="Close">&times;</button>
        <div class="fgc-header"><span class="fgc-gift">🎁</span><h2 class="fgc-heading" id="fgc-heading">YOU’VE UNLOCKED A FREE GIFT!</h2></div>
        <p class="fgc-subheading">${escapeHtml(settings.subheading || "Choose 1 gift below and add it to your cart.")}</p>
        <p class="fgc-urgency">◷ &nbsp; Limited quantities available. Claim yours while supplies last.</p>
        <div class="fgc-content"></div>
        <p class="fgc-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </section></div>`);
    root.hidden = false;
    document.documentElement.classList.add("fgc-lock");
    root.querySelector(".fgc-close")?.addEventListener("click", () => close(signature));
    root.querySelector(".fgc-overlay")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) close(signature); });
    root.onkeydown = (event) => { if (event.key === "Escape" && !root.hidden) close(signature); };
    root.querySelector(".fgc-close")?.focus();
    renderSelector(signature);
  };

  // The cart template's sections (cart-items, cart-footer, ...) plus Dawn's
  // header cart icon; Shopify renders at most five per request.
  const cartSections = () => {
    const sections = Array.from(document.querySelectorAll('.shopify-section[id^="shopify-section-template"]'))
      .filter((element) => /cart/i.test(element.id))
      .map((element) => ({ id: element.id.replace("shopify-section-", ""), target: element }));
    const cartIcon = document.getElementById("cart-icon-bubble");
    if (cartIcon) sections.push({ id: "cart-icon-bubble", target: cartIcon });
    return sections.slice(0, 5);
  };
  // Swaps in the freshly rendered sections. Returns false when the cart
  // sections didn't come back, so the caller falls back to a reload.
  const renderCartSections = (sections, updated) => {
    if (!sections.some((section) => section.id !== "cart-icon-bubble") || !updated.sections) return false;
    const parser = new DOMParser();
    const replacements = [];
    for (const section of sections) {
      const html = updated.sections[section.id];
      const source = html && parser.parseFromString(html, "text/html").querySelector(".shopify-section");
      if (!source) return false;
      replacements.push([section.target, source.innerHTML]);
    }
    replacements.forEach(([target, html]) => { target.innerHTML = html; });
    return true;
  };

  const checkCart = async () => {
    if (cartCheckInProgress || giftRemovalInProgress) return;
    cartCheckInProgress = true;
    try {
      const basePath = window.Shopify?.routes?.root || "/";
      const response = await fetch(`${basePath}cart.js`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const cart = await response.json();
      const paidSubtotal = cart.items.reduce(
        // Match the function's subtotal before discounts, so another promotion
        // cannot remove an otherwise eligible gift.
        (total, item) => isGiftItem(item) ? total : total + item.original_line_price,
        0,
      );
      const giftItems = cart.items.filter(isGiftItem);
      const eligible = paidSubtotal >= threshold;
      if (!eligible) {
        hidePopup();
        sessionStorage.removeItem("fgc-dismissed-cart");
      }

      // Below the minimum every gift goes; otherwise one unit of one gift
      // stays (the claimed line if there is one) and the rest go.
      const keep = eligible ? giftItems.find((item) => item.properties?._free_gift === "true") || giftItems[0] : null;
      const updates = {};
      giftItems.forEach((item) => {
        if (item !== keep) updates[item.key] = 0;
        else if (item.quantity > 1) updates[item.key] = 1;
      });
      if (Object.keys(updates).length) {
        giftRemovalInProgress = true;
        // Ask for the cart's own sections in the same request, so the extra
        // gift vanishes without a reload.
        const sections = cartSections();
        const removeResponse = await fetch(`${basePath}cart/update.js`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            updates,
            ...(sections.length ? { sections: sections.map((section) => section.id), sections_url: window.location.pathname } : {}),
          }),
        });
        // Refresh only when the cart really changed, so a refused update
        // can't loop the page.
        const updated = removeResponse.ok ? await removeResponse.json() : null;
        if (updated && updated.item_count !== cart.item_count) {
          if (!renderCartSections(sections, updated)) window.location.reload();
          else giftRemovalInProgress = false;
        } else giftRemovalInProgress = false;
        return;
      }
      if (!eligible) return;

      if (!giftItems.length) show(cart);
      else hidePopup();
    } catch {
      giftRemovalInProgress = false;
      // A later polling cycle retries temporary cart/network failures.
    } finally {
      cartCheckInProgress = false;
    }
  };

  checkCart();
  window.setInterval(checkCart, 1000);
})();
