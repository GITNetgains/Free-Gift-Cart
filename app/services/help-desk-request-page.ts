import { countryName, fieldLabels } from "./help-desk";

// The customer-facing pages served through the app proxy: the private request
// page and the lookup page. They are returned as Liquid so the store's theme
// wraps them with its own header, footer and fonts; the styles below pin the
// typography so a theme's heading styles can't distort the layout.

// Escapes HTML and Liquid delimiters: these pages are rendered by the theme as Liquid.
const escape = (value: string) => value.replace(/[&<>"'{}]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "{": "&#123;", "}": "&#125;" })[char]!);
const multiline = (value: string) => escape(value).replace(/\r?\n/g, "<br>");
// Rendered in UTC on the server, then switched to the shopper's own time zone by the page script.
const time = (value: Date, style: "full" | "date" = "full") => `<time datetime="${value.toISOString()}" data-hdt-time="${style}">${escape(new Intl.DateTimeFormat("en", style === "date" ? { dateStyle: "medium", timeZone: "UTC" } : { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(value))}</time>`;
const initials = (name: string) => escape(name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "?");

const STATUS_COPY: Record<string, { title: string; text: string }> = {
  Open: { title: "We've got your request", text: "Our team will look at it and reply soon. We'll email you as soon as they do." },
  "In progress": { title: "Our team is working on it", text: "We're sorting this out for you and will update you here and by email." },
  "Waiting on customer": { title: "We've replied: it's your turn", text: "Read our reply below and send us your answer so we can keep going." },
  Resolved: { title: "This request is resolved", text: "Thanks for your patience. If you still need help, please send us a new request." },
};
const STEPS = [
  { label: "Received", status: "Open" },
  { label: "In progress", status: "In progress" },
  { label: "Your reply", status: "Waiting on customer" },
  { label: "Resolved", status: "Resolved" },
];
// Short facts go in the summary; what the customer wrote goes in their message.
const SUMMARY_FIELDS = ["orderNumber", "orderType", "update", "issue", "resolution", "existing", "registeredEmail", "country", "phone"];
const MESSAGE_FIELDS = ["details", "query", "orderDetails", "productDetails", "address", "otherDetails"];

const STYLES = `<style>
.hdt{--ink:#19213d;--muted:#5b6275;--line:#e6e8ee;--soft:#f5f6f9;--accent:#ef3a24;--ok:#0c7a43;max-width:1040px;margin:clamp(24px,4vw,48px) auto clamp(48px,6vw,80px);padding:0 16px;color:var(--ink);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.hdt *{box-sizing:border-box}
.hdt p,.hdt dl,.hdt dd,.hdt ol,.hdt ul{margin:0}
.hdt h1,.hdt h2,.hdt h3{margin:0;color:var(--ink);font-family:inherit;font-style:normal;text-transform:none;letter-spacing:-.01em}
.hdt h1{font-size:clamp(26px,3.4vw,34px);font-weight:700;line-height:1.15}
.hdt h2{font-size:17px;font-weight:700;line-height:1.3}
.hdt-card{border:1px solid var(--line);border-radius:20px;background:#fff;box-shadow:0 1px 2px rgba(25,33,61,.04),0 12px 32px rgba(25,33,61,.06)}
.hdt-pad{padding:clamp(20px,3vw,30px)}
.hdt-hero{position:relative;overflow:hidden;padding:clamp(22px,3.4vw,34px)}
.hdt-hero::before{content:"";position:absolute;inset:0 0 auto;height:4px;background:linear-gradient(90deg,var(--accent),#ff8a5c)}
.hdt-top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px}
.hdt-eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px;color:var(--muted);font-size:13px}
.hdt-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:var(--soft);color:var(--ink);font-size:12px;font-weight:600}
.hdt-pill{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;font-size:13px;font-weight:700;white-space:nowrap}
.hdt-pill i{width:8px;height:8px;border-radius:50%;background:currentColor}
.hdt-pill[data-status="Open"]{background:#fff4d6;color:#7a5600}
.hdt-pill[data-status="In progress"]{background:#e6effc;color:#1d4f94}
.hdt-pill[data-status="Waiting on customer"]{background:#fde8e5;color:#b3261e}
.hdt-pill[data-status="Resolved"]{background:#e3f5ea;color:var(--ok)}
.hdt .hdt-lead{margin-top:8px;color:var(--muted);font-size:15px;max-width:620px}
.hdt-steps{display:grid;grid-template-columns:repeat(4,1fr);margin-top:30px;padding:0;list-style:none}
.hdt-steps li{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--muted);font-size:13px;text-align:center}
.hdt-steps li::before{content:"";position:absolute;top:13px;left:-50%;right:50%;height:3px;border-radius:3px;background:var(--line)}
.hdt-steps li:first-child::before{display:none}
.hdt-steps b{position:relative;z-index:1;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;border:2px solid var(--line);background:#fff;font-size:12px;font-weight:700;color:var(--muted)}
.hdt-steps li[data-done],.hdt-steps li[data-current]{color:var(--ink)}
.hdt-steps li[data-done]::before,.hdt-steps li[data-current]::before{background:var(--ink)}
.hdt-steps li[data-done] b{border-color:var(--ink);background:var(--ink);color:#fff}
.hdt-steps li[data-current]{font-weight:700}
.hdt-steps li[data-current] b{border-color:var(--accent);background:var(--accent);color:#fff;box-shadow:0 0 0 5px rgba(239,58,36,.15)}
.hdt-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:22px;margin-top:22px;align-items:start}
.hdt-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px clamp(20px,3vw,30px);border-bottom:1px solid var(--line)}
.hdt-section-head span{color:var(--muted);font-size:13px}
.hdt-thread{display:grid;gap:22px;padding:clamp(20px,3vw,30px)}
.hdt-msg{display:grid;grid-template-columns:38px minmax(0,1fr);gap:12px;align-items:start}
.hdt-avatar{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:var(--soft);color:var(--ink);font-size:12px;font-weight:700}
.hdt-msg[data-kind="customer"] .hdt-avatar{background:#fde3df;color:#b3261e}
.hdt-msg[data-kind="reply"] .hdt-avatar{background:var(--ink);color:#fff}
.hdt-who{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin-bottom:6px}
.hdt-who strong{font-size:14px}
.hdt-who span{color:var(--muted);font-size:12px}
.hdt-tag{padding:1px 8px;border-radius:999px;background:var(--soft);font-size:11px;font-weight:700;color:var(--ink)}
.hdt-msg[data-kind="reply"] .hdt-tag{background:var(--ink);color:#fff}
.hdt-body{padding:14px 16px;border:1px solid var(--line);border-radius:4px 16px 16px 16px;background:#fff;overflow-wrap:anywhere}
.hdt-msg[data-kind="customer"] .hdt-body{background:var(--soft);border-color:transparent}
.hdt-msg[data-kind="reply"] .hdt-body{border-color:#d7dbe6;box-shadow:0 4px 14px rgba(25,33,61,.05)}
.hdt-msg[data-kind="bot"] .hdt-body{border-style:dashed}
.hdt-body p+p{margin-top:10px}
.hdt-facts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.hdt-facts span{padding:3px 10px;border-radius:999px;background:#fff;border:1px solid var(--line);font-size:12px;font-weight:600}
.hdt-products{display:grid;gap:8px}
.hdt-group{margin-top:16px}
.hdt .hdt-group h3{margin-bottom:8px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.hdt-product{display:flex;align-items:center;gap:12px;padding:8px;border-radius:12px;background:#fff;border:1px solid var(--line)}
.hdt-product img,.hdt-product i{flex:none;width:48px;height:48px;border-radius:9px;object-fit:cover;background:var(--soft)}
.hdt-product strong{font-size:14px;font-weight:600}
.hdt-files{display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:5px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);font-size:12px;font-weight:600}
.hdt-system{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px}
.hdt-system::before,.hdt-system::after{content:"";flex:1;height:1px;background:var(--line)}
.hdt-foot{padding:clamp(20px,3vw,30px);border-top:1px solid var(--line);background:#fbfbfd;border-radius:0 0 20px 20px}
.hdt-wait{display:flex;gap:14px;align-items:flex-start}
.hdt-wait i{flex:none;display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#fff;border:1px solid var(--line);font-style:normal;font-size:20px}
.hdt-wait strong{display:block;font-size:15px}
.hdt-wait p{margin-top:2px;color:var(--muted);font-size:14px}
.hdt label{display:grid;gap:6px;font-size:14px;font-weight:600}
.hdt textarea,.hdt input:not([type=file]){width:100%;margin:0;padding:13px 15px;border:1px solid #d4d7e0;border-radius:12px;background:#fff;color:var(--ink);font:inherit;font-weight:400}
.hdt textarea{min-height:120px;resize:vertical}
.hdt textarea:focus,.hdt input:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 4px rgba(25,33,61,.12)}
.hdt .hdt-drop{position:relative;display:flex;gap:12px;align-items:center;margin-top:12px;padding:12px 14px;border:1.5px dashed #c9ccd6;border-radius:12px;background:#fff;cursor:pointer;font-weight:400}
.hdt .hdt-drop:hover,.hdt .hdt-drop:focus-within{border-color:var(--ink)}
.hdt-drop input{position:absolute;inset:0;opacity:0;cursor:pointer}
.hdt-drop i{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--soft);font-style:normal;font-size:18px}
.hdt-drop strong{display:block;font-size:14px}.hdt-drop small{color:var(--muted);font-size:12px}
.hdt-actions{display:flex;justify-content:flex-end;margin-top:14px}
.hdt button{min-width:170px;margin:0;padding:13px 24px;border:0;border-radius:12px;background:var(--ink);color:#fff;font:inherit;font-weight:700;letter-spacing:normal;text-transform:none;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease}
.hdt button:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(25,33,61,.2)}
.hdt button:focus-visible{outline:3px solid rgba(239,58,36,.45);outline-offset:2px}
.hdt-aside{display:grid;gap:22px;position:sticky;top:24px}
.hdt dl{display:grid}
.hdt dl div{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid var(--line)}
.hdt dl div:last-child{border-bottom:0;padding-bottom:0}
.hdt dt{color:var(--muted);font-size:13px}
.hdt dd{font-size:14px;font-weight:600;text-align:right;overflow-wrap:anywhere}
.hdt-help p{color:var(--muted);font-size:14px}.hdt-help p+p{margin-top:10px}
.hdt-help h2{margin-bottom:10px}
.hdt a{color:var(--ink);font-weight:700;text-underline-offset:3px}
.hdt-note{margin-bottom:14px;padding:12px 14px;border-radius:12px;font-size:14px}
.hdt-note[data-tone="success"]{background:#e3f5ea;color:#0c5132}.hdt-note[data-tone="error"]{background:#fde8e6;color:#8e1f0b}
.hdt-lookup{max-width:500px;margin:0 auto}
.hdt-lookup form{display:grid;gap:14px;margin-top:20px}
@media (max-width:880px){.hdt-layout{grid-template-columns:minmax(0,1fr)}.hdt-aside{position:static}}
@media (max-width:560px){.hdt-steps li{font-size:11px}.hdt button{width:100%}.hdt-actions{display:block}.hdt-msg{grid-template-columns:32px minmax(0,1fr);gap:10px}.hdt-avatar{width:32px;height:32px;font-size:11px}}
@media (prefers-reduced-motion:reduce){.hdt button{transition:none}}
</style>`;

// Small enhancements: local times and the chosen-photos count.
const SCRIPT = `<script>
(function () {
  var full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  var day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  document.querySelectorAll('.hdt [data-hdt-time]').forEach(function (node) {
    var value = new Date(node.getAttribute('datetime'));
    if (!isNaN(value)) node.textContent = (node.getAttribute('data-hdt-time') === 'date' ? day : full).format(value);
  });
  document.querySelectorAll('.hdt-drop input').forEach(function (input) {
    input.addEventListener('change', function () {
      var label = input.closest('.hdt-drop').querySelector('strong');
      var count = input.files ? input.files.length : 0;
      label.textContent = count ? count + (count === 1 ? ' photo selected' : ' photos selected') : 'Add photos';
    });
  });
})();
</script>`;

const page = (title: string, body: string) => `{% layout 'theme' %}${STYLES}
<section class="hdt" aria-label="${escape(title)}">${body}</section>${SCRIPT}`;

const note = (state: { sent?: boolean; error?: string }) => state.sent ? `<div class="hdt-note" data-tone="success" role="status">Thanks, your message has been sent to our team.</div>`
  : state.error ? `<div class="hdt-note" data-tone="error" role="alert">${escape(state.error)}</div>` : "";

// Finding a request without its link: ticket number plus email.
export function renderLookupPage(state: { error?: string; number?: string; email?: string } = {}) {
  return page("Find your request", `
<div class="hdt-card hdt-hero hdt-lookup">
<p class="hdt-eyebrow"><span class="hdt-chip">Help Desk</span></p>
<h1>Find your request</h1>
<p class="hdt-lead">Enter the request number from your confirmation email and the email address you used.</p>
<form method="post" action="?ticket=">
${note(state)}
<input type="hidden" name="intent" value="lookup">
<label>Request number<input name="number" required inputmode="numeric" placeholder="e.g. 1001" value="${escape(state.number ?? "")}"></label>
<label>Email<input name="email" type="email" required autocomplete="email" placeholder="name@example.com" value="${escape(state.email ?? "")}"></label>
<div class="hdt-actions"><button type="submit">Find my request</button></div>
</form></div>`);
}

export type PageProduct = { id: string; title: string; image: string };
export type RequestPageTicket = {
  number: number; topic: string; status: string; channel: string; createdAt: Date; accessToken: string; details: string;
  messages: { id: string; kind: string; author: string; body: string; createdAt: Date }[];
};
export type RequestPageExtras = {
  imageCounts: Map<string, number>; requestImages: number; products: PageProduct[]; receivedProducts: PageProduct[];
  canReply: boolean; maxImages: number; maxLength: number; state?: { sent?: boolean; error?: string; draft?: string };
};

const fieldValue = (key: string, value: string) => key === "country" ? countryName(value) : value;
const files = (count: number) => count ? `<span class="hdt-files">📎 ${count} photo${count === 1 ? "" : "s"} attached</span>` : "";
const productList = (heading: string, products: PageProduct[]) => products.length ? `<div class="hdt-group"><h3>${escape(heading)}</h3><div class="hdt-products">${products.map((product) => `<div class="hdt-product">${product.image ? `<img src="${escape(product.image)}" alt="" loading="lazy">` : "<i></i>"}<strong>${escape(product.title)}</strong></div>`).join("")}</div></div>` : "";

export function renderRequestPage(ticket: RequestPageTicket, extras: RequestPageExtras) {
  const state = extras.state ?? {};
  const values = JSON.parse(ticket.details) as Record<string, string>;
  const chat = ticket.channel === "chat";
  const copy = STATUS_COPY[ticket.status] ?? { title: ticket.status, text: "" };
  const current = STEPS.findIndex((step) => step.status === ticket.status);
  const resolved = ticket.status === "Resolved";
  const steps = STEPS.map((step, index) => {
    const done = index < current || resolved;
    return `<li${done ? " data-done" : ""}${index === current && !resolved ? " data-current" : ""}><b>${done ? "✓" : index + 1}</b>${step.label}</li>`;
  }).join("");

  const message = (kind: string, author: string, at: Date, body: string) => {
    const who = kind === "customer" ? "You" : kind === "bot" ? "Assistant" : author;
    const tag = kind === "reply" ? `<span class="hdt-tag">Support team</span>` : kind === "bot" ? `<span class="hdt-tag">Automated</span>` : "";
    return `<div class="hdt-msg" data-kind="${kind}"><span class="hdt-avatar" aria-hidden="true">${kind === "bot" ? "AI" : kind === "customer" ? "You" : initials(author)}</span>
<div><div class="hdt-who"><strong>${escape(who)}</strong>${tag}<span>${time(at)}</span></div><div class="hdt-body">${body}</div></div></div>`;
  };

  // The customer's original request, as the first message of the conversation.
  const written = MESSAGE_FIELDS.filter((key) => values[key]).map((key) => `<p>${multiline(values[key])}</p>`).join("");
  const facts = ["orderType", "update", "issue", "resolution"].filter((key) => values[key]).map((key) => `<span>${escape(values[key])}</span>`).join("");
  const wrongItem = extras.receivedProducts.length > 0;
  const requestBody = `${facts ? `<div class="hdt-facts">${facts}</div>` : ""}${written || (facts ? "" : `<p>${escape(ticket.topic)}</p>`)}
${productList("Received", extras.receivedProducts)}${productList(wrongItem ? "Wanted instead" : "Products", extras.products)}${files(extras.requestImages)}`;

  const thread = [
    ...(chat ? [] : [message("customer", "", ticket.createdAt, requestBody)]),
    ...ticket.messages.map((entry) => message(entry.kind, entry.author, entry.createdAt, `<p>${multiline(entry.body)}</p>${files(extras.imageCounts.get(entry.id) ?? 0)}`)),
    ...(resolved ? [`<p class="hdt-system">Request resolved</p>`] : []),
  ].join("");

  const foot = extras.canReply ? `<div class="hdt-foot" id="reply">${note(state)}
<form method="post" action="?ticket=${escape(ticket.accessToken)}#reply" enctype="multipart/form-data">
<input type="hidden" name="intent" value="reply"><input type="hidden" name="token" value="${escape(ticket.accessToken)}">
<label>Reply to our team<textarea name="body" maxlength="${extras.maxLength}" placeholder="Write your reply...">${escape(state.draft ?? "")}</textarea></label>
<label class="hdt-drop"><i aria-hidden="true">📷</i><span><strong>Add photos</strong><small>Optional · JPG, PNG or WebP · up to ${extras.maxImages}, 5 MB each</small></span>
<input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple aria-label="Add photos"></label>
<div class="hdt-actions"><button type="submit">Send reply</button></div>
</form></div>`
    : `<div class="hdt-foot" id="reply">${note(state)}<div class="hdt-wait"><i aria-hidden="true">${resolved ? "✅" : "⏳"}</i><div>
<strong>${resolved ? "This request is closed" : "Our team will reply soon"}</strong>
<p>${resolved ? "If you still need help, please send us a new request." : "You can reply here once our team responds. We'll email you when they do."}</p></div></div></div>`;

  const summary = [
    `<div><dt>Request</dt><dd>#${ticket.number}</dd></div>`,
    `<div><dt>Submitted</dt><dd>${time(ticket.createdAt, "date")}</dd></div>`,
    ...SUMMARY_FIELDS.filter((key) => values[key]).map((key) => `<div><dt>${escape(fieldLabels[key] ?? key)}</dt><dd>${escape(fieldValue(key, values[key]))}</dd></div>`),
  ].join("");
  const count = ticket.messages.length + (chat ? 0 : 1);

  return page(`Request #${ticket.number}`, `
<div class="hdt-card hdt-hero">
<div class="hdt-top"><div>
<p class="hdt-eyebrow"><span class="hdt-chip">Request #${ticket.number}</span>${chat ? `<span class="hdt-chip">Live chat</span>` : ""}<span>Submitted ${time(ticket.createdAt)}</span></p>
<h1>${escape(ticket.topic)}</h1>
<p class="hdt-lead"><strong style="color:var(--ink)">${escape(copy.title)}.</strong> ${escape(copy.text)}</p>
</div><span class="hdt-pill" data-status="${escape(ticket.status)}"><i></i>${escape(ticket.status === "Waiting on customer" ? "Awaiting your reply" : ticket.status)}</span></div>
<ol class="hdt-steps" aria-label="Request progress">${steps}</ol>
</div>
<div class="hdt-layout">
<div class="hdt-card">
<div class="hdt-section-head"><h2>Conversation</h2><span>${count} message${count === 1 ? "" : "s"}</span></div>
<div class="hdt-thread">${thread}</div>
${foot}
</div>
<aside class="hdt-aside">
<div class="hdt-card hdt-pad"><h2>Request summary</h2><dl style="margin-top:8px">${summary}</dl></div>
<div class="hdt-card hdt-pad hdt-help"><h2>Good to know</h2>
<p>This page is private to you. Keep the link to yourself: anyone with it can see this request.</p>
<p>Looking for another request? <a href="?ticket=">Find it with its number</a>.</p></div>
</aside>
</div>`);
}
