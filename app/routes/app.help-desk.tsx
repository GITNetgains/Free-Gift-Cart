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
import { addStaffMessage, deleteTickets, readHelpDeskForm, submitTicket, updateTickets } from "../services/help-desk.server";
import { emailConfigured, loadProducts, loadShop, sendTestEmail, trackingUrl, type TicketProduct } from "../services/help-desk-email.server";
import { ordersByEmail } from "../services/help-desk-orders.server";
import { DETECTOR_MODES, rescanMissingKeyScans, scanImage, serializeScan } from "../services/image-scan/scan.server";
import { PROVIDERS, verifyCredentials } from "../services/image-scan/detector.server";
import { FeatureCard, SetupChecklist, since, StatTile, type ChecklistItem } from "../components/HelpDeskUi";
import { ensureWorker, queueEmail, retryEmail } from "../services/help-desk-outbox.server";
import SectionNavigation from "../components/SectionNavigation";
export { shouldRevalidateSections as shouldRevalidate } from "../services/section-navigation";

function HelpDeskNavigation({ current }: { current: string }) {
  return <SectionNavigation label="Help Desk sections" current={current} items={[
    { id: "tickets", label: "Tickets", href: "/app/help-desk" },
    { id: "setup", label: "Setup & overview", href: "/app/help-desk?section=setup" },
    { id: "settings", label: "Settings", href: "/app/help-desk?settings=1" },
  ]} />;
}

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
  // Tickets with a photo the AI photo check flagged as AI-made or reused.
  flagged: { label: "Flagged photos", where: { attachments: { some: { scan: { is: { overallVerdict: { in: ["likely_ai", "duplicate"] } } } } } } },
  all: { label: "All tickets", where: {} },
} satisfies Record<string, { label: string; where: Prisma.HelpDeskTicketWhereInput }>;
type View = keyof typeof VIEWS;
const TOPICS = [...topics, CHAT_TOPIC];
// Staff status changes that email the customer (when turned on in settings).
const STATUS_EMAIL_STATUSES = ["In progress", "Resolved"];
const PERIODS = { "": "Any time", today: "Today", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" } as const;
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
  const period = (url.searchParams.get("period") || "") in PERIODS ? (url.searchParams.get("period") || "") as keyof typeof PERIODS : "";
  const since = period === "today" ? new Date(new Date().setHours(0, 0, 0, 0)) : period ? new Date(Date.now() - Number(period) * DAY) : null;
  const number = /^#?\d{1,9}$/.test(q) ? Number(q.replace("#", "")) : null;
  const where: Prisma.HelpDeskTicketWhereInput = {
    shop, ...VIEWS[view].where,
    ...(topic ? { topic } : {}),
    ...(priority ? { priority } : {}),
    ...(assignee ? { assignee } : {}),
    ...(since ? { createdAt: { gte: since } } : {}),
    // details holds every submitted field, so this also matches order numbers and messages.
    ...(q ? { OR: [{ id: q }, ...(number !== null ? [{ number }] : []), { name: { contains: q } }, { email: { contains: q } }, { details: { contains: q } }, { tags: { contains: q } }] } : {}),
  };
  const orderBy: Prisma.HelpDeskTicketOrderByWithRelationInput[] = sort === "newest" ? [{ createdAt: "desc" }, { id: "desc" }]
    : sort === "oldest" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ lastActivityAt: "desc" }, { createdAt: "desc" }];
  const now = Date.now();
  const [tickets, count, viewCounts, responded, resolvedWeek, newToday, scanGroups, totalTickets] = await Promise.all([
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
    db.helpDeskImageScan.groupBy({ by: ["overallVerdict"], where: { shop, status: "completed", createdAt: { gte: new Date(now - 30 * DAY) } }, _count: { _all: true } }),
    db.helpDeskTicket.count({ where: { shop } }),
  ]);
  const scans = Object.fromEntries(scanGroups.map((row) => [row.overallVerdict || "error", row._count._all])) as Record<string, number>;
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
    },
    filters: { view, topic, priority, assignee, sort, q, period },
    // What the overview cards and setup checklist show.
    overview: {
      apiKey: process.env.SHOPIFY_API_KEY || "",
      formLastSeenAt: settings.formLastSeenAt, signature: Boolean(settings.signature), totalTickets,
      aiEnabled: settings.aiDetectionEnabled,
      detectorConnected: settings.aiDetectionProvider === "truthscan" ? Boolean(settings.truthscanKey) : Boolean(settings.sightengineUser && settings.sightengineSecret),
      photos: {
        checked: Object.values(scans).reduce((sum, value) => sum + value, 0), likelyAi: scans.likely_ai ?? 0, reused: scans.duplicate ?? 0,
        uncertain: scans.uncertain ?? 0, genuine: scans.likely_real ?? 0,
      },
    },
  }, { headers });
};

