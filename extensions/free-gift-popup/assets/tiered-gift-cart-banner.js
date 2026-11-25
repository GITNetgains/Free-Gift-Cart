// Cart page progress banner for Price gifts (spend tiers). The Free Gift
// Progress Bar block loads this instead of free-gift-cart-banner.js only while
// price gift settings are on (app/routes/app.price-gifts.tsx). Same markup and
// CSS as the Free gift banner:
//   below Tier 1                  -> progress to Tier 1, Tier 1 gifts
//   a tier reached, gift not yet  -> "unlocked", full bar, that tier's gifts
//   its gift(s) in the cart       -> progress to the next tier, its gifts
//                                    ("all" tiers: every gift, joined by "+")
//                                    (prices and bar against that tier)
//   top tier's gift in the cart   -> hidden
//   past a tier's maximum (gap)   -> progress to the next tier ("unlock")
(() => {
  const initialize = () => document.querySelectorAll(".fgcb-root[data-tiered]:not([data-initialized])").forEach((root) => {
    root.dataset.initialized = "true";
    let settings;
    try { settings = JSON.parse(root.querySelector("[data-fgcb-tiers]")?.textContent || "{}"); } catch { return; }
    if (!settings?.enabled || !Array.isArray(settings.tiers) || !settings.tiers.length) return;

    const basePath = window.Shopify?.routes?.root || "/";
    // Styles for the next-tier hint. Kept here, not in the shared banner CSS,
    // so the Free gift banner on other stores is untouched.
    if (!document.getElementById("fgcb-tier-style")) {
      const style = document.createElement("style");
      style.id = "fgcb-tier-style";
      style.textContent = ".fgcb-alt{align-items:center;color:#8a8f9c;display:flex;font-size:12px;font-weight:800;gap:10px;letter-spacing:.08em;margin:8px 0 6px;max-width:420px}.fgcb-alt::before,.fgcb-alt::after{background:#e4e7ec;content:\"\";flex:1 1 auto;height:1px}.fgcb-hint{color:#0f1b3d;display:block;font-family:inherit;font-size:clamp(17px,1.36cqi,22px);font-weight:800;letter-spacing:-.02em;line-height:1.2;margin:8px 0 0;word-spacing:normal}.fgcb-alt+.fgcb-hint{margin-top:0}.fgcb-hint .fgcb-gift-icon{display:inline-block;height:.9em;margin:0 6px -.1em 0;vertical-align:baseline;width:.9em}.fgcb-hint strong{color:#ef0b18;font-weight:800}.fgcb-heading .fgcb-gift-icon{display:inline-block;height:.9em;margin:0 6px -.1em 0;vertical-align:baseline;width:.9em}.fgcb-next{border-top:1px solid #e4e7ec;margin-top:16px;padding-top:14px}.fgcb-next-text{color:#0f1b3d;font-size:clamp(15px,1.1cqi,18px);font-weight:700;margin:10px 0 0}";
      style.textContent += ".fgcb-root[data-tiered] .fgcb-heading{font-size:clamp(17px,1.4cqi,22px);font-weight:750;line-height:1.3;letter-spacing:-.02em;margin:12px 0 8px}.fgcb-root[data-tiered] .fgcb-hint{font-size:14px;font-weight:500;line-height:1.55;letter-spacing:normal;color:#475467;margin:0 0 14px}.fgcb-root[data-tiered] .fgcb-hint .fgcb-gift-icon{display:none}.fgcb-root[data-tiered] .fgcb-pill{font-size:11px;letter-spacing:.07em}.fgcb-root[data-tiered] .fgcb-amounts{font-size:12px;color:#667085}.fgcb-root[data-tiered] .fgcb-label{font-size:15px;font-weight:700;margin-bottom:12px}";
      style.textContent += ".fgcb-root[data-tiered] .fgcb-amounts{display:flex;flex-wrap:wrap;gap:6px 16px;white-space:normal;line-height:1.5}.fgcb-root[data-tiered] .fgcb-amounts strong{font-weight:700}";
      // The "OR" offer line under the heading reads like the heading itself.
      style.textContent += ".fgcb-root[data-tiered] .fgcb-hint.fgcb-hint--alt{color:#0f1b3d;font-size:clamp(17px,1.4cqi,22px);font-weight:750;letter-spacing:-.02em;line-height:1.3;margin:0 0 8px}.fgcb-root[data-tiered] .fgcb-hint--alt strong{color:#ef0b18;font-weight:800}";
      style.textContent += "\n.fgcb-root[data-tiered] .fgcb-card--three { grid-template-columns: minmax(0, .85fr) minmax(0, 1.35fr); gap: 20px; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-middle { min-width: 0; padding-left: 20px; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-products { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 12px; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-product { flex-direction: column; justify-content: flex-start; padding: 12px 8px; text-align: center; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-product-info { align-items: center; width: 100%; gap: 10px; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-image { width: 80px; height: 80px; max-width: 100%; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-product-title { font-size: 13px; line-height: 1.4; overflow-wrap: break-word; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-free { margin-top: auto; }\n.fgcb-root[data-tiered] .fgcb-card--three .fgcb-or { display: none; }\n@container (max-width: 900px) {\n .fgcb-root[data-tiered] .fgcb-card--three { grid-template-columns: minmax(0, 1fr); }\n .fgcb-root[data-tiered] .fgcb-card--three .fgcb-middle { border-left: 0; border-top: 1px solid #dfe2e8; padding: 16px 0 0; }\n}\n@container (max-width: 440px) {\n .fgcb-root[data-tiered] .fgcb-card--three .fgcb-products { grid-template-columns: minmax(0, 1fr); gap: 8px; }\n .fgcb-root[data-tiered] .fgcb-card--three .fgcb-product { flex-direction: row; text-align: left; gap: 12px; }\n .fgcb-root[data-tiered] .fgcb-card--three .fgcb-product-info { align-items: flex-start; width: auto; }\n .fgcb-root[data-tiered] .fgcb-card--three .fgcb-image { width: 64px; height: 64px; }\n}\n";
      // Tighter, cleaner banner: less padding, smaller gift cards with
      // two-line titles that line up, compact "SPEND $350+" box.
      style.textContent += `
.fgcb-root[data-tiered] .fgcb-card { align-items: center; column-gap: 24px; padding: 14px 20px 12px; row-gap: 8px; }
.fgcb-root[data-tiered] .fgcb-middle { padding-left: 24px; }
.fgcb-root[data-tiered] .fgcb-pill { padding: 5px 10px; }
.fgcb-root[data-tiered] .fgcb-heading { margin: 10px 0 6px; }
.fgcb-root[data-tiered] .fgcb-alt { margin: 4px 0; }
.fgcb-root[data-tiered] .fgcb-hint.fgcb-hint--alt { margin: 0 0 4px; }
.fgcb-root[data-tiered] .fgcb-progress { gap: 6px; margin-top: 10px; }
.fgcb-root[data-tiered] .fgcb-continue { margin-top: 12px; min-height: 40px; }
.fgcb-root[data-tiered] .fgcb-label { font-size: 14px; margin-bottom: 8px; }
.fgcb-root[data-tiered] .fgcb-products { gap: 10px; }
.fgcb-root[data-tiered] .fgcb-product { gap: 8px; padding: 8px 10px; }
.fgcb-root[data-tiered] .fgcb-product-info { gap: 6px; }
.fgcb-root[data-tiered] .fgcb-product-title { font-size: 12.5px; line-height: 1.3; }
.fgcb-root[data-tiered] .fgcb-free { font-size: 11px; padding: 4px 12px; }
.fgcb-root[data-tiered] .fgcb-card--three .fgcb-products { gap: 10px; }
.fgcb-root[data-tiered] .fgcb-card--three .fgcb-product { gap: 6px; padding: 8px 8px 10px; }
.fgcb-root[data-tiered] .fgcb-card--three .fgcb-image { height: 72px; width: 72px; }
.fgcb-root[data-tiered] .fgcb-card--three .fgcb-product-title { font-size: 12.5px; min-height: 2.6em; }
.fgcb-root[data-tiered] .fgcb-next { align-items: center; display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 10px; padding-top: 10px; }
.fgcb-root[data-tiered] .fgcb-next .fgcb-pill { font-size: 10px; padding: 4px 8px; }
.fgcb-root[data-tiered] .fgcb-next-text { font-size: 14px; margin: 0; }
.fgcb-root[data-tiered] .fgcb-card .fgcb-footer { font-size: 11px; }
@container (max-width: 760px) {
  .fgcb-root[data-tiered] .fgcb-card { padding: 14px; }
  .fgcb-root[data-tiered] .fgcb-middle { padding: 12px 0 0; }
  .fgcb-root[data-tiered] .fgcb-card--three .fgcb-product-title { min-height: 0; }
}
@container (max-width: 440px) {
  .fgcb-root[data-tiered] .fgcb-card--three .fgcb-image { height: 56px; width: 56px; }
}
/* Even tighter: no empty band between a gift's title and its FREE tag,
   both columns start at the top, smaller gaps around every row. */
.fgcb-root[data-tiered] .fgcb-card { align-items: start; padding: 12px 18px 10px; row-gap: 6px; }
.fgcb-root[data-tiered] .fgcb-middle { justify-content: flex-start; }
.fgcb-root[data-tiered] .fgcb-heading { margin: 8px 0 4px; }
.fgcb-root[data-tiered] .fgcb-alt { margin: 2px 0; }
.fgcb-root[data-tiered] .fgcb-progress { margin-top: 8px; }
.fgcb-root[data-tiered] .fgcb-continue { margin-top: 10px; min-height: 38px; }
.fgcb-root[data-tiered] .fgcb-label { margin-bottom: 6px; }
.fgcb-root[data-tiered] .fgcb-card--three .fgcb-product { justify-content: flex-start; padding: 8px 8px; }
.fgcb-root[data-tiered] .fgcb-card--three .fgcb-image { height: 64px; width: 64px; }
.fgcb-root[data-tiered] .fgcb-card--three .fgcb-product-info { flex: 0 0 auto; gap: 6px; justify-content: flex-start; }
.fgcb-root[data-tiered] .fgcb-next { margin-top: 8px; padding-top: 8px; }
@container (max-width: 760px) {
  /* Stacked cards: the title wraps inside the card instead of running past it. */
  .fgcb-root[data-tiered] .fgcb-card--three .fgcb-product-info { flex: 1 1 auto; min-width: 0; }
}
`;
      document.head?.appendChild(style);
    }
    const numericId = (gid) => Number(String(gid || "").split("/").pop());
    // Tier minimums are US dollars; same rule as tiered-gift-popup.js and the
    // tiered-gift-discount function.
    const shopCurrency = root.dataset.shopCurrency || "";
    const thresholdRate = (cartCurrency) => {
      if (cartCurrency === "USD") return 1;
      const currency = window.Shopify?.currency;
      if (shopCurrency === "USD" && currency?.active === cartCurrency) return Number(currency.rate) || 1;
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

        if (!products.has(variant.productId)) products.set(variant.productId, {
          id: variant.productId, title: variant.productTitle, imageUrl: variant.imageUrl, variantIds: new Set(),
        });
        products.get(variant.productId).variantIds.add(numericId(variant.variantId));
      });
      return {
        id: tier.id,
        mode: tier.mode,
        minimum: Number(tier.minimumSpend || 0), products: [...products.values()],
        maximum: tier.maximumSpend == null || tier.maximumSpend === "" ? null : Number(tier.maximumSpend),
      };
    }).sort((a, b) => a.minimum - b.minimum).map((tier, index) => ({
      ...tier, mode: index === 1 ? "two" : "one",
    })).map((tier, index, list) => tier.mode !== "two" ? tier : {
      // Tier 2 (pick two) chooses from the Tier 1 gifts plus its own, as in
      // the popup and the discount function.
      ...tier,
      products: [...new Map(list.slice(0, index + 1).flatMap((candidate) => candidate.products)
        .map((product) => [product.id, product])).values()],
    });

    // Gift lines don't count toward the total, as in the popup.
    const tierVariantIds = new Set(tiers.flatMap((tier) => tier.products.flatMap((product) => [...product.variantIds])));
    const alwaysGiftProductIds = new Set([8708096557231, 8431587655855]);
    const isGiftItem = (item) => Boolean(item.properties?._tier_gift) || item.properties?._free_gift === "true" ||
      alwaysGiftProductIds.has(item.product_id) || (tierVariantIds.has(item.variant_id) && Number(item.original_price) === 0);
    const paidSubtotal = (cart) => cart.items.reduce((total, item) => isGiftItem(item) ? total : total + item.original_line_price, 0);

    const giftIcon = `<svg class="fgcb-gift-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20 7h-2.18A3 3 0 0 0 12 3.76 3 3 0 0 0 6.18 7H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h7V7h2v5h7a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1ZM9 7a1 1 0 1 1 1-1v1H9Zm6 0h-1V6a1 1 0 1 1 1 1ZM4 13v7a1 1 0 0 0 1 1h6v-8H4Zm9 8h6a1 1 0 0 0 1-1v-7h-7v8Z"/></svg>`;

    let lastHtml = "";
    const render = (cart) => {
      const rate = thresholdRate(cart.currency);
      const paid = paidSubtotal(cart);
      const thresholds = tiers.map((tier) => Math.round(tier.minimum * rate));
      const reached = thresholds.filter((threshold) => paid >= threshold).length; // tiers unlocked
      const giftVariants = new Set(cart.items
        .filter((item) => Boolean(item.properties?._tier_gift) || (tierVariantIds.has(item.variant_id) && Number(item.original_price) === 0))
        .map((item) => item.variant_id));

      const giftProducts = new Set(cart.items.filter((item) => Boolean(item.properties?._tier_gift)).map((item) => Number(item.product_id)));

      // Past the reached tier's maximum (a gap before the next tier) no tier
      // applies, so the banner counts toward the next one.
      const current = reached > 0 ? tiers[reached - 1] : null;
      // The reached tier's gifts are all claimed: one gift in a pick-one
      // tier, every gift in an all tier.
      const owns = (product) => giftProducts.has(numericId(product.id)) || [...product.variantIds].some((id) => giftVariants.has(id));
      // Pick-two tier: a Tier 1 gift counts as one of the two (same as the
      // popup and the discount function), even if Tier 2 lists other products.
      const claimedIn = (tierIndex) => {
        const pool = tiers[tierIndex].mode === "two" ? tiers.slice(0, tierIndex + 1) : [tiers[tierIndex]];
        return new Set(pool.flatMap((tier) => tier.products).filter(owns).map((product) => product.id)).size;
      };
      const claimed = current ? (current.mode === "two" ? claimedIn(reached - 1) : current.products.filter(owns).length) : 0;
      const hasGift = Boolean(current) && (current.mode === "all" ? claimed >= current.products.length : claimed >= (current.mode === "two" ? 2 : 1));
      const pastMax = Boolean(current && current.maximum != null && paid > Math.round(current.maximum * rate));

      const giftClaimed = hasGift && !pastMax;

      // Which tier the banner is about: the reached tier while its gift is
      // still to be chosen, otherwise the next tier to unlock.
      const unlocked = reached > 0 && !pastMax && !hasGift;
      if (!unlocked && !giftClaimed && reached === tiers.length) { root.hidden = true; return; }
      const completed = giftClaimed && reached === tiers.length;
      const index = unlocked || completed ? reached - 1 : reached;
      const target = tiers[index];
      const targetThreshold = thresholds[index];
      if (!target.products.length) { root.hidden = true; return; }

      const remaining = Math.max(0, targetThreshold - paid);
      const pct = unlocked || completed ? 100 : targetThreshold > 0 ? Math.min(100, Math.max(0, (paid / targetThreshold) * 100)) : 100;
      const money = (cents) => formatMoney(cents, cart.currency);
      // Whole amounts without ".00", as in the heading ("Spend $150 ...").
      const short = (cents) => money(cents).replace(/[.,]00(?=\D*$)/, "");
      // The pick-two offer: "any 2", or "BOTH" when the tier has 2 gifts.
      const twoOf = (n) => n > 2 ? "any 2" : "BOTH";
      const pickTwo = (n) => n > 2 ? "choose <strong>any 2 FREE gifts</strong>" : "get <strong>BOTH FREE gifts</strong>";
      const upgrade = !unlocked && reached > 0 && !pastMax;
      const has = (product) => giftProducts.has(numericId(product.id)) || [...product.variantIds].some((id) => giftVariants.has(id));
      // In an all tier, gifts already in the cart (e.g. the T-shirt claimed
      // at $150) stay free, so the banner shows only the ones still to come.
      const several = target.mode === "all" && target.products.length > 1;
      const kept = several ? target.products.filter(has) : [];
      const missing = several ? target.products.filter((product) => !has(product)) : target.products;
      const shown = target.mode === "two" ? target.products.filter((product) => !has(product)) : missing.length ? missing : target.products;
      const count = (n) => n === 1 ? "1 more gift" : `${n} more gifts`;
      const all = target.products.length === 2 ? "BOTH" : "ALL";
      // What the next tier adds, under the heading (e.g. "Spend $350.00 and
      // get BOTH gifts FREE.").
      const next = tiers[index + 1];
      const nextRemaining = next ? Math.max(0, thresholds[index + 1] - paid) : 0;
      const nextAll = next && next.mode !== "one" && next.products.length > 1;
      const nextGifts = next?.products.length === 2 ? "BOTH" : "ALL";
      // Below every tier the next-tier line is another choice ("OR" spend
      // more for more gifts); once a gift is unlocked it's the next step.
      const alternative = !unlocked && !upgrade && next?.mode !== "one";
      let hint = target.mode === "one" ? (unlocked && next?.mode === "two"
        ? `Choose your favourite. Add <strong>${money(nextRemaining)}</strong> to choose 2 gifts at Tier ${index + 2}.`
        // Below Tier 1 the "OR" line is the Tier 2 offer.
        : alternative && next?.mode === "two"
          ? `Spend <strong>${short(thresholds[index + 1])}+</strong> and choose <strong>any 2 FREE gifts</strong>.`
          : "Choose your favourite. One free gift per order.") : !next ? ""
        : unlocked
          ? (nextAll ? `Add <strong>${money(nextRemaining)}</strong> more to get a 2nd gift <strong>FREE</strong>.`
            : `Add <strong>${money(nextRemaining)}</strong> more to upgrade your gift.`)
          : !upgrade
            ? (nextAll ? `Spend <strong>${money(thresholds[index + 1])}</strong> and get <strong>${next.mode === "two" ? twoOf(next.products.length) : nextGifts}</strong> gifts <strong>FREE</strong>.`
              : `Spend <strong>${money(thresholds[index + 1])}</strong> to upgrade your gift.`)
            : "";

      let pill;
      let heading;
      let label;
      if (several && unlocked) {
        pill = tiers.length > 1 ? `TIER ${index + 1} UNLOCKED` : "FREE GIFTS UNLOCKED";
        heading = !kept.length
          ? `You've unlocked <strong>${all}</strong> gifts <strong>FREE</strong>!`
          : missing.length === 1
            ? `Claim your <strong>${kept.length === 1 ? "2nd" : "last"}</strong> gift <strong>FREE</strong>!`
            : `Claim your other <strong>${missing.length}</strong> gifts <strong>FREE</strong>!`;
        label = kept.length ? "Also yours, free" : "You get";
      } else if (several) {
        pill = kept.length || upgrade ? `${count(missing.length).toUpperCase()} FREE` : "FREE GIFTS AWAIT";
        heading = kept.length || upgrade
          ? `Add <strong>${money(remaining)}</strong> more and get <strong>${count(missing.length)}</strong> <strong>FREE</strong>!`
          : `Add <strong>${money(remaining)}</strong> more to get <strong>${all}</strong> gifts <strong>FREE</strong>!`;
        label = kept.length ? `Add ${money(remaining)} more to also get` : "You'll get";
      } else if (unlocked) {
        pill = tiers.length > 1 ? `TIER ${index + 1} UNLOCKED` : "FREE GIFT UNLOCKED";
        heading = `Choose <strong>1 of ${target.products.length}</strong> gifts <strong>FREE</strong>!`;
        label = "Select your gift in the popup";
      } else {
        pill = upgrade ? `UPGRADE TO TIER ${index + 1}` : "FREE GIFT AWAITS";
        heading = upgrade
          ? `Add <strong>${money(remaining)}</strong> more to upgrade your <strong>FREE</strong> gift!`
          : `Spend <strong>${money(targetThreshold).replace(/[.,]00(?=\D*$)/, "")}+</strong> and choose <strong>1 FREE gift</strong>.`;
        label = upgrade ? "Upgrade to" : "Choose one gift";
      }
      if (target.mode === "two") {
        const keptCount = claimedIn(index);
        const needed = Math.max(0, 2 - keptCount);
        pill = unlocked ? "FREE GIFTS UNLOCKED" : "UNLOCK 2 FREE GIFTS";
        heading = unlocked
          ? `Choose <strong>${needed}</strong> more free gift${needed === 1 ? "" : "s"}!`
          : `Add <strong>${money(remaining)}</strong> more to ${pickTwo(target.products.length)}!`;
        label = unlocked ? `Choose ${needed} from the remaining gifts` : target.products.length > 2 ? `Choose any 2 of ${target.products.length} gifts` : "Get both gifts";
      }
      if (giftClaimed) {
        pill = completed ? `TIER ${index + 1} REACHED` : "FREE GIFT ADDED";
        heading = "Your <strong>free gift</strong> is in your cart.";
        hint = target?.mode === "two"
          ? completed
            ? `You have reached the highest tier. Your 2 gifts stay free.`
            : `Spend <strong>${money(remaining)}</strong> to reach <strong>Tier ${index + 1}</strong> and ${pickTwo(target.products.length)}.`
          : current?.mode === "two"
          ? completed
            ? "You have reached the highest tier. Both gifts stay free."
            : `Add <strong>${money(remaining)}</strong> to reach <strong>Tier ${index + 1}</strong>. Your claimed gifts stay free.`
          : completed
            ? "You have reached the highest tier. Your gift stays free. One free gift per order."
            : `Add <strong>${money(remaining)}</strong> to reach <strong>Tier ${index + 1}</strong>. Your claimed gift stays free; one free gift per order.`;
        label = completed ? "Gift options for this tier" : `Tier ${index + 1} gift options`;
      }
      const joiner = several ? "+" : "OR";
      // Below every tier: what the next tier unlocks, under the gift cards
      // (e.g. "SPEND $350+ / Unlock BOTH gifts for FREE!").
      const teaser = alternative && next && next.mode !== "one"
        ? `<div class="fgcb-next"><span class="fgcb-pill">SPEND ${escapeHtml(money(thresholds[index + 1]).replace(/[.,]00(?=\D*$)/, ""))}+</span><p class="fgcb-next-text">${nextAll ? `Unlock ${next.mode === "two" ? twoOf(next.products.length) : nextGifts} gifts for FREE!` : "Choose 1 gift at this tier too. One free gift per order."}</p></div>`
        : "";

      const cards = shown.map((product, index) => `
        <div class="fgcb-product">
          ${product.imageUrl ? `<img class="fgcb-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}">` : ""}
          <div class="fgcb-product-info"><span class="fgcb-product-title">${escapeHtml(String(product.title || "").replace(/^\s*free\s+gift\s*[|:–-]\s*/i, "") || product.title)}</span><span class="fgcb-free">FREE</span></div>
        </div>${index < shown.length - 1 ? `<span class="fgcb-or"><span>${joiner}</span></span>` : ""}`).join("");
      // Unlocked: the link opens the gift popup (tiered-gift-popup.js),
      // even after the shopper closed it. Otherwise: keep shopping.
      const continueLink = (placement) => unlocked
        ? `<a class="fgcb-continue fgcb-continue--${placement}" href="#" data-open-gift>${several ? (missing.length === 1 ? "Claim your free gift" : "Claim your free gifts") : "Choose your free gift"} <span aria-hidden="true">&rarr;</span></a>`
        : `<a class="fgcb-continue fgcb-continue--${placement}" href="${escapeHtml(basePath)}collections/all">Continue shopping <span aria-hidden="true">&rarr;</span></a>`;

      const html = `<div class="fgcb-card${shown.length > 2 ? " fgcb-card--three" : ""}">
        <div class="fgcb-left">
          <span class="fgcb-pill">${giftIcon} ${pill}</span>
          <h2 class="fgcb-heading">${heading}</h2>
          ${hint ? `${alternative ? `<div class="fgcb-alt" aria-hidden="true">OR</div>` : ""}<p class="fgcb-hint${alternative ? " fgcb-hint--alt" : ""}">${alternative ? "" : giftIcon}<span>${hint}</span></p>` : ""}
          <div class="fgcb-progress">
            <div class="fgcb-track"><div class="fgcb-fill" style="width:${pct}%;"></div></div>
            <p class="fgcb-amounts"><span>Cart subtotal: <strong>${money(paid)}</strong></span><span>${giftClaimed ? (completed ? "Tier reached at" : "Next tier at") : unlocked ? "Gift unlocked at" : "Gift unlocks at"}: <strong>${money(targetThreshold)}</strong></span></p>
          </div>
          ${continueLink("desktop")}
        </div>
        <div class="fgcb-middle">
          <p class="fgcb-label">${label}</p>
          <div class="fgcb-products">${cards}</div>
          ${teaser}
        </div>
        ${continueLink("mobile")}
        <p class="fgcb-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </div>`;
      // Redraw only when something changed: rewriting the same HTML every
      // poll reloads the images and makes the banner blink.
      if (html !== lastHtml) { root.innerHTML = html; lastHtml = html; }
      root.hidden = false;
    };

    root.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("[data-open-gift]") : null;
      if (!link) return;
      event.preventDefault();
      document.dispatchEvent(new CustomEvent("fgc:open-gift"));
    });

    let timer;
    const checkCart = async () => {
      if (root.isConnected === false) {
        window.clearInterval(timer);
        return;
      }
      try {
        const response = await fetch(`${basePath}cart.js`, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) return;
        render(await response.json());
      } catch {
        // The next poll retries network failures.
      }
    };

    checkCart();
    timer = window.setInterval(checkCart, 2000);
  });
  initialize();
  // Themes can replace the whole cart section after add/change/remove. Start
  // the replacement banner too, without waiting for a full page reload.
  new MutationObserver(initialize).observe(document.body, { childList: true, subtree: true });
})();
