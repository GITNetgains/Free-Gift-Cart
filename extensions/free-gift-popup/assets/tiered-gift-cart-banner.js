// Cart page progress banner for Price gifts (spend tiers). The Free Gift
// Progress Bar block loads this instead of free-gift-cart-banner.js only while
// price gift settings are on (app/routes/app.price-gifts.tsx). Same markup and
// CSS as the Free gift banner:
//   below Tier 1                  -> progress to Tier 1, Tier 1 gifts
//   a tier reached, gift not yet  -> "unlocked", full bar, that tier's gifts
//   its gift in the cart          -> progress to the next tier, its gifts
//                                    (prices and bar against that tier)
//   top tier's gift in the cart   -> hidden
//   past a tier's maximum (gap)   -> progress to the next tier ("unlock")
(() => {
  document.querySelectorAll(".fgcb-root[data-tiered]:not([data-initialized])").forEach((root) => {
    root.dataset.initialized = "true";
    let settings;
    try { settings = JSON.parse(root.querySelector("[data-fgcb-tiers]")?.textContent || "{}"); } catch { return; }
    if (!settings?.enabled || !Array.isArray(settings.tiers) || !settings.tiers.length) return;

    const basePath = window.Shopify?.routes?.root || "/";
    const numericId = (gid) => Number(String(gid || "").split("/").pop());
    // Tier minimums are US dollars; same rule as tiered-gift-popup.js and the
    // tiered-gift-discount function.
    const shopCurrency = root.dataset.shopCurrency || "";
    const thresholdRate = (cartCurrency) => {
      if (cartCurrency === "USD") return 1;
      if (shopCurrency === "USD") return Number(window.Shopify?.currency?.rate) || 1;
      return 1;
    };
    const escapeHtml = (value) => {
      const element = document.createElement("div");
      element.textContent = String(value || "");
      return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    };
    const formatMoney = (cents, currency) => {
      const amount = Math.max(0, Number(cents) || 0) / 100;
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency", currency: currency || window.Shopify?.currency?.active || "USD", currencyDisplay: "narrowSymbol",
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(amount);
      } catch {
        return "$" + amount.toFixed(2);
      }
    };

    // Tiers low to high with their gift products (one card per product).
    const tiers = settings.tiers.map((tier) => {
      const products = new Map();
      (tier.products || []).forEach((variant) => {
        if (variant.availableForSale === false) return;
        if (!products.has(variant.productId)) products.set(variant.productId, {
          id: variant.productId, title: variant.productTitle, imageUrl: variant.imageUrl, variantIds: new Set(),
        });
        products.get(variant.productId).variantIds.add(numericId(variant.variantId));
      });
      return {
        id: tier.id, minimum: Number(tier.minimumSpend || 0), products: [...products.values()],
        maximum: tier.maximumSpend == null || tier.maximumSpend === "" ? null : Number(tier.maximumSpend),
      };
    }).sort((a, b) => a.minimum - b.minimum);

    // Gift lines don't count toward the total, as in the popup.
    const tierVariantIds = new Set(tiers.flatMap((tier) => tier.products.flatMap((product) => [...product.variantIds])));
    const alwaysGiftProductIds = new Set([8708096557231, 8431587655855]);
    const isGiftItem = (item) => Boolean(item.properties?._tier_gift) || item.properties?._free_gift === "true" ||
      alwaysGiftProductIds.has(item.product_id) || (tierVariantIds.has(item.variant_id) && Number(item.original_price) === 0);
    const paidSubtotal = (cart) => cart.items.reduce((total, item) => isGiftItem(item) ? total : total + item.original_line_price, 0);

    const giftIcon = `<svg class="fgcb-gift-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20 7h-2.18A3 3 0 0 0 12 3.76 3 3 0 0 0 6.18 7H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h7V7h2v5h7a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1ZM9 7a1 1 0 1 1 1-1v1H9Zm6 0h-1V6a1 1 0 1 1 1 1ZM4 13v7a1 1 0 0 0 1 1h6v-8H4Zm9 8h6a1 1 0 0 0 1-1v-7h-7v8Z"/></svg>`;

    const render = (cart) => {
      const rate = thresholdRate(cart.currency);
      const paid = paidSubtotal(cart);
      const thresholds = tiers.map((tier) => Math.round(tier.minimum * rate));
      const reached = thresholds.filter((threshold) => paid >= threshold).length; // tiers unlocked
      const hasGift = cart.items.some((item) => Boolean(item.properties?._tier_gift) || (tierVariantIds.has(item.variant_id) && Number(item.original_price) === 0));

      // Past the reached tier's maximum (a gap before the next tier) no tier
      // applies, so the banner counts toward the next one.
      const current = reached > 0 ? tiers[reached - 1] : null;
      const pastMax = Boolean(current && current.maximum != null && paid > Math.round(current.maximum * rate));

      // Which tier the banner is about: the reached tier while its gift is
      // still to be chosen, otherwise the next tier to unlock.
      const unlocked = reached > 0 && !pastMax && !hasGift;
      if (!unlocked && reached === tiers.length) { root.hidden = true; return; }
      const index = unlocked ? reached - 1 : reached;
      const target = tiers[index];
      const targetThreshold = thresholds[index];
      if (!target.products.length) { root.hidden = true; return; }

      const remaining = Math.max(0, targetThreshold - paid);
      const pct = unlocked ? 100 : targetThreshold > 0 ? Math.min(100, Math.max(0, (paid / targetThreshold) * 100)) : 100;
      const money = (cents) => formatMoney(cents, cart.currency);
      const upgrade = !unlocked && reached > 0 && !pastMax;
      const pill = unlocked
        ? (tiers.length > 1 ? `TIER ${index + 1} UNLOCKED` : "FREE GIFT UNLOCKED")
        : upgrade ? `UPGRADE TO TIER ${index + 1}` : "FREE GIFT AWAITS";
      const heading = unlocked
        ? `You've unlocked your <strong>FREE</strong> gift!`
        : upgrade
          ? `Add <strong>${money(remaining)}</strong> more to upgrade your <strong>FREE</strong> gift!`
          : `Add <strong>${money(remaining)}</strong> more to unlock your <strong>FREE</strong> gift!`;
      const label = upgrade ? "Upgrade to" : "Choose your gift";

      const cards = target.products.map((product, index) => `
        <div class="fgcb-product">
          ${product.imageUrl ? `<img class="fgcb-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}">` : ""}
          <div class="fgcb-product-info"><span class="fgcb-product-title">${escapeHtml(product.title)}</span><span class="fgcb-free">FREE</span></div>
        </div>${index < target.products.length - 1 ? `<span class="fgcb-or"><span>OR</span></span>` : ""}`).join("");
      // Unlocked: the link opens the gift popup (tiered-gift-popup.js),
      // even after the shopper closed it. Otherwise: keep shopping.
      const continueLink = (placement) => unlocked
        ? `<a class="fgcb-continue fgcb-continue--${placement}" href="#" data-open-gift>Choose your free gift <span aria-hidden="true">&rarr;</span></a>`
        : `<a class="fgcb-continue fgcb-continue--${placement}" href="${escapeHtml(basePath)}collections/all">Continue shopping <span aria-hidden="true">&rarr;</span></a>`;

      root.innerHTML = `<div class="fgcb-card">
        <div class="fgcb-left">
          <span class="fgcb-pill">${giftIcon} ${pill}</span>
          <h2 class="fgcb-heading">${heading}</h2>
          <div class="fgcb-progress">
            <div class="fgcb-track"><div class="fgcb-fill" style="width:${pct}%;"></div></div>
            <p class="fgcb-amounts">${money(paid)}&nbsp;/&nbsp;${money(targetThreshold)}</p>
          </div>
          ${continueLink("desktop")}
        </div>
        <div class="fgcb-middle">
          <p class="fgcb-label">${label}</p>
          <div class="fgcb-products">${cards}</div>
        </div>
        ${continueLink("mobile")}
        <p class="fgcb-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </div>`;
      root.hidden = false;
    };

    root.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("[data-open-gift]") : null;
      if (!link) return;
      event.preventDefault();
      document.dispatchEvent(new CustomEvent("fgc:open-gift"));
    });

    const checkCart = async () => {
      try {
        const response = await fetch(`${basePath}cart.js`, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) return;
        render(await response.json());
      } catch {
        // The next poll retries network failures.
      }
    };

    checkCart();
    window.setInterval(checkCart, 2000);
  });
})();