export type ActionResult = { errors: Record<string, string>; ticketId?: string; emailed?: boolean; updated?: number; notice?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;
  let form: FormData;
  try { form = await readHelpDeskForm(request); }
  catch { return data<ActionResult>({ errors: { form: "Could not read the request. Use up to five images of 10 MB each." } }, { status: 400 }); }
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
        const mode = (DETECTOR_MODES as readonly string[]).includes(text("mode")) ? text("mode") : "always";
        // A store that never saved the general settings has no row yet.
        const current = await db.helpDeskSettings.findUnique({ where: { shop } })
          || { aiDetectionProvider: "", sightengineUser: "", sightengineSecret: "", truthscanKey: "" };
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
        await db.helpDeskSettings.upsert({ where: { shop }, update: next, create: { shop, ...next } });
        // Photos scanned before a key was added get the detector now.
        if (hasCredentials && next.aiDetectionEnabled) await rescanMissingKeyScans(db, shop);
        return data<ActionResult>({ errors: {}, notice });
      }
      case "delete": {
        const ids = form.getAll("ids").map(String).filter(Boolean);
        if (!ids.length) return fail("Choose tickets to delete.");
        const deleted = await deleteTickets(db, shop, ids);
        if (!deleted) return fail("These tickets no longer exist.");
        return data<ActionResult>({ errors: {}, updated: deleted });
      }
      case "email-retry":
        if (!emailConfigured()) return fail("Email sending is not set up on the server yet.");
        if (!await retryEmail(db, shop, text("id"), admin)) return fail("This email can't be retried.");
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
    params.delete("section");
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

