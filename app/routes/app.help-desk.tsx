import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRevalidator, useSearchParams, data } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  CHAT_TOPIC, countryName, defaultMacros, suggestTags, fieldLabels as LABELS, fillMacro, macroPlaceholders, MAX_MESSAGE_LENGTH, priorities, ticketStatuses, topics,
} from "../services/help-desk";
import { addStaffMessage, deleteTickets, readHelpDeskForm, submitTicket, updateTickets } from "../services/help-desk.server";
import { emailConfigured, loadProducts, loadShop, sendTestEmail, trackingUrl, type TicketProduct } from "../services/help-desk-email.server";
import { ordersByEmail } from "../services/help-desk-orders.server";
import { DETECTOR_MODES, rescanMissingKeyScans, scanImage, serializeScan } from "../services/image-scan/scan.server";
import { PROVIDERS, verifyCredentials } from "../services/image-scan/detector.server";
import { IconTile, SetupChecklist, since, StatTile, TONES, type ChecklistItem } from "../components/HelpDeskUi";
import { buildChecks, PHOTO_VERDICT, PhotoCheckButton, PhotoReportModal } from "../components/PhotoReport";
import { ensureWorker, queueEmail, retryEmail } from "../services/help-desk-outbox.server";
import { assignableTeam, listStaff, recordStaff } from "../services/help-desk-staff.server";
import { loadDashboard } from "../services/help-desk-dashboard.server";
import { DASHBOARD_RANGES, type DashboardRange } from "../services/help-desk-dashboard";
import { BarList, hoursLabel, KpiCard, TrendChart } from "../components/HelpDeskDashboard";
import SectionNavigation from "../components/SectionNavigation";
export { shouldRevalidateSections as shouldRevalidate } from "../services/section-navigation";

