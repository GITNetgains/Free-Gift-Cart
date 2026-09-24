(() => {
  // The Theme Editor app embed is the storefront-wide master switch. Keep the
  // product block hidden and inactive whenever that embed is switched off.
  if (!document.querySelector("[data-free-gift-master]")) return;

  const roots = document.querySelectorAll(".fgpw-root:not([data-initialized])");
  roots.forEach((root) => {
    root.dataset.initialized = "true";
    const settingsNode = root.querySelector("[data-fgpw-settings]");
    const inventoryNode = root.querySelector("[data-fgpw-inventory]");
    let settings;
    try { settings = JSON.parse(settingsNode?.textContent || "{}"); } catch { return; }
    let liveInventory = {};
    try { liveInventory = JSON.parse(inventoryNode?.textContent || "{}"); } catch { liveInventory = {}; }
    // The product's current featured image from Liquid, so reordering media in
    // Shopify admin shows up without re-saving the gift settings.
    let liveImages = {};
    try { liveImages = JSON.parse(root.querySelector("[data-fgpw-images]")?.textContent || "{}"); } catch { liveImages = {}; }
    const variants = Array.isArray(settings.products) ? settings.products.filter((variant) => {
      if (Object.prototype.hasOwnProperty.call(liveInventory, variant.variantId)) return liveInventory[variant.variantId] === true;
      if (variant.inventoryTracked && Number(variant.inventoryQuantity) <= 0) return false;
      return variant.availableForSale !== false;
    }) : [];
    if (!settings.enabled || variants.length === 0) return;

    const escapeHtml = (value) => {
      const element = document.createElement("div");
      element.textContent = String(value || "");
      return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    };
    const products = Array.from(variants.reduce((map, variant) => {
      if (!map.has(variant.productId)) map.set(variant.productId, {
        id: variant.productId, title: variant.productTitle, imageUrl: liveImages[variant.productId] || variant.imageUrl, variants: [],
      });
      map.get(variant.productId).variants.push(variant);
      return map;
    }, new Map()).values());
    let selectedProduct = products[0];
    let selectedVariant = selectedProduct.variants[0];
    const startedAt = Date.now();
    const render = () => {
      const productCards = products.map((product) => `
        <button class="fgpw-product${product.id === selectedProduct.id ? " is-selected" : ""}" type="button" data-fgpw-product="${escapeHtml(product.id)}">
          ${product.imageUrl ? `<img class="fgpw-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}" loading="lazy">` : ""}
          <span class="fgpw-product-title">${escapeHtml(product.title)}</span><span class="fgpw-free">FREE</span>
        </button>`).join("");
      const threshold = Math.round(Number(settings.minimumSpend || 0) / 100);
      root.innerHTML = `<div class="fgpw-card">
        <h2 class="fgpw-title">Unlock a <strong>FREE Gift</strong> on Orders <strong>$${threshold}+</strong></h2>
        <p class="fgpw-subtitle">Choose 1 free gift below and add it to your cart.</p>
        <div class="fgpw-body"><div class="fgpw-products">${productCards}</div></div>
        <div class="fgpw-bottom"><span class="fgpw-timer">◷ Limited-time offer · Ends in <b data-fgpw-timer>10:00</b></span></div>
        <button class="fgpw-claim" type="button">🎁 &nbsp; CLAIM MY FREE GIFT</button><p class="fgpw-status" aria-live="polite"></p>
      </div>`;
      root.hidden = false;

      root.querySelectorAll("[data-fgpw-product]").forEach((button) => button.addEventListener("click", () => {
        selectedProduct = products.find((product) => product.id === button.dataset.fgpwProduct) || products[0];
        selectedVariant = selectedProduct.variants[0];
        render();
      }));
      root.querySelector(".fgpw-claim")?.addEventListener("click", claimGift);
      updateTimer();
    };

    const updateTimer = () => {
      const remaining = Math.max(0, 600 - Math.floor((Date.now() - startedAt) / 1000));
      const timer = root.querySelector("[data-fgpw-timer]");
      if (timer) timer.textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    };
    const claimGift = async () => {
      const button = root.querySelector(".fgpw-claim");
      const status = root.querySelector(".fgpw-status");
      button.disabled = true;
      try {
        const cartResponse = await fetch(`${window.Shopify?.routes?.root || "/"}cart.js`, { headers: { Accept: "application/json" } });
        if (!cartResponse.ok) throw new Error("Cart could not be checked.");
        const cart = await cartResponse.json();
        // Gift eligibility uses spend before discounts, matching the cart popup
        // and the server-side discount function.
        const paidSubtotal = cart.items.reduce((total, item) => item.properties?._free_gift === "true" ? total : total + item.original_line_price, 0);
        if (paidSubtotal < Number(settings.minimumSpend || 0)) {
          const remaining = (Number(settings.minimumSpend || 0) - paidSubtotal) / 100;
          throw new Error(`Add $${remaining.toFixed(2)} more to unlock your free gift.`);
        }
        if (cart.items.some((item) => item.properties?._free_gift === "true")) throw new Error("A free gift is already in your cart.");
        const formData = new URLSearchParams({
          id: String(Number(selectedVariant.variantId.split("/").pop())),
          quantity: "1",
          "properties[_free_gift]": "true",
        });
        const response = await fetch(`${window.Shopify?.routes?.root || "/"}cart/add.js`, {
          method: "POST", headers: { Accept: "application/json" }, body: formData,
        });
        if (!response.ok) throw new Error("Gift could not be added. Please try again.");
        status.textContent = settings.successMessage || "Your free gift was added to the cart.";
        window.setTimeout(() => { window.location.href = root.dataset.cartPath || "/cart"; }, 500);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Gift could not be added.";
        button.disabled = false;
      }
    };

    render();
    window.setInterval(updateTimer, 1000);
  });
})();