// Live updates, like a chat app: polls a cheap fingerprint of the screen every
// few seconds (and as soon as the tab is back in view) and reloads the page data
// only when it changed, so new customer messages and photo checks appear
// without a refresh. Typed text is kept. `paused` holds off while the user is
// mid-action (e.g. tickets selected for a bulk change).
function useLiveRefresh({ ticketId = "", paused = false, intervalMs = 4_000 }: { ticketId?: string; paused?: boolean; intervalMs?: number } = {}) {
  const revalidator = useRevalidator();
  const pulse = useFetcher<{ stamp: string }>();
  const live = useRef({ revalidator, pulse, paused });
  live.current = { revalidator, pulse, paused };
  const lastStamp = useRef<string | null>(null);
  const url = `/app/help-desk-pulse${ticketId ? `?ticket=${encodeURIComponent(ticketId)}` : ""}`;

  useEffect(() => {
    lastStamp.current = null;
    const check = () => {
      const { pulse: current, paused: hold } = live.current;
      if (document.visibilityState === "visible" && current.state === "idle" && !hold) void current.load(url);
    };
    check();
    const timer = setInterval(check, intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [url, intervalMs]);

  useEffect(() => {
    const stamp = pulse.data?.stamp;
    if (!stamp || pulse.state !== "idle") return;
    // The first answer is the baseline for what's already on screen.
    if (lastStamp.current !== null && stamp !== lastStamp.current && live.current.revalidator.state === "idle") void live.current.revalidator.revalidate();
    lastStamp.current = stamp;
  }, [pulse.data, pulse.state]);
}

// Tells staff when the customer writes while the ticket is open.
function useNewMessageToast(messages: { id: string; kind: string }[]) {
  const shopify = useAppBridge();
  const seen = useRef(new Set(messages.map((message) => message.id)));
  useEffect(() => {
    const fresh = messages.filter((message) => !seen.current.has(message.id));
    fresh.forEach((message) => seen.current.add(message.id));
    if (fresh.some((message) => message.kind === "customer")) shopify.toast.show("New message from the customer");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);
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
  useLiveRefresh({ ticketId: ticket.id });
  useNewMessageToast(conversation);
  const navigate = useNavigate();
  const remover = useFetcher<typeof action>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (remover.state !== "idle" || !remover.data) return;
    if (Object.keys(remover.data.errors).length) shopify.toast.show(Object.values(remover.data.errors)[0], { isError: true });
    else { shopify.toast.show(`Ticket #${ticket.number} deleted`); navigate(listLink({ ticket: "" })); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remover.state, remover.data]);
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

    <s-section slot="aside" heading="Delete ticket">
      <s-stack gap="small-200">
        <s-paragraph color="subdued">Removes this ticket, its conversation, photos and emails for good.</s-paragraph>
        {confirmDelete
          ? <DeleteConfirm count={1} busy={remover.state !== "idle"} onCancel={() => setConfirmDelete(false)}
            onConfirm={() => { const form = new FormData(); form.set("intent", "delete"); form.append("ids", ticket.id); void remover.submit(form, { method: "post" }); }} />
          : <s-button tone="critical" icon="delete" onClick={() => setConfirmDelete(true)}>Delete ticket</s-button>}
      </s-stack>
    </s-section>

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

// Asks before tickets are deleted for good.
function DeleteConfirm({ count, busy, onCancel, onConfirm }: { count: number; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <s-box paddingBlockStart="base">
    <s-banner tone="critical" heading={`Delete ${count === 1 ? "this ticket" : `${count} tickets`} permanently?`}>
      <s-stack gap="base">
        <s-paragraph>The conversation, notes, photos and photo checks are deleted and can&apos;t be recovered. The customer&apos;s request page link stops working.</s-paragraph>
        <s-stack direction="inline" gap="small-200">
          <s-button tone="critical" variant="primary" loading={busy} onClick={onConfirm}>Delete permanently</s-button>
          <s-button variant="tertiary" disabled={busy} onClick={onCancel}>Cancel</s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  </s-box>;
}

function BulkBar({ ids, team, onDone }: { ids: string[]; team: string[]; onDone: () => void }) {
  const fetcher = useFetcher<typeof action>();
  const [confirming, setConfirming] = useState(false);
  const deleting = useRef(false);
  const remove = (targets: string[]) => {
    deleting.current = true;
    const form = new FormData();
    form.set("intent", "delete");
    targets.forEach((id) => form.append("ids", id));
    void fetcher.submit(form, { method: "post" });
  };
  useResultToast(fetcher, (result) => `${result.updated ?? ids.length} ticket${(result.updated ?? ids.length) === 1 ? "" : "s"} ${deleting.current ? "deleted" : "updated"}`);
  useEffect(() => { if (fetcher.state === "idle" && fetcher.data && !Object.keys(fetcher.data.errors).length) onDone(); }, [fetcher.state, fetcher.data, onDone]);
  const apply = (changes: Record<string, string>) => {
    deleting.current = false;
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
      <s-button tone="critical" icon="delete" disabled={busy} onClick={() => setConfirming(true)}>Delete</s-button>
      <s-button variant="tertiary" disabled={busy} onClick={onDone}>Clear selection</s-button>
    </s-stack>
    {confirming && <DeleteConfirm count={ids.length} busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); remove(ids); }} />}
  </s-box>;
}

// Store-side setup and the AI photo check, above the ticket inbox.
function HelpDeskOverview({ screen }: { screen: ListData }) {
  const { overview, views, metrics, team, configured } = screen;
  const navigate = useNavigate();
  const listLink = useListLink();
  const recently = (value: string | Date | null, days: number) => Boolean(value && Date.now() - new Date(value).getTime() < days * DAY);
  const formLive = recently(overview.formLastSeenAt, 30);
  // Theme editor deep link: add the form block to a page.
  const formLink = `shopify://admin/themes/current/editor?template=page&addAppBlockId=${overview.apiKey}/help_desk&target=newAppsSection`;
  const flagged = overview.photos.likelyAi + overview.photos.reused;

  const steps: ChecklistItem[] = [
    {
      id: "form", done: formLive, title: "Add the Help Desk form to your store",
      description: formLive ? `Live on your store · last opened ${since(overview.formLastSeenAt)}.` : "Create a page such as Contact or Support, then add the Help Desk form block to it in your theme.",
      action: formLive ? undefined : <s-stack direction="inline" gap="small-200">
        <s-button href="shopify://admin/pages/new" target="_blank">Create page</s-button>
        <s-button variant="primary" href={formLink} target="_blank">Add form block</s-button>
      </s-stack>,
    },
    {
      id: "team", done: team.length > 0 && overview.signature, title: "Add your team and reply signature",
      description: team.length ? `${team.length} team member${team.length === 1 ? "" : "s"}${overview.signature ? " and a signature" : ". Add a reply signature too"}.` : "Add the names of the people who reply, so you can assign tickets and reply as them.",
      action: team.length > 0 && overview.signature ? undefined : <s-button href="/app/help-desk?settings=1">Open settings</s-button>,
    },
    {
      id: "email", done: configured, title: "Turn on email sending",
      description: configured ? "Customers get confirmations and replies by email, and your team gets alerts." : "Needs your email (SMTP) details added on the app server. Until then tickets and request pages work, but no emails are sent.",
    },
    {
      id: "photos", done: overview.aiEnabled && overview.detectorConnected, title: "Connect your AI detector",
      description: !overview.aiEnabled ? "Switched off: customer photos aren't being checked."
        : overview.detectorConnected ? "On, with your AI detector connected."
        : "Only the free checks are running. Add your Sightengine or TruthScan API key so photos they can't settle get the AI detector's verdict.",
      action: overview.aiEnabled && overview.detectorConnected ? undefined : <s-button href="/app/help-desk?settings=1&part=photos">{overview.aiEnabled ? "Connect detector" : "Turn on"}</s-button>,
    },
  ];

  return <>
    {steps.some((step) => !step.done) && <SetupChecklist items={steps} />}

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
        <FeatureCard tone="green" icon="image" title="AI photo check" status={!overview.aiEnabled ? "Off" : overview.detectorConnected ? "On · detector connected" : "On · detector not connected"}
          statusTone={!overview.aiEnabled ? "neutral" : overview.detectorConnected ? "success" : "warning"}
          metrics={[{ label: "Checked (30 days)", value: String(overview.photos.checked) }, { label: "Flagged", value: String(flagged) }]}
          description="Every photo customers send is checked for AI generation, reuse from another request, and editing.">
          <s-button href="/app/photo-checks">Review photos</s-button>
          {flagged > 0 && <s-button variant="tertiary" onClick={() => navigate(listLink({ view: "flagged" }))}>Flagged tickets</s-button>}
        </FeatureCard>
      </s-grid>
    </s-section>

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        <StatTile tone="red" icon="notification" label="Needs attention" value={String(views.open)} detail={`${views.unassigned} unassigned`} />
        <StatTile tone="amber" icon="alert-triangle" label="High priority" value={String(views.urgent)} detail="Open high and urgent" />
        <StatTile tone="blue" icon="clock" label="Avg. first response" value={metrics.avgResponse === null ? "—" : duration(metrics.avgResponse)} detail="Last 30 days" />
        <StatTile tone="green" icon="check-circle" label="Resolved" value={String(metrics.resolvedWeek)} detail={`Last 7 days · ${metrics.newToday} new today`} />
      </s-grid>
    </s-section>
  </>;
}

function TicketList({ screen }: { screen: ListData }) {
  const { tickets, count, page, views, filters, team } = screen;
  const listLink = useListLink();
  const navigate = useNavigate();
  const [search, setSearch] = useState(filters.q);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => setSelected([]), [tickets]);
  const clearSelection = useRef(() => setSelected([])).current;
  const filtered = Boolean(filters.topic || filters.priority || filters.assignee || filters.q || filters.period);
  const allSelected = tickets.length > 0 && tickets.every((ticket) => selected.includes(ticket.id));
  const [pendingDelete, setPendingDelete] = useState<{ id: string; number: number } | null>(null);
  const rowRemover = useFetcher<typeof action>();
  const deletedNumber = useRef(0);
  if (pendingDelete) deletedNumber.current = pendingDelete.number;
  useResultToast(rowRemover, () => `Ticket #${deletedNumber.current} deleted`);
  useEffect(() => { if (rowRemover.state === "idle" && rowRemover.data && !Object.keys(rowRemover.data.errors).length) setPendingDelete(null); }, [rowRemover.state, rowRemover.data]);
  const toggle = (id: string, on: boolean) => setSelected((current) => on ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  useLiveRefresh({ paused: selected.length > 0 || Boolean(pendingDelete) });
  return <s-page heading="Help Desk tickets" inlineSize="large">
    <s-button slot="secondary-actions" icon="image" href="/app/photo-checks">Photo checks</s-button>
    <s-button slot="secondary-actions" icon="settings" href="/app/help-desk?settings=1">Settings</s-button>

    <HelpDeskNavigation current="tickets" />

    <s-section padding="base">
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-heading>Tickets</s-heading>
        <s-text color="subdued">{count} in this view</s-text>
      </s-stack>
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
            <s-select label="Created" labelAccessibilityVisibility="exclusive" value={filters.period} onChange={(event) => navigate(listLink({ period: event.currentTarget.value ?? "" }))}>
              {Object.entries(PERIODS).map(([value, label]) => <s-option key={value} value={value}>{label}</s-option>)}
            </s-select>
            <s-select label="Sort" labelAccessibilityVisibility="exclusive" value={filters.sort} onChange={(event) => navigate(listLink({ sort: event.currentTarget.value === "activity" ? "" : event.currentTarget.value ?? "" }))}>
              {Object.entries(SORTS).map(([value, label]) => <s-option key={value} value={value}>{label}</s-option>)}
            </s-select>
          </s-grid>
          {filtered && <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued">{count} matching ticket{count === 1 ? "" : "s"}</s-text>
            <s-button variant="tertiary" onClick={() => { setSearch(""); navigate(listLink({ q: "", topic: "", priority: "", assignee: "", period: "" })); }}>Clear filters</s-button>
          </s-stack>}
        </s-stack>
      </s-box>

      {tickets.length > 0 && <s-box paddingInline="base" paddingBlockEnd="small-200">
        <s-checkbox label={allSelected ? "Deselect all on this page" : "Select all on this page"} checked={allSelected}
          onChange={() => setSelected(allSelected ? [] : tickets.map((ticket) => ticket.id))} />
      </s-box>}
      {selected.length > 0 && <BulkBar ids={selected} team={team} onDone={clearSelection} />}
      {pendingDelete && <s-box paddingInline="base" paddingBlockEnd="base">
        <DeleteConfirm count={1} busy={rowRemover.state !== "idle"} onCancel={() => setPendingDelete(null)}
          onConfirm={() => { const form = new FormData(); form.set("intent", "delete"); form.append("ids", pendingDelete.id); void rowRemover.submit(form, { method: "post" }); }} />
      </s-box>}

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
            <s-table-header>Delete</s-table-header>
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
                <s-table-cell>
                  <div onClick={(event) => event.stopPropagation()} role="presentation">
                    <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel={`Delete ticket #${ticket.number}`}
                      onClick={() => setPendingDelete({ id: ticket.id, number: ticket.number })} />
                  </div>
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
  always: { label: "Every photo the free checks can't settle (recommended)", details: "Layers 1-4 (Content Credentials, watermarks, metadata, known-image match) run first and free; any photo they can't settle goes to your AI detector." },
  suspicious: { label: "Skip clear camera originals", details: "Saves checks: photos with intact, consistent camera data aren't sent. Everything else the free checks can't settle is." },
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
        details={DETECTOR_MODE_LABELS[values.mode]?.details} onChange={(event) => set("mode", event.currentTarget.value || "always")}>
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
  const [params] = useSearchParams();
  const requested = params.get("part") || "email";
  const part = ["email", "team", "replies", "photos", "storefront"].includes(requested) ? requested : "email";
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

    <HelpDeskNavigation current="settings" />
    <SectionNavigation label="Settings categories" current={part} items={[
      { id: "email", label: "Email notifications", href: "/app/help-desk?settings=1" },
      { id: "team", label: "Team", href: "/app/help-desk?settings=1&part=team" },
      { id: "replies", label: "Saved replies", href: "/app/help-desk?settings=1&part=replies" },
      { id: "photos", label: "Photo detection", href: "/app/help-desk?settings=1&part=photos" },
      { id: "storefront", label: "Storefront form", href: "/app/help-desk?settings=1&part=storefront" },
    ]} />
    {part === "email" && <>
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

    </>}
    {part === "team" && <s-section heading="Team">
      <s-text-field label="Team members" value={values.team} placeholder="e.g. Priya, Rahul, Support team"
        details="Separate names with commas. You can assign tickets to these people and reply as them." onInput={(event) => set("team", event.currentTarget.value ?? "")} />
    </s-section>}

    {part === "photos" && <AiSettings ai={screen.ai} />}

    {part === "replies" && <SavedReplies macros={screen.macros} />}

    {part === "storefront" && <s-section heading="Storefront setup">
      <s-stack gap="small-200">
        <s-paragraph>In your theme editor, add the <s-text type="strong">Help Desk form</s-text> block to a page, such as a Contact or Support page.</s-paragraph>
        <s-paragraph color="subdued">Customers get a ticket number and a private request page where they can see replies and answer you. Signed-in customers also see their past requests in the form.</s-paragraph>
        <s-link href="shopify://admin/themes/current/editor" target="_blank">Open theme editor</s-link>
      </s-stack>
    </s-section>}
  </s-page>;
}

export default function HelpDeskRoute() {
  const screen = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  if (screen.screen === "settings") return <SettingsScreen screen={screen} />;
  if (screen.screen === "ticket") return <TicketDetail key={screen.ticket.id} screen={screen} />;
  if (params.get("section") === "setup") return <s-page heading="Help Desk setup & overview" inlineSize="large">
    <HelpDeskNavigation current="setup" />
    <HelpDeskOverview screen={screen} />
  </s-page>;
  return <TicketList screen={screen} />;
}