function HelpDeskNavigation({ current }: { current: string }) {
  return <SectionNavigation label="Help Desk sections" current={current} items={[
    { id: "tickets", label: "Inbox", href: "/app/help-desk" },
    { id: "setup", label: "Overview & setup", href: "/app/help-desk?section=setup" },
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
  // Whoever is using the app is recorded as staff, so tickets can be assigned to them.
  const me = await recordStaff(db, shop, session.onlineAccessInfo?.associated_user);
  const staff = await listStaff(db, shop);
  const team = assignableTeam(staff, teamList(settings.team));
  const base = { configured: emailConfigured(), team, me };
  const headers = { "Cache-Control": "private, no-store" };

  if (url.searchParams.get("settings")) {
    const [macros, store] = await Promise.all([
      db.helpDeskMacro.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
      loadShop(admin).catch(() => ({ name: "", email: "", url: "" })),
    ]);
    return data({
      screen: "settings" as const, ...base, macros: macros.map(({ id, title, body }) => ({ id, title, body })), storeEmail: store.email, staff,
      storefront: { apiKey: process.env.SHOPIFY_API_KEY || "", formLastSeenAt: settings.formLastSeenAt },
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
    const [products, receivedProducts, others, orders, macros, store, usedTags] = await Promise.all([
      loadProducts(admin, parseJson<string[]>(ticket.products, [])),
      loadProducts(admin, parseJson<string[]>(ticket.receivedProducts, [])),
      db.helpDeskTicket.findMany({
        where: { shop, email: ticket.email, id: { not: ticket.id } }, orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, number: true, topic: true, status: true, createdAt: true },
      }),
      ordersByEmail(admin, ticket.email),
      db.helpDeskMacro.findMany({ where: { shop }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, body: true } }),
      loadShop(admin).catch(() => ({ name: "", email: "", url: "" })),
      // Recent tags across the store, for suggestions on the Tags field.
      db.helpDeskTicket.findMany({ where: { shop, tags: { not: "" } }, orderBy: { updatedAt: "desc" }, take: 300, select: { tags: true } }),
    ]);
    const { accessToken, details, id, number, name, email, topic, status, priority, assignee, tags, customerId, channel, createdAt, firstResponseAt, resolvedAt, attachments, messages, emails } = ticket;
    const files = attachments.map(({ scan, ...file }) => ({ ...file, scan: serializeScan(scan) }));
    const rest = { id, number, name, email, topic, status, priority, assignee, tags, customerId, channel, createdAt, firstResponseAt, resolvedAt, attachments: files, messages, emails, readAt };
    return data({
      screen: "ticket" as const, ...base, macros, others, orders, storeName: store.name || shop,
      trackingUrl: store.url ? trackingUrl(store.url, accessToken) : "",
      ticket: { ...rest, details: parseJson<Record<string, string>>(details, {}), products, receivedProducts },
      tagSuggestions: suggestTags({ topic, tags, details: parseJson<Record<string, string>>(details, {}) }, usedTags.map((row) => row.tags)),
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
  // The overview page gets its charts; the inbox doesn't need them.
  const requestedRange = Number(url.searchParams.get("range"));
  const range: DashboardRange = (DASHBOARD_RANGES as readonly number[]).includes(requestedRange) ? requestedRange as DashboardRange : 30;
  const dashboard = url.searchParams.get("section") === "setup" ? await loadDashboard(db, shop, range) : null;
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
    dashboard,
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
        // Every reply shows on the customer's request page; "email" also emails it.
        const byEmail = text("kind") === "reply" && text("channel") !== "page" && emailConfigured();
        if (byEmail) queueEmail(db, { shop, ticketId: result.ticketId!, kind: "reply", messageId: result.messageId }, admin);
        const emailed = byEmail;
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
      case "staff-visibility": {
        const { count } = await db.helpDeskStaff.updateMany({ where: { id: text("id"), shop }, data: { hidden: text("hidden") === "true" } });
        if (!count) return fail("This staff member is no longer listed.");
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

function Attachment({ file, onOpen, onReport }: { file: TicketFile; onOpen: (image: { url: string; name: string; id: string }) => void; onReport: () => void }) {
  const fetcher = useFetcher<{ url?: string; name?: string; error?: string }>();
  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) void fetcher.load(`/app/help-desk-attachment?id=${encodeURIComponent(file.id)}`);
  }, [fetcher, file.id]);
  const url = fetcher.data?.url;
  return <div style={{ display: "grid", gap: 6, width: 112, alignContent: "start" }}>
    <s-clickable border="base" borderRadius="base" padding="none" accessibilityLabel={`Open ${file.name}`} disabled={!url} onClick={() => { if (url) onOpen({ url, name: file.name, id: file.id }); }}>
      <div style={{ width: 112, height: 112, display: "grid", placeItems: "center", overflow: "hidden" }}>
        {url ? <img src={url} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : fetcher.data?.error ? <s-text tone="critical">Unavailable</s-text> : <s-spinner size="base" />}
      </div>
    </s-clickable>
    <PhotoCheckButton scan={file.scan} onOpen={onReport} />
  </div>;
}

// A short summary under the opened photo; the popup has the full report.
function ScanSummary({ file, onReport }: { file: TicketFile; onReport: () => void }) {
  const listLink = useListLink();
  const scan = file.scan;
  const verdict = scan?.status === "completed" ? PHOTO_VERDICT[scan.overallVerdict || "error"] ?? PHOTO_VERDICT.error : null;
  const issues = scan?.status === "completed"
    ? buildChecks(scan, { ticket: (ticketId) => listLink({ ticket: ticketId }), settings: "/app/help-desk?settings=1&part=photos" })
      .flatMap((check) => check.findings).filter((finding) => finding.severity === "critical" || finding.severity === "warning")
      .sort((a, b) => (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1))
    : [];
  return <s-box border="base" borderRadius="base" padding="base" background="subdued">
    <s-stack gap="small-200">
      <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text type="strong">AI photo check</s-text>
          {verdict ? <s-badge tone={verdict.badge}>{verdict.label}</s-badge>
            : <s-badge tone={scan?.status === "pending" ? "info" : "neutral"}>{!scan ? "Not checked" : scan.status === "pending" ? "Checking photo" : "Scan incomplete"}</s-badge>}
          {verdict && typeof scan?.overallConfidence === "number" && scan.overallVerdict !== "error" && <s-text color="subdued">{Math.round(scan.overallConfidence * 100)}% confidence</s-text>}
          {verdict && <s-text color="subdued">· {issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"} found` : "No issues found"}</s-text>}
        </s-stack>
        <s-button icon="view" onClick={onReport}>View full report</s-button>
      </s-stack>
      {issues.slice(0, 3).map((issue, index) => (
        <s-stack key={index} direction="inline" gap="small-200" alignItems="center">
          <s-icon type={issue.severity === "critical" ? "alert-octagon" : "alert-triangle"} tone={issue.severity === "critical" ? "critical" : "warning"} size="small" />
          <s-text>{issue.title}</s-text>
        </s-stack>
      ))}
      {issues.length > 3 && <s-link onClick={onReport}>+ {issues.length - 3} more in the full report</s-link>}
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
  const listLink = useListLink();
  const [image, setImage] = useState<{ url: string; name: string; id: string } | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  if (!files.length) return null;
  const open = image && files.find((file) => file.id === image.id);
  const report = reportId ? files.find((file) => file.id === reportId) ?? null : null;
  return <s-stack gap="small-200">
    <s-text type="strong">Images ({files.length})</s-text>
    <s-stack direction="inline" gap="base">
      {files.map((file) => <Attachment key={file.id} file={file} onOpen={setImage} onReport={() => setReportId(file.id)} />)}
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
        {open && <ScanSummary file={open} onReport={() => setReportId(open.id)} />}
      </s-stack>
    </s-box>}
    <PhotoReportModal file={report} onClose={() => setReportId(null)} ticketLink={(ticketId) => listLink({ ticket: ticketId })} />
  </s-stack>;
}

function OriginalRequest({ ticket }: { ticket: TicketData["ticket"] }) {
  const values = ticket.details;
  const files = ticket.attachments.filter((file) => !file.messageId);
  if (ticket.channel === "chat") {
    return <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="center">
      <s-icon type="chat" tone="neutral" size="small" />
      <s-text color="subdued">{ticket.name} started a chat from the storefront · <span suppressHydrationWarning>{formatDate(ticket.createdAt)}</span>. Earlier messages with the assistant are shown below.</s-text>
    </s-stack>;
  }
  const rows = Object.keys(LABELS).filter((key) => key !== "phone" && values[key]);
  return <div style={{ maxWidth: "min(700px, 90%)", padding: 12, borderRadius: "4px 14px 14px 14px", background: "#fff", border: "1px solid #E4E7EC", boxShadow: "0 1px 2px rgba(16,24,40,.03)" }}>
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
  </div>;
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

const timeOnly = (value: string | Date) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
const dayLabel = (value: string | Date) => {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - DAY);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
};

// WhatsApp-style bubble: the customer and the assistant on the left (white),
// your team on the right (green), internal notes on the right (yellow).
// Time and delivery sit inside the bubble.
function Message({ message, files, email, isNew, grouped }: { message: TicketData["ticket"]["messages"][number]; files: TicketFile[]; email?: TicketEmail; isNew: boolean; grouped: boolean }) {
  if (message.kind === "event") {
    return <div style={{ display: "flex", justifyContent: "center", margin: "4px 0" }}>
      <span style={{ maxWidth: "85%", padding: "4px 10px", borderRadius: 8, background: "rgba(255,255,255,.08)", color: "#C9D1EA", fontSize: 12, textAlign: "center" }}>
        {message.body} · {message.author} · <span suppressHydrationWarning>{timeOnly(message.createdAt)}</span>
      </span>
    </div>;
  }
  const note = message.kind === "note";
  const customer = message.kind === "customer";
  const bot = message.kind === "bot";
  const mine = !customer && !bot;
  // Dark Zion theme: the customer in lighter navy, your team in Zion blue, notes in dark amber.
  const team = mine && !note;
  const background = note ? "#3A3117" : team ? "#334FB4" : "#1F2A4D";
  const delivery = note ? "🔒 Internal note" : !mine ? "" : email ? "" : message.emailed ? "✓✓ Emailed" : "✓ On request page";
  return <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginTop: grouped ? 2 : 10 }}>
    <div style={{
      position: "relative", maxWidth: "min(620px, 78%)", minWidth: 120, padding: "8px 12px 6px", background, color: note ? "#FFE8A8" : "#F2F4FA",
      borderRadius: grouped ? 14 : mine ? "14px 4px 14px 14px" : "4px 14px 14px 14px", boxShadow: "0 2px 8px rgba(0,0,0,.25)",
      border: bot ? "1px dashed rgba(255,255,255,.28)" : note ? "1px solid #6B5A22" : team ? "1px solid #4A66CC" : "1px solid rgba(255,255,255,.08)",
    }}>
      {!grouped && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 2, fontSize: 12.5, fontWeight: 650, color: note ? "#F5C451" : team ? "#DCE3FF" : bot ? "#A9B3D3" : "#FF9C8C" }}>
        {message.author}
        {isNew && <span style={{ padding: "0 6px", borderRadius: 6, background: "#E6EFFC", color: "#003A80", fontSize: 11 }}>New</span>}
        {bot && <span style={{ fontWeight: 500, color: "#A9B3D3" }}>· Automated answer</span>}
      </div>}
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 14, lineHeight: 1.45 }}>{message.body}</div>
      {files.length > 0 && <div style={{ marginTop: 8, padding: 8, borderRadius: 10, background: "#FFFFFF", color: "#1A1F36" }}><Gallery files={files} /></div>}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginTop: 3, fontSize: 11, color: note ? "rgba(255,232,168,.7)" : "rgba(242,244,250,.62)" }}>
        {delivery && <span>{delivery}</span>}
        <span suppressHydrationWarning>{timeOnly(message.createdAt)}</span>
      </div>
      {email && mine && !note && <div style={{ marginTop: 4, display: "flex", justifyContent: "flex-end" }}><EmailStatus email={email} /></div>}
    </div>
  </div>;
}

