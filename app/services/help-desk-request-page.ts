import { countryName, fieldLabels } from "./help-desk";

// The customer-facing pages served through the app proxy: the private request page and the lookup page. They are returned as Liquid so the store's theme wraps them with its own header, footer and fonts.

// Escapes HTML and Liquid delimiters: these pages are rendered by the theme as Liquid.
const escape = (value: string) => value.replace(/[&<>"'{}]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "{": "&#123;", "}": "&#125;" })[char]!);
const multiline = (value: string) => escape(value).replace(/\r?\n/g, "<br>");
// Rendered in UTC on the server, then switched to the shopper's own time zone by the page script.
const time = (value: Date) => `<time datetime="${value.toISOString()}" data-hdt-time>${escape(new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(value))} UTC</time>`;
const initials = (name: string) => escape(name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "?");

const STATUS_COPY: Record<string, { title: string; text: string }> = {
  Open: { title: "We've got your request", text: "Our team will look at it and reply soon. We'll email you as soon as they do." },
  "In progress": { title: "Our team is working on it", text: "We're sorting this out for you and will update you here and by email." },
  "Waiting on customer": { title: "We've replied: your turn", text: "Read our reply below and send us your answer so we can keep going." },
  Resolved: { title: "This request is resolved", text: "Thanks for your patience. If you still need help, please send us a new request." },
};
const STEPS = [
  { label: "Received", statuses: ["Open"] },
  { label: "Team is on it", statuses: ["In progress"] },
  { label: "Your reply", statuses: ["Waiting on customer"] },
  { label: "Resolved", statuses: ["Resolved"] },
];

const STYLES = `<style>
.hdt{--ink:#19213d;--muted:#5b6275;--line:#e4e5ea;--soft:#f5f6f8;--accent:#ef3a24;--ok:#0c7a43;max-width:1080px;margin:clamp(20px,4vw,48px) auto clamp(40px,6vw,72px);padding:0 16px;color:var(--ink);font-size:16px;line-height:1.55}
.hdt *{box-sizing:border-box}.hdt p{margin:0}
.hdt-card{border:1px solid var(--line);border-radius:18px;background:#fff;padding:clamp(18px,3vw,28px);box-shadow:0 8px 28px rgba(25,33,61,.06)}
.hdt-eyebrow{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--muted);font-size:13px;letter-spacing:.02em}
.hdt-eyebrow b{color:var(--ink);font-weight:600}
.hdt-hero{position:relative;overflow:hidden}
.hdt-hero::before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--accent)}
.hdt-hero h1{margin:10px 0 14px;font-size:clamp(26px,3.6vw,36px);line-height:1.15;letter-spacing:-.01em}
.hdt-state{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border-radius:14px;background:var(--soft)}
.hdt-state strong{display:block;font-size:16px}.hdt-state p{color:var(--muted);font-size:14px;margin-top:2px}
.hdt-dot{flex:none;width:12px;height:12px;margin-top:6px;border-radius:50%;background:#d9a100;box-shadow:0 0 0 5px rgba(217,161,0,.18)}
.hdt-state[data-status="In progress"] .hdt-dot{background:#2c6ecb;box-shadow:0 0 0 5px rgba(44,110,203,.18)}
.hdt-state[data-status="Waiting on customer"] .hdt-dot{background:var(--accent);box-shadow:0 0 0 5px rgba(239,58,36,.18)}
.hdt-state[data-status="Resolved"] .hdt-dot{background:var(--ok);box-shadow:0 0 0 5px rgba(12,122,67,.18)}
.hdt-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:22px 0 0;padding:0;list-style:none;counter-reset:step}
.hdt-steps li{position:relative;padding-top:30px;color:var(--muted);font-size:13px;text-align:center}
.hdt-steps li::before{content:"";position:absolute;top:9px;left:-50%;right:50%;height:3px;background:var(--line)}
.hdt-steps li:first-child::before{display:none}
.hdt-steps li span{position:absolute;top:0;left:50%;width:22px;height:22px;margin-left:-11px;border-radius:50%;border:2px solid var(--line);background:#fff;z-index:1}
.hdt-steps li[data-done]{color:var(--ink)}.hdt-steps li[data-done]::before,.hdt-steps li[data-current]::before{background:var(--ink)}
.hdt-steps li[data-done] span{border-color:var(--ink);background:var(--ink)}
.hdt-steps li[data-done] span::after{content:"";position:absolute;left:6px;top:3px;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.hdt-steps li[data-current]{color:var(--ink);font-weight:600}
.hdt-steps li[data-current] span{border-color:var(--accent);box-shadow:0 0 0 4px rgba(239,58,36,.15)}
.hdt-layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;margin-top:20px;align-items:start}
.hdt-main{display:grid;gap:20px}
.hdt h2{margin:0 0 16px;font-size:18px;line-height:1.3}
.hdt-thread{display:grid;gap:16px}
.hdt-msg{display:flex;gap:10px;align-items:flex-end;max-width:92%}
.hdt-msg[data-mine]{flex-direction:row-reverse;justify-self:end}
.hdt-avatar{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--soft);color:var(--ink);font-size:12px;font-weight:700}
.hdt-msg[data-kind="reply"] .hdt-avatar{background:var(--ink);color:#fff}
.hdt-msg[data-mine] .hdt-avatar{background:#fde3df;color:var(--accent)}
.hdt-bubble{padding:12px 15px;border-radius:16px;border:1px solid var(--line);background:#fff;overflow-wrap:anywhere}
.hdt-msg[data-kind="reply"] .hdt-bubble{border-bottom-left-radius:4px;background:#f7f8fb}
.hdt-msg[data-kind="bot"] .hdt-bubble{border-bottom-left-radius:4px;border-style:dashed}
.hdt-msg[data-mine] .hdt-bubble{border-color:var(--ink);border-bottom-right-radius:4px;background:var(--ink);color:#fff}
.hdt-meta{display:flex;flex-wrap:wrap;gap:4px 8px;margin-bottom:4px;font-size:12px;opacity:.75}
.hdt-meta b{font-weight:600;opacity:1}
.hdt-tag{padding:0 7px;border-radius:999px;background:rgba(25,33,61,.08);font-size:11px;font-weight:600}
.hdt-msg[data-mine] .hdt-tag{background:rgba(255,255,255,.18)}
.hdt-files{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:4px 10px;border-radius:999px;background:rgba(25,33,61,.07);font-size:12px}
.hdt-msg[data-mine] .hdt-files{background:rgba(255,255,255,.16)}
.hdt-system{justify-self:center;padding:4px 12px;border-radius:999px;background:var(--soft);color:var(--muted);font-size:12px}
.hdt-aside{display:grid;gap:20px;position:sticky;top:20px}
.hdt dl{display:grid;gap:12px;margin:0}
.hdt dt{color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.hdt dd{margin:2px 0 0;font-size:15px;overflow-wrap:anywhere}
.hdt-help p{color:var(--muted);font-size:14px}.hdt-help p+p{margin-top:10px}
.hdt a{color:var(--ink);font-weight:600;text-underline-offset:3px}
.hdt label{display:grid;gap:6px;margin-top:14px;font-size:14px;font-weight:600}
.hdt textarea,.hdt input:not([type=file]){width:100%;padding:13px 15px;border:1px solid #d4d6dd;border-radius:12px;background:#fbfbfc;color:var(--ink);font:inherit;font-weight:400}
.hdt textarea{min-height:130px;resize:vertical}
.hdt textarea:focus,.hdt input:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 4px rgba(25,33,61,.12);background:#fff}
.hdt .hdt-drop{position:relative;display:flex;gap:12px;align-items:center;margin-top:14px;padding:14px 16px;border:1.5px dashed #c9ccd6;border-radius:12px;background:#fbfbfc;cursor:pointer;font-weight:400}
.hdt .hdt-drop:hover,.hdt .hdt-drop:focus-within{border-color:var(--ink);background:#fff}
.hdt-drop input{position:absolute;inset:0;opacity:0;cursor:pointer}
.hdt-drop i{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--soft);font-style:normal;font-size:20px}
.hdt-drop strong{display:block;font-size:14px}.hdt-drop small{color:var(--muted);font-size:13px}
.hdt-actions{display:flex;justify-content:flex-end;margin-top:16px}
.hdt button{min-width:180px;padding:13px 24px;border:0;border-radius:12px;background:var(--ink);color:#fff;font:inherit;font-weight:600;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease}
.hdt button:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(25,33,61,.2)}
.hdt button:focus-visible{outline:3px solid rgba(239,58,36,.45);outline-offset:2px}
.hdt-wait{display:flex;gap:14px;align-items:flex-start}
.hdt-wait i{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--soft);font-style:normal;font-size:20px}
.hdt-wait p{color:var(--muted);font-size:14px;margin-top:2px}
.hdt-note{margin-bottom:14px;padding:12px 14px;border-radius:12px;font-size:14px}
.hdt-note[data-tone="success"]{background:#e3f5ea;color:#0c5132}.hdt-note[data-tone="error"]{background:#fde8e6;color:#8e1f0b}
.hdt-narrow{max-width:520px}
@media (max-width:860px){.hdt-layout{grid-template-columns:minmax(0,1fr)}.hdt-aside{position:static}}
@media (max-width:560px){.hdt-steps{grid-template-columns:repeat(4,minmax(0,1fr))}.hdt-steps li{font-size:11px}.hdt-msg{max-width:100%}.hdt button{width:100%}.hdt-actions{display:block}}
@media (prefers-reduced-motion:reduce){.hdt button{transition:none}}
</style>`;

// Small enhancements: local times and the chosen-photos count.
const SCRIPT = `<script>
(function () {
  var format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  document.querySelectorAll('.hdt [data-hdt-time]').forEach(function (node) {
    var value = new Date(node.getAttribute('datetime'));
    if (!isNaN(value)) node.textContent = format.format(value);
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

export const page = (title: string, body: string) => `{% layout 'theme' %}${STYLES}
<section class="hdt" aria-label="${escape(title)}">${body}</section>${SCRIPT}`;

const note = (state: { sent?: boolean; error?: string }) => state.sent ? `<div class="hdt-note" data-tone="success" role="status">Thanks, your message has been sent to our team.</div>`
  : state.error ? `<div class="hdt-note" data-tone="error" role="alert">${escape(state.error)}</div>` : "";

// Finding a request without its link: ticket number plus email.
export function renderLookupPage(state: { error?: string; number?: string; email?: string } = {}) {
  return page("Find your request", `
<div class="hdt-card hdt-hero hdt-narrow" style="margin:0 auto">
<p class="hdt-eyebrow"><b>Help Desk</b></p>
<h1>Find your request</h1>
<p style="color:var(--muted)">Enter your request number from the confirmation email and the email address you used.</p>
<div style="margin-top:18px">${note(state)}</div>
<form method="post" action="?ticket=">
<input type="hidden" name="intent" value="lookup">
<label>Request number<input name="number" required inputmode="numeric" placeholder="e.g. 1001" value="${escape(state.number ?? "")}"></label>
<label>Email<input name="email" type="email" required autocomplete="email" placeholder="name@example.com" value="${escape(state.email ?? "")}"></label>
<div class="hdt-actions"><button type="submit">Find my request</button></div>
</form></div>`);
}

export type RequestPageTicket = {
  number: number; topic: string; status: string; channel: string; createdAt: Date; accessToken: string; details: string;
  messages: { id: string; kind: string; author: string; body: string; createdAt: Date }[];
};

export function renderRequestPage(ticket: RequestPageTicket, imageCounts: Map<string, number>, options: { canReply: boolean; maxImages: number; maxLength: number; state?: { sent?: boolean; error?: string; draft?: string } }) {
  const state = options.state ?? {};
  const values = JSON.parse(ticket.details) as Record<string, string>;
  const chat = ticket.channel === "chat";
  const copy = STATUS_COPY[ticket.status] ?? { title: ticket.status, text: "" };
  const current = STEPS.findIndex((step) => step.statuses.includes(ticket.status));
  const steps = STEPS.map((step, index) => `<li${index < current || ticket.status === "Resolved" ? " data-done" : ""}${index === current && ticket.status !== "Resolved" ? " data-current" : ""}><span></span>${step.label}</li>`).join("");
  const rows = chat ? "" : Object.keys(fieldLabels).filter((key) => values[key])
    .map((key) => `<div><dt>${escape(fieldLabels[key])}</dt><dd>${multiline(key === "country" ? countryName(values[key]) : values[key])}</dd></div>`).join("");

  const bubble = (kind: string, author: string, body: string, at: Date, extra = "") => {
    const mine = kind === "customer";
    const who = mine ? "You" : kind === "bot" ? "Assistant" : author;
    const tag = kind === "reply" ? `<span class="hdt-tag">Support team</span>` : kind === "bot" ? `<span class="hdt-tag">Automated</span>` : "";
    return `<div class="hdt-msg" data-kind="${kind}"${mine ? " data-mine" : ""}>
<span class="hdt-avatar" aria-hidden="true">${kind === "bot" ? "AI" : mine ? "You" : initials(author)}</span>
<div class="hdt-bubble"><div class="hdt-meta"><b>${escape(who)}</b>${tag}<span>${time(at)}</span></div><p>${multiline(body)}</p>${extra}</div></div>`;
  };
  const thread = [
    ...(chat ? [] : [bubble("customer", "", `Request submitted: ${ticket.topic}`, ticket.createdAt)]),
    ...ticket.messages.map((message) => {
      const count = imageCounts.get(message.id) ?? 0;
      return bubble(message.kind, message.author, message.body, message.createdAt, count ? `<span class="hdt-files">📎 ${count} photo${count === 1 ? "" : "s"} attached</span>` : "");
    }),
    ...(ticket.status === "Resolved" ? [`<p class="hdt-system">Request resolved</p>`] : []),
  ].join("");

  const reply = options.canReply ? `<div class="hdt-card" id="reply"><h2>Reply to our team</h2>${note(state)}
<form method="post" action="?ticket=${escape(ticket.accessToken)}#reply" enctype="multipart/form-data">
<input type="hidden" name="intent" value="reply"><input type="hidden" name="token" value="${escape(ticket.accessToken)}">
<label>Your message<textarea name="body" maxlength="${options.maxLength}" placeholder="Write your reply...">${escape(state.draft ?? "")}</textarea></label>
<label class="hdt-drop"><i aria-hidden="true">📷</i><span><strong>Add photos</strong><small>Optional · JPG, PNG or WebP · up to ${options.maxImages}, 5 MB each</small></span>
<input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple aria-label="Add photos"></label>
<div class="hdt-actions"><button type="submit">Send reply</button></div>
</form></div>`
    : `<div class="hdt-card" id="reply">${note(state)}<div class="hdt-wait"><i aria-hidden="true">${ticket.status === "Resolved" ? "✅" : "⏳"}</i><div>
<strong>${ticket.status === "Resolved" ? "This request is closed" : "Our team will reply soon"}</strong>
<p>${ticket.status === "Resolved" ? "If you still need help, please send us a new request." : "You'll be able to reply here once our team responds. We'll email you when they do."}</p></div></div></div>`;

  return page(`Request #${ticket.number}`, `
<div class="hdt-card hdt-hero">
<p class="hdt-eyebrow"><b>Request #${ticket.number}</b><span>Submitted ${time(ticket.createdAt)}</span>${chat ? "<span>Live chat</span>" : ""}</p>
<h1>${escape(ticket.topic)}</h1>
<div class="hdt-state" data-status="${escape(ticket.status)}"><span class="hdt-dot" aria-hidden="true"></span><div><strong>${escape(copy.title)}</strong><p>${escape(copy.text)}</p></div></div>
<ol class="hdt-steps" aria-label="Request progress">${steps}</ol>
</div>
<div class="hdt-layout">
<div class="hdt-main">
<div class="hdt-card"><h2>Conversation</h2><div class="hdt-thread">${thread}</div></div>
${reply}
</div>
<aside class="hdt-aside">
${rows ? `<div class="hdt-card"><h2>Your request</h2><dl>${rows}</dl></div>` : ""}
<div class="hdt-card hdt-help"><h2>Good to know</h2>
<p>This page is private to you. Keep the link to yourself: anyone with it can see this request.</p>
<p>Looking for another request? <a href="?ticket=">Find it with its number</a>.</p></div>
</aside>
</div>`);
}
