// Spend-tier gifts on the cart page. Settings come from the "Price gifts" page
// in the app (app/routes/app.price-gifts.tsx); the tiered-gift-discount
// function makes the claimed lines free. Lines carry `_tier_gift: <tier id>`.
(() => {
  const root = document.getElementById("tiered-gift-root");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";
  const cartPath = root.dataset.cartPath || "/cart";
  if (window.location.pathname.replace(/\/$/, "") !== cartPath.replace(/\/$/, "")) return;

  let settings;
  try { settings = JSON.parse(root.querySelector("[data-tiered-gift-settings]")?.textContent || "{}"); } catch { return; }
  if (!settings.enabled || !Array.isArray(settings.tiers)) return;
  let live = {};
  try { live = JSON.parse(root.querySelector("[data-tiered-gift-inventory]")?.textContent || "{}"); } catch { live = {}; }

  const rate = Number(window.Shopify?.currency?.rate) || 1;
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
  const tiers = settings.tiers.map((tier) => {
    const products = new Map();
    (tier.products || []).forEach((variant) => {
      if (!products.has(variant.productId)) products.set(variant.productId, { id: variant.productId, title: variant.productTitle, variants: [], allVariantIds: new Set() });
      const product = products.get(variant.productId);
      product.allVariantIds.add(numericId(variant.variantId));
      if (inStock(variant)) product.variants.push({ ...variant, imageUrl: live[variant.variantId]?.image || variant.imageUrl });
    });
    return {
      id: tier.id, mode: tier.mode === "all" ? "all" : "one",
      threshold: Math.round(Number(tier.minimumSpend || 0) * rate),
      allProducts: [...products.values()],
      products: [...products.values()].filter((product) => product.variants.length),
    };
  }).sort((a, b) => a.threshold - b.threshold);

  const isTierGift = (item) => Boolean(item.properties?._tier_gift);
  const isAnyGift = (item) => isTierGift(item) || item.properties?._free_gift === "true";
  const paidSubtotal = (cart) => cart.items.reduce((total, item) => isAnyGift(item) ? total : total + item.original_line_price, 0);
  const activeTier = (cart) => {
    const subtotal = paidSubtotal(cart);
    return [...tiers].reverse().find((tier) => subtotal >= tier.threshold) || null;
  };
  const productFor = (tier, item) => tier.allProducts.find((product) => product.allVariantIds.has(item.variant_id));

  const variantValues = (variant) => {
    if (Array.isArray(variant.optionValues) && variant.optionValues.length) return variant.optionValues;
    if (!variant.variantTitle || variant.variantTitle === "Default Title") return [];
    return variant.variantTitle.split(" / ");
  };
  const optionGroups = (product) => {
    const count = Math.max(0, ...product.variants.map((variant) => variantValues(variant).length));
    return Array.from({ length: count }, (_, index) => ({
      name: product.variants.find((variant) => variant.optionNames?.[index])?.optionNames[index] || `Option ${index + 1}`,
      values: [...new Set(product.variants.map((variant) => variantValues(variant)[index]).filter(Boolean))],
    }));
  };

  let busy = false;
  // Chosen variant per product, and the chosen product in "one" tiers.
  let chosenVariant = {};
  let chosenProductId = "";

  const signatureOf = (cart, tier) => `${tier.id}|${cart.items.filter((item) => !isAnyGift(item))
    .map((item) => `${item.variant_id}:${item.quantity}`).sort().join(",")}`;
  const hide = () => {
    document.documentElement.classList.remove("tgp-lock");
    root.querySelector(".tgp-overlay")?.remove();
    root.hidden = true;
  };
  const dismiss = (signature) => {
    try { sessionStorage.setItem("tgp-dismissed", signature); } catch { /* storage blocked */ }
    hide();
  };
  const dismissed = (signature) => { try { return sessionStorage.getItem("tgp-dismissed") === signature; } catch { return false; } };

  const productHtml = (tier, product) => {
    const variant = chosenVariant[product.id] || product.variants[0];
    const selected = tier.mode === "all" || product.id === chosenProductId;
    const values = variantValues(variant);
    const groups = selected ? optionGroups(product) : [];
    return `<div class="tgp-product${selected ? " is-selected" : ""}" data-product="${escapeHtml(product.id)}">
      <button class="tgp-card" type="button" data-pick="${escapeHtml(product.id)}" ${tier.mode === "all" ? "disabled" : ""}>
        ${variant.imageUrl ? `<img src="${escapeHtml(variant.imageUrl)}" alt="${escapeHtml(product.title)}" loading="lazy">` : ""}
        <strong>${escapeHtml(product.title)}</strong>
        <span class="tgp-free">🎁 FREE</span>
      </button>
      ${groups.map((group, index) => `<fieldset class="tgp-options"><legend>${escapeHtml(group.name)}</legend>
        ${group.values.map((value) => `<button type="button" class="tgp-option${values[index] === value ? " is-selected" : ""}" data-product-option="${escapeHtml(product.id)}" data-index="${index}" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join("")}
      </fieldset>`).join("")}
    </div>`;
  };

  const render = (tier, missing, signature) => {
    const dialog = root.querySelector(".tgp-content");
    if (!dialog) return;
    const intro = tier.mode === "all"
      ? `${missing.length > 1 ? "These gifts are" : "This gift is"} on us.`
      : "Choose 1 gift.";
    dialog.innerHTML = `<p class="tgp-intro">${escapeHtml(intro)}</p>
      <div class="tgp-products">${missing.map((product) => productHtml(tier, product)).join("")}</div>
      <button class="tgp-claim" type="button">🎁 ${escapeHtml(settings.buttonLabel || "Claim my free gift")}</button>
      <p class="tgp-status" aria-live="polite"></p>`;
    dialog.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", () => {
      chosenProductId = button.dataset.pick;
      render(tier, missing, signature);
    }));
    dialog.querySelectorAll("[data-product-option]").forEach((button) => button.addEventListener("click", () => {
      const product = missing.find((item) => item.id === button.dataset.productOption);
      const current = chosenVariant[product.id] || product.variants[0];
      const wanted = [...variantValues(current)];
      wanted[Number(button.dataset.index)] = button.dataset.value;
      chosenVariant[product.id] = product.variants.find((variant) => wanted.every((value, index) => variantValues(variant)[index] === value))
        || product.variants.find((variant) => variantValues(variant)[Number(button.dataset.index)] === button.dataset.value)
        || current;
      render(tier, missing, signature);
    }));
    dialog.querySelector(".tgp-claim").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const status = dialog.querySelector(".tgp-status");
      const claim = tier.mode === "all" ? missing : missing.filter((product) => product.id === chosenProductId);
      button.disabled = true;
      busy = true;
      try {
        const response = await fetch(`${basePath}cart/add.js`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ items: claim.map((product) => ({
            id: numericId((chosenVariant[product.id] || product.variants[0]).variantId),
            quantity: 1,
            properties: { _tier_gift: tier.id },
          })) }),
        });
        if (!response.ok) throw new Error("Gift could not be added. Please try another option.");
        status.textContent = settings.successMessage || "Free gift added.";
        window.setTimeout(() => window.location.reload(), 650);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Gift could not be added.";
        button.disabled = false;
        busy = false;
      }
    });
  };

  const show = (tier, missing, signature) => {
    if (root.querySelector(".tgp-overlay")) return;
    if (!missing.some((product) => product.id === chosenProductId)) chosenProductId = missing[0].id;
    root.style.setProperty("--tgp-background", settings.backgroundColor || "#FFFFFF");
    root.style.setProperty("--tgp-text", settings.textColor || "#111111");
    root.style.setProperty("--tgp-button", settings.buttonColor || "#111111");
    root.style.setProperty("--tgp-button-text", settings.buttonTextColor || "#FFFFFF");
    root.style.setProperty("--tgp-overlay", settings.overlayColor || "#000000B3");
    root.insertAdjacentHTML("beforeend", `<div class="tgp-overlay" role="presentation">
      <section class="tgp-dialog" role="dialog" aria-modal="true" aria-labelledby="tgp-heading">
        <button class="tgp-close" type="button" aria-label="Close">&times;</button>
        <h2 class="tgp-heading" id="tgp-heading">${escapeHtml(settings.heading || "You've unlocked a free gift!")}</h2>
        <p class="tgp-subheading">${escapeHtml(settings.subheading || "")}</p>
        <div class="tgp-content"></div>
        <p class="tgp-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </section></div>`);
    root.hidden = false;
    document.documentElement.classList.add("tgp-lock");
    root.querySelector(".tgp-close").addEventListener("click", () => dismiss(signature));
    root.querySelector(".tgp-overlay").addEventListener("click", (event) => { if (event.target === event.currentTarget) dismiss(signature); });
    root.onkeydown = (event) => { if (event.key === "Escape") dismiss(signature); };
    render(tier, missing, signature);
  };

  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(`${basePath}cart.js`, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const cart = await response.json();
      const tier = activeTier(cart);
      const giftItems = cart.items.filter(isTierGift);

      // Keep only lines of the current tier: one line per gift product, one
      // unit each, and a single line in "one" tiers. Everything else goes.
      const updates = {};
      const keptProducts = new Set();
      giftItems.forEach((item) => {
        const product = tier && item.properties._tier_gift === tier.id ? productFor(tier, item) : null;
        const allowed = product && !keptProducts.has(product.id) && (tier.mode === "all" || keptProducts.size === 0);
        if (!allowed) { updates[item.key] = 0; return; }
        keptProducts.add(product.id);
        if (item.quantity > 1) updates[item.key] = 1;
      });
      if (Object.keys(updates).length) {
        hide();
        const update = await fetch(`${basePath}cart/update.js`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ updates }),
        });
        // Reload only when the cart changed, so a refused update can't loop.
        const updated = update.ok ? await update.json() : null;
        if (updated && JSON.stringify(updated.items.map((item) => [item.key, item.quantity])) !== JSON.stringify(cart.items.map((item) => [item.key, item.quantity]))) {
          window.location.reload();
          return;
        }
      }

      if (!tier) { hide(); return; }
      const missing = tier.mode === "all"
        ? tier.products.filter((product) => !keptProducts.has(product.id))
        : (keptProducts.size ? [] : tier.products);
      const signature = signatureOf(cart, tier);
      if (!missing.length || dismissed(signature)) { if (!missing.length) hide(); return; }
      show(tier, missing, signature);
    } catch {
      // The next poll retries network failures.
    } finally {
      busy = false;
    }
  };

  check();
  window.setInterval(check, 1000);
})();