// The conversation as a chat window: fixed height, opens at the newest
// message and stays there as new ones arrive, unless you've scrolled up to
// read, then a button offers to jump down.
function ChatThread({ ticket, replyEmails, readAt }: { ticket: TicketData["ticket"]; replyEmails: Map<string, TicketEmail>; readAt: number }) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Photos load after the first paint and push the thread down; stay on the newest message while pinned.
  useEffect(() => {
    const node = box.current;
    const inner = content.current;
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (pinned.current) node.scrollTop = node.scrollHeight; });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const [unseen, setUnseen] = useState(0);
  const count = ticket.messages.length;
  const seenCount = useRef(count);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    if (pinned.current) { node.scrollTop = node.scrollHeight; setUnseen(0); }
    else if (count > seenCount.current) setUnseen((value) => value + count - seenCount.current);
    seenCount.current = count;
  }, [count]);
  const toBottom = () => { const node = box.current; if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" }); setUnseen(0); };
  let lastDay = "";
  let lastAuthor = "";
  return <div style={{ position: "relative" }}>
    <div ref={box} onScroll={(event) => {
      const node = event.currentTarget;
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      if (pinned.current && unseen) setUnseen(0);
    }} style={{
      maxHeight: "min(56vh, 560px)", overflowY: "auto", scrollbarWidth: "thin", scrollbarColor: "#3E4C7A transparent", padding: "14px 16px 18px",
      // Dark Zion navy, like the dark sections of zioncases.com, with a faint dot pattern.
      backgroundColor: "#0F1730", backgroundImage: "radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px)", backgroundSize: "16px 16px",
    }}>
      <div ref={content}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
        <span suppressHydrationWarning style={{ padding: "4px 12px", borderRadius: 8, background: "rgba(255,255,255,.1)", color: "#E8EBF5", fontSize: 12, fontWeight: 600 }}>{dayLabel(ticket.createdAt)}</span>
      </div>
      <OriginalRequest ticket={ticket} />
      {ticket.messages.map((message) => {
        const day = new Date(message.createdAt).toDateString();
        const newDay = day !== lastDay && day !== new Date(ticket.createdAt).toDateString();
        const author = `${message.kind}:${message.author}`;
        const grouped = !newDay && author === lastAuthor && message.kind !== "event";
        lastDay = day;
        lastAuthor = message.kind === "event" ? "" : author;
        return <div key={message.id}>
          {newDay && <div style={{ display: "flex", justifyContent: "center", margin: "12px 0 4px" }}>
            <span suppressHydrationWarning style={{ padding: "4px 12px", borderRadius: 8, background: "rgba(255,255,255,.1)", color: "#E8EBF5", fontSize: 12, fontWeight: 600 }}>{dayLabel(message.createdAt)}</span>
          </div>}
          <Message message={message} email={replyEmails.get(message.id)} grouped={grouped}
            files={ticket.attachments.filter((file) => file.messageId === message.id)}
            isNew={Boolean(readAt) && message.kind === "customer" && new Date(message.createdAt).getTime() > readAt} />
        </div>;
      })}
      </div>
    </div>
    {unseen > 0 && <button type="button" onClick={toBottom} style={{
      position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", padding: "7px 14px", border: 0, borderRadius: 999, cursor: "pointer",
      background: "#EF3A24", color: "#fff", font: "inherit", fontSize: 13, fontWeight: 600, boxShadow: "0 4px 14px rgba(0,0,0,.35)",
    }}>{unseen} new message{unseen === 1 ? "" : "s"} ↓</button>}
  </div>;
}

// Where a reply goes. The request page always gets it (that's the chat the
// customer sees in the store); email also sends it to their inbox. Only
// channels that are set up are offered; WhatsApp and SMS join this list once
// a messaging account is connected.
const CHANNELS = [
  { id: "page", label: "Request page", icon: "chat" },
  { id: "email", label: "Email", icon: "email" },
] as const;

function ChannelPicker({ value, onChange, email }: { value: "page" | "email"; onChange: (value: "page" | "email") => void; email: string }) {
  const hint = value === "email" ? `Shown on their request page and emailed to ${email}.`
    : "Shown on the customer's private request page in your store. Choose Email to also send it to their inbox.";
  return <div style={{ display: "grid", gap: 6 }}>
    <span style={{ fontSize: 13, color: "#A9B3D3" }}>Send via</span>
    <div role="radiogroup" aria-label="Send via" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {CHANNELS.map((channel) => {
        const active = value === channel.id;
        return <button key={channel.id} type="button" role="radio" aria-checked={active} onClick={() => onChange(channel.id)} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 10, font: "inherit", fontSize: 13, cursor: "pointer",
          fontWeight: active ? 650 : 500, color: active ? "#fff" : "#C9D1EA", background: active ? "#334FB4" : "rgba(255,255,255,.06)", border: `1px solid ${active ? "#334FB4" : "rgba(255,255,255,.16)"}`,
        }}>
          <s-icon type={channel.icon} size="small" />
          {channel.label}
        </button>;
      })}
    </div>
    <span style={{ fontSize: 13, color: "#A9B3D3" }}>{hint}</span>
  </div>;
}

