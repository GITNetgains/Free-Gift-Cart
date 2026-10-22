import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRevalidator, useSearchParams, data } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  CHAT_TOPIC, countryName, defaultMacros, fieldLabels as LABELS, fillMacro, macroPlaceholders, MAX_MESSAGE_LENGTH, priorities, ticketStatuses, topics,
} from "../services/help-desk";
import { addStaffMessage, readHelpDeskForm, submitTicket, updateTickets } from "../services/help-desk.server";
import { emailConfigured, loadProducts, loadShop, sendTestEmail, trackingUrl, type TicketProduct } from "../services/help-desk-email.server";
import { ordersByEmail } from "../services/help-desk-orders.server";
import { matchFaq, NO_ANSWER } from "../services/help-desk-bot";
import { DETECTOR_MODES, rescanMissingKeyScans, scanImage, serializeScan } from "../services/image-scan/scan.server";
import { PROVIDERS, verifyCredentials } from "../services/image-scan/detector.server";
import { ensureFaqs } from "../services/help-desk-chat.server";
import { ensureWorker, queueEmail, retryEmail } from "../services/help-desk-outbox.server";

const PAGE_SIZE = 25;
const STATUS_TONE = { Open: "warning", "In progress": "info", "Waiting on customer": "caution", Resolved: "success" } as const;
const PRIORITY_TONE = { Low: "neutral", Normal: "neutral", High: "warning", Urgent: "critical" } as const;
const UNRESOLVED = { not: "Resolved" };
// Inbox views, like the saved views of dedicated help desks.
const VIEWS = {
  open: { label: "Needs attention", where: { status: { in: ["Open", "In progress"] } } },
  unassigned: { label: "Unassigned", where: { status: UNRESOLVED, assignee: "" } },
  urgent: { label: "High priority", where: { status: UNRESOLVED, priority: { in: ["High", "Urgent"] } } },
  waiting: { label: "Waiting on customer", where: { status: "Waiting on customer" } },
  resolved: { label: "Resolved", where: { status: "Resolved" } },
  all: { label: "All tickets", where: {} },
} satisfies Record<string, { label: string; where: Prisma.HelpDeskTicketWhereInput }>;
type View = keyof typeof VIEWS;
const TOPICS = [...topics, CHAT_TOPIC];
// Staff status changes that email the customer (when turned on in settings).
const STATUS_EMAIL_STATUSES = ["In progress", "Resolved"];
const SORTS = { activity: "Last activity", newest: "Newest first", oldest: "Oldest first" } as const;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const parseJson = <T,>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
const teamList = (team: string | undefined) => [...new Set((team || "").split(",").map((name) => name.trim()).filter(Boolean))];
const pick = <T extends string>(value: string | null, options: readonly T[]) => (options as readonly string[]).includes(value || "") ? value as T : "";

// New stores get a starter set of saved replies once.
async function ensureMacros(shop: string) {
  const settings = await db.helpDeskSettings.findUnique({ where: { shop } });
  if (settings) return settings;
  if (!await db.helpDeskMacro.count({ where: { shop } })) await db.helpDeskMacro.createMany({ data: defaultMacros.map((macro) => ({ shop, ...macro })) });
  return db.helpDeskSettings.upsert({ where: { shop }, update: {}, create: { shop } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;
  const url = new URL(request.url);
  ensureWorker(db);
  const settings = await ensureMacros(shop);
  const team = teamList(settings.team);
  const base = { configured: emailConfigured(), team };
  const headers = { "Cache-Control": "private, no-store" };

  if (url.searchParams.get("settings")) {
    const [macros, store] = await Promise.all([
      db.helpDeskMacro.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
      loadShop(admin).catch(() => ({ name: "", email: "", url: "" })),
    ]);
    return data({
      screen: "settings" as const, ...base, macros: macros.map(({ id, title, body }) => ({ id, title, body })), storeEmail: store.email,
      settings: { notify: settings.notify, notifyEmail: settings.notifyEmail, autoReply: settings.autoReply, statusEmails: settings.statusEmails, signature: settings.signature, team: settings.team },
      // Secrets never go to the browser, only whether they're saved.
      ai: {
        enabled: settings.aiDetectionEnabled, mode: settings.aiDetectorMode, provider: settings.aiDetectionProvider,
        sightengineUser: settings.sightengineUser, hasSightengineSecret: Boolean(settings.sightengineSecret), hasTruthscanKey: Boolean(settings.truthscanKey),
      },
    }, { headers });
  }

  if (url.searchParams.get("chatbot")) {
    const chat = await ensureFaqs(db, shop);
    const since = new Date(Date.now() - 30 * DAY);
    const [faqs, results, unanswered, chats] = await Promise.all([
      db.helpDeskFaq.findMany({ where: { shop }, orderBy: { createdAt: "asc" }, select: { id: true, question: true, keywords: true, answer: true } }),
      db.helpDeskBotQuestion.groupBy({ by: ["result"], where: { shop, createdAt: { gte: since } }, _count: { _all: true } }),
      db.helpDeskBotQuestion.findMany({ where: { shop, result: "none", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 200, select: { question: true, createdAt: true } }),
      db.helpDeskTicket.count({ where: { shop, channel: "chat", createdAt: { gte: since } } }),
    ]);
    const counts = Object.fromEntries(results.map((row) => [row.result, row._count._all])) as Record<string, number>;
    // The same question asked several times is one row, most asked first.
    const grouped = new Map<string, { question: string; count: number; last: Date }>();
    for (const row of unanswered) {
      const key = row.question.toLowerCase().replace(/s+/g, " ").trim();
      const entry = grouped.get(key);
      if (entry) entry.count += 1; else grouped.set(key, { question: row.question, count: 1, last: row.createdAt });
    }
    return data({
      screen: "chatbot" as const, ...base, faqs,
      chat: { chatEnabled: chat.chatEnabled, chatGreeting: chat.chatGreeting },
      stats: { asked: (counts.faq ?? 0) + (counts.order ?? 0) + (counts.none ?? 0), answered: (counts.faq ?? 0) + (counts.order ?? 0), orders: counts.order ?? 0, chats },
      unanswered: [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    }, { headers });
  }

  const ticketId = url.searchParams.get("ticket");
  const ticket = ticketId ? await db.helpDeskTicket.findFirst({
    where: { id: ticketId, shop },
    include: {
      attachments: { select: { id: true, name: true, messageId: true, scan: true } }, messages: { orderBy: { createdAt: "asc" } },
      emails: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, messageId: true, status: true, attempts: true, lastError: true, sentAt: true, createdAt: true } },
    },
  }) : null;
  if (ticket) {
    // Messages after the previous visit are marked new, like an unread divider.
    const readAt = ticket.staffReadAt;
    await db.helpDeskTicket.update({ where: { id: ticket.id }, data: { unread: false, staffReadAt: new Date() } });
    const [products, receivedProducts, others, orders, macros, store] = await Promise.all([
      loadProducts(admin, parseJson<string[]>(ticket.products, [])),
      loadProducts(admin, parseJson<string[]>(ticket.receivedProducts, [])),
      db.helpDeskTicket.findMany({
        where: { shop, email: ticket.email, id: { not: ticket.id } }, orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, number: true, topic: true, status: true, createdAt: true },
      }),
      ordersByEmail(admin, ticket.email),
      db.helpDeskMacro.findMany({ where: { shop }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, body: true } }),
      loadShop(admin).catch(() => ({ name: "", email: "", url: "" })),
    ]);
    const { accessToken, details, id, number, name, email, topic, status, priority, assignee, tags, customerId, channel, createdAt, firstResponseAt, resolvedAt, attachments, messages, emails } = ticket;
    const files = attachments.map(({ scan, ...file }) => ({ ...file, scan: serializeScan(scan) }));
    const rest = { id, number, name, email, topic, status, priority, assignee, tags, customerId, channel, createdAt, firstResponseAt, resolvedAt, attachments: files, messages, emails, readAt };
    return data({
      screen: "ticket" as const, ...base, macros, others, orders, storeName: store.name || shop,
      trackingUrl: store.url ? trackingUrl(store.url, accessToken) : "",
      ticket: { ...rest, details: parseJson<Record<string, string>>(details, {}), products, receivedProducts },
    }, { headers });
  }

  const page = Math.floor(Math.max(1, Math.min(100000, Number(url.searchParams.get("page")) || 1)));
  // Older links filter by status; they map onto the matching view.
  const legacyStatus = pick(url.searchParams.get("status"), ticketStatuses);
  const view: View = (url.searchParams.get("view") as View) in VIEWS ? url.searchParams.get("view") as View
    : legacyStatus === "Resolved" ? "resolved" : legacyStatus === "Waiting on customer" ? "waiting" : legacyStatus ? "open" : "open";
  const topic = pick(url.searchParams.get("topic"), TOPICS);
  const priority = pick(url.searchParams.get("priority"), priorities);
  const assignee = (url.searchParams.get("assignee") || "").slice(0, 80);
  const sort = (url.searchParams.get("sort") || "activity") in SORTS ? (url.searchParams.get("sort") || "activity") as keyof typeof SORTS : "activity";
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const number = /^#?\d{1,9}$/.test(q) ? Number(q.replace("#", "")) : null;
  const where: Prisma.HelpDeskTicketWhereInput = {
    shop, ...VIEWS[view].where,
    ...(topic ? { topic } : {}),
    ...(priority ? { priority } : {}),
    ...(assignee ? { assignee } : {}),
    // details holds every submitted field, so this also matches order numbers and messages.
    ...(q ? { OR: [{ id: q }, ...(number !== null ? [{ number }] : []), { name: { contains: q } }, { email: { contains: q } }, { details: { contains: q } }, { tags: { contains: q } }] } : {}),
  };
  const orderBy: Prisma.HelpDeskTicketOrderByWithRelationInput[] = sort === "newest" ? [{ createdAt: "desc" }, { id: "desc" }]
    : sort === "oldest" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ lastActivityAt: "desc" }, { createdAt: "desc" }];
  const now = Date.now();
  const [tickets, count, viewCounts, responded, resolvedWeek, newToday, botResults] = await Promise.all([
    db.helpDeskTicket.findMany({
      where, orderBy, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      select: {
        id: true, number: true, name: true, email: true, topic: true, status: true, priority: true, assignee: true, tags: true, unread: true, channel: true,
        createdAt: true, lastActivityAt: true, firstResponseAt: true, details: true, _count: { select: { attachments: true, messages: { where: { kind: "customer" } } } },
      },
    }),
    db.helpDeskTicket.count({ where }),
    Promise.all((Object.keys(VIEWS) as View[]).map(async (key) => [key, await db.helpDeskTicket.count({ where: { shop, ...VIEWS[key].where } })] as const)),
    db.helpDeskTicket.findMany({ where: { shop, firstResponseAt: { gte: new Date(now - 30 * DAY) } }, select: { createdAt: true, firstResponseAt: true }, take: 2000 }),
    db.helpDeskTicket.count({ where: { shop, status: "Resolved", resolvedAt: { gte: new Date(now - 7 * DAY) } } }),
    db.helpDeskTicket.count({ where: { shop, createdAt: { gte: new Date(now - DAY) } } }),
    db.helpDeskBotQuestion.groupBy({ by: ["result"], where: { shop, createdAt: { gte: new Date(now - 30 * DAY) } }, _count: { _all: true } }),
  ]);
  const bot = Object.fromEntries(botResults.map((row) => [row.result, row._count._all])) as Record<string, number>;
  const flaggedScans = await db.helpDeskImageScan.findMany({
    where: { shop, overallVerdict: { in: ["likely_ai", "duplicate"] }, attachment: { ticketId: { in: tickets.map((ticket) => ticket.id) } } },
    select: { overallVerdict: true, attachment: { select: { ticketId: true } } },
  });
  const flagged = new Map<string, string>();
  for (const scan of flaggedScans) if (flagged.get(scan.attachment.ticketId) !== "likely_ai") flagged.set(scan.attachment.ticketId, scan.overallVerdict!);
  const responseTimes = responded.map((ticket) => ticket.firstResponseAt!.getTime() - ticket.createdAt.getTime());
  return data({
    screen: "list" as const, ...base,
    tickets: tickets.map(({ details, _count, ...ticket }) => {
      const values = parseJson<Record<string, string>>(details, {});
      return {
        ...ticket, images: _count.attachments, customerReplies: _count.messages, photoFlag: flagged.get(ticket.id) ?? null,
        reference: values.orderNumber || (values.country ? countryName(values.country) : "") || (values.existing ? `Existing partner: ${values.existing}` : ""),
      };
    }),
    count, page, views: Object.fromEntries(viewCounts) as Record<View, number>,
    metrics: {
      avgResponse: responseTimes.length ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length : null, resolvedWeek, newToday,
      botAsked: (bot.faq ?? 0) + (bot.order ?? 0) + (bot.none ?? 0), botAnswered: (bot.faq ?? 0) + (bot.order ?? 0),
    },
    filters: { view, topic, priority, assignee, sort, q },
  }, { headers });
};

