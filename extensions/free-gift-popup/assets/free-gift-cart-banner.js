(() => {
  // The Theme Editor app embed is the storefront-wide master switch. Keep this
  // banner hidden and inactive whenever that embed is switched off.
  if (!document.querySelector("[data-free-gift-master]")) return;

  const roots = document.querySelectorAll(".fgcb-root:not([data-initialized])");
  roots.forEach((root) => {
    root.dataset.initialized = "true";
    const settingsNode = root.querySelector("[data-fgcb-settings]");
    const inventoryNode = root.querySelector("[data-fgcb-inventory]");
    let settings;
    try { settings = JSON.parse(settingsNode?.textContent || "{}"); } catch { return; }
    let liveInventory = {};
    try { liveInventory = JSON.parse(inventoryNode?.textContent || "{}"); } catch { liveInventory = {}; }

    const variants = Array.isArray(settings.products) ? settings.products.filter((variant) => {
      if (Object.prototype.hasOwnProperty.call(liveInventory, variant.variantId)) return liveInventory[variant.variantId] === true;
      if (variant.inventoryTracked && Number(variant.inventoryQuantity) <= 0) return false;
      return variant.availableForSale !== false;
    }) : [];
    if (!settings.enabled || variants.length === 0) return;

    const basePath = window.Shopify?.routes?.root || "/";
    const cartAddUrl = root.dataset.cartAddUrl || `${basePath}cart/add.js`;
    const cartUpdateUrl = root.dataset.cartUpdateUrl || `${basePath}cart/update.js`;
    const threshold = Number(settings.minimumSpend || 0);
    const giftVariantIds = new Set(variants.map((variant) => Number(variant.variantId.split("/").pop())));

    const escapeHtml = (value) => {
      const element = document.createElement("div");
      element.textContent = String(value || "");
      return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    };
    const formatMoney = (cents) => (Math.max(0, Number(cents) || 0) / 100).toFixed(2);
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

    const products = Array.from(variants.reduce((map, variant) => {
      if (!map.has(variant.productId)) map.set(variant.productId, {
        id: variant.productId, title: variant.productTitle, imageUrl: variant.imageUrl, variants: [],
      });
      map.get(variant.productId).variants.push(variant);
      return map;
    }, new Map()).values());

    let selectedProduct = products[0];
    let selectedVariant = selectedProduct.variants[0];
    let busy = false;

    const paidSubtotal = (cart) => cart.items.reduce(
      // Matches the popup and the server-side discount function: eligibility is
      // based on spend before discounts and excludes the free gift line itself.
      (total, item) => item.properties?._free_gift === "true" ? total : total + item.original_line_price, 0,
    );
    const claimedGift = (cart) => cart.items.find((item) => item.properties?._free_gift === "true" && giftVariantIds.has(item.variant_id));

    const render = (cart) => {
      const paid = paidSubtotal(cart);
      const claimed = claimedGift(cart);
      const pct = threshold > 0 ? Math.min(100, Math.max(0, (paid / threshold) * 100)) : 100;
      const unlocked = paid >= threshold;
      const remaining = Math.max(0, threshold - paid);

      const heading = claimed
        ? `You've claimed your <strong>FREE gift</strong>!`
        : unlocked
          ? `You've unlocked a <strong>FREE gift</strong>!`
          : `Add <strong>$${formatMoney(remaining)}</strong> more to unlock your <strong>FREE gift</strong>!`;

      const progress = `
        <div class="fgcb-progress">
          <div class="fgcb-track"><div class="fgcb-fill" style="width:${pct}%;"></div></div>
          <p class="fgcb-amounts">$${formatMoney(paid)}&nbsp;/&nbsp;$${formatMoney(threshold)}</p>
        </div>`;

      const cards = products.map((product, index) => {
        const isSelected = claimed ? claimed.product_id === Number(product.id.split("/").pop()) : product.id === selectedProduct.id;
        return `
        <button class="fgcb-product${isSelected ? " is-selected" : ""}" type="button" data-fgcb-product="${escapeHtml(product.id)}" ${unlocked && !claimed ? "" : "disabled"}>
          ${product.imageUrl ? `<img class="fgcb-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}">` : ""}
          <span class="fgcb-product-title">${escapeHtml(product.title)}</span><span class="fgcb-free">FREE</span>
        </button>${index < products.length - 1 ? `<span class="fgcb-or">OR</span>` : ""}`;
      }).join("");

      const groups = !claimed && unlocked ? optionGroups(selectedProduct) : [];
      const selectedValues = variantValues(selectedVariant);
      const options = groups.length ? `<div class="fgcb-variant-panel">${groups.map((group, groupIndex) => `
        <fieldset class="fgcb-option-group">
          <legend>Choose your ${escapeHtml(group.name.toLowerCase())}</legend>
          <div class="fgcb-options">${group.values.map((value) =>
            `<button class="fgcb-option${selectedValues[groupIndex] === value ? " is-selected" : ""}" type="button" data-option-index="${groupIndex}" data-option-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`
          ).join("")}</div>
        </fieldset>`).join("")}</div>` : "";

      const action = claimed
        ? `<p class="fgcb-claimed"><span class="fgcb-check" aria-hidden="true">&#10003;</span> ${escapeHtml(claimed.product_title)} added to your cart</p>
           <button class="fgcb-remove" type="button">Remove free gift</button>`
        : unlocked
          ? `<button class="fgcb-claim" type="button">CLAIM MY FREE GIFT</button><p class="fgcb-status" aria-live="polite"></p>`
          : `<p class="fgcb-hint">Keep shopping to unlock your free gift.</p>`;

      root.innerHTML = `<div class="fgcb-card">
        <div class="fgcb-left">
          <span class="fgcb-pill"><span class="fgcb-gift-icon" aria-hidden="true">&#127873;</span> FREE GIFT ${unlocked ? "UNLOCKED" : "AWAITS"}</span>
          <h2 class="fgcb-heading">${heading}</h2>
          ${progress}
        </div>
        <div class="fgcb-middle">
          <p class="fgcb-label">Your free gift options:</p>
          <div class="fgcb-products">${cards}</div>
          ${options}
          ${action}
        </div>
        <div class="fgcb-right">
          <ul class="fgcb-perks">
            <li>Spend $${Math.round(threshold / 100)}+</li>
            <li>Choose 1 free gift</li>
          </ul>
        </div>
      </div>`;
      root.hidden = false;

      root.querySelectorAll("[data-fgcb-product]").forEach((button) => button.addEventListener("click", () => {
        if (button.disabled) return;
        selectedProduct = products.find((product) => product.id === button.dataset.fgcbProduct) || products[0];
        selectedVariant = selectedProduct.variants[0];
        render(cart);
      }));
      root.querySelectorAll("[data-option-index]").forEach((button) => button.addEventListener("click", () => {
        const index = Number(button.dataset.optionIndex);
        const wanted = [...variantValues(selectedVariant)];
        wanted[index] = button.dataset.optionValue;
        selectedVariant = selectedProduct.variants.find((variant) => {
          const values = variantValues(variant);
          return wanted.every((value, optionIndex) => !value || values[optionIndex] === value);
        }) || selectedProduct.variants.find((variant) => variantValues(variant)[index] === button.dataset.optionValue) || selectedVariant;
        render(cart);
      }));
      root.querySelector(".fgcb-claim")?.addEventListener("click", () => addGift());
      root.querySelector(".fgcb-remove")?.addEventListener("click", () => removeGift(claimed));
    };

    const addGift = async () => {
      if (busy) return;
      busy = true;
      const button = root.querySelector(".fgcb-claim");
      const status = root.querySelector(".fgcb-status");
      if (button) button.disabled = true;
      try {
        const formData = new URLSearchParams({
          id: String(Number(selectedVariant.variantId.split("/").pop())),
          quantity: "1",
          "properties[_free_gift]": "true",
        });
        const response = await fetch(cartAddUrl, { method: "POST", headers: { Accept: "application/json" }, body: formData });
        if (!response.ok) throw new Error("Gift could not be added. Please try another option.");
        if (status) status.textContent = settings.successMessage || "Your free gift was added to the cart.";
        window.setTimeout(() => window.location.reload(), 500);
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : "Gift could not be added.";
        if (button) button.disabled = false;
        busy = false;
      }
    };
    const removeGift = async (item) => {
      if (busy || !item) return;
      busy = true;
      const button = root.querySelector(".fgcb-remove");
      if (button) button.disabled = true;
      try {
        const response = await fetch(cartUpdateUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ updates: { [item.key]: 0 } }),
        });
        if (!response.ok) throw new Error("Gift could not be removed.");
        window.location.reload();
      } catch {
        if (button) button.disabled = false;
        busy = false;
      }
    };

    const checkCart = async () => {
      try {
        const response = await fetch(`${basePath}cart.js`, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) return;
        const cart = await response.json();
        render(cart);
      } catch {
        // A later polling cycle retries temporary cart/network failures.
      }
    };

    checkCart();
    window.setInterval(checkCart, 2000);
  });
})();
