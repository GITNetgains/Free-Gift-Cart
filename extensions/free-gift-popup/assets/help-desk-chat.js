(() => {
  // Storefront chat: a rule-based assistant answers first (store FAQs and live
  // order status). "Talk to our team" turns the chat into a Help Desk ticket,
  // after which the same window is a live conversation with the store's team.
  const TOKEN_KEY = 'hd-chat-token';
  const SEEN_KEY = 'hd-chat-seen';
  const TRANSCRIPT_KEY = 'hd-chat-transcript';
  const CONFIG_KEY = 'hd-chat-config';
  const MAX_IMAGES = 3;
  const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
    set(area, key, value) { try { if (value === null) window[area].removeItem(key); else window[area].setItem(key, value); } catch { /* storage unavailable */ } },
  };

  function node(tag, text, attributes = {}) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function initialize(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = 'true';
    let endpoint;
    try {
      endpoint = new URL(root.dataset.endpoint || '/apps/help-desk', location.origin);
      if (endpoint.origin !== location.origin) return;
    } catch { return; }
    let customer = null;
    try { customer = JSON.parse(root.querySelector('[data-hd-chat-customer]')?.textContent || 'null'); } catch { customer = null; }
    const title = root.dataset.title || 'Chat with us';
    root.dataset.position = root.dataset.position === 'left' ? 'left' : 'right';

    const launcher = node('button', '', { type: 'button', class: 'hd-chat-launcher', 'aria-expanded': 'false', 'aria-label': title });
    launcher.append(node('span', '', { class: 'hd-chat-icon', 'aria-hidden': 'true' }), node('span', '', { class: 'hd-chat-dot', hidden: '' }));
    const panel = node('section', '', { class: 'hd-chat-panel', role: 'dialog', 'aria-label': title, hidden: '' });
    const header = node('header');
    const heading = node('div');
    const headingTitle = node('strong', title);
    const subtitle = node('small', 'We usually reply within a few hours');
    heading.append(headingTitle, subtitle);
    const menu = node('button', 'New chat', { type: 'button', class: 'hd-chat-new', hidden: '' });
    const close = node('button', '×', { type: 'button', class: 'hd-chat-close', 'aria-label': 'Close chat' });
    header.append(heading, menu, close);
    const log = node('div', '', { class: 'hd-chat-log', role: 'log', 'aria-live': 'polite' });
    const chips = node('div', '', { class: 'hd-chat-chips' });
    const form = node('form', '', { class: 'hd-chat-compose' });
    const input = node('textarea', '', { rows: '1', placeholder: 'Type your message...', 'aria-label': 'Message', maxlength: '2000' });
    const attach = node('label', '', { class: 'hd-chat-attach', title: 'Attach photos', hidden: '' });
    const files = node('input', '', { type: 'file', accept: TYPES.join(','), multiple: '' });
    attach.append(node('span', '+', { 'aria-hidden': 'true' }), node('span', 'Attach photos', { class: 'hd-chat-sr' }), files);
    const send = node('button', 'Send', { type: 'submit', class: 'hd-chat-send' });
    const fileNote = node('div', '', { class: 'hd-chat-files', hidden: '' });
    form.append(attach, input, send);
    panel.append(header, log, chips, fileNote, form);
    root.append(launcher, panel);

    let config = null;
    let token = store.get('localStorage', TOKEN_KEY);
    let transcript = [];
    try { transcript = JSON.parse(store.get('sessionStorage', TRANSCRIPT_KEY) || '[]'); } catch { transcript = []; }
    let ticket = null;
    let messages = [];
    let pollTimer = 0;
    let busy = false;
    let handoff = null;

    const isOpen = () => !panel.hidden;
    const saveTranscript = () => store.set('sessionStorage', TRANSCRIPT_KEY, JSON.stringify(transcript.slice(-30)));

    async function request(params, body) {
      const target = new URL(endpoint);
      for (const [key, value] of Object.entries(params || {})) target.searchParams.set(key, value);
      const response = await fetch(target, body ? { method: 'POST', body, headers: { Accept: 'application/json' } } : { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, data };
    }

    function bubble(kind, text, meta, extra) {
      const item = node('div', '', { class: 'hd-chat-msg', 'data-kind': kind });
      if (meta) item.append(node('small', meta));
      item.append(node('p', text));
      if (extra) item.append(extra);
      log.append(item);
      log.scrollTop = log.scrollHeight;
      return item;
    }

    function typing() {
      const item = node('div', '', { class: 'hd-chat-msg hd-chat-typing', 'data-kind': 'bot', 'aria-label': 'Assistant is typing' });
      item.append(node('span'), node('span'), node('span'));
      log.append(item);
      log.scrollTop = log.scrollHeight;
      return item;
    }

    function setChips(list) {
      chips.replaceChildren(...list.map(([label, action]) => {
        const chip = node('button', label, { type: 'button' });
        chip.onclick = action;
        return chip;
      }));
    }

    const talkChip = ['Talk to our team', () => showHandoff()];

    // ----- Assistant mode -----
    function renderAssistant() {
      log.replaceChildren();
      bubble('bot', config?.greeting || 'Hi! How can we help?', 'Assistant');
      for (const line of transcript) bubble(line.from === 'bot' ? 'bot' : 'customer', line.text, line.from === 'bot' ? 'Assistant' : 'You');
      setChips([...(transcript.length ? [] : (config?.suggestions || []).map(question => [question, () => ask(question)])), talkChip]);
      subtitle.textContent = 'Ask a question or talk to our team';
      menu.hidden = true;
      attach.hidden = true;
    }

    async function ask(question) {
      if (busy || !question.trim()) return;
      busy = true;
      transcript.push({ from: 'customer', text: question.trim() });
      saveTranscript();
      bubble('customer', question.trim(), 'You');
      setChips([]);
      const dots = typing();
      const body = new FormData();
      body.set('intent', 'ask');
      body.set('question', question.trim());
      try {
        const { ok, data } = await request({}, body);
        dots.remove();
        const answer = ok && data.answer ? data.answer : (data.errors && Object.values(data.errors)[0]) || 'Sorry, something went wrong. Please try again.';
        let links = null;
        if (Array.isArray(data.links) && data.links.length) {
          links = node('div', '', { class: 'hd-chat-links' });
          for (const link of data.links) {
            try {
              const url = new URL(link.url);
              if (url.protocol === 'https:') links.append(node('a', link.label, { href: url.href, target: '_blank', rel: 'noopener' }));
            } catch { /* skip invalid links */ }
          }
        }
        bubble('bot', answer, 'Assistant', links);
        transcript.push({ from: 'bot', text: answer });
        saveTranscript();
        setChips(data.result === 'none' ? [talkChip] : [['That helped, thanks', () => { bubble('bot', 'Great! Anything else, just ask.', 'Assistant'); setChips([talkChip]); }], talkChip]);
      } catch {
        dots.remove();
        bubble('bot', 'We could not reach the assistant. Please check your connection and try again.', 'Assistant');
        setChips([talkChip]);
      } finally { busy = false; }
    }

    // ----- Hand-off to the team -----
    function showHandoff() {
      if (handoff) { handoff.querySelector('input,textarea')?.focus(); return; }
      setChips([]);
      handoff = node('form', '', { class: 'hd-chat-handoff' });
      const lastQuestion = [...transcript].reverse().find(line => line.from === 'customer')?.text || '';
      const field = (label, { multiline, ...attributes }, value = '') => {
        const wrap = node('label', label);
        const control = node(multiline ? 'textarea' : 'input', '', attributes);
        control.value = value;
        wrap.append(control);
        handoff.append(wrap);
        return control;
      };
      handoff.append(node('p', 'Leave your details and our team will reply here and by email.'));
      const name = field('Name', { name: 'name', required: '', autocomplete: 'name', maxlength: '200' }, customer?.name || '');
      const email = field('Email', { name: 'email', type: 'email', required: '', autocomplete: 'email', maxlength: '200' }, customer?.email || '');
      const message = field('Message', { name: 'body', required: '', multiline: true, rows: '3', maxlength: '2000' }, lastQuestion);
      const error = node('p', '', { class: 'hd-chat-error', role: 'alert' });
      const submit = node('button', 'Send to our team', { type: 'submit' });
      handoff.append(error, submit);
      log.append(handoff);
      log.scrollTop = log.scrollHeight;
      (name.value ? (email.value ? message : email) : name).focus();
      let requestKey = '';
      handoff.onsubmit = async event => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        submit.disabled = true;
        submit.textContent = 'Sending...';
        error.textContent = '';
        if (!requestKey) requestKey = crypto.randomUUID();
        const body = new FormData();
        body.set('intent', 'chat-start');
        body.set('name', name.value);
        body.set('email', email.value);
        body.set('body', message.value);
        body.set('requestKey', requestKey);
        // The question being handed off is sent as the message, not repeated in the transcript.
        const earlier = transcript.slice();
        if (earlier.length && earlier[earlier.length - 1].from === 'customer' && earlier[earlier.length - 1].text === message.value.trim()) earlier.pop();
        body.set('transcript', JSON.stringify(earlier));
        try {
          const { ok, data } = await request({}, body);
          if (!ok || !data.token) {
            error.textContent = Object.values(data.errors || {}).join(' ') || 'Your message could not be sent. Please try again.';
            return;
          }
          token = data.token;
          store.set('localStorage', TOKEN_KEY, token);
          transcript = [];
          saveTranscript();
          handoff = null;
          await refresh(true);
        } catch {
          error.textContent = 'Your message could not be sent. Please check your connection and try again.';
        } finally {
          busy = false;
          submit.disabled = false;
          submit.textContent = 'Send to our team';
        }
      };
    }

    // ----- Live conversation -----
    function renderLive() {
      log.replaceChildren();
      for (const message of messages) {
        const who = message.kind === 'customer' ? 'You' : message.kind === 'bot' ? 'Assistant' : message.author;
        const time = new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const extra = message.images ? node('small', `${message.images} image${message.images === 1 ? '' : 's'} attached`, { class: 'hd-chat-meta' }) : null;
        bubble(message.kind === 'customer' ? 'customer' : message.kind === 'bot' ? 'bot' : 'agent', message.body, `${who} · ${time}`, extra);
      }
      if (ticket?.status === 'Resolved') bubble('system', 'This conversation is resolved. Send a message to reopen it, or start a new chat.');
      headingTitle.textContent = `${title} · #${ticket.number}`;
      subtitle.textContent = ticket.status === 'Waiting on customer' ? 'We replied. Your turn!' : ticket.status === 'Resolved' ? 'Resolved' : 'Our team will reply here and by email';
      setChips([]);
      menu.hidden = false;
      attach.hidden = false;
      const latest = messages[messages.length - 1];
      if (latest && isOpen()) store.set('localStorage', SEEN_KEY, latest.id);
    }

    function markUnread() {
      const latestReply = [...messages].reverse().find(message => message.kind === 'reply');
      const unread = Boolean(latestReply && latestReply.id !== store.get('localStorage', SEEN_KEY) && !isOpen()
        && messages[messages.length - 1].kind === 'reply');
      launcher.querySelector('.hd-chat-dot').hidden = !unread;
    }

    async function refresh(force) {
      if (!token) return;
      try {
        const { ok, status, data } = await request({ chat: token });
        if (status === 404) { startOver(); return; }
        if (!ok) return;
        const changed = force || !ticket || data.messages.length !== messages.length || data.ticket.status !== ticket.status
          || data.messages[data.messages.length - 1]?.id !== messages[messages.length - 1]?.id;
        ticket = data.ticket;
        messages = data.messages;
        if (changed && isOpen()) renderLive();
        markUnread();
      } catch { /* try again on the next poll */ }
    }

    function schedule() {
      clearTimeout(pollTimer);
      if (!token) return;
      // Fast while the chat is open and visible, slow in the background.
      const delay = document.visibilityState !== 'visible' ? 120000 : isOpen() ? 6000 : 45000;
      pollTimer = setTimeout(async () => { await refresh(false); schedule(); }, delay);
    }

    function startOver() {
      token = null;
      ticket = null;
      messages = [];
      store.set('localStorage', TOKEN_KEY, null);
      headingTitle.textContent = title;
      renderAssistant();
    }

    async function sendLive(text) {
      const chosen = Array.from(files.files || []);
      if (chosen.length > MAX_IMAGES || chosen.some(file => !TYPES.includes(file.type) || file.size > 5 * 1024 * 1024)) {
        bubble('system', `Attach up to ${MAX_IMAGES} JPG, PNG or WebP photos, 5 MB each.`);
        return false;
      }
      const body = new FormData();
      body.set('intent', 'reply');
      body.set('token', token);
      body.set('body', text);
      for (const file of chosen) body.append('images', file);
      const pending = bubble('customer', text || `Sending ${chosen.length} photo${chosen.length === 1 ? '' : 's'}...`, 'You · sending');
      try {
        const { ok, data } = await request({}, body);
        if (!ok) {
          pending.remove();
          bubble('system', Object.values(data.errors || {}).join(' ') || 'Your message could not be sent. Please try again.');
          return false;
        }
        files.value = '';
        fileNote.hidden = true;
        await refresh(true);
        return true;
      } catch {
        pending.remove();
        bubble('system', 'Your message could not be sent. Please check your connection and try again.');
        return false;
      }
    }

    // ----- Wiring -----
    async function loadConfig() {
      const cached = store.get('sessionStorage', CONFIG_KEY);
      if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }
      const { ok, data } = await request({ view: 'chat' });
      if (!ok) throw new Error('config');
      store.set('sessionStorage', CONFIG_KEY, JSON.stringify(data));
      return data;
    }

    async function open() {
      panel.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
      root.classList.add('hd-chat-open');
      launcher.querySelector('.hd-chat-dot').hidden = true;
      if (token) {
        if (ticket) renderLive(); else bubble('system', 'Loading your conversation...');
        await refresh(true);
      } else renderAssistant();
      input.focus();
      schedule();
    }

    function hide() {
      panel.hidden = true;
      launcher.setAttribute('aria-expanded', 'false');
      root.classList.remove('hd-chat-open');
      launcher.focus();
      schedule();
    }

    launcher.onclick = () => (isOpen() ? hide() : open());
    close.onclick = hide;
    menu.onclick = () => { if (confirm('Start a new chat? You can still find this conversation in your email.')) startOver(); };
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    files.onchange = () => {
      const count = files.files?.length || 0;
      fileNote.hidden = !count;
      fileNote.textContent = count ? `${count} photo${count === 1 ? '' : 's'} attached` : '';
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
    });
    form.onsubmit = async event => {
      event.preventDefault();
      const text = input.value.trim();
      if (busy || (!text && !(token && files.files?.length))) return;
      if (!token) {
        input.value = '';
        await ask(text);
        return;
      }
      busy = true;
      send.disabled = true;
      input.value = '';
      const sent = await sendLive(text);
      if (!sent) input.value = text;
      send.disabled = false;
      busy = false;
      input.focus();
    };
    document.addEventListener('visibilitychange', schedule);

    // The launcher appears only when the store has the chat turned on.
    loadConfig().then(data => {
      config = data;
      if (!config.enabled) return;
      root.hidden = false;
      if (token) refresh(false).then(schedule);
    }).catch(() => { /* chat stays hidden */ });
  }

  function mount() { document.querySelectorAll('[data-hd-chat]').forEach(initialize); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