export type ActionResult = { errors: Record<string, string>; ticketId?: string; emailed?: boolean; updated?: number; notice?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;
  let form: FormData;
  try { form = await readHelpDeskForm(request); }
  catch { return data<ActionResult>({ errors: { form: "Could not read the request. Use up to five images of 5 MB each." } }, { status: 400 }); }
  const text = (key: string) => String(form.get(key) ?? "");
  const fail = (message: string, status = 400, key = "form") => data<ActionResult>({ errors: { [key]: message } }, { status });
  const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  try {
    switch (text("intent")) {
      case "settings": {
        const notifyEmail = text("notifyEmail").trim();
        if (notifyEmail && !validEmail(notifyEmail)) return fail("Enter a valid email address.", 400, "notifyEmail");
        if (text("signature").length > 2000) return fail("Use no more than 2,000 characters.", 400, "signature");
        const values = {
          notify: text("notify") === "true", notifyEmail, autoReply: text("autoReply") === "true", statusEmails: text("statusEmails") === "true",
          signature: text("signature").trim(), team: teamList(text("team")).map((name) => name.slice(0, 60)).slice(0, 50).join(", "),
        };
        await db.helpDeskSettings.upsert({ where: { shop }, update: values, create: { shop, ...values } });
        return data<ActionResult>({ errors: {} });
      }
      case "test-email": {
        const to = text("to").trim();
        if (!emailConfigured()) return fail("Email sending is not set up on the server yet.");
        if (!validEmail(to)) return fail("Enter a valid email address first.");
        try { await sendTestEmail(shop, admin, to); }
        catch { return fail("The test email could not be sent. Check the SMTP settings on the server.", 502); }
        return data<ActionResult>({ errors: {} });
      }
      case "update":
      case "status":
      case "bulk": {
        const ids = text("intent") === "bulk" ? form.getAll("ids").map(String) : [text("id")];
        const changes = Object.fromEntries(["status", "priority", "assignee", "tags"].filter((key) => form.has(key)).map((key) => [key, text(key)]));
        if (!Object.keys(changes).length || !ids.length) return fail("Choose what to change.");
        const before = new Map((await db.helpDeskTicket.findMany({ where: { shop, id: { in: ids } }, select: { id: true, status: true } })).map((ticket) => [ticket.id, ticket.status]));
        const updated = await updateTickets(db, shop, ids, changes, text("author") || "Staff");
        if (updated < 1) return fail(updated < 0 ? "That value isn't valid." : "These tickets couldn't be updated. Reload the page and try again.");
        // Tell customers when their ticket starts being worked on or is resolved.
        if (changes.status && STATUS_EMAIL_STATUSES.includes(changes.status)) {
          for (const [ticketId, status] of before) if (status !== changes.status) queueEmail(db, { shop, ticketId, kind: "status" }, admin);
        }
        return data<ActionResult>({ errors: {}, updated });
      }
      case "message": {
        const result = await addStaffMessage(db, shop, text("id"), { kind: text("kind"), body: text("body"), author: text("author"), status: text("status") || undefined });
        if (!result.messageId) return data<ActionResult>({ errors: result.errors }, { status: 400 });
        const emailed = text("kind") === "reply" && emailConfigured();
        if (text("kind") === "reply") queueEmail(db, { shop, ticketId: result.ticketId!, kind: "reply", messageId: result.messageId }, admin);
        return data<ActionResult>({ errors: {}, ticketId: result.ticketId, emailed });
      }
      case "scan": {
        const file = await db.helpDeskAttachment.findFirst({ where: { id: text("id"), ticket: { shop } }, select: { id: true } });
        if (!file) return fail("This image no longer exists.");
        const result = await scanImage(db, file.id, { forceDetector: text("force") === "true", manual: true });
        if (!result) return fail("This file can't be scanned.");
        return data<ActionResult>(result.status === "failed" ? { errors: { form: result.error || "The scan failed. Try again." } } : { errors: {} });
      }
      case "ai-settings": {
        const provider = text("provider") in PROVIDERS ? text("provider") : "sightengine";
        const mode = (DETECTOR_MODES as readonly string[]).includes(text("mode")) ? text("mode") : "suspicious";
        const current = await db.helpDeskSettings.findUniqueOrThrow({ where: { shop } });
        // Blank secret fields keep the saved value.
        const next = {
          aiDetectionEnabled: text("enabled") === "true", aiDetectorMode: mode, aiDetectionProvider: provider,
          sightengineUser: text("sightengineUser").trim().slice(0, 200),
          sightengineSecret: text("sightengineSecret").trim().slice(0, 200) || current.sightengineSecret,
          truthscanKey: text("truthscanKey").trim().slice(0, 300) || current.truthscanKey,
        };
        const credentials = provider === "truthscan" ? { apiKey: next.truthscanKey } : { apiUser: next.sightengineUser, apiSecret: next.sightengineSecret };
        const changed = provider === "truthscan" ? next.truthscanKey !== current.truthscanKey
          : next.sightengineUser !== current.sightengineUser || next.sightengineSecret !== current.sightengineSecret;
        const hasCredentials = provider === "truthscan" ? Boolean(next.truthscanKey) : Boolean(next.sightengineUser && next.sightengineSecret);
        let notice = "";
        if (hasCredentials && (changed || provider !== current.aiDetectionProvider)) {
          const check = await verifyCredentials(provider, credentials);
          if (!check.valid) return fail(check.message || "These credentials don't work.", 400, "credentials");
          notice = "warning" in check && check.warning ? check.warning : "";
        }
        await db.helpDeskSettings.update({ where: { shop }, data: next });
        // Photos scanned before a key was added get the detector now.
        if (hasCredentials && next.aiDetectionEnabled) await rescanMissingKeyScans(db, shop);
        return data<ActionResult>({ errors: {}, notice });
      }
      case "email-retry":
        if (!emailConfigured()) return fail("Email sending is not set up on the server yet.");
        if (!await retryEmail(db, shop, text("id"), admin)) return fail("This email can't be retried.");
        return data<ActionResult>({ errors: {} });
      case "chat-settings": {
        if (text("chatGreeting").length > 300) return fail("Use no more than 300 characters.", 400, "chatGreeting");
        const values = { chatEnabled: text("chatEnabled") === "true", chatGreeting: text("chatGreeting").trim() };
        await db.helpDeskSettings.upsert({ where: { shop }, update: values, create: { shop, ...values } });
        return data<ActionResult>({ errors: {} });
      }
      case "faq-save": {
        const values = { question: text("question").trim(), keywords: text("keywords").trim(), answer: text("answer").trim() };
        const errors: Record<string, string> = {};
        if (!values.question || values.question.length > 200) errors.question = "Enter a question of up to 200 characters.";
        if (values.keywords.length > 500) errors.keywords = "Use no more than 500 characters.";
        if (!values.answer || values.answer.length > 2000) errors.answer = "Enter an answer of up to 2,000 characters.";
        if (Object.keys(errors).length) return data<ActionResult>({ errors }, { status: 400 });
        if (text("id")) {
          const { count } = await db.helpDeskFaq.updateMany({ where: { id: text("id"), shop }, data: values });
          if (!count) return fail("This answer no longer exists.");
        } else if (await db.helpDeskFaq.count({ where: { shop } }) >= 200) {
          return fail("You can save up to 200 answers.");
        } else await db.helpDeskFaq.create({ data: { shop, ...values } });
        return data<ActionResult>({ errors: {} });
      }
      case "faq-delete":
        await db.helpDeskFaq.deleteMany({ where: { id: text("id"), shop } });
        return data<ActionResult>({ errors: {} });
      case "macro-save": {
        const title = text("title").trim();
        const body = text("body").trim();
        const errors: Record<string, string> = {};
        if (!title || title.length > 80) errors.title = "Enter a name of up to 80 characters.";
        if (!body || body.length > MAX_MESSAGE_LENGTH) errors.body = "Enter the reply text.";
        if (Object.keys(errors).length) return data<ActionResult>({ errors }, { status: 400 });
        if (text("id")) {
          const { count } = await db.helpDeskMacro.updateMany({ where: { id: text("id"), shop }, data: { title, body } });
          if (!count) return fail("This saved reply no longer exists.");
        } else if (await db.helpDeskMacro.count({ where: { shop } }) >= 100) {
          return fail("You can save up to 100 replies.");
        } else await db.helpDeskMacro.create({ data: { shop, title, body } });
        return data<ActionResult>({ errors: {} });
      }
      case "macro-delete":
        await db.helpDeskMacro.deleteMany({ where: { id: text("id"), shop } });
        return data<ActionResult>({ errors: {} });
      default: {
        const result = await submitTicket(db, shop, form);
        return data<ActionResult>(result, { status: Object.keys(result.errors).length ? 400 : 200 });
      }
    }
  } catch {
    return fail("The change could not be saved. Please try again.", 500);
  }
};

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;
type TicketData = Extract<LoaderData, { screen: "ticket" }>;
type ListData = Extract<LoaderData, { screen: "list" }>;
type SettingsData = Extract<LoaderData, { screen: "settings" }>;

