// Product page widget for Price gifts (spend tiers). The Free Gift Product
// Widget block loads this instead of free-gift-product-widget.js only while
// price gift settings are on (netgains10). Same card and CSS as the Free gift
// widget. It shows the gifts of the tier the shopper is working towards (all
// of them, e.g. 3 cards) and the next tier's offer; "Claim" opens the tier
// popup (tiered-gift-popup.js), which handles the choice, sizes and limits.
(() => {
  // The app embed is the master switch: without its popup there is nothing
  // to claim with, so the widget stays hidden.
  const popupRoot = document.getElementById("free-gift-cart-root");
  if (!popupRoot?.querySelector("[data-tiered-gift-settings]")) return;
  let live = {};
  try { live = JSON.parse(popupRoot.querySelector("[data-tiered-gift-inventory]")?.textContent || "{}") || {}; } catch { live = {}; }

  document.querySelectorAll(".fgpw-root[data-tiered]:not([data-initialized])").forEach((root) => {
    root.dataset.initialized = "true";
    let settings;
    try { settings = JSON.parse(root.querySelector("[data-fgpw-tiers]")?.textContent || "{}"); } catch { return; }
    if (!settings?.enabled || !Array.isArray(settings.tiers) || !settings.tiers.length) return;

    const basePath = window.Shopify?.routes?.root || "/";
    const numericId = (gid) => Number(String(gid || "").split("/").pop());
    const escapeHtml = (value) => {
      const element = document.createElement("div");
      element.textContent = String(value ?? "");
      return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    };
    // Tier minimums are US dollars; same rule as the popup and the banner.
    const shopCurrency = root.dataset.shopCurrency || "";
    const thresholdRate = (cartCurrency) => {
      if (cartCurrency === "USD") return 1;
      const currency = window.Shopify?.currency;
      if (shopCurrency === "USD" && currency?.active === cartCurrency) return Number(currency.rate) || 1;
      return 1;
    };
    const formatMoney = (cents, currency) => {
      const amount = Math.max(0, Number(cents) || 0) / 100;
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency", currency: currency || window.Shopify?.currency?.active || "USD", currencyDisplay: "narrowSymbol",
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(amount).replace(/[.,]00(?=\D*$)/, "");
      } catch {
        return "$" + amount.toFixed(2).replace(/\.00$/, "");
      }
    };

    // Tiers low to high, one card per gift product. Tier 2 is pick two.
    const tiers = settings.tiers.map((tier) => {
      const products = new Map();
      (tier.products || []).forEach((variant) => {
        if (!products.has(variant.productId)) products.set(variant.productId, {
          id: variant.productId, title: variant.productTitle,
          imageUrl: live[variant.variantId]?.productImage || variant.imageUrl, variantIds: new Set(),
        });
        products.get(variant.productId).variantIds.add(numericId(variant.variantId));
      });
      return { minimum: Number(tier.minimumSpend || 0), products: [...products.values()] };
    }).sort((a, b) => a.minimum - b.minimum).map((tier, index) => ({ ...tier, limit: index === 1 ? 2 : 1 }))
      // Tier 2 (pick two) chooses from the Tier 1 gifts plus its own, as in
      // the popup and the discount function.
      .map((tier, index, list) => tier.limit !== 2 ? tier : {
        ...tier,
        products: [...new Map(list.slice(0, index + 1).flatMap((candidate) => candidate.products)
          .map((product) => [product.id, product])).values()],
      });

    const tierVariantIds = new Set(tiers.flatMap((tier) => tier.products.flatMap((product) => [...product.variantIds])));
    const alwaysGiftProductIds = new Set([8708096557231, 8431587655855]);
    const isGiftItem = (item) => Boolean(item.properties?._tier_gift) || item.properties?._free_gift === "true" ||
      alwaysGiftProductIds.has(item.product_id) || (tierVariantIds.has(item.variant_id) && Number(item.original_price) === 0);
    // "any 2", or "BOTH" when the tier has two gifts.
    const pickText = (tier) => tier.limit === 1 ? "1 FREE gift" : tier.products.length > 2 ? "any 2 FREE gifts" : "BOTH FREE gifts";

    // What the widget says for this cart, or null to hide it.
    const stateFor = (cart) => {
      const rate = thresholdRate(cart?.currency);
      const items = cart?.items || [];
      const paid = items.reduce((total, item) => isGiftItem(item) ? total : total + item.original_line_price, 0);
      const thresholds = tiers.map((tier) => Math.round(tier.minimum * rate));
      const reached = thresholds.filter((threshold) => paid >= threshold).length;
      const giftProducts = new Set(items.filter((item) => item.properties?._tier_gift).map((item) => Number(item.product_id)));
      // Gifts claimed so far, counted across the tiers up to the reached one
      // (a Tier 1 gift counts as one of Tier 2's two).
      const claimed = new Set(tiers.slice(0, Math.max(reached, 1)).flatMap((tier) => tier.products)
        .filter((product) => giftProducts.has(numericId(product.id))).map((product) => product.id)).size;
      const money = (cents) => formatMoney(cents, cart?.currency);
      const first = tiers[0];
      const next = tiers[reached];
      if (reached === 0) {
        return {
          tier: first,
          title: `Unlock a <strong>FREE Gift</strong> on Orders <strong>${money(thresholds[0])}+</strong>`,
          subtitle: tiers[1]
            ? `Spend <strong>${money(thresholds[0])}+</strong> and choose <strong>1 FREE gift</strong>. Spend <strong>${money(thresholds[1])}+</strong> and choose <strong>any 2 FREE gifts</strong>.`
            : `Spend <strong>${money(thresholds[0])}+</strong> and choose <strong>1 FREE gift</strong>.`,
          claim: "locked", remaining: thresholds[0] - paid, money,
        };
      }
      const current = tiers[reached - 1];
      if (claimed < current.limit) {
        const left = current.limit - claimed;
        return {
          tier: current,
          title: `You've unlocked <strong>${left === 1 ? "1 FREE Gift" : `${left} FREE Gifts`}</strong>!`,
          subtitle: next
            ? `Choose your gift now, or spend <strong>${money(thresholds[reached] - paid)}</strong> more to choose <strong>${pickText(next)}</strong>.`
            : `Choose <strong>${left === 1 ? "1 more FREE gift" : pickText(current)}</strong> and add ${left === 1 ? "it" : "them"} to your cart.`,
          claim: "open", money,
        };
      }
      // This tier's gifts are in the cart: show the next tier, if any.
      if (!next) return null;
      return {
        tier: next,
        title: `Spend <strong>${money(thresholds[reached] - paid)}</strong> more to choose <strong>${pickText(next)}</strong>`,
        subtitle: next.limit === 2 ? "Your free gift is in your cart and counts as one of the two." : "Your free gift is in your cart.",
        claim: "none", money,
      };
    };

    let state = null;
    let lastHtml = "";
    const startedAt = Date.now();
    const timerText = () => {
      const remaining = Math.max(0, 600 - Math.floor((Date.now() - startedAt) / 1000));
      return `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    };
    const render = (cart) => {
      state = stateFor(cart);
      if (!state || !state.tier.products.length) { root.hidden = true; return; }
      const cards = state.tier.products.map((product) => `
        <div class="fgpw-product">
          <span class="fgpw-thumb">${product.imageUrl ? `<img class="fgpw-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}" loading="lazy">` : ""}</span>
          <span class="fgpw-info"><span class="fgpw-free">FREE GIFT</span><span class="fgpw-product-title">${escapeHtml(product.title)}</span></span>
        </div>`).join("");
      const html = `<div class="fgpw-card">
        <h2 class="fgpw-title">${state.title}</h2>
        <p class="fgpw-subtitle">${state.subtitle}</p>
        <div class="fgpw-body"><div class="fgpw-products${state.tier.products.length > 2 ? " fgpw-products--three" : ""}">${cards}</div></div>
        <div class="fgpw-bottom"><span class="fgpw-timer">◷ Limited-time offer · Ends in <b data-fgpw-timer>${timerText()}</b></span></div>
        <p class="fgpw-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </div>`;
      // Redraw only when something changed, so images don't blink.
      if (html.replace(/data-fgpw-timer>[^<]*/, "") !== lastHtml) {
        root.innerHTML = html;
        lastHtml = html.replace(/data-fgpw-timer>[^<]*/, "");
      }
      root.hidden = false;
    };

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
    window.setInterval(() => {
      const timer = root.querySelector("[data-fgpw-timer]");
      if (timer) timer.textContent = timerText();
    }, 1000);
  });
})();
