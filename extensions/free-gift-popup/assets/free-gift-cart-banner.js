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
    // minimumSpend is saved in the shop currency (USD) while cart.js amounts are in
    // the buyer's currency, so convert it with the storefront's active rate.
    const threshold = Math.round(Number(settings.minimumSpend || 0) * (Number(window.Shopify?.currency?.rate) || 1));

    const escapeHtml = (value) => {
      const element = document.createElement("div");
      element.textContent = String(value || "");
      return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    };
    const formatMoney = (cents, digits = 2) => {
      const amount = Math.max(0, Number(cents) || 0) / 100;
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency", currency: window.Shopify?.currency?.active || "USD", currencyDisplay: "narrowSymbol",
          minimumFractionDigits: digits, maximumFractionDigits: digits,
        }).format(digits ? amount : Math.ceil(amount));
      } catch {
        return "$" + (digits ? amount : Math.ceil(amount)).toFixed(digits);
      }
    };

    // One entry per gift product; variants are picked in the popup, not here.
    const products = Array.from(variants.reduce((map, variant) => {
      if (!map.has(variant.productId)) map.set(variant.productId, {
        id: variant.productId, title: variant.productTitle, imageUrl: variant.imageUrl,
      });
      return map;
    }, new Map()).values());

    const giftIcon = `<svg class="fgcb-gift-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20 7h-2.18A3 3 0 0 0 12 3.76 3 3 0 0 0 6.18 7H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h7V7h2v5h7a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1ZM9 7a1 1 0 1 1 1-1v1H9Zm6 0h-1V6a1 1 0 1 1 1 1ZM4 13v7a1 1 0 0 0 1 1h6v-8H4Zm9 8h6a1 1 0 0 0 1-1v-7h-7v8Z"/></svg>`;

    const paidSubtotal = (cart) => cart.items.reduce(
      // Matches the popup and the server-side discount function: eligibility is
      // based on spend before discounts and excludes the free gift line itself.
      (total, item) => item.properties?._free_gift === "true" ? total : total + item.original_line_price, 0,
    );

    const render = (cart) => {
      // Like the product page widget: hide the banner while a free gift is in
      // the cart, and bring it back once the gift is removed.
      if (cart.items.some((item) => item.properties?._free_gift === "true")) {
        root.hidden = true;
        return;
      }

      const paid = paidSubtotal(cart);
      const pct = threshold > 0 ? Math.min(100, Math.max(0, (paid / threshold) * 100)) : 100;
      const unlocked = paid >= threshold;
      const remaining = Math.max(0, threshold - paid);

      const heading = unlocked
        ? `You've unlocked your <strong>FREE</strong> gift!`
        : `Add <strong>${formatMoney(remaining)}</strong> more to unlock your <strong>FREE</strong> gift!`;

      const progress = `
        <div class="fgcb-progress">
          <div class="fgcb-track"><div class="fgcb-fill" style="width:${pct}%;"></div></div>
          <p class="fgcb-amounts">${formatMoney(paid)}&nbsp;/&nbsp;${formatMoney(threshold)}</p>
        </div>`;

      // Display-only cards: gift options and variants are chosen in the popup.
      const cards = products.map((product, index) => `
        <div class="fgcb-product">
          ${product.imageUrl ? `<img class="fgcb-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}">` : ""}
          <div class="fgcb-product-info"><span class="fgcb-product-title">${escapeHtml(product.title)}</span><span class="fgcb-free">FREE</span></div>
        </div>${index < products.length - 1 ? `<span class="fgcb-or"><span>OR</span></span>` : ""}`).join("");

      // Rendered twice: beside the progress bar on desktop, below the gifts on mobile (CSS picks one).
      const continueLink = (placement) =>
        `<a class="fgcb-continue fgcb-continue--${placement}" href="${escapeHtml(basePath)}collections/all">Continue shopping <span aria-hidden="true">&rarr;</span></a>`;

      root.innerHTML = `<div class="fgcb-card">
        <div class="fgcb-left">
          <span class="fgcb-pill">${giftIcon} FREE GIFT ${unlocked ? "UNLOCKED" : "AWAITS"}</span>
          <h2 class="fgcb-heading">${heading}</h2>
          ${progress}
          ${continueLink("desktop")}
        </div>
        <div class="fgcb-middle">
          <p class="fgcb-label">Choose your gift</p>
          <div class="fgcb-products">${cards}</div>
        </div>
        ${continueLink("mobile")}
        <p class="fgcb-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </div>`;
      root.hidden = false;
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