const formatDate = (value: string | Date) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
function duration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60 ? `${minutes % 60}m` : ""}`.trim();
  return `${Math.round(hours / 24)}d`;
}
const ago = (value: string | Date) => `${duration(Date.now() - new Date(value).getTime())} ago`;

function StatusBadge({ status }: { status: string }) {
  return <s-badge tone={STATUS_TONE[status as keyof typeof STATUS_TONE] ?? "neutral"}>{status}</s-badge>;
}
function PriorityBadge({ priority }: { priority: string }) {
  return <s-badge tone={PRIORITY_TONE[priority as keyof typeof PRIORITY_TONE] ?? "neutral"} icon={priority === "Urgent" ? "alert-triangle" : undefined}>{priority}</s-badge>;
}

// Shows a toast for a fetcher's result once it settles.
function useResultToast(fetcher: { state: string; data?: ActionResult }, success: string | ((data: ActionResult) => string)) {
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const errors = Object.values(fetcher.data.errors);
    if (errors.length) shopify.toast.show(errors[0], { isError: true });
    else shopify.toast.show(typeof success === "string" ? success : success(fetcher.data));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data, shopify]);
}

function useListLink() {
  const [searchParams] = useSearchParams();
  return (changes: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    params.delete("status");
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value); else params.delete(key);
    }
    if (!("page" in changes)) params.delete("page");
    const query = params.toString();
    return `/app/help-desk${query ? `?${query}` : ""}`;
  };
}

// ---------- Ticket ----------

type TicketFile = TicketData["ticket"]["attachments"][number];
type Scan = NonNullable<TicketFile["scan"]>;

const VERDICT: Record<string, { label: string; tone: "critical" | "warning" | "caution" | "success" | "neutral"; icon?: "alert-triangle" | "duplicate" | "check-circle" | "question-circle" }> = {
  likely_ai: { label: "Likely AI-generated", tone: "critical", icon: "alert-triangle" },
  duplicate: { label: "Reused photo", tone: "warning", icon: "duplicate" },
  uncertain: { label: "Can't confirm", tone: "caution", icon: "question-circle" },
  likely_real: { label: "Likely genuine", tone: "success", icon: "check-circle" },
  error: { label: "Couldn't check", tone: "neutral" },
};

function ScanBadge({ scan }: { scan: Scan | null }) {
  if (!scan || scan.status === "pending") return <s-badge tone="info">{scan ? "Checking photo" : "Not checked"}</s-badge>;
  if (scan.status === "failed") return <s-badge tone="neutral">Scan incomplete</s-badge>;
  const verdict = VERDICT[scan.overallVerdict || "error"] ?? VERDICT.error;
  return <s-badge tone={verdict.tone} icon={verdict.icon}>{verdict.label}</s-badge>;
}

function Attachment({ file, onOpen }: { file: TicketFile; onOpen: (image: { url: string; name: string; id: string }) => void }) {
  const fetcher = useFetcher<{ url?: string; name?: string; error?: string }>();
  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) void fetcher.load(`/app/help-desk-attachment?id=${encodeURIComponent(file.id)}`);
  }, [fetcher, file.id]);
  const url = fetcher.data?.url;
  return <s-stack gap="small-100">
    <s-clickable border="base" borderRadius="base" padding="none" accessibilityLabel={`Open ${file.name}`} disabled={!url} onClick={() => { if (url) onOpen({ url, name: file.name, id: file.id }); }}>
      <div style={{ width: 112, height: 112, display: "grid", placeItems: "center", overflow: "hidden" }}>
        {url ? <img src={url} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : fetcher.data?.error ? <s-text tone="critical">Unavailable</s-text> : <s-spinner size="base" />}
      </div>
    </s-clickable>
    <ScanBadge scan={file.scan} />
  </s-stack>;
}

// Everything the scan found, in plain language, strongest evidence first.
function scanFindings(scan: Scan, listLink: (changes: Record<string, string>) => string) {
  const { c2pa, watermark, exif, hash, classifier, editing } = scan.layers;
  const lines: { tone: "critical" | "warning" | "neutral" | "success"; text: string; href?: string }[] = [];
  if (c2pa?.isAiGenerated) {
    lines.push({ tone: "critical", text: `Content Credentials (C2PA) declare it ${c2pa.aiActions?.[0]?.toLowerCase() || "AI-generated"}${c2pa.claimGenerator ? ` by ${c2pa.claimGenerator}` : ""}${c2pa.generatedAt ? ` on ${c2pa.generatedAt.slice(0, 10)}` : ""}.` });
  } else if (c2pa?.present) {
    lines.push({ tone: "neutral", text: `Carries Content Credentials${c2pa.claimGenerator ? ` from ${c2pa.claimGenerator}` : ""}${c2pa.actions?.length ? ` (${c2pa.actions.join(", ")})` : ""}.` });
  }
  if (watermark?.detected) lines.push({ tone: "critical", text: watermark.reason });
  const match = hash?.match;
  if (match) {
    const where = match.sameTicket ? "another photo on this ticket" : `a photo on ticket #${match.ticketNumber}`;
    lines.push({
      tone: match.sameTicket ? "neutral" : match.previousVerdict === "likely_ai" ? "critical" : "warning",
      text: `${match.matchType === "exact" ? "Identical to" : `Near-identical (${match.distance}/64 bits) to`} ${where} (${match.fileName})${match.previousVerdict === "likely_ai" ? ", which was identified as AI-generated" : ""}.`,
      href: match.sameTicket ? undefined : listLink({ ticket: match.ticketId }),
    });
  }
  for (const finding of exif?.findings ?? []) {
    const strongFinding = /AI tool|source type|generation record|naming pattern/.test(finding);
    lines.push({ tone: strongFinding ? "critical" : /Pixel count/.test(finding) ? "warning" : "neutral", text: finding });
  }
  if (classifier) {
    if (typeof classifier.aiProbability === "number") {
      lines.push({ tone: classifier.aiProbability >= 70 ? "critical" : classifier.aiProbability >= 40 ? "warning" : "success", text: `${classifier.reasoning}${classifier.reused ? " (earlier result for the same image, so no new check was used)" : ""}` });
    } else if (classifier.error) {
      lines.push({ tone: "warning", text: `${classifier.errorTitle || "The AI detector failed"}. ${classifier.errorHint || ""}` });
    } else if (classifier.reason) {
      lines.push({ tone: classifier.skipReason === "camera_original" ? "success" : "neutral", text: classifier.reason });
    }
  }
  for (const signal of editing?.signals ?? []) {
    lines.push({ tone: signal.strength === "strong" ? "warning" : "neutral", text: signal.detail });
  }
  return lines;
}

function ScanPanel({ file }: { file: TicketFile }) {
  const fetcher = useFetcher<typeof action>();
  const listLink = useListLink();
  const pending = fetcher.state !== "idle";
  const lastForce = useRef(false);
  useResultToast(fetcher, () => lastForce.current ? "Checked with the AI detector" : "Photo re-scanned");
  const scan = file.scan;
  const run = (force: boolean) => { lastForce.current = force; void fetcher.submit({ intent: "scan", id: file.id, force: String(force) }, { method: "post" }); };
  const detectorRan = typeof scan?.layers.classifier?.aiProbability === "number" && !scan.layers.classifier.reused;
  const exif = scan?.layers.exif;
  const editing = scan?.layers.editing;
  return <s-box border="base" borderRadius="base" padding="base" background="subdued">
    <s-stack gap="small-200">
      <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text type="strong">Photo check</s-text>
          <ScanBadge scan={scan} />
          {scan?.status === "completed" && typeof scan.overallConfidence === "number" && scan.overallVerdict !== "error" && <s-text color="subdued">{Math.round(scan.overallConfidence * 100)}% confidence</s-text>}
          {editing?.level === "edited" && <s-badge tone="warning">Edited{editing.editor ? `: ${editing.editor}` : ""}</s-badge>}
          {editing?.level === "not_original" && <s-badge>Not a camera original</s-badge>}
        </s-stack>
        <s-stack direction="inline" gap="small-100">
          <s-button variant="tertiary" icon="refresh" loading={pending && !lastForce.current} disabled={pending} onClick={() => run(false)}>Re-scan</s-button>
          {!detectorRan && <s-button icon="wand" loading={pending && lastForce.current} disabled={pending} onClick={() => run(true)}>Check with AI detector</s-button>}
        </s-stack>
      </s-stack>
      {scan?.status === "failed" && <s-text tone="critical">{scan.error}</s-text>}
      {scan?.status === "completed" && <s-unordered-list>
        {scanFindings(scan, listLink).map((line, index) => (
          <s-list-item key={index}>
            <s-text tone={line.tone === "neutral" ? undefined : line.tone}>{line.text}</s-text>
            {line.href && <> <s-link href={line.href}>Open ticket</s-link></>}
          </s-list-item>
        ))}
      </s-unordered-list>}
      {exif?.image && <s-text color="subdued">
        {[exif.image.width && exif.image.height ? `${exif.image.width}×${exif.image.height} (${exif.image.megapixels} MP)` : "", exif.image.format?.toUpperCase(),
          exif.camera?.make || exif.camera?.model ? [exif.camera.make, exif.camera.model].filter(Boolean).join(" ") : "No camera details",
          editing?.cameraCoherence?.attested ? "camera hardware signature verified" : ""].filter(Boolean).join(" · ")}
      </s-text>}
      <s-text color="subdued">A finding is evidence, not proof: use it to decide whether to ask the customer for more photos. Metadata is often removed by messaging apps, so its absence doesn&apos;t count against a photo.</s-text>
    </s-stack>
  </s-box>;
}