function Composer({ ticket, macros, storeName, team, configured, me }: { ticket: TicketData["ticket"]; macros: TicketData["macros"]; storeName: string; team: string[]; configured: boolean; me: string }) {
  const fetcher = useFetcher<typeof action>();
  const [kind, setKind] = useState<"reply" | "note">("reply");
  const [body, setBody] = useState("");
  const [macro, setMacro] = useState("");
  const [channel, setChannel] = useState<"page" | "email">("page");
  const authors = [...new Set([...(me ? [me] : []), ...team, `${storeName} Support`])];
  // Replies go out as the staff member signed in to Shopify; a choice made on this device is remembered when they aren't known.
  const [author, setAuthor] = useState(() => me || (ticket.assignee && authors.includes(ticket.assignee) ? ticket.assignee : authors[0]));
  useEffect(() => {
    if (me) return;
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
    void fetcher.submit({ intent: "message", id: ticket.id, kind, body, author, status, channel }, { method: "post" });
  };
  const note = kind === "note";
  const pill = (value: "reply" | "note", label: string) => <button type="button" role="tab" aria-selected={kind === value} onClick={() => setKind(value)} style={{
    padding: "9px 18px", borderRadius: 10, font: "inherit", fontSize: 14, cursor: "pointer", fontWeight: kind === value ? 650 : 500,
    color: kind === value ? "#fff" : "#C9D1EA", background: kind === value ? (value === "note" ? "#B7791F" : "#334FB4") : "rgba(255,255,255,.06)",
    border: `1px solid ${kind === value ? "transparent" : "rgba(255,255,255,.16)"}`,
  }}>{label}</button>;
  // Zion red, like the buttons on zioncases.com, so it stands out on the dark bar.
  const sendButton = (label: string, onClick: () => void, primary = true) => <button type="button" disabled={!body.trim() || sending} onClick={onClick} style={{
    padding: "9px 18px", borderRadius: 6, font: "inherit", fontSize: 14, fontWeight: 650, cursor: !body.trim() || sending ? "not-allowed" : "pointer",
    opacity: !body.trim() || sending ? 0.5 : 1, color: "#fff", background: primary ? (note ? "#B7791F" : "#EF3A24") : "transparent",
    border: primary ? "1px solid transparent" : "1px solid rgba(255,255,255,.3)", boxShadow: primary ? "0 4px 10px rgba(0,0,0,.25)" : "none",
  }}>{label}</button>;
  // The reply box is the bottom bar of the chat window, like a messaging app.
  return <div style={{ display: "grid", gap: 10, padding: "14px 16px 16px", background: note ? "#2A2412" : "#141E3D", borderTop: "1px solid rgba(255,255,255,.08)", color: "#C9D1EA" }}>
    {ticket.status === "Resolved" && <span style={{ fontSize: 13, color: "#8FE3B0" }}>✓ This ticket is resolved. If the customer replies, it reopens automatically.</span>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <div role="tablist" aria-label="Message type" style={{ display: "flex", gap: 4 }}>
        {pill("reply", `Reply to ${ticket.name.split(" ")[0] || "customer"}`)}
        {pill("note", "Internal note")}
      </div>
      <div style={{ flex: "1 1 180px", minWidth: 160 }}>
        <s-select label="Insert a saved reply" labelAccessibilityVisibility="exclusive" value={macro} disabled={!macros.length} onChange={(event) => {
          const chosen = macros.find((item) => item.id === event.currentTarget.value);
          // Choosing a saved reply swaps in its text, replacing the previous one.
          setMacro(chosen?.id ?? "");
          if (chosen) setBody(fillMacro(chosen.body, ticket, storeName));
        }}>
          <s-option value="">{macros.length ? "Insert a saved reply" : "No saved replies yet"}</s-option>
          {macros.map((item) => <s-option key={item.id} value={item.id}>{item.title}</s-option>)}
        </s-select>
      </div>
      <div style={{ flex: "1 1 170px", minWidth: 150 }}>
        <s-select label={note ? "Note by" : "Reply as"} labelAccessibilityVisibility="exclusive" value={author} onChange={(event) => setAuthor(event.currentTarget.value || authors[0])}>
          {authors.map((name) => <s-option key={name} value={name}>{note ? "Note by" : "Reply as"} {name}</s-option>)}
        </s-select>
      </div>
    </div>
    {!note && configured && <ChannelPicker value={channel} onChange={setChannel} email={ticket.email} />}
    <div role="presentation" onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && body.trim() && !sending) { event.preventDefault(); send(); } }}>
    <s-text-area label={note ? "Note" : "Message"} labelAccessibilityVisibility="exclusive" rows={6} value={body} maxLength={MAX_MESSAGE_LENGTH}
      placeholder={note ? "Write a note only your team can see..." : `Write a message to ${ticket.name}...`}
      error={fetcher.data?.errors.body} onInput={(event) => setBody(event.currentTarget.value ?? "")} />
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 13, color: "#A9B3D3" }}>{note ? "🔒 Only your team sees notes" : "The customer sees this in their chat on the request page"} · Ctrl + Enter to send</span>
      <div style={{ display: "flex", gap: 8 }}>
        {note ? sendButton(sending ? "Adding..." : "Add note", () => send()) : <>
          {sendButton("Send and resolve", () => send("Resolved"), false)}
          {sendButton(sending ? "Sending..." : channel === "email" ? "Send by email" : "Send", () => send())}
        </>}
      </div>
    </div>
  </div>;
}

