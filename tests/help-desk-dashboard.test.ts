import { describe, expect, it } from "vitest";
import { buildDashboard } from "../app/services/help-desk-dashboard.server";

const now = Date.parse("2026-10-23T12:00:00Z");
const ago = (days: number, hours = 0) => new Date(now - days * 86400_000 - hours * 3600_000);

describe("Help Desk dashboard numbers", () => {
  const rows = [
    { createdAt: ago(1, 5), firstResponseAt: ago(1, 3), resolvedAt: ago(0, 2), topic: "Order Queries" },
    { createdAt: ago(2), firstResponseAt: ago(2, -4), resolvedAt: null, topic: "Order Queries" },
    { createdAt: ago(3), firstResponseAt: null, resolvedAt: null, topic: "Wholesale Queries" },
    { createdAt: ago(9), firstResponseAt: ago(9, -1), resolvedAt: ago(8), topic: "Order Queries" },
  ];
  const open = [
    { id: "t2", number: 1002, name: "B", topic: "Order Queries", status: "Waiting on customer", assignee: "Priya", createdAt: ago(2), firstResponseAt: ago(2, -4) },
    { id: "t3", number: 1003, name: "C", topic: "Wholesale Queries", status: "Open", assignee: "", createdAt: ago(3), firstResponseAt: null },
  ];
  const dashboard = buildDashboard(rows, open, [{ verdict: "likely_ai" }, { verdict: "likely_real" }, { verdict: "likely_real" }], 7, now);

  it("counts this period against the one before", () => {
    expect([dashboard.created.total, dashboard.created.previous]).toEqual([3, 1]);
    expect([dashboard.resolved.total, dashboard.resolved.previous]).toEqual([1, 1]);
    expect(dashboard.created.series).toHaveLength(7);
    expect(dashboard.created.series.reduce((sum, value) => sum + value, 0)).toBe(3);
  });
  it("averages first reply time in hours", () => {
    expect(dashboard.response.hours).toBe(3);
    expect(dashboard.response.previous).toBe(1);
  });
  it("lists who has waited longest without a reply, and open work per person", () => {
    expect(dashboard.open).toMatchObject({ total: 2, unassigned: 1, waiting: 1 });
    expect(dashboard.open.noReply.map((ticket) => ticket.number)).toEqual([1003]);
    expect(dashboard.workload).toEqual([{ label: "Priya", value: 1 }, { label: "Unassigned", value: 1 }]);
  });
  it("ranks topics and sums photo verdicts", () => {
    expect(dashboard.topics).toEqual([{ label: "Order Queries", value: 2 }, { label: "Wholesale Queries", value: 1 }]);
    expect(dashboard.photos).toMatchObject({ checked: 3, likelyAi: 1, genuine: 2 });
  });
});
