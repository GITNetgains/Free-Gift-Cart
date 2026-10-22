(() => {
  function node(tag, text, attributes = {}) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  async function initialize(root) {
    if (root.dataset.initialized) return;
    root.dataset.initialized = 'true';
    const status = root.querySelector('[data-help-desk-status]');
    function message(text, error = false, focus = true) {
      status.textContent = text;
      status.dataset.error = String(error);
      if (focus) status.focus();
    }
    let endpoint;
    try {
      endpoint = new URL(root.dataset.endpoint, location.origin);
      if (endpoint.origin !== location.origin) throw new Error();
    } catch {
      message('The help desk address is not configured correctly. Please contact the store.', true, false);
      return;
    }
    let config;
    try {
      const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      config = await response.json();
      if (!Array.isArray(config.topics)) throw new Error();
    } catch {
      message('The help desk could not load. Please try again.', true, false);
      const retry = node('button', 'Try again', { type: 'button' });
      retry.onclick = () => { retry.disabled = true; delete root.dataset.initialized; initialize(root); };
      status.append(retry);
      return;
    }
    const { topics, orderTypes, issues, updates, countries } = config;
    const trackingLink = token => `${endpoint.pathname}?ticket=${encodeURIComponent(token)}`;
    let requestKey = '';
    // Signed-in customers: the block renders their contact details and recent orders.
    let customer = null;
    try { customer = JSON.parse(root.querySelector('[data-help-desk-customer]')?.textContent || 'null'); } catch { customer = null; }
    // Live orders from the app (signed proxy request) win over the theme's copy.
    const sourceOrders = Array.isArray(config.orders) && config.orders.length ? config.orders : customer?.orders;
    const orders = Array.isArray(sourceOrders) ? sourceOrders.filter(order => order?.name && !order.cancelled) : [];
    const items = order => (Array.isArray(order?.items) ? order.items : []);
    const shipped = order => order.fulfillment === 'fulfilled' || order.fulfillment === 'partial';
    const itemLine = item => [item.title, item.variant].filter(Boolean).join(' - ') + ` × ${item.quantity || 1}`;
    // Chosen products: products the customer wants (or ships), and for a
    // wrong delivery the products they actually received.
    const selected = new Map();
    const received = new Map();
    const form = node('form');
    const controls = node('fieldset');
    const fields = node('div', '', { 'data-fields': '' });
    function field(parent, name, label, options = {}) {
      const wrap = node('label');
      const title = node('span', label);
      if (!options.optional) title.append(' ', node('span', '*', { class: 'help-desk-required', 'aria-hidden': 'true' }));
      wrap.append(title);
      let input;
      if (options.choices) {
        input = node('select');
        input.append(node('option', 'Select an option', { value: '' }));
        for (const choice of options.choices) {
          const [value, title] = Array.isArray(choice) ? choice : [choice, choice];
          input.append(node('option', title, { value }));
        }
      } else {
        input = node(options.multiline ? 'textarea' : 'input');
        if (!options.multiline) input.type = options.type || 'text';
        input.maxLength = options.multiline ? 5000 : 200;
        if (options.placeholder) input.placeholder = options.placeholder;
        if (options.autocomplete) input.autocomplete = options.autocomplete;
      }
      input.name = name;
      input.required = !options.optional;
      wrap.append(input);
      parent.append(wrap);
      return input;
    }
    const contact = [
      [field(controls, 'name', 'Name', { autocomplete: 'name' }), 'name'],
      [field(controls, 'email', 'Email', { type: 'email', autocomplete: 'email' }), 'email'],
      [field(controls, 'phone', 'Phone number (optional)', { type: 'tel', optional: true, autocomplete: 'tel' }), 'phone'],
    ];
    function prefill() { for (const [input, key] of contact) if (!input.value && customer?.[key]) input.value = String(customer[key]); }
    // Order queries are the most common, so they're listed first; the logic below still uses topics' own order.
    const topic = field(controls, 'topic', 'How can we help you?', { choices: [topics[3], ...topics.filter((_, index) => index !== 3)] });
    controls.append(fields);
    const trap = field(controls, 'website', 'Leave this blank', { optional: true });
    trap.parentElement.className = 'help-desk-trap';
    trap.tabIndex = -1;
    trap.autocomplete = 'off';
    const submit = node('button', 'Submit request', { type: 'submit' });
    controls.append(submit);
    if (customer) form.append(node('p', `Signed in as ${customer.name || customer.email}. We've filled in your details${orders.length ? ' and listed your recent orders' : ''}.`, { class: 'help-desk-signed' }));
    form.append(controls);
    prefill();
    // Signed-in customers' earlier requests, each linking to its private request page.
    const history = Array.isArray(config.tickets) && config.tickets.length ? node('details', '', { class: 'help-desk-history' }) : null;
    if (history) {
      history.append(node('summary', `Your requests (${config.tickets.length})`));
      const list = node('ul');
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
      for (const ticket of config.tickets) {
        const item = node('li');
        const link = node('a', `#${ticket.number} · ${ticket.topic}`, { href: trackingLink(ticket.token) });
        item.append(link, node('span', ticket.status, { class: 'help-desk-pill', 'data-status': ticket.status }), node('small', `Updated ${date.format(new Date(ticket.updatedAt))}`));
        list.append(item);
      }
      history.append(list);
      history.open = config.tickets.some(ticket => ticket.status === 'Waiting on customer');
    }
    root.querySelector('[data-help-desk-form]').replaceChildren(...(history ? [history] : []), form);
    message('', false, false);

    // A drop zone over the native file input; picks add to the chosen images,
    // which show as thumbnails that can be removed before submitting.
    function imageField(parent, required) {
      const types = ['image/jpeg', 'image/png', 'image/webp'];
      const wrap = node('div', '', { class: 'help-desk-upload' });
      const label = node('label');
      const title = node('span');
      const drop = node('span', '', { class: 'help-desk-drop' });
      const upload = node('input', '', { type: 'file', name: 'images', accept: types.join(','), multiple: '' });
      const previews = node('div', '', { class: 'help-desk-previews' });
      drop.append(node('span', '', { class: 'help-desk-drop-icon', 'aria-hidden': 'true' }), node('strong', 'Click to upload or drag and drop'), node('small', 'JPG, PNG or WebP · up to 5 images, 5 MB each'), upload);
      label.append(title, drop);
      wrap.append(label, previews);
      parent.append(wrap);
      let files = [];
      let urls = [];
      function sync() {
        const transfer = new DataTransfer();
        files.forEach(file => transfer.items.add(file));
        upload.files = transfer.files;
        upload.setCustomValidity(files.length > 5 || files.some(file => !types.includes(file.type) || !file.size || file.size > 5 * 1024 * 1024)
          ? 'Choose up to five JPG, PNG or WebP images, no more than 5 MB each.' : '');
        urls.forEach(url => URL.revokeObjectURL(url));
        urls = files.map(file => URL.createObjectURL(file));
        previews.replaceChildren(...files.map((file, index) => {
          const item = node('figure', '', { class: file.size > 5 * 1024 * 1024 || !types.includes(file.type) ? 'help-desk-invalid' : '' });
          const remove = node('button', '×', { type: 'button', 'aria-label': `Remove ${file.name}` });
          remove.onclick = () => { files.splice(index, 1); sync(); };
          item.append(node('img', '', { src: urls[index], alt: '' }), node('figcaption', file.name), remove);
          return item;
        }));
        drop.dataset.count = files.length ? `${files.length} of 5 selected` : '';
      }
      upload.onchange = () => {
        for (const file of upload.files) if (!files.some(item => item.name === file.name && item.size === file.size)) files.push(file);
        sync();
      };
      for (const [type, active] of [['dragenter', true], ['dragover', true], ['dragleave', false], ['drop', false]]) upload.addEventListener(type, () => drop.classList.toggle('help-desk-dragging', active));
      upload.setRequired = value => {
        upload.required = value;
        title.replaceChildren('Upload images ', value ? node('span', '*', { class: 'help-desk-required', 'aria-hidden': 'true' }) : '(optional)');
      };
      upload.setRequired(required);
      return upload;
    }

    // Product thumbnails: theme-rendered URLs are already small; search results get a width hint.
    function sized(url) {
      if (!url) return '';
      try { const target = new URL(url, location.origin); target.searchParams.set('width', '120'); return target.href; } catch { return ''; }
    }
    function thumb(src) {
      return src ? node('img', '', { src, alt: '', loading: 'lazy', class: 'help-desk-thumb' }) : node('span', '', { class: 'help-desk-thumb', 'aria-hidden': 'true' });
    }

    // Signed-in customers pick from their orders (or type another number); the
    // chosen order's items are shown and passed to onPick. include narrows the list.
    function orderField(parent, onPick, include = () => true, showItems = true) {
      const choices = orders.filter(include);
      if (!choices.length) return field(parent, 'orderNumber', 'Order number', { placeholder: 'e.g. #1001' });
      const count = order => items(order).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
      const pick = field(parent, 'orderNumber', 'Order number', {
        choices: [...choices.map(order => [order.name, `${order.name} · ${order.date} · ${count(order)} item${count(order) === 1 ? '' : 's'}`]), ['', "My order isn't listed"]],
      });
      pick.lastElementChild.value = 'other';
      const extra = node('div', '', { 'data-fields': '' });
      parent.append(extra);
      pick.onchange = () => {
        extra.replaceChildren();
        pick.name = pick.value === 'other' ? '' : 'orderNumber';
        if (pick.value === 'other') { field(extra, 'orderNumber', 'Enter your order number', { placeholder: 'e.g. #1001' }); onPick?.(null); return; }
        const order = choices.find(entry => entry.name === pick.value);
        if (!order) return onPick?.(null);
        if (!showItems) return onPick?.(order);
        const list = node('div', '', { class: 'help-desk-order-items' });
        for (const item of items(order)) {
          const row = node('div');
          const text = node('span', item.title);
          text.append(node('small', [item.variant, `Qty ${item.quantity || 1}`].filter(Boolean).join(' · ')));
          row.append(thumb(item.image), text);
          list.append(row);
        }
        extra.append(list);
        onPick?.(order);
      };
      // Preselect the most recent matching order so signed-in customers don't have to pick or type one.
      pick.value = choices[0].name;
      pick.onchange();
      return pick;
    }

    // The store's products, with the signed-in customer's ordered products first.
    function catalog() {
      const products = Array.from(root.querySelector('[data-help-desk-products]').options).map(option => ({ id: option.value, title: option.textContent, image: option.dataset.image || '' }));
      const ordered = new Map();
      for (const item of orders.flatMap(items)) if (item.id && !ordered.has(item.id)) ordered.set(item.id, { id: item.id, title: item.title, image: item.image, ordered: true });
      return [...ordered.values(), ...products.filter(product => !ordered.has(product.id))];
    }

    // Multi-select product list. With a fixed source (one order's items) there
    // is no search; otherwise the store catalog can be searched.
    function productPicker(parent, title = 'Select products', source = null, selection = selected) {
      const dropdown = node('details');
      const summary = node('summary');
      const results = node('div', '', { class: 'help-desk-results' });
      const chips = node('div', '', { class: 'help-desk-selected' });
      const hint = node('p', source ? 'Choose the products from this order.' : 'Choose multiple products. Search by name to find more products.');
      dropdown.append(summary);
      const search = source ? null : field(dropdown, '', 'Search products', { type: 'search', optional: true });
      const searchButton = node('button', 'Search', { type: 'button' });
      if (search) dropdown.append(searchButton);
      dropdown.append(hint, results);
      dropdown.open = Boolean(source);
      parent.append(dropdown, chips);
      const initial = source || catalog();
      let current = initial;
      let searchVersion = 0;
      function render() {
        summary.textContent = `${title} * (${selection.size} selected)`;
        results.replaceChildren();
        chips.replaceChildren();
        for (const product of current) {
          const label = node('label', '', { class: 'help-desk-choice' });
          const checkbox = node('input', '', { type: 'checkbox' });
          checkbox.checked = selection.has(product.id);
          checkbox.onchange = () => { if (checkbox.checked) selection.set(product.id, product); else selection.delete(product.id); render(); };
          label.append(checkbox, thumb(product.image), node('span', product.title));
          if (product.ordered) label.append(node('span', 'Ordered', { class: 'help-desk-badge' }));
          results.append(label);
        }
        for (const [id, { title: name, image }] of selection) {
          const remove = node('button', '', { type: 'button', 'aria-label': `Remove ${name}` });
          remove.append(thumb(image), node('span', name), node('span', '×', { 'aria-hidden': 'true' }));
          remove.onclick = () => { selection.delete(id); render(); };
          chips.append(remove);
        }
      }
      async function searchProducts() {
        const version = ++searchVersion;
        if (!search.value.trim()) {
          current = initial;
          render();
          hint.textContent = 'Choose multiple products. Search by name to find more products.';
          searchButton.disabled = false;
          return;
        }
        searchButton.disabled = true;
        hint.textContent = 'Searching...';
        try {
          const base = window.Shopify?.routes?.root || '/';
          const params = new URLSearchParams({ q: search.value.trim(), 'resources[type]': 'product', 'resources[limit]': '10', 'resources[options][unavailable_products]': 'show' });
          const response = await fetch(`${base}search/suggest.json?${params}`);
          if (!response.ok) throw new Error();
          const data = await response.json();
          if (version !== searchVersion) return;
          current = data.resources.results.products.map(product => ({ id: `gid://shopify/Product/${product.id}`, title: product.title, image: sized(product.featured_image?.url || product.image) }));
          render();
          hint.textContent = current.length ? 'Showing up to 10 matches. Refine your search to find another product.' : 'No products found. Try a different name.';
        } catch { if (version === searchVersion) hint.textContent = 'Products could not be loaded. Please try searching again.'; }
        finally { if (version === searchVersion) searchButton.disabled = false; }
      }
      if (search) {
        searchButton.onclick = searchProducts;
        search.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); searchProducts(); } };
      }
      render();
    }

    function renderTopic() {
      fields.replaceChildren();
      selected.clear();
      received.clear();
      message('', false, false);
      if (topic.value === topics[0]) {
        productPicker(fields);
        field(fields, 'country', 'Select country', { choices: countries.map(country => [country.code, country.name]) });
        field(fields, 'address', 'Address', { multiline: true, placeholder: 'Street address, city, state / province and postal code' });
        field(fields, 'otherDetails', 'Any other details (optional)', { multiline: true, optional: true });
      } else if (topic.value === topics[1] || topic.value === topics[2]) {
        const wholesale = topic.value === topics[1];
        const radios = node('fieldset');
        const legend = node('legend', `Are you an existing ${wholesale ? 'wholesaler' : 'affiliate'}? `);
        legend.append(node('span', '*', { class: 'help-desk-required', 'aria-hidden': 'true' }));
        radios.append(legend);
        const partnerFields = node('div', '', { 'data-fields': '' });
        for (const answer of ['Yes', 'No']) {
          const label = node('label', '', { class: 'help-desk-choice' });
          const radio = node('input', '', { type: 'radio', name: 'existing', value: answer, required: '' });
          label.append(radio, document.createTextNode(answer));
          radios.append(label);
          radio.onchange = () => {
            partnerFields.replaceChildren();
            if (answer === 'Yes') field(partnerFields, 'registeredEmail', 'Registered email', { type: 'email' });
            else {
              const url = wholesale ? root.dataset.wholesaleUrl : root.dataset.affiliateUrl;
              const prompt = node('p', `Want to become ${wholesale ? 'a wholesaler' : 'an affiliate'}? `);
              if (url) {
                const target = new URL(url, location.origin);
                if (['http:', 'https:'].includes(target.protocol)) prompt.append(node('a', 'Visit the signup page', { href: target.href, target: '_blank', rel: 'noopener' }));
              }
              prompt.append(document.createTextNode(' You can also send your query below using the contact information above.'));
              partnerFields.append(prompt);
            }
            field(partnerFields, 'query', 'Query', { multiline: true, placeholder: 'How can we help you?' });
          };
        }
        fields.append(radios, partnerFields);
      } else if (topic.value === topics[3] || topic.value === topics[4]) {
        let orderDetails, productDetails;
        // Fill the order's date and items in, unless the customer has typed their own.
        const autofill = (input, value) => { if (input && (!input.value || input.dataset.auto)) { input.value = value; input.dataset.auto = value ? 'true' : ''; } };
        if (topic.value === topics[4]) {
          orderField(fields, order => {
            autofill(orderDetails, order ? `Order ${order.name} placed on ${order.date}` : '');
            autofill(productDetails, order ? items(order).map(itemLine).join('\n') : '');
          }, shipped);
          orderDetails = field(fields, 'orderDetails', 'Order details', { multiline: true, placeholder: 'Order date and any relevant order information' });
          productDetails = field(fields, 'productDetails', 'Product details', { multiline: true, placeholder: 'Product name, variant and quantity' });
          for (const input of [orderDetails, productDetails]) input.addEventListener('input', () => { input.dataset.auto = ''; });
          field(fields, 'issue', 'Issue faced', { choices: issues });
          field(fields, 'details', 'Issue details', { multiline: true, placeholder: 'Share in detail' });
          imageField(fields, true);
          field(fields, 'resolution', 'What would you like to do?', { choices: ['Return', 'Exchange', 'Refund'] });
        } else {
          const orderType = field(fields, 'orderType', 'What is your order query?', { choices: orderTypes });
          const orderFields = node('div', '', { 'data-fields': '' });
          fields.append(orderFields);
          orderType.onchange = () => {
            orderFields.replaceChildren();
            selected.clear();
            received.clear();
            if (!orderType.value) return;
            const wrongProduct = orderType.value === orderTypes[2];
            const picker = node('div', '', { 'data-fields': '' });
            // Updates are for orders that haven't shipped; issues and wrong items come with delivered orders.
            orderField(orderFields, order => {
              if (!wrongProduct) return;
              selected.clear();
              picker.replaceChildren();
              productPicker(picker, 'Which product did you want?', order ? items(order).filter(item => item.id).map(item => ({ id: item.id, title: [item.title, item.variant].filter(Boolean).join(' - '), image: item.image })) : null);
            }, orderType.value === orderTypes[0] ? order => order.fulfillment !== 'fulfilled' : shipped, !wrongProduct);
            if (orderType.value === orderTypes[0]) {
              const update = field(orderFields, 'update', 'Order update', { choices: updates });
              const details = node('div', '', { 'data-fields': '' });
              orderFields.append(details);
              update.onchange = () => {
                details.replaceChildren();
                if (update.value) field(details, 'details', update.value === updates[1] ? 'Shipping details' : 'Product or quantity changes', { multiline: true, placeholder: update.value === updates[1] ? 'Share the current address and updated address' : 'Share the current product / quantity and the changes you would like' });
              };
            } else if (orderType.value === orderTypes[1]) {
              const issue = field(orderFields, 'issue', 'Product issue', { choices: issues.slice(0, 3) });
              field(orderFields, 'details', 'Issue details', { multiline: true, placeholder: 'Share in detail' });
              const images = imageField(orderFields, false);
              issue.onchange = () => {
                images.setRequired(issues.slice(0, 2).includes(issue.value));
              };
            } else if (wrongProduct) {
              // What arrived (searched in the store) and what should have arrived (from the order when known).
              const receivedPicker = node('div', '', { 'data-fields': '' });
              productPicker(receivedPicker, 'Which product did you receive?', null, received);
              orderFields.append(receivedPicker, picker);
              if (!orders.some(shipped)) productPicker(picker, 'Which product did you want?');
              field(orderFields, 'details', 'Anything else we should know? (optional)', { multiline: true, optional: true, placeholder: 'For example size, colour or quantity differences' });
              imageField(orderFields, true);
            }
          };
        }
      }
    }
    topic.onchange = renderTopic;
    form.onsubmit = async event => {
      event.preventDefault();
      if (controls.disabled) return;
      const wrongProduct = topic.value === topics[3] && form.elements.orderType?.value === orderTypes[2];
      if (wrongProduct && !received.size) { message('Select the product you received.', true); return; }
      if ((topic.value === topics[0] || wrongProduct) && !selected.size) { message(wrongProduct ? 'Select the product you wanted.' : 'Select at least one product.', true); return; }
      if (!requestKey) requestKey = crypto.randomUUID();
      const body = new FormData(form);
      body.set('requestKey', requestKey);
      for (const id of selected.keys()) body.append('products', id);
      for (const id of received.keys()) body.append('receivedProducts', id);
      controls.disabled = true;
      submit.textContent = 'Submitting...';
      message('', false, false);
      try {
        const response = await fetch(endpoint, { method: 'POST', body, headers: { Accept: 'application/json' } });
        const result = await response.json();
        if (!response.ok || !result.ticketId) {
          message(Object.values(result.errors || {}).join(' ') || 'Your request could not be saved. Please try again.', true);
          return;
        }
        form.reset();
        prefill();
        renderTopic();
        requestKey = '';
        const label = result.number ? `#${result.number}` : result.ticketId;
        message(`Thank you! Your request ${label} has been received. We'll reply by email, and you can follow it on your request page. `);
        if (result.token) status.append(node('a', 'View your request', { href: trackingLink(result.token) }));
      } catch { message('We could not confirm your submission. Please try again; your entries are still here.', true); }
      finally { controls.disabled = false; submit.textContent = 'Submit request'; }
    };
  }
  function mount() { document.querySelectorAll('[data-help-desk]').forEach(initialize); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  document.addEventListener('shopify:section:load', mount);
})();