function TicketProperties({ ticket, team, suggestions }: { ticket: TicketData["ticket"]; team: string[]; suggestions: TicketData["tagSuggestions"] }) {
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
      {(suggestions.fromRequest.length > 0 || suggestions.popular.length > 0) && <s-stack gap="small-100">
        {[["From this request", suggestions.fromRequest], ["Your team uses", suggestions.popular]].filter(([, list]) => list.length).map(([label, list]) => (
          <s-stack key={label as string} gap="small-100">
            <s-text color="subdued">{label as string}</s-text>
            <s-stack direction="inline" gap="small-100">
              {(list as string[]).filter((tag) => !tags.split(",").map((value) => value.trim().toLowerCase()).includes(tag)).map((tag) => (
                <s-clickable-chip key={tag} disabled={busy} accessibilityLabel={`Add tag ${tag}`} onClick={() => {
                  const next = [...tags.split(",").map((value) => value.trim()).filter(Boolean), tag].join(", ");
                  setTags(next);
                  update({ tags: next });
                }}>+ {tag}</s-clickable-chip>
              ))}
            </s-stack>
          </s-stack>
        ))}
      </s-stack>}
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

// Live updates, like a chat app: asks the server for a cheap fingerprint of
// the screen every few seconds (faster on an open ticket, and at once when the
// tab comes back into view) and reloads the page data only when it changed, so
// new customer messages and photo checks appear without a refresh. A change
// seen while a reload is still running is retried on the next tick, never
// dropped, and a failed check (a deploy, a dropped connection) is ignored.
// Typed text is kept. `paused` holds off while the user is mid-action.
function useLiveRefresh({ ticketId = "", paused = false, intervalMs = ticketId ? 2_500 : 4_000 }: { ticketId?: string; paused?: boolean; intervalMs?: number } = {}) {
  const revalidator = useRevalidator();
  const live = useRef({ revalidator, paused });
  live.current = { revalidator, paused };

  useEffect(() => {
    // App Bridge adds the session token to fetches to the app's own server.
    const url = `/app/help-desk-pulse${ticketId ? `?ticket=${encodeURIComponent(ticketId)}` : ""}`;
    let last: string | null = null;
    let checking = false;
    let stopped = false;
    const check = async () => {
      if (checking || stopped || live.current.paused || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) return;
        const { stamp } = await response.json() as { stamp?: string };
        if (!stamp || stopped) return;
        if (last !== null && stamp !== last) {
          // Still loading the previous change: leave `last` alone so the next tick picks this one up.
          if (live.current.revalidator.state !== "idle") return;
          await live.current.revalidator.revalidate();
        }
        last = stamp;
      } catch {
        // Offline, restarting or signed out: try again on the next tick.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [ticketId, intervalMs]);
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
        <s-stack direction="inline" alignItems="center" justifyContent="space-between">
          <s-heading>Conversation</s-heading>
          <s-text color="subdued">{conversation.filter((message) => message.kind !== "event").length + (ticket.channel === "chat" ? 0 : 1)} messages</s-text>
        </s-stack>
        <div style={{ border: "1px solid #E3E3E3", borderRadius: 12, overflow: "hidden" }}>
          <ChatThread ticket={ticket} replyEmails={replyEmails} readAt={readAt} />
              </div>
      </s-stack>
    </s-section>

    <Composer key={ticket.id} ticket={ticket} macros={screen.macros} storeName={screen.storeName} team={screen.team} configured={screen.configured} me={screen.me} />

    <TicketProperties ticket={ticket} team={screen.team} suggestions={screen.tagSuggestions} />

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

    <s-section slot="aside" heading="Delete ticket">
      <s-stack gap="small-200">
        <s-paragraph color="subdued">Removes this ticket, its conversation, photos and emails for good.</s-paragraph>
        {confirmDelete
          ? <DeleteConfirm count={1} busy={remover.state !== "idle"} onCancel={() => setConfirmDelete(false)}
            onConfirm={() => { const form = new FormData(); form.set("intent", "delete"); form.append("ids", ticket.id); void remover.submit(form, { method: "post" }); }} />
          : <s-button tone="critical" icon="delete" onClick={() => setConfirmDelete(true)}>Delete ticket</s-button>}
      </s-stack>
    </s-section>
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

// The four things a store needs set up, shared by the inbox nudge and the setup page.
function setupSteps(screen: ListData): ChecklistItem[] {
  const { overview, team, configured } = screen;
  const formLive = Boolean(overview.formLastSeenAt && Date.now() - new Date(overview.formLastSeenAt).getTime() < 30 * DAY);
  // Theme editor deep link: add the form block to a page.
  const formLink = `shopify://admin/themes/current/editor?template=page&addAppBlockId=${overview.apiKey}/help_desk&target=newAppsSection`;
  return [
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
      action: team.length > 0 && overview.signature ? undefined : <s-button href="/app/help-desk?settings=1&part=team">Add team</s-button>,
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
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <div style={{ display: "grid", gap: 12, alignContent: "start", height: "100%", padding: 16, background: "#fff", border: "1px solid #E3E3E3", borderRadius: 12, boxShadow: "0 1px 0 rgba(26,26,26,.05)" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <s-heading>{title}</s-heading>
      {action}
    </div>
    {children}
  </div>;
}

// The Help Desk dashboard, like Shopify's analytics: the period's numbers
// against the one before, trends per day, and what needs someone now.
function HelpDeskOverview({ screen }: { screen: ListData }) {
  const navigate = useNavigate();
  const listLink = useListLink();
  const steps = setupSteps(screen);
  const dashboard = screen.dashboard;
  if (!dashboard) return null;
  const { created, resolved, response, open, photos } = dashboard;
  const go = (changes: Record<string, string>) => navigate(listLink({ section: "", ...changes }));
  const flagged = photos.likelyAi + photos.reused;
  return <>
    <s-section padding="base">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
        <s-stack gap="none">
          <s-heading>How your Help Desk is doing</s-heading>
          <s-text color="subdued">Compared with the {dashboard.range} days before</s-text>
        </s-stack>
        <div style={{ minWidth: 180 }}>
          <s-select label="Date range" labelAccessibilityVisibility="exclusive" value={String(dashboard.range)}
            onChange={(event) => navigate(listLink({ section: "setup", range: event.currentTarget.value === "30" ? "" : event.currentTarget.value ?? "" }))}>
            {DASHBOARD_RANGES.map((value) => <s-option key={value} value={String(value)}>Last {value} days</s-option>)}
          </s-select>
        </div>
      </div>
    </s-section>

    {steps.some((step) => !step.done) && <SetupChecklist items={steps} />}

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        <KpiCard label="New tickets" value={String(created.total)} current={created.total} previous={created.previous} series={created.series} color="#334FB4" />
        <KpiCard label="Resolved" value={String(resolved.total)} current={resolved.total} previous={resolved.previous} series={resolved.series} color="#EB6834" />
        <KpiCard label="Avg. first reply" value={hoursLabel(response.hours)} current={response.hours} previous={response.previous} lowerIsBetter series={response.series} color="#334FB4"
          detail={response.hours === null ? "No replies in this period" : undefined} />
        <KpiCard label="Open right now" value={String(open.total)} current={null} previous={null}
          detail={`${open.unassigned} unassigned · ${open.waiting} waiting on customer`} onClick={() => go({ view: "" })} />
      </s-grid>
    </s-section>

    <s-section padding="base">
      <Card title="Tickets over time">
        <TrendChart dashboard={dashboard} />
      </Card>
    </s-section>

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" gap="base">
        <Card title="Waiting longest for a reply" action={open.noReply.length > 0 ? <s-link onClick={() => go({ view: "" })}>View all</s-link> : undefined}>
          {open.noReply.length === 0 ? <s-stack direction="inline" gap="small-200" alignItems="center"><s-icon type="check-circle" tone="success" /><s-text>Every open request has a reply. Nice work!</s-text></s-stack>
            : <div style={{ display: "grid" }}>
              {open.noReply.map((ticket, index) => <s-clickable key={ticket.id} onClick={() => go({ ticket: ticket.id })} accessibilityLabel={`Open ticket ${ticket.number}`}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "9px 0", borderTop: index ? "1px solid #F1F1F1" : "none" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#303030" }}>#{ticket.number} {ticket.topic}</div>
                    <div style={{ fontSize: 12.5, color: "#616161" }}>{ticket.name}</div>
                  </div>
                  <span style={{ flex: "none", fontSize: 12.5, fontWeight: 600, color: "#B3261E" }} suppressHydrationWarning>{duration(Date.now() - new Date(ticket.createdAt).getTime())}</span>
                </div>
              </s-clickable>)}
            </div>}
        </Card>
        <Card title="Tickets by topic">
          <BarList items={dashboard.topics} empty="No new tickets in this period." onSelect={(topic) => go({ topic, view: "all" })} />
        </Card>
        <Card title="Open tickets by person">
          <BarList items={dashboard.workload} empty="Nothing open right now." color="#6B7FD7"
            onSelect={(name) => go(name === "Unassigned" ? { view: "unassigned" } : { assignee: name })} />
        </Card>
        <Card title="AI photo check" action={<s-link href="/app/photo-checks">Review photos</s-link>}>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 700, color: "#303030" }}>{photos.checked}</span>
              <s-text color="subdued">photos checked</s-text>
            </div>
            {[
              { label: "Likely AI-generated", value: photos.likelyAi, tone: "critical" as const },
              { label: "Reused photo", value: photos.reused, tone: "warning" as const },
              { label: "Can't confirm", value: photos.uncertain, tone: "caution" as const },
              { label: "Likely genuine", value: photos.genuine, tone: "success" as const },
            ].map((row) => <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <s-badge tone={row.tone}>{row.label}</s-badge><b style={{ fontSize: 13 }}>{row.value}</b>
            </div>)}
            {flagged > 0 && <s-link onClick={() => go({ view: "flagged" })}>See {flagged} flagged ticket{flagged === 1 ? "" : "s"}</s-link>}
          </div>
        </Card>
      </s-grid>
    </s-section>
  </>;
}

// Views as tabs with a count each; the first four are what a team works in daily.
const VIEW_ORDER: View[] = ["open", "waiting", "resolved", "all", "unassigned", "urgent", "flagged"];

function ViewTabs({ current, counts, onSelect }: { current: View; counts: Record<View, number>; onSelect: (view: View) => void }) {
  return <div role="tablist" aria-label="Ticket views" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
    {VIEW_ORDER.map((key, index) => {
      const active = current === key;
      const alert = (key === "open" || key === "flagged") && counts[key] > 0;
      return <span key={key} style={{ display: "contents" }}>
        {index === 4 && <span aria-hidden="true" style={{ width: 1, alignSelf: "stretch", margin: "4px 4px", background: "#E3E3E3" }} />}
        <button type="button" role="tab" aria-selected={active} onClick={() => onSelect(key)} style={{
          display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 10, cursor: "pointer", font: "inherit", fontSize: 13,
          fontWeight: active ? 650 : 500, color: active ? "#fff" : "#303030", background: active ? "#172351" : "#fff",
          border: `1px solid ${active ? "#172351" : "#E3E3E3"}`,
        }}>
          {VIEWS[key].label}
          <span style={{
            minWidth: 20, padding: "1px 7px", borderRadius: 20, fontSize: 12, fontWeight: 700, textAlign: "center",
            background: active ? "#ffffff2e" : alert ? TONES[key === "flagged" ? "amber" : "red"].soft : "#F1F2F4",
            color: active ? "#fff" : alert ? TONES[key === "flagged" ? "amber" : "red"].ink : "#4A4F5C",
          }}>{counts[key]}</span>
        </button>
      </span>;
    })}
  </div>;
}

function TicketList({ screen }: { screen: ListData }) {
  const { tickets, count, page, views, filters, team, metrics } = screen;
  const listLink = useListLink();
  const navigate = useNavigate();
  const [search, setSearch] = useState(filters.q);
  const [selected, setSelected] = useState<string[]>([]);
  const activeFilters = [
    filters.topic && { key: "topic", label: filters.topic },
    filters.priority && { key: "priority", label: `${filters.priority} priority` },
    filters.assignee && { key: "assignee", label: `Assigned to ${filters.assignee}` },
    filters.period && { key: "period", label: `Created: ${PERIODS[filters.period as keyof typeof PERIODS] ?? filters.period}` },
  ].filter(Boolean) as { key: string; label: string }[];
  const [showFilters, setShowFilters] = useState(activeFilters.length > 0);
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => setSelected([]), [tickets]);
  const clearSelection = useRef(() => setSelected([])).current;
  const filtered = Boolean(activeFilters.length || filters.q);
  const allSelected = tickets.length > 0 && tickets.every((ticket) => selected.includes(ticket.id));
  const toggle = (id: string, on: boolean) => setSelected((current) => on ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  useLiveRefresh({ paused: selected.length > 0 });
  const steps = setupSteps(screen);
  const remaining = steps.filter((step) => !step.done);
  const view = filters.view as View;
  const tiles: { view: View; tone: "red" | "amber" | "blue" | "green"; icon: "notification" | "alert-triangle" | "clock" | "image"; label: string; detail: string }[] = [
    { view: "open", tone: "red", icon: "notification", label: "Needs attention", detail: `${views.unassigned} unassigned` },
    { view: "waiting", tone: "blue", icon: "clock", label: "Waiting on customer", detail: metrics.avgResponse === null ? "Your reply was sent" : `Avg. first reply ${duration(metrics.avgResponse)}` },
    { view: "urgent", tone: "amber", icon: "alert-triangle", label: "High priority", detail: "High and urgent, not resolved" },
    { view: "flagged", tone: "amber", icon: "image", label: "Flagged photos", detail: "AI-made or reused photos" },
  ];
  return <s-page heading="Help Desk" inlineSize="large">
    <s-button slot="secondary-actions" icon="image" href="/app/photo-checks">Photo checks</s-button>

    <HelpDeskNavigation current="tickets" />

    {remaining.length > 0 && <s-banner tone="info" heading={`Finish setting up: ${steps.length - remaining.length} of ${steps.length} done`}>
      <s-stack gap="small-200">
        <s-text>Still to do: {remaining.map((step) => step.title.toLowerCase()).join(" · ")}.</s-text>
        <s-stack direction="inline"><s-button href="/app/help-desk?section=setup">Continue setup</s-button></s-stack>
      </s-stack>
    </s-banner>}

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        {tiles.map((tile) => <s-clickable key={tile.view} borderRadius="base" accessibilityLabel={`Show ${tile.label.toLowerCase()}`} onClick={() => navigate(listLink({ view: tile.view === "open" ? "" : tile.view }))}>
          <div style={{ borderRadius: 14, boxShadow: view === tile.view ? `0 0 0 2px ${TONES[tile.tone].accent}` : "none" }}>
            <StatTile tone={tile.tone} icon={tile.icon} label={tile.label} value={String(views[tile.view])} detail={tile.detail} />
          </div>
        </s-clickable>)}
      </s-grid>
    </s-section>

    <s-section padding="none">
      <s-box padding="base">
        <s-stack gap="base">
          <ViewTabs current={view} counts={views} onSelect={(key) => navigate(listLink({ view: key === "open" ? "" : key }))} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <form style={{ flex: "1 1 280px" }} onSubmit={(event) => { event.preventDefault(); navigate(listLink({ q: search.trim() })); }}>
              <s-search-field label="Search tickets" labelAccessibilityVisibility="exclusive" placeholder="Search by #number, name, email, order or tag"
                value={search} onInput={(event) => setSearch(event.currentTarget.value ?? "")} />
            </form>
            <s-button icon="filter" variant={showFilters ? "secondary" : "tertiary"} onClick={() => setShowFilters(!showFilters)}>
              {activeFilters.length ? `Filters (${activeFilters.length})` : "Filters"}
            </s-button>
            <div style={{ minWidth: 170 }}>
              <s-select label="Sort" labelAccessibilityVisibility="exclusive" value={filters.sort} onChange={(event) => navigate(listLink({ sort: event.currentTarget.value === "activity" ? "" : event.currentTarget.value ?? "" }))}>
                {Object.entries(SORTS).map(([value, label]) => <s-option key={value} value={value}>Sort: {label}</s-option>)}
              </s-select>
            </div>
          </div>
          {showFilters && <s-box padding="base" background="subdued" borderRadius="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
              <s-select label="Topic" value={filters.topic} onChange={(event) => navigate(listLink({ topic: event.currentTarget.value ?? "" }))}>
                <s-option value="">All topics</s-option>
                {TOPICS.map((topic) => <s-option key={topic} value={topic}>{topic}</s-option>)}
              </s-select>
              <s-select label="Priority" value={filters.priority} onChange={(event) => navigate(listLink({ priority: event.currentTarget.value ?? "" }))}>
                <s-option value="">Any priority</s-option>
                {priorities.map((value) => <s-option key={value} value={value}>{value}</s-option>)}
              </s-select>
              {team.length > 0 && <s-select label="Assignee" value={filters.assignee} onChange={(event) => navigate(listLink({ assignee: event.currentTarget.value ?? "" }))}>
                <s-option value="">Anyone</s-option>
                {team.map((name) => <s-option key={name} value={name}>{name}</s-option>)}
              </s-select>}
              <s-select label="Created" value={filters.period} onChange={(event) => navigate(listLink({ period: event.currentTarget.value ?? "" }))}>
                {Object.entries(PERIODS).map(([value, label]) => <s-option key={value} value={value}>{label}</s-option>)}
              </s-select>
            </s-grid>
          </s-box>}
          {filtered && <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued">{count} matching ticket{count === 1 ? "" : "s"}</s-text>
            {filters.q && <s-clickable-chip removable onRemove={() => { setSearch(""); navigate(listLink({ q: "" })); }}>&ldquo;{filters.q}&rdquo;</s-clickable-chip>}
            {activeFilters.map((filter) => <s-clickable-chip key={filter.key} removable onRemove={() => navigate(listLink({ [filter.key]: "" }))}>{filter.label}</s-clickable-chip>)}
            <s-button variant="tertiary" onClick={() => { setSearch(""); navigate(listLink({ q: "", topic: "", priority: "", assignee: "", period: "" })); }}>Clear all</s-button>
          </s-stack>}
        </s-stack>
      </s-box>

      {selected.length > 0 && <BulkBar ids={selected} team={team} onDone={clearSelection} />}

      {tickets.length === 0 ? (
        <s-box padding="large-200">
          <s-stack gap="small-200" alignItems="center">
            <s-icon type={filtered ? "search" : "check-circle"} tone={filtered ? "neutral" : "success"} />
            <s-heading>{filtered ? "No tickets match these filters" : view === "open" ? "You're all caught up" : "No tickets here"}</s-heading>
            <s-paragraph color="subdued">{filtered ? "Try a different search or clear the filters."
              : views.all ? "New requests and customer replies appear in Needs attention." : "Requests customers send from the storefront Help Desk form appear here."}</s-paragraph>
          </s-stack>
        </s-box>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header>
              <s-checkbox accessibilityLabel={allSelected ? "Deselect all on this page" : "Select all on this page"} checked={allSelected}
                onChange={() => setSelected(allSelected ? [] : tickets.map((ticket) => ticket.id))} />
            </s-table-header>
            <s-table-header listSlot="primary">Ticket</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>Assignee</s-table-header>
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
                  <s-stack gap="small-100">
                    <s-stack direction="inline" gap="small-100" alignItems="center">
                      {ticket.unread && <s-badge tone="info">New</s-badge>}
                      {ticket.channel === "chat" && <s-icon type="chat" tone="neutral" size="small" />}
                      <s-link id={`ticket-${ticket.id}`} href={listLink({ ticket: ticket.id, page: String(page) })}>
                        {ticket.unread ? <strong>#{ticket.number} {ticket.topic}</strong> : `#${ticket.number} ${ticket.topic}`}
                      </s-link>
                    </s-stack>
                    {(ticket.photoFlag || ticket.priority === "High" || ticket.priority === "Urgent") && <s-stack direction="inline" gap="small-100">
                      {(ticket.priority === "High" || ticket.priority === "Urgent") && <PriorityBadge priority={ticket.priority} />}
                      {ticket.photoFlag && <s-badge tone={ticket.photoFlag === "likely_ai" ? "critical" : "warning"} icon="image">{ticket.photoFlag === "likely_ai" ? "AI photo" : "Reused photo"}</s-badge>}
                    </s-stack>}
                    {[ticket.reference, ticket.images ? `${ticket.images} image${ticket.images === 1 ? "" : "s"}` : "", ticket.tags].filter(Boolean).length > 0
                      && <s-text color="subdued">{[ticket.reference, ticket.images ? `${ticket.images} image${ticket.images === 1 ? "" : "s"}` : "", ticket.tags].filter(Boolean).join(" · ")}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="none">
                    <s-text>{ticket.name}</s-text>
                    <s-text color="subdued">{ticket.email}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell><StatusBadge status={ticket.status} /></s-table-cell>
                <s-table-cell>{ticket.assignee || <s-text color="subdued">Unassigned</s-text>}</s-table-cell>
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

      <s-box padding="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">{count} ticket{count === 1 ? "" : "s"}{count > PAGE_SIZE ? ` · page ${page} of ${Math.ceil(count / PAGE_SIZE)}` : ""} · select tickets to change or delete several at once</s-text>
          {count > PAGE_SIZE && <s-stack direction="inline" gap="small-200">
            <s-button icon="chevron-left" accessibilityLabel="Previous page" disabled={page <= 1} onClick={() => navigate(listLink({ page: String(page - 1) }))} />
            <s-button icon="chevron-right" accessibilityLabel="Next page" disabled={page * PAGE_SIZE >= count} onClick={() => navigate(listLink({ page: String(page + 1) }))} />
          </s-stack>}
        </s-stack>
      </s-box>
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
  const [adding, setAdding] = useState(macros.length === 0);
  const remove = useFetcher<typeof action>();
  useResultToast(remove, "Saved reply deleted");
  return <s-section heading="Saved replies">
    <s-stack gap="base">
      <s-paragraph color="subdued">Pick one from Insert a saved reply in any ticket. These placeholders fill in by themselves: {macroPlaceholders.map(([key]) => `{{ ${key} }}`).join(", ")}.</s-paragraph>
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
      {adding ? <s-box border="base" borderRadius="base" padding="base" background="subdued">
        <s-stack gap="base">
          <s-heading>New saved reply</s-heading>
          <MacroEditor onDone={() => setAdding(false)} />
        </s-stack>
      </s-box> : <s-stack direction="inline"><s-button icon="plus" onClick={() => setAdding(true)}>Add saved reply</s-button></s-stack>}
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

// Shopify staff who have opened the Help Desk, each one assignable or not.
function StaffList({ staff, me }: { staff: SettingsData["staff"]; me: string }) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher, "Team updated");
  return <s-section heading="Shopify staff">
    <s-stack gap="base">
      <s-paragraph color="subdued">
        Everyone with access to your Shopify admin is added here the first time they open the Help Desk, so you can assign tickets to them.
        Replies are sent as the person who is signed in. Ask a staff member to open Apps → Zion App → Help Desk once to add them.
      </s-paragraph>
      {staff.length === 0 ? <s-paragraph>No staff yet. They appear here after opening the Help Desk.</s-paragraph>
        : staff.map((member) => (
          <s-box key={member.id} border="base" borderRadius="base" padding="base">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-avatar initials={member.name.slice(0, 2).toUpperCase()} alt={member.name} size="small" />
                <s-stack gap="none">
                  <s-stack direction="inline" gap="small-100" alignItems="center">
                    <s-text type="strong">{member.name}</s-text>
                    {member.name === me && <s-badge tone="info">You</s-badge>}
                    {member.accountOwner && <s-badge>Store owner</s-badge>}
                    {member.hidden && <s-badge tone="neutral">Not assignable</s-badge>}
                  </s-stack>
                  <s-text color="subdued">{[member.email, `last opened ${since(member.lastSeenAt)}`].filter(Boolean).join(" · ")}</s-text>
                </s-stack>
              </s-stack>
              <s-switch label="Can be assigned tickets" labelAccessibilityVisibility="exclusive" checked={!member.hidden} disabled={fetcher.state !== "idle"}
                onChange={(event) => void fetcher.submit({ intent: "staff-visibility", id: member.id, hidden: String(!event.currentTarget.checked) }, { method: "post" })} />
            </s-stack>
          </s-box>
        ))}
    </s-stack>
  </s-section>;
}

// The top of each settings tab: what it's for and how it stands right now.
function SettingsIntro({ icon, tone, title, description, status, statusTone }: {
  icon: "email" | "team" | "chat" | "image" | "store"; tone: "blue" | "navy" | "green" | "red" | "amber"; title: string; description: string; status: string; statusTone: "success" | "warning" | "info" | "neutral";
}) {
  return <s-section>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flex: "1 1 320px", minWidth: 0 }}>
        <IconTile icon={icon} tone={tone} size={46} />
        <s-stack gap="small-100">
          <s-heading>{title}</s-heading>
          <s-text color="subdued">{description}</s-text>
        </s-stack>
      </div>
      <s-badge tone={statusTone}>{status}</s-badge>
    </div>
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
  const detectorConnected = screen.ai.provider === "truthscan" ? screen.ai.hasTruthscanKey : Boolean(screen.ai.sightengineUser && screen.ai.hasSightengineSecret);
  const formLive = Boolean(screen.storefront.formLastSeenAt && Date.now() - new Date(screen.storefront.formLastSeenAt).getTime() < 30 * DAY);
  return <s-page heading="Help Desk settings">
    <s-link slot="breadcrumb-actions" href="/app/help-desk">Help Desk</s-link>
    {(part === "email" || part === "team") && <s-button slot="primary-action" variant="primary" disabled={!dirty} loading={save.state !== "idle"}
      onClick={() => void save.submit({ intent: "settings", ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) }, { method: "post" })}>Save</s-button>}

    <HelpDeskNavigation current="settings" />
    <SectionNavigation label="Settings categories" current={part} items={[
      { id: "email", label: "Emails", href: "/app/help-desk?settings=1" },
      { id: "team", label: "Team", href: "/app/help-desk?settings=1&part=team" },
      { id: "replies", label: "Saved replies", href: "/app/help-desk?settings=1&part=replies" },
      { id: "photos", label: "AI photo check", href: "/app/help-desk?settings=1&part=photos" },
      { id: "storefront", label: "Storefront form", href: "/app/help-desk?settings=1&part=storefront" },
    ]} />
    {part === "email" && <>
    <SettingsIntro icon="email" tone="blue" title="Emails" description="Who gets alerts about new requests, and what customers receive by email."
      status={configured ? "Sending on" : "Not set up yet"} statusTone={configured ? "success" : "warning"} />
    {!configured && <s-banner tone="info" heading="Emails aren't being sent yet">
      The app server needs a mailbox login (Gmail or Brevo) before it can send email. Until then, everything still works in the app and in the customer&apos;s chat on their request page. The Channels setup guide lists what&apos;s needed.
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
    {part === "team" && <>
      <SettingsIntro icon="team" tone="navy" title="Team" description="People who can be assigned tickets and chosen in Reply as."
        status={`${screen.team.length} ${screen.team.length === 1 ? "person" : "people"}`} statusTone={screen.team.length ? "success" : "warning"} />
      <StaffList staff={screen.staff} me={screen.me} />
      <s-section heading="Other names">
        <s-text-field label="Extra team members" value={values.team} placeholder="e.g. Priya, Warehouse team"
          details="For people who don't have a Shopify login. Separate names with commas. They can be assigned tickets and chosen in Reply as." onInput={(event) => set("team", event.currentTarget.value ?? "")} />
      </s-section>
    </>}

    {part === "photos" && <>
      <SettingsIntro icon="image" tone="green" title="AI photo check" description="Checks every customer photo for AI generation, reuse from another request and editing."
        status={!screen.ai.enabled ? "Off" : detectorConnected ? "Detector connected" : "Detector not connected"}
        statusTone={!screen.ai.enabled ? "neutral" : detectorConnected ? "success" : "warning"} />
      <AiSettings ai={screen.ai} />
    </>}

    {part === "replies" && <>
      <SettingsIntro icon="chat" tone="green" title="Saved replies" description="Ready answers your team can insert into any reply with one click."
        status={`${screen.macros.length} saved`} statusTone={screen.macros.length ? "success" : "warning"} />
      <SavedReplies macros={screen.macros} />
    </>}

    {part === "storefront" && <>
      <SettingsIntro icon="store" tone="red" title="Storefront form" description="The form customers use to send requests, and their private chat page."
        status={formLive ? "Live on your store" : "Not added yet"} statusTone={formLive ? "success" : "warning"} />
      <s-section heading="Add the form to your store">
        <s-stack gap="base">
          <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
            <li><s-text>Create a page, such as Contact or Support.</s-text></li>
            <li><s-text>Add the Help Desk form block to it in the theme editor, then save.</s-text></li>
            <li><s-text>Send a test request with a photo. It appears in your inbox within a few seconds.</s-text></li>
          </ol>
          <s-stack direction="inline" gap="small-200">
            <s-button href="shopify://admin/pages/new" target="_blank" icon="page">Create page</s-button>
            <s-button variant="primary" target="_blank" icon="theme-edit"
              href={`shopify://admin/themes/current/editor?template=page&addAppBlockId=${screen.storefront.apiKey}/help_desk&target=newAppsSection`}>Add form block</s-button>
          </s-stack>
          {screen.storefront.formLastSeenAt && <s-text color="subdued">Last opened by a customer {since(screen.storefront.formLastSeenAt)}.</s-text>}
        </s-stack>
      </s-section>
      <s-section heading="What customers get">
        <s-unordered-list>
          <s-list-item>A request number and a private page where they chat with your team, live.</s-list-item>
          <s-list-item>Signed-in customers pick from their own orders and see their past requests.</s-list-item>
          <s-list-item>Their photos are checked automatically by the AI photo check.</s-list-item>
        </s-unordered-list>
      </s-section>
    </>}
  </s-page>;
}

export default function HelpDeskRoute() {
  const screen = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  if (screen.screen === "settings") return <SettingsScreen screen={screen} />;
  if (screen.screen === "ticket") return <TicketDetail key={screen.ticket.id} screen={screen} />;
  if (params.get("section") === "setup") return <s-page heading="Help Desk overview" inlineSize="large">
    <s-button slot="secondary-actions" icon="image" href="/app/photo-checks">Photo checks</s-button>
    <HelpDeskNavigation current="setup" />
    <HelpDeskOverview screen={screen} />
  </s-page>;
  return <TicketList screen={screen} />;
}
