// Price gifts (spend tiers) in the Free Gift App (Master) popup. The embed
// loads this instead of free-gift-popup.js only while price gift settings are
// on (app/routes/app.price-gifts.tsx). It draws the same popup with the same
// classes and CSS (tiered-gift-popup.css lays out all-gift tiers: "+" not "OR",
// and each gift's options under its own card). The
// tiered-gift-discount function makes claimed lines free; they carry
// `_tier_gift: <tier id>`.
//
// It runs on every page: the popup opens as soon as the cart crosses a tier's
// minimum, whether the item was added from a product page, a cart drawer or
// the cart page.
(async () => {
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
    // Shopify's cart API returns amounts in the buyer's presentment currency.
    // `currency.rate` is not guaranteed to describe that currency on every
    // theme, so only apply it when Shopify confirms the active currency matches
    // the cart. This mirrors the discount function's presentment conversion.
    if (cartCurrency === "USD") return 1;
    const currency = window.Shopify?.currency;
    if (shopCurrency === "USD" && currency?.active === cartCurrency) {
      return Number(currency.rate) || 1;
    }
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
    if (typeof state?.available === "boolean") return state.available;
    // Saved inventory counts are a snapshot, not current storefront availability.
    return variant.availableForSale !== false;
  };

  // Refresh once per product, shared across tiers. Shopify's live availability
  // respects the current market, inventory policy and the selected variant.
  const productsToRefresh = new Map();
  const currentProducts = new Map();
  tierSettings.tiers.forEach((tier) => (tier.products || []).forEach((variant) => {
    if (variant.productHandle) {
      const variants = productsToRefresh.get(variant.productHandle) || [];
      variants.push(variant);
      productsToRefresh.set(variant.productHandle, variants);
    }
  }));
  await Promise.all([...productsToRefresh].map(async ([handle, variants]) => {
    try {
      const response = await nativeFetch(`${basePath}products/${encodeURIComponent(handle)}.js`, {
        cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return;
      const product = await response.json();
      if (!Array.isArray(product.variants)) return;
      if (product.id && !variants.some((variant) => numericId(variant.productId) === Number(product.id))) return;
      currentProducts.set(handle, product);
      const current = new Map(product.variants.map((variant) => [Number(variant.id), variant]));
      variants.forEach((variant) => {
        const state = current.get(numericId(variant.variantId));
        if (typeof state?.available === "boolean") {
          live[variant.variantId] = { ...live[variant.variantId], available: state.available };
        }
      });
    } catch {
      // A failed refresh keeps the server-rendered availability.
    }
  }));

  // Image chosen per gift product on the Price gifts page; it replaces the
  // product and variant photos everywhere the gift is shown.
  const giftImages = tierSettings.giftImages && typeof tierSettings.giftImages === "object" ? tierSettings.giftImages : {};
  const hiddenVariants = new Set(Array.isArray(tierSettings.hiddenVariantIds) ? tierSettings.hiddenVariantIds : []);
  // Tiers low to high, each with its gift products grouped from variants.
  const tiers = tierSettings.tiers.map((tier) => {
    const products = new Map();
    const expanded = new Set();
    const variants = (tier.products || []).flatMap((saved) => {
      const current = currentProducts.get(saved.productHandle);
      if (!current) return [saved];
      if (expanded.has(saved.productId)) return [];
      expanded.add(saved.productId);
      return current.variants.map((variant) => ({
        ...saved,
        variantId: `gid://shopify/ProductVariant/${variant.id}`,
        variantTitle: variant.public_title || variant.title || "Default Title",
        optionNames: (current.options || []).map((option) => typeof option === "string" ? option : option.name),
        optionValues: variant.options || [variant.option1, variant.option2, variant.option3].filter(Boolean),
        imageUrl: variant.featured_image?.src || saved.imageUrl,
        availableForSale: variant.available,
      }));
    });
    variants.forEach((variant) => {
      if (!products.has(variant.productId)) products.set(variant.productId, {
        id: variant.productId, title: variant.productTitle,
        imageUrl: giftImages[variant.productId] || live[variant.variantId]?.productImage || variant.imageUrl,
        variants: [], allVariants: [], variantIds: new Set(),
      });
      const product = products.get(variant.productId);
      product.variantIds.add(numericId(variant.variantId));
      // Variants the admin hid (Price gifts page) are never offered; a cart
      // line of one is still recognised as this gift.
      if (hiddenVariants.has(variant.variantId)) return;
      product.allVariants.push(variant);
      if (inStock(variant)) product.variants.push({ ...variant, imageUrl: giftImages[variant.productId] || live[variant.variantId]?.image || variant.imageUrl });
    });
    return {
      // Netgains10: Tier 1 is pick one; Tier 2 is pick two from its choices.
      id: tier.id,
      mode: tier.mode,
      minimum: Number(tier.minimumSpend || 0),
      // Optional upper end, included; empty runs until the next tier.
      maximum: tier.maximumSpend == null || tier.maximumSpend === "" ? null : Number(tier.maximumSpend),
      allProducts: [...products.values()],
      products: [...products.values()].filter((product) => product.variants.length),
    };
  }).sort((a, b) => a.minimum - b.minimum).map((tier, index) => ({
    ...tier, mode: index === 1 ? "two" : "one",
  })).map((tier, index, list) => {
    // Tier 2 (pick two) chooses from the Tier 1 gifts plus its own, so the
    // shopper sees the gifts left after the one already in the cart (same
    // pool as the discount function).
    if (tier.mode !== "two") return tier;
    const pool = (key) => [...new Map(list.slice(0, index + 1).flatMap((candidate) => candidate[key])
      .map((product) => [product.id, product])).values()];
    return { ...tier, allProducts: pool("allProducts"), products: pool("products") };
  });

  // Always-gift products (their variants are $0), as in free-gift-popup.js.
  const alwaysGiftProductIds = new Set([8708096557231, 8431587655855]);
  // Every tier gift variant. A $0 line of one, added from its product page
  // rather than the popup, is a gift too; a paid line of it is a purchase.
  const tierVariantIds = new Set(tiers.flatMap((tier) => tier.allProducts.flatMap((product) => [...product.variantIds])));
  const isTierGift = (item) => Boolean(item.properties?._tier_gift);
  const isFreeTierVariant = (item) => !isTierGift(item) && tierVariantIds.has(item.variant_id) && Number(item.original_price) === 0;
  const isGiftItem = (item) => isTierGift(item) || isFreeTierVariant(item) || item.properties?._free_gift === "true" || alwaysGiftProductIds.has(item.product_id);
  // After discounts: paid lines at their discounted price (final_line_price,
  // e.g. a Black Friday sale price), less order discounts (discount codes,
  // automatic order discounts). Gift lines don't count. Same rule as the
  // banner, widget, checkout block and checkout validation.
  const paidSubtotal = (cart) => Math.max(0, cart.items.reduce((total, item) => isGiftItem(item) ? total : total + Number(item.final_line_price ?? item.original_line_price ?? 0), 0)
    - (cart.cart_level_discount_applications || []).reduce((total, discount) => total + Number(discount.total_allocated_amount || 0), 0));
  // The highest tier whose minimum the cart reaches, unless the cart is past
  // its maximum (a gap before the next tier: no gift). Same as the function.
  const tierFor = (subtotal, cartCurrency) => {
    const rate = thresholdRate(cartCurrency);
    const tier = [...tiers].reverse().find((candidate) => subtotal >= Math.round(candidate.minimum * rate));
    if (!tier || (tier.maximum != null && subtotal >= Math.round((tier.maximum + 100) * rate))) return null;
    return tier;
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
  // Only in-stock variants: an unavailable size/colour is not shown at all.
  const optionGroups = (product) => {
    const variants = product.variants;
    const count = Math.max(0, ...variants.map((variant) => variantValues(variant).length));
    return Array.from({ length: count }, (_, index) => {
      const values = [...new Set(variants.map((variant) => variantValues(variant)[index]).filter(Boolean))];
      const name = variants.find((variant) => variant.optionNames?.[index])?.optionNames[index];
      return { name: name || inferredOptionName(values, index), values };
    });
  };

  let busy = false;
  let pending = false;
  // What the last cart check found: "ok", "changed" (gifts were removed and
  // the page reloads) or "keep" (too many gifts for a pick-one tier).
  let checkResult = "ok";
  // The card whose options are showing (in "one" tiers, also the chosen
  // gift) and the chosen variant per product.
  let focusedId = "";
  const chosen = {};
  const variantOf = (product) => product.variants.find((variant) => variant.variantId === chosen[product.id]) || product.variants[0];

  // Closing the popup hides it for that tier until the cart drops below it
  // or reaches another tier.
  // Closing remembers the tier and the cart's paid items: any cart change
  // (or a "Choose your free gift" click on the cart banner) opens it again.
  const DISMISS_KEY = "fgc-tier-dismissed";
  const dismissedSignature = () => { try { return sessionStorage.getItem(DISMISS_KEY) || ""; } catch { return ""; } };
  const setDismissed = (value) => { try { value ? sessionStorage.setItem(DISMISS_KEY, value) : sessionStorage.removeItem(DISMISS_KEY); } catch { /* blocked */ } };
  let currentSignature = "";
  // The paid items and gift line count after the last check. When the paid
  // items are the same but a gift line is gone, the shopper deleted the gift
  // themselves: the popup then waits until they add a product or change a
  // quantity (or click "Choose your free gift" on the cart banner).
  const STATE_KEY = "fgc-tier-gifts";
  const readState = () => { try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || "null"); } catch { return null; } };
  const writeState = (state) => { try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* blocked */ } };
  const paidSignature = (cart) => cart.items.filter((item) => !isGiftItem(item))
    .map((item) => `${item.variant_id}:${item.quantity}`).sort().join(",");
  const signatureOf = (cart, tier) => `${tier.id}|${cart.items.filter((item) => !isGiftItem(item))
    .map((item) => `${item.variant_id}:${item.quantity}`).sort().join(",")}`;

  const hidePopup = () => {
    openKey = "";
    document.documentElement.classList.remove("fgc-lock");
    root.querySelector(".fgc-overlay")?.remove();
    root.hidden = true;
  };
  const close = () => { setDismissed(currentSignature); hidePopup(); };

  // Variant for a click: it keeps the options above the clicked one, takes
  // the clicked value, and keeps the options below when that combination
  // exists (otherwise the first one that does).
  const pickVariant = (product, index, value) => {
    const current = variantValues(variantOf(product));
    const candidates = product.variants.filter((variant) => {
      const values = variantValues(variant);
      return values[index] === value && current.slice(0, index).every((item, optionIndex) => values[optionIndex] === item);
    });
    const keepsLower = candidates.find((variant) => variantValues(variant).every((item, optionIndex) => optionIndex <= index || item === current[optionIndex]));
    return keepsLower || candidates[0] || variantOf(product);
  };
  // Options cascade: the first option (e.g. size) lists every value; each
  // later option (e.g. colour) lists only the values that exist with the
  // choices above it, so a shopper never sees a combination that isn't there
  // (or one that is out of stock).
  const valuesFor = (product, index, values) => {
    const current = variantValues(variantOf(product));
    return values.filter((value) => product.variants.some((variant) => {
      const options = variantValues(variant);
      return options[index] === value && current.slice(0, index).every((item, optionIndex) => options[optionIndex] === item);
    }));
  };

  // Every word of an option label starts with a capital ("matte black" shows
  // as "Matte Black"); the rest of each word stays as it is ("MagPro").
  // Size codes are all capitals ("xl" shows as "XL", "2xl" as "2XL").
  const displayValue = (value) => String(value)
    .replace(/(^|[\s(\/-])(\p{Ll})/gu, (_, before, letter) => before + letter.toUpperCase())
    .replace(/\b(\d*x*[sml])\b/gi, (size) => size.toUpperCase());
  // Option buttons sit in equal-width columns, so no button stretches across
  // a row on its own: 4 for short labels (S, M, XL), 3 for words (Gray,
  // White), 2 for long names (Magnetic Card Holder).
  // Labels too long for half a box (Magpro Lite/Magnetic Card Holder) take
  // a full row of their own and do not count towards the column choice.
  const isWideValue = (value) => String(value).length > 20;
  const gridColumns = (values) => {
    const longest = Math.max(0, ...values.filter((value) => !isWideValue(value)).map((value) => String(value).length));
    return longest <= 3 ? 4 : longest <= 8 ? 3 : 2;
  };
  // Options for one product. In "all" tiers every gift gets its own block,
  // titled with the product, so it is clear which gift each choice is for.
  const optionsHtml = (product, titled) => {
    const groups = optionGroups(product);
    if (!groups.length) return "";
    const selected = variantValues(variantOf(product));
    return `<div class="fgc-tier-options" data-options-for="${escapeHtml(product.id)}">
      ${titled ? `<p class="fgc-tier-options-title">${escapeHtml(product.title)}</p>` : ""}
      ${groups.map((group, groupIndex) => `
      <fieldset class="fgc-option-group">
        <legend>Choose your ${escapeHtml(group.name.toLowerCase())}</legend>
        <div class="fgc-options fgc-grid-${gridColumns(valuesFor(product, groupIndex, group.values))}">${valuesFor(product, groupIndex, group.values).map((value) => {
          const isSelected = selected[groupIndex] === value;
          return `<button class="fgc-option${isSelected ? " is-selected" : ""}${isWideValue(value) ? " fgc-option--wide" : ""}" type="button" aria-pressed="${isSelected}" data-product="${escapeHtml(product.id)}" data-option-index="${groupIndex}" data-option-value="${escapeHtml(value)}">${escapeHtml(displayValue(value))}</button>`;
        }).join("")}</div>
      </fieldset>`).join("")}
    </div>`;
  };

  // Draws the gift cards once, then updates them in place on every choice,
  // so images don't reload and the popup doesn't jump.
  const renderSelector = (tier, offered) => {
    const selectedIds = new Set();
    const available = offered.filter((product) => product.variants.length);
    const needed = Math.min(tier.remaining || 2, available.length);
    const focused = () => available.find((product) => product.id === focusedId) || available[0];
    const isSelected = (product) => product.variants.length > 0 && (tier.mode === "all" || (tier.mode === "two" ? selectedIds.has(product.id) : product.id === focused()?.id));
    const imageFor = (product) => (isSelected(product) ? variantOf(product)?.imageUrl : "") || product.imageUrl;
    const content = root.querySelector(".fgc-content");
    // "all" and "two" tiers: each gift is a column with its own options right
    // under its card. In "two" every gift's options always show, so the
    // shopper sees all sizes/colours before deciding.
    // Pick-one tiers use the same boxes: every gift shows its own options,
    // and choosing an option picks that gift.
    const columns = true;
    const pickBetween = tier.mode === "two" ? needed === 1 : offered.length === 2;
    const layout = tier.mode === "all" ? " fgc-products--all"
      : ` fgc-products--all fgc-products--two${pickBetween ? " fgc-products--or" : ""}${offered.length > 2 ? " fgc-products--cols3" : ""}`;
    content.innerHTML = `
      <div class="fgc-products${layout}">${offered.map((product) => {
        const card = `
        <button class="fgc-product" type="button" data-product-id="${escapeHtml(product.id)}"${tier.mode === "all" ? ' tabindex="-1"' : ""}>
          <span class="fgc-check" aria-hidden="true"></span>
          <img class="fgc-product-image" src="${escapeHtml(imageFor(product))}" alt="${escapeHtml(product.title)}" loading="lazy"${imageFor(product) ? "" : " hidden"}>
          <strong class="fgc-product-title">${escapeHtml(product.title)}</strong>
          ${product.variants.length ? "" : '<span class="fgc-free">OUT OF STOCK</span>'}
        </button>`;
        return columns
          ? `<div class="fgc-gift-col" data-col="${escapeHtml(product.id)}">${card}<div class="fgc-col-options" data-col-for="${escapeHtml(product.id)}"></div></div>`
          : card;
      }).join("")}
      </div>
      <div class="fgc-variant-panel"></div>
      <button class="fgc-claim" type="button">🎁 ${tier.mode === "all" && offered.length > 1 ? "CLAIM YOUR GIFTS" : "CLAIM YOUR GIFT"}</button>
      <p class="fgc-status" aria-live="polite"></p>
      <div class="fgc-benefits"><span>◆&nbsp; Secure Checkout</span><span>▰&nbsp; Fast Shipping</span><span>★&nbsp; Loved by Collectors</span></div>`;
    const panel = content.querySelector(".fgc-variant-panel");
    // Pick a gift; when the limit is already reached the earliest choice
    // makes room (with 1 to pick, the other gift simply swaps in).
    const select = (id) => {
      if (selectedIds.size >= needed) selectedIds.delete(selectedIds.values().next().value);
      selectedIds.add(id);
    };

    const refresh = () => {
      content.querySelectorAll("[data-product-id]").forEach((card) => {
        const product = offered.find((item) => item.id === card.dataset.productId);
        const selected = isSelected(product);
        card.classList.toggle("is-selected", selected);
        card.setAttribute("aria-pressed", String(selected));
        // Never locked once the limit is reached: a click swaps the choice.
        card.disabled = !product.variants.length;
        card.querySelector(".fgc-check").textContent = selected ? "✓" : "";
        const image = card.querySelector("img");
        const src = imageFor(product);
        if (src && image.getAttribute("src") !== src) image.setAttribute("src", src);
        image.hidden = !src;
      });
      if (tier.mode === "two") {
        offered.forEach((product) => {
          const column = content.querySelector(`[data-col-for="${product.id}"]`);
          if (column) column.innerHTML = product.variants.length ? optionsHtml(product, false) : "";
          content.querySelector(`[data-col="${product.id}"]`)?.classList.toggle("is-selected", isSelected(product));
        });
        panel.innerHTML = "";
        panel.hidden = true;
        const button = content.querySelector(".fgc-claim");
        button.disabled = selectedIds.size !== needed;
        button.textContent = `CLAIM ${needed} FREE GIFT${needed === 1 ? "" : "S"} (${selectedIds.size}/${needed} selected)`;
        return;
      }
      if (tier.mode === "all") {
        offered.forEach((product) => {
          const column = content.querySelector(`[data-col-for="${product.id}"]`);
          if (column) column.innerHTML = optionsHtml(product, false);
        });
        panel.innerHTML = "";
        panel.hidden = true;
        return;
      }
      // Pick-one: every gift's options stay in its own box.
      offered.forEach((product) => {
        const column = content.querySelector(`[data-col-for="${product.id}"]`);
        if (column) column.innerHTML = product.variants.length ? optionsHtml(product, false) : "";
        content.querySelector(`[data-col="${product.id}"]`)?.classList.toggle("is-selected", isSelected(product));
      });
      panel.innerHTML = "";
      panel.hidden = true;
    };

    content.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const option = target?.closest("[data-option-index]");
      if (option) {
        const product = offered.find((item) => item.id === option.dataset.product);
        if (!product) return;
        chosen[product.id] = pickVariant(product, Number(option.dataset.optionIndex), option.dataset.optionValue).variantId;
        // Choosing a size/colour of a gift also picks that gift.
        if (tier.mode === "two" && !selectedIds.has(product.id)) select(product.id);
        if (tier.mode === "one") focusedId = product.id;
        refresh();
        return;
      }
      const card = target?.closest("[data-product-id]");
      if (card && !offered.find((product) => product.id === card.dataset.productId)?.variants.length) return;
      if (card && tier.mode === "two") {
        const id = card.dataset.productId;
        if (selectedIds.has(id)) selectedIds.delete(id);
        else select(id);
        refresh();
        return;
      }
      if (card && tier.mode === "one" && card.dataset.productId !== focusedId) {
        focusedId = card.dataset.productId;
        refresh();
        return;
      }
      if (target?.closest(".fgc-claim")) claim(tier, tier.mode === "all" ? offered : tier.mode === "two" ? offered.filter(isSelected) : [focused()]);
    });
    refresh();
  };

  const claim = async (tier, products) => {
    const button = root.querySelector(".fgc-claim");
    const status = root.querySelector(".fgc-status");
    if (!button || button.disabled) return;
    button.disabled = true;
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
      button.disabled = false;
      busy = false;
    }
  };

  // Desktop: the popup heading stays on one line. Fonts differ by theme, so
  // it is measured and stepped down until the whole line fits the dialog.
  // Phones (760px and below) let it wrap.
  const fitHeading = () => {
    const heading = root.querySelector(".fgc-dialog--compact .fgc-heading");
    if (!heading) return;
    heading.style.fontSize = "";
    if (window.innerWidth <= 760) return;
    if (!window.getComputedStyle) return;
    let size = parseFloat(window.getComputedStyle(heading).fontSize) || 20;
    while (heading.scrollWidth > heading.clientWidth + 1 && size > 12) {
      size -= 0.5;
      heading.style.fontSize = `${size}px`;
    }
  };
  window.addEventListener?.("resize", () => { if (root.querySelector(".fgc-overlay")) fitHeading(); });

  // What the open popup offers, so a cart change that alters it redraws it.
  let openKey = "";
  const offerKey = (tier, offered) => `${tier.id}:${tier.mode}:${tier.remaining || ""}:${offered.map((product) => product.id).join(",")}`;

  const show = (tier, offered) => {
    const key = offerKey(tier, offered);
    if (root.querySelector(".fgc-overlay")) {
      if (openKey === key) return;
      hidePopup();
    }
    openKey = key;
    const available = offered.filter((product) => product.variants.length);
    if (!available.some((product) => product.id === focusedId)) focusedId = available[0]?.id || "";
    const several = tier.mode === "all" && offered.length > 1;
    // Popup copy (netgains10): pick-one tier ($150+) "Choose ONE free gift";
    // all tier with every gift still to add ($350+) "BOTH FREE GIFTS". An
    // all tier with one gift left keeps its own text.
    const pickOne = tier.mode === "one";
    const both = offered.length === 2 ? "BOTH" : "ALL";
    // $350+ tier: "You have unlocked two free gifts" (the line under it says
    // how many are still to pick).
    const heading = tier.mode === "two" ? "CONGRATULATIONS! YOU HAVE UNLOCKED TWO FREE GIFTS!" : several ? `YOU’VE UNLOCKED ${both} FREE GIFTS!` : "CONGRATULATIONS! YOU’VE UNLOCKED A FREE GIFT!";
    const subheading = tier.mode === "two"
      ? tier.remaining === 1
        // One gift already in the cart: only the "Choose 1 more gift from
        // below" line shows.
        ? ""
        : `Pick ${Math.min(tier.remaining || 2, available.length)} different gift${Math.min(tier.remaining || 2, available.length) === 1 ? "" : "s"} below and choose the options under each gift. Each gift is free with your order.`
      : several
      ? `Congratulations! Your cart qualifies for ${both} gifts. Add them to your order!`
      : pickOne
        ? "Choose 1 free gift below. Select your preferred options, then claim your gift."
        : "The gift below is free with your order. Choose your options and add it to your cart.";
    const giftTitle = several ? "Your FREE Gifts" : pickOne ? "Choose Your FREE Gift" : "";
    root.style.setProperty("--fgc-background", look.backgroundColor || "#FFFFFF");
    root.style.setProperty("--fgc-text", look.textColor || "#111827");
    root.style.setProperty("--fgc-button", look.buttonColor || "#EF0B18");
    root.style.setProperty("--fgc-button-text", look.buttonTextColor || "#FFFFFF");
    root.style.setProperty("--fgc-overlay", look.overlayColor || "#111827B3");
    root.insertAdjacentHTML("beforeend", `<div class="fgc-overlay" role="presentation">
      <section class="fgc-dialog fgc-dialog--compact${tier.mode === "all" ? " fgc-dialog--all" : ""}" role="dialog" aria-modal="true" aria-labelledby="fgc-heading">
        <button class="fgc-close" type="button" aria-label="Close">&times;</button>
        <div class="fgc-header"><span class="fgc-gift">🎁</span><h2 class="fgc-heading" id="fgc-heading">${heading}</h2></div>
        ${subheading ? `<p class="fgc-subheading">${escapeHtml(subheading)}</p>` : ""}
        ${tier.mode === "two" && tier.remaining === 1 ? '<p class="fgc-pick-note">Choose 1 more gift from below</p>' : ""}
        ${giftTitle ? `<p class="fgc-gift-title">${giftTitle}</p>` : ""}
        <div class="fgc-content"></div>
        <p class="fgc-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </section></div>`);
    root.hidden = false;
    document.documentElement.classList.add("fgc-lock");
    root.querySelector(".fgc-close")?.addEventListener("click", () => close());
    root.querySelector(".fgc-overlay")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) close(); });
    root.onkeydown = (event) => { if (event.key === "Escape" && !root.hidden) close(); };
    renderSelector(tier, offered);
    fitHeading();
    root.querySelector(".fgc-close")?.focus({ preventScroll: true });
  };

  // Gift lines in the theme's cart (page and drawer) can't be opened or
  // changed: their product links stop working and the quantity selector is
  // hidden. The remove button stays. Rows are found by line key or line
  // number (Dawn-style ids); a product link with ?variant= is the fallback
  // when no paid line shares the variant.
  let lastCart = null;
  const ROW = "tr, li, .cart-item, .cart-drawer-item, [class*='cart-item'], [class*='line-item'], [class*='CartItem']";
  const rowsFor = (item, index) => {
    const rows = new Set();
    const line = index + 1;
    document.querySelectorAll(`[data-key="${item.key}"], [data-line-item-key="${item.key}"], [data-cart-item-key="${item.key}"], [data-item-key="${item.key}"], #CartItem-${line}, #CartDrawer-Item-${line}`)
      .forEach((element) => rows.add(element.closest(ROW) || element));
    document.querySelectorAll(`input[data-index="${line}"], [data-line="${line}"]`).forEach((element) => {
      const row = element.closest(ROW);
      if (row) rows.add(row);
    });
    const sharedWithPaid = lastCart.items.some((other) => other !== item && other.variant_id === item.variant_id && !isGiftItem(other));
    if (!rows.size && !sharedWithPaid) {
      document.querySelectorAll(`a[href*="variant=${item.variant_id}"]`).forEach((link) => {
        const row = link.closest(ROW);
        if (row) rows.add(row);
      });
    }
    return [...rows].filter((row) => row && row !== document.body && row !== root && !root.contains(row));
  };
  const lockRow = (row) => {
    row.classList.add("fgc-gift-line");
    row.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!/\/products\//.test(href)) return;
      link.dataset.fgcHref = href;
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
      link.setAttribute("tabindex", "-1");
    });
    row.querySelectorAll("input[name='updates[]'], input[type='number'], quantity-input, .quantity, [class*='quantity-selector'], [class*='quantity__']").forEach((element) => {
      // Hide the selector, never the remove button that may sit beside it.
      const box = element.closest("quantity-input, .quantity, [class*='quantity-selector']") || element;
      if (box.querySelector("cart-remove-button, [href*='/cart/change'], [class*='remove'], [aria-label*='emove']")) element.hidden = true;
      else box.hidden = true;
    });
  };
  const lockGiftRows = () => {
    if (!lastCart) return;
    lastCart.items.forEach((item, index) => { if (isGiftItem(item)) rowsFor(item, index).forEach(lockRow); });
    // The server-rendered first-paint style (snippets/tiered-gift-lines-style)
    // goes once the rows are locked here: its line numbers go stale when the
    // cart changes without a page load.
    document.querySelectorAll("style[data-fgc-gift-lines]").forEach((style) => style.remove());
  };
  // Themes redraw the cart after changes; lock the new rows too.
  let lockTimer = 0;
  new MutationObserver(() => {
    window.clearTimeout(lockTimer);
    lockTimer = window.setTimeout(lockGiftRows, 60);
  }).observe(document.body, { childList: true, subtree: true });
  // A product link that a theme script adds back is blocked on click.
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest(".fgc-gift-line a") : null;
    if (link && /\/products\//.test(link.getAttribute("href") || link.dataset.fgcHref || "")) event.preventDefault();
  }, true);

  // "Which gift do you want to keep?" Shown when the cart drops into a
  // pick-one tier holding more than one gift. It can't be closed: it stays
  // until the shopper keeps one gift and the other is removed (otherwise the
  // extra gift would be charged at checkout). It comes back on every page
  // while the cart still holds too many gifts.
  let keepKey = "";
  const formatMoney = (cents, currency) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", currencyDisplay: "narrowSymbol" }).format(cents / 100);
    } catch {
      return "$" + (cents / 100).toFixed(2);
    }
  };
  // Why a gift has to go.
  const keepMessage = (count, tier, subtotal, currency) => {
    const next = tiers[tiers.findIndex((candidate) => candidate.id === tier.id) + 1];
    if (!next) return { text: `Only 1 gift is free with your order. Pick the one to keep.` };
    const threshold = Math.round(next.minimum * thresholdRate(currency));
    return { text: `Your cart is under ${formatMoney(threshold, currency)}, so only 1 gift is free. Pick the one to keep.` };
  };
  const showKeep = (items, tier, subtotal, currency) => {
    const key = `keep:${items.map((item) => item.key).sort().join(",")}`;
    if (openKey === key && root.querySelector(".fgc-overlay")) return;
    hidePopup();
    openKey = key;
    keepKey = items.some((item) => item.key === keepKey) ? keepKey : items[0].key;
    root.style.setProperty("--fgc-background", look.backgroundColor || "#FFFFFF");
    root.style.setProperty("--fgc-text", look.textColor || "#111827");
    root.style.setProperty("--fgc-button", look.buttonColor || "#EF0B18");
    root.style.setProperty("--fgc-button-text", look.buttonTextColor || "#FFFFFF");
    root.style.setProperty("--fgc-overlay", look.overlayColor || "#111827B3");
    const message = keepMessage(items.length, tier, subtotal, currency);
    const variantLabel = (item) => item.variant_title && item.variant_title !== "Default Title" ? item.variant_title : "";
    root.insertAdjacentHTML("beforeend", `<div class="fgc-overlay" role="presentation">
      <section class="fgc-dialog fgc-dialog--compact fgc-dialog--keep" role="dialog" aria-modal="true" aria-labelledby="fgc-heading">
        <div class="fgc-header"><span class="fgc-gift">🎁</span><h2 class="fgc-heading" id="fgc-heading">CHOOSE 1 GIFT TO KEEP</h2></div>
        <p class="fgc-subheading">${escapeHtml(message.text)}</p>
        <div class="fgc-content">
          <div class="fgc-products">${items.map((item) => `
            <button class="fgc-product" type="button" data-keep="${escapeHtml(item.key)}">
              <span class="fgc-check" aria-hidden="true"></span>
              ${item.image ? `<img class="fgc-product-image" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.product_title)}" loading="lazy">` : ""}
              <strong class="fgc-product-title">${escapeHtml(item.product_title)}</strong>
              ${variantLabel(item) ? `<span class="fgc-keep-variant">${escapeHtml(displayValue(variantLabel(item)))}</span>` : ""}
            </button>`).join("")}
          </div>
          <button class="fgc-claim" type="button">🎁 KEEP THIS GIFT</button>
          <p class="fgc-status" aria-live="polite"></p>
        </div>
        <p class="fgc-footer">*Free gift items are not eligible for exchange or replacement.*</p>
      </section></div>`);
    root.hidden = false;
    document.documentElement.classList.add("fgc-lock");
    const refresh = () => root.querySelectorAll("[data-keep]").forEach((card) => {
      const selected = card.dataset.keep === keepKey;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-pressed", String(selected));
      card.querySelector(".fgc-check").textContent = selected ? "✓" : "";
    });
    let saving = false;
    const keep = async () => {
      if (saving) return;
      saving = true;
      const button = root.querySelector(".fgc-claim");
      if (button) button.disabled = true;
      const updates = Object.fromEntries(items.filter((item) => item.key !== keepKey).map((item) => [item.key, 0]));
      try {
        const response = await nativeFetch(`${basePath}cart/update.js`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ updates }),
        });
        if (!response.ok) throw new Error("update failed");
        writeState({ paid: paidSignature({ items: lastCart?.items || [] }), gifts: 1 });
        // Reload so the theme's cart (page, drawer, count) shows the change.
        window.location.reload();
      } catch {
        saving = false;
        if (button) button.disabled = false;
        const status = root.querySelector(".fgc-status");
        if (status) status.textContent = "We could not update your cart. Please try again.";
      }
    };
    root.querySelector(".fgc-products")?.addEventListener("click", (event) => {
      const card = event.target instanceof Element ? event.target.closest("[data-keep]") : null;
      if (!card) return;
      keepKey = card.dataset.keep;
      refresh();
    });
    root.querySelector(".fgc-claim")?.addEventListener("click", keep);
    // No close button; clicking outside or Escape does nothing.
    root.onkeydown = null;
    refresh();
  };

  const checkCart = async () => {
    if (busy) { pending = true; return; }
    busy = true;
    checkResult = "ok";
    try {
      const response = await nativeFetch(`${basePath}cart.js`, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const cart = await response.json();
      lastCart = cart;
      lockGiftRows();
      const subtotal = paidSubtotal(cart);
      const tier = tierFor(subtotal, cart.currency);

      // Keep only this tier's gifts: one unit per gift product. A gift
      // claimed in a lower tier stays when it is also one of this tier's
      // gifts (the T-shirt from $150 is kept at $350, and only the Sling is
      // offered). Other gifts and extra units go.
      const updates = {};
      const kept = new Set();
      // Gift lines this tier allows, newest first (cart.js lists the most
      // recently added line first).
      const valid = [];
      // A gift matches by product (any variant). In the pick-two tier a gift
      // claimed in Tier 1 counts as one of the two even when Tier 2 lists
      // other products, so the shopper picks only 1 more and nothing is
      // removed (no hide / update / reload flash).
      const tierIndex = tier ? tiers.indexOf(tier) : -1;
      const eligible = tier ? (tier.mode === "two" ? tiers.slice(0, tierIndex + 1) : [tier]).flatMap((candidate) => candidate.allProducts) : [];
      const productFor = (item) => eligible.find((candidate) => numericId(candidate.id) === Number(item.product_id) || candidate.variantIds.has(item.variant_id));
      cart.items.filter(isGiftItem).forEach((item) => {
        const product = tier && (isTierGift(item) || isFreeTierVariant(item)) ? productFor(item) : null;
        if (!product || kept.has(product.id) || (tier.mode === "two" && kept.size >= 2)) { updates[item.key] = 0; return; }
        kept.add(product.id);
        valid.push(item);
        if (item.quantity > 1) updates[item.key] = 1;
      });
      const paid = paidSignature(cart);
      const previous = readState();
      const giftLines = cart.items.filter(isGiftItem).length;
      const removedByShopper = Boolean(previous) && previous.paid === paid && giftLines < previous.gifts;
      // After this check the cart holds the allowed gifts only, so our own
      // removals never look like the shopper's.
      writeState({ paid, gifts: valid.length });
      if (Object.keys(updates).length) {
        checkResult = "changed";
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
      // The popups open on the cart page only. Other pages still keep the
      // cart's gifts in line (above), they just never show a popup.
      // A pick-one tier with more than one gift in the cart (e.g. the cart
      // dropped from $350 to under $350 with both gifts): the shopper chooses
      // which gift to keep (cart page only); the other one is removed.
      if (tier.mode === "one" && valid.length > 1) {
        checkResult = "keep";
        if (onCartPage) showKeep(valid, tier, subtotal, cart.currency); else hidePopup();
        return;
      }
      if (!onCartPage) { hidePopup(); return; }
      if (removedByShopper) setDismissed(signatureOf(cart, tier));
      const limit = tier.mode === "all" ? tier.allProducts.length : tier.mode === "two" ? 2 : 1;
      tier.remaining = Math.max(0, limit - kept.size);
      // A product whose every variant is hidden is not offered at all.
      const choices = (tier.mode === "all" ? tier.products : tier.allProducts).filter((product) => product.allVariants.length);
      const offered = kept.size >= limit ? [] : choices.filter((product) => !kept.has(product.id));
      if (!offered.some((product) => product.variants.length)) { hidePopup(); return; }
      currentSignature = signatureOf(cart, tier);
      if (dismissedSignature() !== currentSignature) show(tier, offered);
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
  // Short delay: themes often fire several cart calls in a row; one check
  // after them is enough (busy/pending collapse the rest).
  let changeTimer = 0;
  const afterCartChange = () => { window.clearTimeout(changeTimer); changeTimer = window.setTimeout(checkCart, 150); };
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
  // "Choose your free gift" on the cart banner (tiered-gift-cart-banner.js).
  document.addEventListener("fgc:open-gift", () => { setDismissed(""); checkCart(); });

  // Checkout buttons run a fresh gift check first, so a cart changed a
  // moment ago (e.g. dropped under $350 with two gifts) can't reach checkout
  // with a gift that would be charged. The checkout validation
  // (no-discount-products) holds the same rule on the server.
  const CHECKOUT_TRIGGER = 'button[name="checkout"], input[name="checkout"], a[href$="/checkout"], a[href*="/checkout?"], form[action$="/checkout"] [type="submit"]';
  let checkoutCleared = false;
  document.addEventListener("click", async (event) => {
    const trigger = event.target instanceof Element ? event.target.closest(CHECKOUT_TRIGGER) : null;
    if (!trigger || checkoutCleared) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    while (busy) await new Promise((resolve) => window.setTimeout(resolve, 50));
    await checkCart();
    while (busy) await new Promise((resolve) => window.setTimeout(resolve, 50));
    // On the cart page a fixed cart reloads; elsewhere it is already fixed.
    if (checkResult === "changed" && onCartPage) return;
    if (checkResult === "keep") {
      if (!onCartPage) window.location.href = `${cartPath}`;
      return;
    }
    checkoutCleared = true;
    if (trigger instanceof HTMLAnchorElement) { window.location.href = trigger.href; return; }
    trigger.click();
    window.setTimeout(() => { checkoutCleared = false; }, 3000);
  }, true);

  checkCart();
  // The cart page's own quantity controls vary by theme, so it also polls.
  if (onCartPage) window.setInterval(checkCart, 1000);
})();
