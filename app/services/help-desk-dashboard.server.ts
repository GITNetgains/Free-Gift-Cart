import type { PrismaClient } from "@prisma/client";

// Numbers for the Help Desk overview, like Shopify's analytics: totals for the
// chosen period against the period before it, a value per day for the charts,
// and what's open right now.

import type { DashboardRange } from "./help-desk-dashboard";
const DAY = 24 * 3600_000;

type TicketRow = { createdAt: Date; resolvedAt: Date | null; firstResponseAt: Date | null; topic: string };
type OpenRow = { id: string; number: number; name: string; topic: string; status: string; assignee: string; createdAt: Date; firstResponseAt: Date | null };

const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

// Pure, so it can be tested without a database.
export function buildDashboard(rows: TicketRow[], open: OpenRow[], scans: { verdict: string | null }[], range: DashboardRange, now = Date.now()) {
  const start = now - range * DAY;
  const previousStart = now - 2 * range * DAY;
  const days = Array.from({ length: range }, (_, index) => dayKey(new Date(start + (index + 1) * DAY)));
  const perDay = (pick: (row: TicketRow) => Date | null) => {
    const counts = new Map(days.map((day) => [day, 0]));
    for (const row of rows) {
      const at = pick(row);
      if (at && at.getTime() > start) counts.set(dayKey(at), (counts.get(dayKey(at)) ?? 0) + 1);
    }
    return days.map((day) => counts.get(day) ?? 0);
  };
  const within = (at: Date | null, from: number, to: number) => Boolean(at && at.getTime() > from && at.getTime() <= to);
  const responseHours = (from: number, to: number) => rows.filter((row) => within(row.firstResponseAt, from, to)).map((row) => (row.firstResponseAt!.getTime() - row.createdAt.getTime()) / 3600_000);
  const responseByDay = days.map((day) => average(rows.filter((row) => row.firstResponseAt && dayKey(row.firstResponseAt) === day && row.firstResponseAt.getTime() > start)
    .map((row) => (row.firstResponseAt!.getTime() - row.createdAt.getTime()) / 3600_000)));

  const topics = new Map<string, number>();
  for (const row of rows) if (row.createdAt.getTime() > start) topics.set(row.topic, (topics.get(row.topic) ?? 0) + 1);
  const workload = new Map<string, number>();
  for (const row of open) workload.set(row.assignee || "Unassigned", (workload.get(row.assignee || "Unassigned") ?? 0) + 1);
  const verdicts = new Map<string, number>();
  for (const scan of scans) verdicts.set(scan.verdict || "error", (verdicts.get(scan.verdict || "error") ?? 0) + 1);

  return {
    range, days,
    created: { total: rows.filter((row) => within(row.createdAt, start, now)).length, previous: rows.filter((row) => within(row.createdAt, previousStart, start)).length, series: perDay((row) => row.createdAt) },
    resolved: { total: rows.filter((row) => within(row.resolvedAt, start, now)).length, previous: rows.filter((row) => within(row.resolvedAt, previousStart, start)).length, series: perDay((row) => row.resolvedAt) },
    response: { hours: average(responseHours(start, now)), previous: average(responseHours(previousStart, start)), series: responseByDay },
    open: {
      total: open.length, unassigned: open.filter((row) => !row.assignee).length, waiting: open.filter((row) => row.status === "Waiting on customer").length,
      // Oldest first: the customers who have waited longest for a first reply.
      noReply: open.filter((row) => !row.firstResponseAt && row.status !== "Waiting on customer").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 5)
        .map(({ id, number, name, topic, createdAt }) => ({ id, number, name, topic, createdAt })),
    },
    topics: [...topics.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
    workload: [...workload.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
    photos: {
      checked: scans.length, likelyAi: verdicts.get("likely_ai") ?? 0, reused: verdicts.get("duplicate") ?? 0,
      uncertain: verdicts.get("uncertain") ?? 0, genuine: verdicts.get("likely_real") ?? 0,
    },
  };
}

export type Dashboard = ReturnType<typeof buildDashboard>;

export async function loadDashboard(db: PrismaClient, shop: string, range: DashboardRange) {
  const now = Date.now();
  const previousStart = new Date(now - 2 * range * DAY);
  const [rows, open, scans] = await Promise.all([
    db.helpDeskTicket.findMany({
      where: { shop, OR: [{ createdAt: { gte: previousStart } }, { resolvedAt: { gte: previousStart } }, { firstResponseAt: { gte: previousStart } }] },
      select: { createdAt: true, resolvedAt: true, firstResponseAt: true, topic: true }, take: 20000,
    }),
    db.helpDeskTicket.findMany({
      where: { shop, status: { not: "Resolved" } },
      select: { id: true, number: true, name: true, topic: true, status: true, assignee: true, createdAt: true, firstResponseAt: true }, take: 5000,
    }),
    db.helpDeskImageScan.findMany({ where: { shop, status: "completed", createdAt: { gte: new Date(now - range * DAY) } }, select: { overallVerdict: true }, take: 20000 }),
  ]);
  return buildDashboard(rows, open, scans.map((scan) => ({ verdict: scan.overallVerdict })), range, now);
}