function ProductList({ heading, products }: { heading: string; products: TicketProduct[] }) {
  return <s-stack gap="small-200">
    <s-text type="strong">{heading} ({products.length})</s-text>
    {products.map((product) => (
      <s-stack key={product.id} direction="inline" gap="base" alignItems="center">
        <s-thumbnail src={product.image || undefined} alt={product.title} size="small" />
        <s-link href={`shopify://admin/products/${product.id.split("/").pop()}`} target="_blank">{product.title}</s-link>
      </s-stack>
    ))}
  </s-stack>;
}

function Gallery({ files }: { files: TicketFile[] }) {
  const [image, setImage] = useState<{ url: string; name: string; id: string } | null>(null);
  if (!files.length) return null;
  const open = image && files.find((file) => file.id === image.id);
  return <s-stack gap="small-200">
    <s-text type="strong">Images ({files.length})</s-text>
    <s-stack direction="inline" gap="base">
      {files.map((file) => <Attachment key={file.id} file={file} onOpen={setImage} />)}
    </s-stack>
    {image && <s-box border="base" borderRadius="base" padding="base">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text type="strong">{image.name}</s-text>
          <s-stack direction="inline" gap="small-200">
            <a href={image.url} download={image.name}><s-button icon="download">Download</s-button></a>
            <s-button icon="x" variant="tertiary" accessibilityLabel="Close image" onClick={() => setImage(null)} />
          </s-stack>
        </s-stack>
        <img src={image.url} alt={image.name} style={{ display: "block", maxWidth: "100%", maxHeight: 640, margin: "0 auto", borderRadius: 8 }} />
        {open && <ScanPanel file={open} />}
      </s-stack>
    </s-box>}
  </s-stack>;
}

function OriginalRequest({ ticket }: { ticket: TicketData["ticket"] }) {
  const values = ticket.details;
  const files = ticket.attachments.filter((file) => !file.messageId);
  if (ticket.channel === "chat") {
    return <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-icon type="chat" tone="neutral" size="small" />
      <s-text color="subdued">{ticket.name} started a chat from the storefront · <span suppressHydrationWarning>{formatDate(ticket.createdAt)}</span>. Earlier messages with the assistant are shown below.</s-text>
    </s-stack>;
  }
  const rows = Object.keys(LABELS).filter((key) => key !== "phone" && values[key]);
  return <s-box border="base" borderRadius="base" padding="base">
    <s-stack gap="base">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-avatar initials={ticket.name.slice(0, 2).toUpperCase()} alt={ticket.name} size="small" />
        <s-text type="strong">{ticket.name}</s-text>
        <s-text color="subdued">submitted a request · <span suppressHydrationWarning>{formatDate(ticket.createdAt)}</span></s-text>
      </s-stack>
      {rows.length === 0 && <s-paragraph color="subdued">No additional details were submitted.</s-paragraph>}
      {rows.map((key) => (
        <s-grid key={key} gridTemplateColumns="minmax(130px, 1fr) 3fr" gap="base">
          <s-text color="subdued">{LABELS[key]}</s-text>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {key === "country" ? countryName(values[key]) : key === "registeredEmail" ? <s-link href={`mailto:${values[key]}`}>{values[key]}</s-link> : values[key]}
          </div>
        </s-grid>
      ))}
      {ticket.receivedProducts.length > 0 && <ProductList heading="Received by mistake" products={ticket.receivedProducts} />}
      {ticket.products.length > 0 && <ProductList heading={ticket.receivedProducts.length ? "Wanted instead" : "Products"} products={ticket.products} />}
      <Gallery files={files} />
    </s-stack>
  </s-box>;
}

type TicketEmail = TicketData["ticket"]["emails"][number];
const EMAIL_KIND: Record<string, string> = {
  "new-ticket": "New ticket alert to your team", "customer-reply": "Customer reply alert to your team",
  ack: "Confirmation to customer", reply: "Reply to customer", status: "Status update to customer",
};

// Delivery state of one queued email, with a retry for failures.
function EmailStatus({ email }: { email: TicketEmail }) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher, "Email sent again");
  const retrying = fetcher.state !== "idle";
  if (email.status === "sent") return <s-badge tone="success" icon="email">Emailed</s-badge>;
  if (email.status === "pending" || email.status === "processing") {
    return <s-badge tone="info">{email.attempts ? `Retrying (attempt ${email.attempts + 1})` : "Sending email"}</s-badge>;
  }
  return <s-stack direction="inline" gap="small-100" alignItems="center">
    <s-badge tone={email.status === "failed" ? "critical" : "neutral"}>{email.status === "failed" ? "Email failed" : "Email not sent"}</s-badge>
    {email.status === "failed" && <s-button variant="tertiary" icon="refresh" loading={retrying}
      onClick={() => void fetcher.submit({ intent: "email-retry", id: email.id }, { method: "post" })}>Retry</s-button>}
  </s-stack>;
}

function Message({ message, files, email, isNew }: { message: TicketData["ticket"]["messages"][number]; files: TicketFile[]; email?: TicketEmail; isNew: boolean }) {
  const time = <span suppressHydrationWarning>{formatDate(message.createdAt)}</span>;
  if (message.kind === "event") {
    return <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-icon type="clock" tone="neutral" size="small" />
      <s-text color="subdued">{message.body} · {message.author} · {time}</s-text>
    </s-stack>;
  }
  const note = message.kind === "note";
  const customer = message.kind === "customer";
  const bot = message.kind === "bot";
  return <div style={note ? { background: "#fff8db", border: "1px solid #f0d983", borderRadius: 12, padding: 16 } : undefined}>
    <s-box border={note ? undefined : "base"} borderRadius="base" padding={note ? "none" : "base"} background={customer ? "base" : note ? "transparent" : "subdued"}>
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-avatar initials={bot ? "AI" : message.author.slice(0, 2).toUpperCase()} alt={message.author} size="small" />
          <s-text type="strong">{message.author}</s-text>
          {isNew && <s-badge tone="info">New</s-badge>}
          {note ? <s-badge tone="caution" icon="lock">Internal note</s-badge>
            : customer ? <s-badge tone="info">Customer</s-badge>
            : bot ? <s-badge>Automated answer</s-badge>
            : email ? <EmailStatus email={email} />
            : <s-badge tone={message.emailed ? "success" : "neutral"} icon={message.emailed ? "email" : undefined}>{message.emailed ? "Emailed to customer" : "Shown on request page"}</s-badge>}
          <s-text color="subdued">{time}</s-text>
        </s-stack>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.body}</div>
        <Gallery files={files} />
      </s-stack>
    </s-box>
  </div>;
}

