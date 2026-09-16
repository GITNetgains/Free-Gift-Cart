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
  const variants = Array.isArray(settings.products) ? settings.products.filter((variant) => {
    if (Object.prototype.hasOwnProperty.call(liveInventory, variant.variantId)) return liveInventory[variant.variantId] === true;
    if (variant.inventoryTracked && Number(variant.inventoryQuantity) <= 0) return false;
    return variant.availableForSale !== false;
  }) : [];
  if (!settings.enabled || variants.length === 0) return;

  const escapeHtml = (value) => {
    const element = document.createElement("div");
    element.textContent = String(value || "");
    return element.innerHTML;
  };
  const products = Array.from(variants.reduce((map, variant) => {
    if (!map.has(variant.productId)) map.set(variant.productId, {
      id: variant.productId, title: variant.productTitle,
      imageUrl: variant.imageUrl, variants: [],
    });
    map.get(variant.productId).variants.push(variant);
    return map;
  }, new Map()).values());
  const giftVariantIds = new Set(variants.map((variant) => Number(variant.variantId.split("/").pop())));
  let selectedProduct = products[0];
  let selectedVariant = selectedProduct.variants[0];

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

  const renderSelector = (signature) => {
    const groups = optionGroups(selectedProduct);
    const selectedValues = variantValues(selectedVariant);
    const cards = products.map((product) => {
      const displayedVariant = product.id === selectedProduct.id ? selectedVariant : product.variants[0];
      const displayedImage = displayedVariant?.imageUrl || product.imageUrl;
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
      ${groups.length ? `<div class="fgc-variant-panel">${options}<p class="fgc-selected">Selected: ${escapeHtml(selectedValues.join(" / "))}</p></div>` : ""}
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
        const response = await fetch(`${window.Shopify?.routes?.root || "/"}cart/add.js`, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ items: [{ id: Number(selectedVariant.variantId.split("/").pop()), quantity: 1, properties: { _free_gift: "true" } }] }),
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
    const paidSubtotal = cart.items.reduce((total, item) => item.properties?._free_gift === "true" ? total : total + item.final_line_price, 0);
    const alreadyHasGift = cart.items.some((item) => item.properties?._free_gift === "true" && giftVariantIds.has(item.variant_id));
    if (paidSubtotal < Number(settings.minimumSpend || 0) || alreadyHasGift || sessionStorage.getItem("fgc-dismissed-cart") === signature) return;

    root.style.setProperty("--fgc-background", settings.backgroundColor || "#FFFFFF");
    root.style.setProperty("--fgc-text", settings.textColor || "#111827");
    root.style.setProperty("--fgc-button", settings.buttonColor || "#EF0B18");
    root.style.setProperty("--fgc-button-text", settings.buttonTextColor || "#FFFFFF");
    root.style.setProperty("--fgc-overlay", settings.overlayColor || "#111827B3");
    const threshold = Math.round(Number(settings.minimumSpend || 0) / 100);
    root.insertAdjacentHTML("beforeend", `<div class="fgc-overlay" role="presentation">
      <section class="fgc-dialog" role="dialog" aria-modal="true" aria-labelledby="fgc-heading">
        <button class="fgc-close" type="button" aria-label="Close">&times;</button>
        <div class="fgc-header"><span class="fgc-gift">🎁</span><span class="fgc-unlocked">YOU’VE UNLOCKED A FREE GIFT!</span></div>
        <h2 class="fgc-heading" id="fgc-heading">Your $${threshold}+ order qualifies for a free gift.</h2>
        <p class="fgc-subheading">${escapeHtml(settings.subheading || "Choose 1 gift below and add it to your cart.")}</p>
        <p class="fgc-urgency">◷ &nbsp; Limited quantities available. Claim yours while supplies last.</p>
        <div class="fgc-content"></div>
      </section></div>`);
    root.hidden = false;
    document.documentElement.classList.add("fgc-lock");
    root.querySelector(".fgc-close")?.addEventListener("click", () => close(signature));
    root.querySelector(".fgc-overlay")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) close(signature); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !root.hidden) close(signature); }, { once: true });
    renderSelector(signature);
  };

  fetch(`${window.Shopify?.routes?.root || "/"}cart.js`, { headers: { Accept: "application/json" } })
    .then((response) => response.ok ? response.json() : Promise.reject()).then(show).catch(() => {});
})();