function Composer({ ticket, macros, storeName, team, configured }: { ticket: TicketData["ticket"]; macros: TicketData["macros"]; storeName: string; team: string[]; configured: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const [kind, setKind] = useState<"reply" | "note">("reply");
  const [body, setBody] = useState("");
  const [macro, setMacro] = useState("");
  const authors = [...new Set([...team, `${storeName} Support`])];
  const [author, setAuthor] = useState(() => ticket.assignee && authors.includes(ticket.assignee) ? ticket.assignee : authors[0]);
  useEffect(() => {
    try { const saved = localStorage.getItem("help-desk-author"); if (saved && authors.includes(saved)) setAuthor(saved); } catch { /* storage unavailable */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sending = fetcher.state !== "idle";
  const sentKind = useRef(kind);
  useResultToast(fetcher, (result) => sentKind.current === "note" ? "Note added" : result.emailed ? "Reply sent to the customer" : "Reply saved. It's shown on the customer's request page.");
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !Object.keys(fetcher.data.errors).length) { setBody(""); setMacro(""); }
  }, [fetcher.state, fetcher.data]);
  const send = (status = "") => {
    sentKind.current = kind;
    try { localStorage.setItem("help-desk-author", author); } catch { /* storage unavailable */ }
    void fetcher.submit({ intent: "message", id: ticket.id, kind, body, author, status }, { method: "post" });
  };
  return <s-section heading={kind === "reply" ? `Reply to ${ticket.name}` : "Add an internal note"}>
    <s-stack gap="base">
      <s-stack direction="inline" gap="small-200">
        <s-button variant={kind === "reply" ? "secondary" : "tertiary"} icon="email" onClick={() => setKind("reply")}>Reply to customer</s-button>
        <s-button variant={kind === "note" ? "secondary" : "tertiary"} icon="note" onClick={() => setKind("note")}>Internal note</s-button>
      </s-stack>
      {kind === "reply" && !configured && <s-banner tone="info">
        Email isn&apos;t set up on the server, so replies are shown on the customer&apos;s request page but not emailed.
      </s-banner>}
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        <s-select label="Insert a saved reply" value={macro} disabled={!macros.length} onChange={(event) => {
          const chosen = macros.find((item) => item.id === event.currentTarget.value);
          setMacro("");
          if (chosen) setBody((current) => (current.trim() ? `${current.trimEnd()}\n\n` : "") + fillMacro(chosen.body, ticket, storeName));
        }}>
          <s-option value="">{macros.length ? "Choose a saved reply" : "No saved replies yet"}</s-option>
          {macros.map((item) => <s-option key={item.id} value={item.id}>{item.title}</s-option>)}
        </s-select>
        <s-select label={kind === "reply" ? "Reply as" : "Note by"} value={author} onChange={(event) => setAuthor(event.currentTarget.value || authors[0])}>
          {authors.map((name) => <s-option key={name} value={name}>{name}</s-option>)}
        </s-select>
      </s-grid>
      <s-text-area label={kind === "reply" ? "Message" : "Note"} labelAccessibilityVisibility="exclusive" rows={7} value={body} maxLength={MAX_MESSAGE_LENGTH}
        placeholder={kind === "reply" ? `Write your reply to ${ticket.name}...` : "Only your team can see notes."}
        error={fetcher.data?.errors.body} onInput={(event) => setBody(event.currentTarget.value ?? "")} />
      <s-stack direction="inline" gap="small-200" justifyContent="end">
        {kind === "reply" ? <>
          <s-button disabled={!body.trim() || sending} onClick={() => send("Resolved")}>Send and resolve</s-button>
          <s-button variant="primary" icon="send" disabled={!body.trim()} loading={sending} onClick={() => send()}>Send reply</s-button>
        </> : <s-button variant="primary" icon="note" disabled={!body.trim()} loading={sending} onClick={() => send()}>Add note</s-button>}
      </s-stack>
    </s-stack>
  </s-section>;
}

function TicketProperties({ ticket, team }: { ticket: TicketData["ticket"]; team: string[] }) {
  const fetcher = useFetcher<typeof action>();
  const [tags, setTags] = useState(ticket.tags);
  useEffect(() => setTags(ticket.tags), [ticket.tags]);
  useResultToast(fetcher, "Ticket updated");
  const update = (changes: Record<string, string>) => void fetcher.submit({ intent: "update", id: ticket.id, ...changes }, { method: "post" });
  const people = [...new Set([...team, ...(ticket.assignee ? [ticket.assignee] : [])])];
  const busy = fetcher.state !== "idle";
  return <s-section slot="aside" heading="Ticket">
    <s-stack gap="base">
      <s-select label="Status" value={ticket.status} disabled={busy} onChange={(event) => update({ status: event.currentTarget.value || "Open" })}>
        {ticketStatuses.map((value) => <s-option key={value} value={value}>{value}</s-option>)}
      </s-select>
      <s-select label="Priority" value={ticket.priority} disabled={busy} onChange={(event) => update({ priority: event.currentTarget.value || "Normal" })}>
        {priorities.map((value) => <s-option key={value} value={value}>{value}</s-option>)}
      </s-select>
      <s-select label="Assignee" value={ticket.assignee} disabled={busy}
        details={team.length ? undefined : "Add your team in Help Desk settings to assign tickets."} onChange={(event) => update({ assignee: event.currentTarget.value ?? "" })}>
        <s-option value="">Unassigned</s-option>
        {people.map((name) => <s-option key={name} value={name}>{name}</s-option>)}
      </s-select>
      <form onSubmit={(event) => { event.preventDefault(); if (tags !== ticket.tags) update({ tags }); }}>
        <s-text-field label="Tags" value={tags} placeholder="e.g. damaged, vip" details="Separate tags with commas. Press Enter to save."
          onInput={(event) => setTags(event.currentTarget.value ?? "")} onBlur={() => { if (tags !== ticket.tags) update({ tags }); }} />
      </form>
      <s-divider />
      <s-stack gap="small-100">
        <s-text color="subdued">Created <span suppressHydrationWarning>{formatDate(ticket.createdAt)}</span></s-text>
        <s-text color="subdued">{ticket.firstResponseAt
          ? <>First response in {duration(new Date(ticket.firstResponseAt).getTime() - new Date(ticket.createdAt).getTime())}</>
          : <span suppressHydrationWarning>Waiting for a first response · {ago(ticket.createdAt)}</span>}</s-text>
        {ticket.resolvedAt && <s-text color="subdued">Resolved <span suppressHydrationWarning>{formatDate(ticket.resolvedAt)}</span></s-text>}
      </s-stack>
    </s-stack>
  </s-section>;
}

// Reloads the page data every 15 seconds while the tab is visible, so new chat
// messages and email results appear without a refresh. Typed text is kept.
function useLiveRefresh(intervalMs = 15_000) {
  const revalidator = useRevalidator();
  const state = useRef(revalidator);
  state.current = revalidator;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && state.current.state === "idle") void state.current.revalidate();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

function TicketDetail({ screen }: { screen: TicketData }) {
  const { ticket, others, orders, trackingUrl: link } = screen;
  const listLink = useListLink();
  const shopify = useAppBridge();
  const values = ticket.details;
  const orderNumber = values.orderNumber?.replace(/^#/, "");
  const conversation = ticket.messages;
  const readAt = ticket.readAt ? new Date(ticket.readAt).getTime() : 0;
  const replyEmails = new Map(ticket.emails.filter((email) => email.messageId).map((email) => [email.messageId!, email]));
  const otherEmails = ticket.emails.filter((email) => !(email.kind === "reply" && email.messageId));
  useLiveRefresh();
  return <s-page heading={`#${ticket.number} · ${ticket.topic}`}>
    <s-link slot="breadcrumb-actions" href={listLink({ ticket: "" })}>Help Desk</s-link>
    {link && <s-button slot="secondary-actions" icon="external" href={link} target="_blank">Customer&apos;s request page</s-button>}

    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          {ticket.assignee ? <s-badge icon="person">{ticket.assignee}</s-badge> : <s-badge tone="neutral">Unassigned</s-badge>}
          {ticket.channel === "chat" && <s-badge icon="chat">Live chat</s-badge>}
          {ticket.tags && ticket.tags.split(", ").map((tag) => <s-chip key={tag}>{tag}</s-chip>)}
        </s-stack>
        <s-heading>Conversation</s-heading>
        <OriginalRequest ticket={ticket} />
        {conversation.map((message) => (
          <Message key={message.id} message={message} email={replyEmails.get(message.id)}
            files={ticket.attachments.filter((file) => file.messageId === message.id)}
            isNew={Boolean(readAt) && message.kind === "customer" && new Date(message.createdAt).getTime() > readAt} />
        ))}
        {ticket.status === "Resolved" && <s-banner tone="success">This ticket is resolved. If the customer replies, it reopens automatically.</s-banner>}
      </s-stack>
    </s-section>

    <Composer key={ticket.id} ticket={ticket} macros={screen.macros} storeName={screen.storeName} team={screen.team} configured={screen.configured} />

    <TicketProperties ticket={ticket} team={screen.team} />

    <s-section slot="aside" heading="Customer">
      <s-stack gap="small-200">
        <s-text type="strong">{ticket.name}</s-text>
        <s-stack direction="inline" gap="small-100" alignItems="center">
          <s-link href={`mailto:${ticket.email}?subject=${encodeURIComponent(`Re: [#${ticket.number}] ${ticket.topic}`)}`}>{ticket.email}</s-link>
          <s-button variant="tertiary" icon="clipboard" accessibilityLabel="Copy email" onClick={() => {
            void navigator.clipboard?.writeText(ticket.email).then(() => shopify.toast.show("Email copied"));
          }} />
        </s-stack>
        {values.phone && <s-link href={`tel:${values.phone.replace(/[^\d+]/g, "")}`}>{values.phone}</s-link>}
        {ticket.customerId && <s-link href={`shopify://admin/customers/${ticket.customerId}`} target="_blank">View customer in Shopify</s-link>}
        {orderNumber && <s-link href={`shopify://admin/orders?query=${encodeURIComponent(orderNumber)}`} target="_blank">Find order {values.orderNumber}</s-link>}
      </s-stack>
    </s-section>

    <s-section slot="aside" heading="Recent orders">
      {orders === null ? <s-paragraph color="subdued">Orders couldn&apos;t be loaded.</s-paragraph>
        : orders.length === 0 ? <s-paragraph color="subdued">No orders found for {ticket.email}.</s-paragraph>
        : <s-stack gap="base">
          {orders.map((order) => (
            <s-stack key={order.id} gap="small-100">
              <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
                <s-link href={`shopify://admin/orders/${order.id}`} target="_blank">{order.name}</s-link>
                <s-text>{order.total}</s-text>
              </s-stack>
              <s-stack direction="inline" gap="small-100">
                <s-text color="subdued">{order.date}</s-text>
                {order.cancelled ? <s-badge tone="critical">Cancelled</s-badge> : <>
                  {order.payment && <s-badge>{order.payment}</s-badge>}
                  {order.fulfillment && <s-badge tone={order.fulfillment === "Fulfilled" ? "success" : "warning"}>{order.fulfillment}</s-badge>}
                </>}
              </s-stack>
            </s-stack>
          ))}
        </s-stack>}
    </s-section>

    {otherEmails.length > 0 && <s-section slot="aside" heading="Emails">
      <s-stack gap="small-200">
        {otherEmails.map((email) => (
          <s-stack key={email.id} gap="small-100">
            <s-text>{EMAIL_KIND[email.kind] ?? email.kind}</s-text>
            <s-stack direction="inline" gap="small-100" alignItems="center">
              <EmailStatus email={email} />
              <s-text color="subdued"><span suppressHydrationWarning>{formatDate(email.sentAt ?? email.createdAt)}</span></s-text>
            </s-stack>
            {email.status === "failed" && email.lastError && <s-text color="subdued">{email.lastError}</s-text>}
          </s-stack>
        ))}
      </s-stack>
    </s-section>}

    {others.length > 0 && <s-section slot="aside" heading={`Other requests (${others.length})`}>
      <s-stack gap="small-200">
        {others.map((other) => (
          <s-stack key={other.id} direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
            <s-link href={listLink({ ticket: other.id })}>#{other.number} {other.topic}</s-link>
            <StatusBadge status={other.status} />
          </s-stack>
        ))}
      </s-stack>
    </s-section>}
  </s-page>;
}

// ---------- List ----------

function BulkBar({ ids, team, onDone }: { ids: string[]; team: string[]; onDone: () => void }) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher, (result) => `${result.updated ?? ids.length} ticket${(result.updated ?? ids.length) === 1 ? "" : "s"} updated`);
  useEffect(() => { if (fetcher.state === "idle" && fetcher.data && !Object.keys(fetcher.data.errors).length) onDone(); }, [fetcher.state, fetcher.data, onDone]);
  const apply = (changes: Record<string, string>) => {
    const form = new FormData();
    form.set("intent", "bulk");
    ids.forEach((id) => form.append("ids", id));
    for (const [key, value] of Object.entries(changes)) form.set(key, value);
    void fetcher.submit(form, { method: "post" });
  };
  const busy = fetcher.state !== "idle";
  return <s-box padding="base" background="subdued">
    <s-stack direction="inline" gap="base" alignItems="end">
      <s-text type="strong">{ids.length} selected</s-text>
      <s-select label="Set status" value="" disabled={busy} onChange={(event) => { if (event.currentTarget.value) apply({ status: event.currentTarget.value }); }}>
        <s-option value="">Set status</s-option>
        {ticketStatuses.map((value) => <s-option key={value} value={value}>{value}</s-option>)}
      </s-select>
      <s-select label="Set priority" value="" disabled={busy} onChange={(event) => { if (event.currentTarget.value) apply({ priority: event.currentTarget.value }); }}>
        <s-option value="">Set priority</s-option>
        {priorities.map((value) => <s-option key={value} value={value}>{value}</s-option>)}
      </s-select>
      {team.length > 0 && <s-select label="Assign to" value="" disabled={busy} onChange={(event) => {
        const value = event.currentTarget.value;
        if (value) apply({ assignee: value === "-" ? "" : value });
      }}>
        <s-option value="">Assign to</s-option>
        <s-option value="-">Unassigned</s-option>
        {team.map((name) => <s-option key={name} value={name}>{name}</s-option>)}
      </s-select>}
      <s-button variant="tertiary" disabled={busy} onClick={onDone}>Clear selection</s-button>
    </s-stack>
  </s-box>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <s-box border="base" borderRadius="base" padding="base">
    <s-stack gap="small-100">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
      {detail && <s-text color="subdued">{detail}</s-text>}
    </s-stack>
  </s-box>;
}

function TicketList({ screen }: { screen: ListData }) {
  const { tickets, count, page, views, metrics, filters, team } = screen;
  const listLink = useListLink();
  const navigate = useNavigate();
  const [search, setSearch] = useState(filters.q);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => setSelected([]), [tickets]);
  const clearSelection = useRef(() => setSelected([])).current;
  const filtered = Boolean(filters.topic || filters.priority || filters.assignee || filters.q);
  const allSelected = tickets.length > 0 && tickets.every((ticket) => selected.includes(ticket.id));
  const toggle = (id: string, on: boolean) => setSelected((current) => on ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  return <s-page heading="Help Desk" inlineSize="large">
    <s-button slot="secondary-actions" icon="chat" href="/app/help-desk?chatbot=1">Chatbot</s-button>
    <s-button slot="secondary-actions" icon="settings" href="/app/help-desk?settings=1">Settings</s-button>

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
        <Metric label="Needs attention" value={String(views.open)} detail={`${views.unassigned} unassigned`} />
        <Metric label="High priority" value={String(views.urgent)} detail="Open high and urgent" />
        <Metric label="Avg. first response" value={metrics.avgResponse === null ? "—" : duration(metrics.avgResponse)} detail="Last 30 days" />
        <Metric label="Resolved" value={String(metrics.resolvedWeek)} detail={`Last 7 days · ${metrics.newToday} new today`} />
        <Metric label="Answered by chatbot" value={metrics.botAsked ? `${Math.round((metrics.botAnswered / metrics.botAsked) * 100)}%` : "—"}
          detail={`${metrics.botAnswered} of ${metrics.botAsked} questions · 30 days`} />
      </s-grid>
    </s-section>

    <s-section padding="none">
      <s-box padding="base">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200">
            {(Object.keys(VIEWS) as View[]).map((key) => (
              <s-button key={key} variant={filters.view === key ? "secondary" : "tertiary"} onClick={() => navigate(listLink({ view: key === "open" ? "" : key }))}>
                {`${VIEWS[key].label} ${views[key]}`}
              </s-button>
            ))}
          </s-stack>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base" alignItems="end">
            <s-grid-item gridColumn="span 2">
              <form onSubmit={(event) => { event.preventDefault(); navigate(listLink({ q: search.trim() })); }}>
                <s-search-field label="Search tickets" labelAccessibilityVisibility="exclusive" placeholder="Search by #number, name, email, order or tag"
                  value={search} onInput={(event) => setSearch(event.currentTarget.value ?? "")} />
              </form>
            </s-grid-item>
            <s-select label="Topic" labelAccessibilityVisibility="exclusive" value={filters.topic} onChange={(event) => navigate(listLink({ topic: event.currentTarget.value ?? "" }))}>
              <s-option value="">All topics</s-option>
              {TOPICS.map((topic) => <s-option key={topic} value={topic}>{topic}</s-option>)}
            </s-select>
            <s-select label="Priority" labelAccessibilityVisibility="exclusive" value={filters.priority} onChange={(event) => navigate(listLink({ priority: event.currentTarget.value ?? "" }))}>
              <s-option value="">Any priority</s-option>
              {priorities.map((value) => <s-option key={value} value={value}>{value}</s-option>)}
            </s-select>
            {team.length > 0 && <s-select label="Assignee" labelAccessibilityVisibility="exclusive" value={filters.assignee} onChange={(event) => navigate(listLink({ assignee: event.currentTarget.value ?? "" }))}>
              <s-option value="">Anyone</s-option>
              {team.map((name) => <s-option key={name} value={name}>{name}</s-option>)}
            </s-select>}
            <s-select label="Sort" labelAccessibilityVisibility="exclusive" value={filters.sort} onChange={(event) => navigate(listLink({ sort: event.currentTarget.value === "activity" ? "" : event.currentTarget.value ?? "" }))}>
              {Object.entries(SORTS).map(([value, label]) => <s-option key={value} value={value}>{label}</s-option>)}
            </s-select>
          </s-grid>
          {filtered && <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued">{count} matching ticket{count === 1 ? "" : "s"}</s-text>
            <s-button variant="tertiary" onClick={() => { setSearch(""); navigate(listLink({ q: "", topic: "", priority: "", assignee: "" })); }}>Clear filters</s-button>
          </s-stack>}
        </s-stack>
      </s-box>

      {tickets.length > 0 && <s-box paddingInline="base" paddingBlockEnd="small-200">
        <s-checkbox label={allSelected ? "Deselect all on this page" : "Select all on this page"} checked={allSelected}
          onChange={() => setSelected(allSelected ? [] : tickets.map((ticket) => ticket.id))} />
      </s-box>}
      {selected.length > 0 && <BulkBar ids={selected} team={team} onDone={clearSelection} />}

      {tickets.length === 0 ? (
        <s-box padding="large-200">
          <s-stack gap="small-200" alignItems="center">
            <s-heading>{filtered ? "No tickets match these filters" : filters.view === "open" ? "You're all caught up" : "No tickets here"}</s-heading>
            <s-paragraph color="subdued">{filtered ? "Try a different search or clear the filters."
              : views.all ? "New requests and customer replies appear in Needs attention." : "Requests customers send from the storefront Help Desk form appear here."}</s-paragraph>
          </s-stack>
        </s-box>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header>Select</s-table-header>
            <s-table-header listSlot="primary">Ticket</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>Priority</s-table-header>
            <s-table-header>Assignee</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>Last activity</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {tickets.map((ticket) => (
              <s-table-row key={ticket.id} clickDelegate={`ticket-${ticket.id}`}>
                <s-table-cell>
                  <div onClick={(event) => event.stopPropagation()} role="presentation">
                    <s-checkbox accessibilityLabel={`Select ticket #${ticket.number}`} checked={selected.includes(ticket.id)}
                      onChange={(event) => toggle(ticket.id, Boolean(event.currentTarget.checked))} />
                  </div>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="none">
                    <s-stack direction="inline" gap="small-100" alignItems="center">
                      {ticket.unread && <s-badge tone="info">New</s-badge>}
                      {ticket.channel === "chat" && <s-icon type="chat" tone="neutral" size="small" />}
                      {ticket.photoFlag && <s-badge tone={ticket.photoFlag === "likely_ai" ? "critical" : "warning"} icon="image">{ticket.photoFlag === "likely_ai" ? "AI photo" : "Reused photo"}</s-badge>}
                      <s-link id={`ticket-${ticket.id}`} href={listLink({ ticket: ticket.id, page: String(page) })}>
                        {ticket.unread ? <strong>#{ticket.number} {ticket.topic}</strong> : `#${ticket.number} ${ticket.topic}`}
                      </s-link>
                    </s-stack>
                    <s-text color="subdued">
                      {[ticket.reference, ticket.images ? `${ticket.images} image${ticket.images === 1 ? "" : "s"}` : "", ticket.tags].filter(Boolean).join(" · ") || "—"}
                    </s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="none">
                    <s-text>{ticket.name}</s-text>
                    <s-text color="subdued">{ticket.email}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell><PriorityBadge priority={ticket.priority} /></s-table-cell>
                <s-table-cell>{ticket.assignee || <s-text color="subdued">Unassigned</s-text>}</s-table-cell>
                <s-table-cell><StatusBadge status={ticket.status} /></s-table-cell>
                <s-table-cell>
                  <s-stack gap="none">
                    <span suppressHydrationWarning>{ago(ticket.lastActivityAt ?? ticket.createdAt)}</span>
                    {!ticket.firstResponseAt && ticket.status !== "Resolved" && <s-text tone="critical"><span suppressHydrationWarning>No reply yet · {duration(Date.now() - new Date(ticket.createdAt).getTime())}</span></s-text>}
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}

      {count > PAGE_SIZE && <s-box padding="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">Page {page} of {Math.ceil(count / PAGE_SIZE)}</s-text>
          <s-stack direction="inline" gap="small-200">
            <s-button icon="chevron-left" accessibilityLabel="Previous page" disabled={page <= 1} onClick={() => navigate(listLink({ page: String(page - 1) }))} />
            <s-button icon="chevron-right" accessibilityLabel="Next page" disabled={page * PAGE_SIZE >= count} onClick={() => navigate(listLink({ page: String(page + 1) }))} />
          </s-stack>
        </s-stack>
      </s-box>}
    </s-section>
  </s-page>;
}

// ---------- Settings ----------

function MacroEditor({ macro, onDone }: { macro?: { id: string; title: string; body: string }; onDone?: () => void }) {
  const fetcher = useFetcher<typeof action>();
  const [title, setTitle] = useState(macro?.title ?? "");
  const [body, setBody] = useState(macro?.body ?? "");
  useResultToast(fetcher, macro ? "Saved reply updated" : "Saved reply added");
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || Object.keys(fetcher.data.errors).length) return;
    if (!macro) { setTitle(""); setBody(""); }
    onDone?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
  return <s-stack gap="base">
    <s-text-field label="Name" value={title} maxLength={80} error={fetcher.data?.errors.title} onInput={(event) => setTitle(event.currentTarget.value ?? "")} />
    <s-text-area label="Reply" rows={6} value={body} maxLength={MAX_MESSAGE_LENGTH} error={fetcher.data?.errors.body}
      details={`Placeholders: ${macroPlaceholders.map(([key]) => `{{ ${key} }}`).join(", ")}`} onInput={(event) => setBody(event.currentTarget.value ?? "")} />
    <s-stack direction="inline" gap="small-200">
      <s-button variant="primary" loading={fetcher.state !== "idle"} disabled={!title.trim() || !body.trim()}
        onClick={() => void fetcher.submit({ intent: "macro-save", id: macro?.id ?? "", title, body }, { method: "post" })}>{macro ? "Save" : "Add saved reply"}</s-button>
      {onDone && <s-button variant="tertiary" onClick={onDone}>Cancel</s-button>}
    </s-stack>
  </s-stack>;
}

function SavedReplies({ macros }: { macros: SettingsData["macros"] }) {
  const [editing, setEditing] = useState("");
  const remove = useFetcher<typeof action>();
  useResultToast(remove, "Saved reply deleted");
  return <s-section heading="Saved replies">
    <s-stack gap="base">
      <s-paragraph color="subdued">Insert these into a reply with one click. Placeholders are filled in with the ticket&apos;s details.</s-paragraph>
      {macros.map((macro) => editing === macro.id
        ? <s-box key={macro.id} border="base" borderRadius="base" padding="base"><MacroEditor macro={macro} onDone={() => setEditing("")} /></s-box>
        : <s-box key={macro.id} border="base" borderRadius="base" padding="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack gap="none">
              <s-text type="strong">{macro.title}</s-text>
              <s-text color="subdued">{macro.body.replace(/\s+/g, " ").slice(0, 110)}{macro.body.length > 110 ? "..." : ""}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="small-100">
              <s-button variant="tertiary" icon="edit" accessibilityLabel={`Edit ${macro.title}`} onClick={() => setEditing(macro.id)} />
              <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel={`Delete ${macro.title}`} disabled={remove.state !== "idle"}
                onClick={() => void remove.submit({ intent: "macro-delete", id: macro.id }, { method: "post" })} />
            </s-stack>
          </s-stack>
        </s-box>)}
      <s-divider />
      <s-heading>Add a saved reply</s-heading>
      <MacroEditor />
    </s-stack>
  </s-section>;
}

const DETECTOR_MODE_LABELS: Record<string, { label: string; details: string }> = {
  suspicious: { label: "Only when a photo looks suspicious (recommended)", details: "Clear camera originals skip the paid check; everything else the free checks can't settle is sent." },
  always: { label: "Every photo the free checks can't settle", details: "Most thorough; uses the most checks on your plan." },
  manual: { label: "Only when I click \"Check with AI detector\"", details: "No checks are used automatically." },
};

function AiSettings({ ai }: { ai: SettingsData["ai"] }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [values, setValues] = useState({ enabled: ai.enabled, mode: ai.mode, provider: ai.provider, sightengineUser: ai.sightengineUser, sightengineSecret: "", truthscanKey: "" });
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (Object.keys(fetcher.data.errors).length) shopify.toast.show(Object.values(fetcher.data.errors)[0], { isError: true });
    else {
      shopify.toast.show(fetcher.data.notice || "AI photo check saved", { isError: Boolean(fetcher.data.notice) });
      setValues((current) => ({ ...current, sightengineSecret: "", truthscanKey: "" }));
    }
  }, [fetcher.state, fetcher.data, shopify]);
  const set = (key: keyof typeof values, value: string | boolean) => setValues((current) => ({ ...current, [key]: value }));
  const truthscan = values.provider === "truthscan";
  const connected = truthscan ? ai.hasTruthscanKey : Boolean(ai.sightengineUser && ai.hasSightengineSecret);
  return <s-section heading="AI photo check">
    <s-stack gap="base">
      <s-paragraph color="subdued">
        Every photo customers send is checked for signs it was made with AI or reused from another request: Content Credentials, AI watermarks
        (including Gemini&apos;s), generator metadata, duplicate photos and signs of editing. These checks are free. Photos they can&apos;t settle can also go
        to a dedicated AI-image detector on your own account.
      </s-paragraph>
      <s-switch label="Check customer photos" checked={values.enabled} onChange={(event) => set("enabled", event.currentTarget.checked ?? false)} />
      <s-select label="AI detector" value={values.provider} disabled={!values.enabled} onChange={(event) => set("provider", event.currentTarget.value || "sightengine")}>
        <s-option value="sightengine">Sightengine (free plan: 2,000 checks a month)</s-option>
        <s-option value="truthscan">TruthScan (the engine behind ZeroGPT; free plan: 25 a month)</s-option>
      </s-select>
      {truthscan ? (
        <s-password-field label="TruthScan API key" value={values.truthscanKey} disabled={!values.enabled} autocomplete="off"
          placeholder={ai.hasTruthscanKey ? "Saved. Enter a new key to replace it" : "Paste your API key"}
          error={fetcher.data?.errors.credentials} onInput={(event) => set("truthscanKey", event.currentTarget.value ?? "")} />
      ) : <>
        <s-text-field label="Sightengine API user" value={values.sightengineUser} disabled={!values.enabled} autocomplete="off" onInput={(event) => set("sightengineUser", event.currentTarget.value ?? "")} />
        <s-password-field label="Sightengine API secret" value={values.sightengineSecret} disabled={!values.enabled} autocomplete="off"
          placeholder={ai.hasSightengineSecret ? "Saved. Enter a new secret to replace it" : "Paste your API secret"}
          error={fetcher.data?.errors.credentials} onInput={(event) => set("sightengineSecret", event.currentTarget.value ?? "")} />
      </>}
      <s-text color="subdued">{connected ? "Detector connected. Keys are checked with the provider when you save." : "Without a key the free checks still run; photos they can't settle show as \"Can't confirm\"."}</s-text>
      <s-select label="When to use the AI detector" value={values.mode} disabled={!values.enabled}
        details={DETECTOR_MODE_LABELS[values.mode]?.details} onChange={(event) => set("mode", event.currentTarget.value || "suspicious")}>
        {Object.entries(DETECTOR_MODE_LABELS).map(([value, { label }]) => <s-option key={value} value={value}>{label}</s-option>)}
      </s-select>
      <s-stack direction="inline">
        <s-button variant="primary" loading={fetcher.state !== "idle"}
          onClick={() => void fetcher.submit({ intent: "ai-settings", ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) }, { method: "post" })}>Save AI photo check</s-button>
      </s-stack>
    </s-stack>
  </s-section>;
}

function SettingsScreen({ screen }: { screen: SettingsData }) {
  const { settings, storeEmail, configured } = screen;
  const save = useFetcher<typeof action>();
  const test = useFetcher<typeof action>();
  const [values, setValues] = useState(settings);
  useEffect(() => setValues(settings), [settings]);
  const recipient = values.notifyEmail.trim() || storeEmail;
  useResultToast(save, "Help Desk settings saved");
  useResultToast(test, `Test email sent to ${recipient}`);
  const dirty = (Object.keys(settings) as (keyof typeof settings)[]).some((key) => settings[key] !== values[key]);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((current) => ({ ...current, [key]: value }));
  return <s-page heading="Help Desk settings">
    <s-link slot="breadcrumb-actions" href="/app/help-desk">Help Desk</s-link>
    <s-button slot="primary-action" variant="primary" disabled={!dirty} loading={save.state !== "idle"}
      onClick={() => void save.submit({ intent: "settings", ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) }, { method: "post" })}>Save</s-button>

    {!configured && <s-banner tone="warning" heading="Email sending isn't set up yet">
      Add the SMTP settings (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and optionally SMTP_FROM) to the app server. Until then, tickets and replies still work in the app and on the customer&apos;s request page, but no emails are sent.
    </s-banner>}

    <s-section heading="Team notifications">
      <s-stack gap="base">
        <s-switch label="Email me about new requests and customer replies" checked={values.notify} onChange={(event) => set("notify", event.currentTarget.checked ?? false)} />
        <s-email-field label="Send notifications to" value={values.notifyEmail} placeholder={storeEmail || "name@example.com"}
          details={storeEmail ? `Leave blank to use your store email (${storeEmail}).` : "Leave blank to use your store email."}
          error={save.data?.errors.notifyEmail} disabled={!values.notify} onInput={(event) => set("notifyEmail", event.currentTarget.value ?? "")} />
        <s-stack direction="inline">
          <s-button disabled={!configured || !recipient} loading={test.state !== "idle"} onClick={() => void test.submit({ intent: "test-email", to: recipient }, { method: "post" })}>Send test email</s-button>
        </s-stack>
      </s-stack>
    </s-section>

    <s-section heading="Customer emails">
      <s-stack gap="base">
        <s-switch label="Send customers a confirmation with their ticket number" details="Includes a private link where they can follow their request and reply."
          checked={values.autoReply} onChange={(event) => set("autoReply", event.currentTarget.checked ?? false)} />
        <s-switch label="Email customers when their ticket is In progress or Resolved" details="Sent when your team changes the status. Replies are always emailed."
          checked={values.statusEmails} onChange={(event) => set("statusEmails", event.currentTarget.checked ?? false)} />
        <s-text-area label="Reply signature" rows={3} value={values.signature} maxLength={2000} placeholder={"Best regards,\nThe support team"}
          details="Added to the end of every reply emailed to a customer." error={save.data?.errors.signature} onInput={(event) => set("signature", event.currentTarget.value ?? "")} />
      </s-stack>
    </s-section>

    <s-section heading="Team">
      <s-text-field label="Team members" value={values.team} placeholder="e.g. Priya, Rahul, Support team"
        details="Separate names with commas. You can assign tickets to these people and reply as them." onInput={(event) => set("team", event.currentTarget.value ?? "")} />
    </s-section>

    <AiSettings ai={screen.ai} />

    <SavedReplies macros={screen.macros} />

    <s-section slot="aside" heading="Storefront setup">
      <s-stack gap="small-200">
        <s-paragraph>In your theme editor, add the <s-text type="strong">Help Desk form</s-text> block to a page, such as a Contact or Support page.</s-paragraph>
        <s-paragraph color="subdued">Customers get a ticket number and a private request page where they can see replies and answer you. Signed-in customers also see their past requests in the form.</s-paragraph>
        <s-link href="shopify://admin/themes/current/editor" target="_blank">Open theme editor</s-link>
      </s-stack>
    </s-section>
  </s-page>;
}

// ---------- Chatbot ----------

type ChatbotData = Extract<LoaderData, { screen: "chatbot" }>;
type FaqEntry = ChatbotData["faqs"][number];

function FaqEditor({ faq, prefill, onDone }: { faq?: FaqEntry; prefill?: string; onDone?: () => void }) {
  const fetcher = useFetcher<typeof action>();
  const [question, setQuestion] = useState(faq?.question ?? prefill ?? "");
  const [keywords, setKeywords] = useState(faq?.keywords ?? "");
  const [answer, setAnswer] = useState(faq?.answer ?? "");
  useEffect(() => { if (prefill !== undefined) setQuestion(prefill); }, [prefill]);
  useResultToast(fetcher, faq ? "Answer updated" : "Answer added");
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || Object.keys(fetcher.data.errors).length) return;
    if (!faq) { setQuestion(""); setKeywords(""); setAnswer(""); }
    onDone?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
  return <s-stack gap="base">
    <s-text-field label="Customer question" value={question} maxLength={200} placeholder="e.g. How long does shipping take?"
      error={fetcher.data?.errors.question} onInput={(event) => setQuestion(event.currentTarget.value ?? "")} />
    <s-text-field label="Other ways customers ask" value={keywords} maxLength={500} placeholder="e.g. delivery time, when will it arrive, shipping days"
      details="Comma-separated words and phrases. Exact phrases count the most." error={fetcher.data?.errors.keywords} onInput={(event) => setKeywords(event.currentTarget.value ?? "")} />
    <s-text-area label="Answer" rows={4} value={answer} maxLength={2000} error={fetcher.data?.errors.answer} onInput={(event) => setAnswer(event.currentTarget.value ?? "")} />
    <s-stack direction="inline" gap="small-200">
      <s-button variant="primary" loading={fetcher.state !== "idle"} disabled={!question.trim() || !answer.trim()}
        onClick={() => void fetcher.submit({ intent: "faq-save", id: faq?.id ?? "", question, keywords, answer }, { method: "post" })}>{faq ? "Save" : "Add answer"}</s-button>
      {onDone && <s-button variant="tertiary" onClick={onDone}>Cancel</s-button>}
    </s-stack>
  </s-stack>;
}

// Runs the storefront matcher in the browser so answers can be checked before customers see them.
function TryBot({ faqs }: { faqs: FaqEntry[] }) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const match = asked ? matchFaq(asked, faqs) : null;
  return <s-section heading="Try the chatbot">
    <s-stack gap="base">
      <form onSubmit={(event) => { event.preventDefault(); setAsked(question.trim()); }}>
        <s-stack direction="inline" gap="small-200" alignItems="end">
          <s-text-field label="Ask a question like a customer would" value={question} placeholder="e.g. can i send my order back?"
            onInput={(event) => setQuestion(event.currentTarget.value ?? "")} />
          <s-button type="submit" disabled={!question.trim()}>Ask</s-button>
        </s-stack>
      </form>
      {asked && <s-box padding="base" border="base" borderRadius="base" background="subdued">
        <s-stack gap="small-100">
          <s-text color="subdued">{match ? `Matched "${match.question}"` : "No confident match: the customer is offered your team instead"}</s-text>
          <div style={{ whiteSpace: "pre-wrap" }}>{match ? match.answer : NO_ANSWER}</div>
        </s-stack>
      </s-box>}
      <s-paragraph color="subdued">Order questions (like &quot;where is order #1001, name@example.com&quot;) are answered from your live Shopify orders on the storefront.</s-paragraph>
    </s-stack>
  </s-section>;
}

function ChatbotScreen({ screen }: { screen: ChatbotData }) {
  const { faqs, stats, unanswered } = screen;
  const save = useFetcher<typeof action>();
  const remove = useFetcher<typeof action>();
  const [chat, setChat] = useState(screen.chat);
  const [editing, setEditing] = useState("");
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => setChat(screen.chat), [screen.chat]);
  useResultToast(save, "Chat settings saved");
  useResultToast(remove, "Answer deleted");
  const dirty = chat.chatEnabled !== screen.chat.chatEnabled || chat.chatGreeting !== screen.chat.chatGreeting;
  return <s-page heading="Chatbot">
    <s-link slot="breadcrumb-actions" href="/app/help-desk">Help Desk</s-link>
    <s-button slot="primary-action" variant="primary" disabled={!dirty} loading={save.state !== "idle"}
      onClick={() => void save.submit({ intent: "chat-settings", chatEnabled: String(chat.chatEnabled), chatGreeting: chat.chatGreeting }, { method: "post" })}>Save</s-button>

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
        <Metric label="Questions asked" value={String(stats.asked)} detail="Last 30 days" />
        <Metric label="Answered automatically" value={stats.asked ? `${Math.round((stats.answered / stats.asked) * 100)}%` : "—"} detail={`${stats.answered} answered`} />
        <Metric label="Order status lookups" value={String(stats.orders)} detail="Answered from live orders" />
        <Metric label="Chats sent to your team" value={String(stats.chats)} detail="Became tickets" />
      </s-grid>
    </s-section>

    <s-section heading="Chat widget">
      <s-stack gap="base">
        <s-switch label="Show the chat widget on my store" checked={chat.chatEnabled} onChange={(event) => setChat((current) => ({ ...current, chatEnabled: event.currentTarget.checked ?? false }))} />
        <s-text-field label="Greeting" value={chat.chatGreeting} maxLength={300} placeholder="Hi! Ask me anything, like where your order is, or tap a question below."
          error={save.data?.errors.chatGreeting} onInput={(event) => setChat((current) => ({ ...current, chatGreeting: event.currentTarget.value ?? "" }))} />
        <s-paragraph color="subdued">The widget answers from the questions below and from live order data. When it can&apos;t help, the customer can talk to your team and the chat becomes a ticket here, transcript included.</s-paragraph>
      </s-stack>
    </s-section>

    {unanswered.length > 0 && <s-section heading="Questions the chatbot couldn't answer">
      <s-stack gap="small-200">
        <s-paragraph color="subdued">Add answers for these so the chatbot can handle them next time.</s-paragraph>
        {unanswered.map((item) => (
          <s-stack key={item.question} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack gap="none">
              <s-text>{item.question}</s-text>
              <s-text color="subdued">Asked {item.count} time{item.count === 1 ? "" : "s"} · last <span suppressHydrationWarning>{formatDate(item.last)}</span></s-text>
            </s-stack>
            <s-button icon="plus" onClick={() => { setPrefill(item.question); addRef.current?.scrollIntoView({ behavior: "smooth" }); }}>Add answer</s-button>
          </s-stack>
        ))}
      </s-stack>
    </s-section>}

    <s-section heading={`Answers (${faqs.length})`}>
      <s-stack gap="base">
        {faqs.length === 0 && <s-paragraph color="subdued">No answers yet. Add the questions customers ask most, such as shipping times and your return policy.</s-paragraph>}
        {faqs.map((faq) => editing === faq.id
          ? <s-box key={faq.id} border="base" borderRadius="base" padding="base"><FaqEditor faq={faq} onDone={() => setEditing("")} /></s-box>
          : <s-box key={faq.id} border="base" borderRadius="base" padding="base">
            <s-stack direction="inline" gap="base" alignItems="start" justifyContent="space-between">
              <s-stack gap="small-100">
                <s-text type="strong">{faq.question}</s-text>
                <s-text color="subdued">{faq.answer.replace(/\s+/g, " ").slice(0, 160)}{faq.answer.length > 160 ? "..." : ""}</s-text>
                {faq.keywords && <s-text color="subdued">Also matches: {faq.keywords}</s-text>}
              </s-stack>
              <s-stack direction="inline" gap="small-100">
                <s-button variant="tertiary" icon="edit" accessibilityLabel={`Edit ${faq.question}`} onClick={() => setEditing(faq.id)} />
                <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel={`Delete ${faq.question}`} disabled={remove.state !== "idle"}
                  onClick={() => void remove.submit({ intent: "faq-delete", id: faq.id }, { method: "post" })} />
              </s-stack>
            </s-stack>
          </s-box>)}
        <s-divider />
        <div ref={addRef}>
          <s-stack gap="base">
            <s-heading>Add an answer</s-heading>
            <FaqEditor prefill={prefill} />
          </s-stack>
        </div>
      </s-stack>
    </s-section>

    <TryBot faqs={faqs} />

    <s-section slot="aside" heading="Add the chat to your store">
      <s-stack gap="small-200">
        <s-paragraph>In your theme editor, open <s-text type="strong">App embeds</s-text> and turn on <s-text type="strong">Help Desk chat</s-text>.</s-paragraph>
        <s-link href="shopify://admin/themes/current/editor?context=apps" target="_blank">Open theme editor</s-link>
      </s-stack>
    </s-section>
  </s-page>;
}

export default function HelpDeskRoute() {
  const screen = useLoaderData<typeof loader>();
  if (screen.screen === "settings") return <SettingsScreen screen={screen} />;
  if (screen.screen === "chatbot") return <ChatbotScreen screen={screen} />;
  if (screen.screen === "ticket") return <TicketDetail key={screen.ticket.id} screen={screen} />;
  return <TicketList screen={screen} />;
}
