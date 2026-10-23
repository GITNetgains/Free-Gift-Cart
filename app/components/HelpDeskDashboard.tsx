import { useState } from "react";
import type { Dashboard } from "../services/help-desk-dashboard.server";

// Charts for the Help Desk overview, in the style of Shopify's analytics cards:
// a headline number with its change and a sparkline, a trend chart with a
// hover crosshair, and ranked bar lists. Plain SVG, no chart library.

// Validated categorical pair (CVD and contrast checked): Zion blue, then orange.
const SERIES = { created: "#334FB4", resolved: "#EB6834" };
const INK = "#303030";
const MUTED = "#616161";
const GRID = "#EBEBEB";

const shortDate = (day: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
export const hoursLabel = (hours: number | null) => hours === null ? "—" : hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : hours < 48 ? `${hours.toFixed(1).replace(/\.0$/, "")}h` : `${Math.round(hours / 24)}d`;

function niceMax(value: number) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power * 4 >= value)! * power;
  return step * 4;
}

function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  const points = values.map((value, index) => [index, value ?? 0] as const);
  const max = Math.max(1, ...points.map(([, value]) => value));
  const path = points.map(([index, value], i) => `${i ? "L" : "M"} ${(index / Math.max(1, values.length - 1)) * 100} ${28 - (value / max) * 24}`).join(" ");
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" width="100%" height="34" aria-hidden="true" style={{ display: "block" }}>
    <path d={`${path} L 100 30 L 0 30 Z`} fill={color} opacity="0.08" />
    <path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

// A headline number with its change against the previous period.
export function KpiCard({ label, value, current, previous, lowerIsBetter = false, series, color, detail, onClick }: {
  label: string; value: string; current: number | null; previous: number | null; lowerIsBetter?: boolean; series?: (number | null)[]; color?: string; detail?: string; onClick?: () => void;
}) {
  let change: { text: string; good: boolean } | null = null;
  if (current !== null && previous !== null && previous > 0) {
    const percent = Math.round(((current - previous) / previous) * 100);
    change = { text: `${percent > 0 ? "↑" : percent < 0 ? "↓" : "→"} ${Math.abs(percent)}%`, good: percent === 0 || (percent < 0) === lowerIsBetter };
  } else if (current !== null && previous === 0 && current > 0) {
    change = { text: "New", good: !lowerIsBetter };
  }
  const body = <div style={{ display: "grid", gap: 6, alignContent: "start", padding: "14px 16px", background: "#fff", border: "1px solid #E3E3E3", borderRadius: 12, boxShadow: "0 1px 0 rgba(26,26,26,.05)" }}>
    <span style={{ color: MUTED, fontSize: 13, fontWeight: 550, textDecoration: "underline dotted #B5B5B5", textUnderlineOffset: 4 }}>{label}</span>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 24, fontWeight: 700, color: INK, lineHeight: 1.15 }}>{value}</span>
      {change && <span style={{ fontSize: 12.5, fontWeight: 600, color: change.good ? "#0C7A43" : "#B3261E" }}>{change.text}</span>}
    </div>
    {series && color ? <Sparkline values={series} color={color} /> : <div style={{ height: 34, display: "flex", alignItems: "flex-end" }}><span style={{ color: MUTED, fontSize: 12.5 }}>{detail}</span></div>}
    {series && detail && <span style={{ color: MUTED, fontSize: 12.5 }}>{detail}</span>}
  </div>;
  return onClick ? <s-clickable onClick={onClick} borderRadius="base" accessibilityLabel={`${label}: ${value}`}>{body}</s-clickable> : body;
}

// New vs resolved per day, one shared axis, crosshair tooltip on hover.
export function TrendChart({ dashboard }: { dashboard: Dashboard }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const { days, created, resolved } = dashboard;
  const width = 720;
  const height = 240;
  const pad = { left: 36, right: 86, top: 14, bottom: 28 };
  const max = niceMax(Math.max(...created.series, ...resolved.series));
  const x = (index: number) => pad.left + (index / Math.max(1, days.length - 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
  const line = (values: number[]) => values.map((value, index) => `${index ? "L" : "M"} ${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const ticks = [0, max / 4, max / 2, (max * 3) / 4, max];
  const labelIndexes = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const lastIndex = days.length - 1;
  // Direct labels at the line ends, nudged apart if they would overlap.
  let createdY = y(created.series[lastIndex] ?? 0);
  let resolvedY = y(resolved.series[lastIndex] ?? 0);
  if (Math.abs(createdY - resolvedY) < 16) { const mid = (createdY + resolvedY) / 2; createdY = mid - 8; resolvedY = mid + 8; if (created.series[lastIndex] < resolved.series[lastIndex]) [createdY, resolvedY] = [resolvedY, createdY]; }
  const legend = [{ key: "created", label: "New tickets", color: SERIES.created, total: created.total }, { key: "resolved", label: "Resolved", color: SERIES.resolved, total: resolved.total }];

  return <div style={{ display: "grid", gap: 10 }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        {legend.map((item) => <span key={item.key} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: INK }}>
          <span aria-hidden="true" style={{ width: 14, height: 3, borderRadius: 2, background: item.color }} />{item.label} <b>{item.total}</b>
        </span>)}
      </div>
      <button type="button" onClick={() => setTable(!table)} style={{ border: 0, background: "none", color: "#005BD3", font: "inherit", fontSize: 13, cursor: "pointer", padding: 0 }}>{table ? "Show chart" : "View as table"}</button>
    </div>
    {table ? <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #E3E3E3", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ background: "#F7F7F7", textAlign: "left" }}><th style={{ padding: "6px 10px" }}>Day</th><th style={{ padding: "6px 10px" }}>New tickets</th><th style={{ padding: "6px 10px" }}>Resolved</th></tr></thead>
        <tbody>{days.map((day, index) => <tr key={day} style={{ borderTop: "1px solid #F1F1F1" }}><td style={{ padding: "5px 10px" }}>{shortDate(day)}</td><td style={{ padding: "5px 10px" }}>{created.series[index]}</td><td style={{ padding: "5px 10px" }}>{resolved.series[index]}</td></tr>)}</tbody>
      </table>
    </div> : <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`New tickets and resolved tickets per day over the last ${days.length} days`} style={{ display: "block", overflow: "visible" }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((tick) => <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke={GRID} strokeWidth="1" />
          <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill={MUTED}>{Number.isInteger(tick) ? tick : tick.toFixed(1)}</text>
        </g>)}
        {labelIndexes.map((index) => <text key={index} x={x(index)} y={height - 8} textAnchor={index === 0 ? "start" : index === lastIndex ? "end" : "middle"} fontSize="11" fill={MUTED}>{shortDate(days[index])}</text>)}
        <path d={line(resolved.series)} fill="none" stroke={SERIES.resolved} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={line(created.series)} fill="none" stroke={SERIES.created} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <text x={x(lastIndex) + 8} y={createdY + 4} fontSize="12" fill={INK} fontWeight="600">New {created.series[lastIndex]}</text>
        <text x={x(lastIndex) + 8} y={resolvedY + 4} fontSize="12" fill={INK} fontWeight="600">Resolved {resolved.series[lastIndex]}</text>
        {hover !== null && <g>
          <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={height - pad.bottom} stroke="#8A8A8A" strokeWidth="1" strokeDasharray="3 3" />
          {[{ v: resolved.series[hover], c: SERIES.resolved }, { v: created.series[hover], c: SERIES.created }].map((point, i) => <circle key={i} cx={x(hover)} cy={y(point.v)} r="5" fill={point.c} stroke="#fff" strokeWidth="2" />)}
        </g>}
        {days.map((day, index) => <rect key={day} x={x(index) - (width - pad.left - pad.right) / days.length / 2} y={pad.top} width={(width - pad.left - pad.right) / days.length} height={height - pad.top - pad.bottom}
          fill="transparent" onMouseEnter={() => setHover(index)} />)}
      </svg>
      {hover !== null && <div role="status" style={{
        position: "absolute", top: 0, left: `${(x(hover) / width) * 100}%`, transform: `translateX(${hover > days.length / 2 ? "calc(-100% - 12px)" : "12px"})`,
        pointerEvents: "none", padding: "8px 10px", borderRadius: 8, background: "#fff", border: "1px solid #E3E3E3", boxShadow: "0 4px 14px rgba(0,0,0,.12)", fontSize: 12.5, color: INK, whiteSpace: "nowrap",
      }}>
        <div style={{ fontWeight: 650, marginBottom: 4 }}>{shortDate(days[hover])}</div>
        {legend.map((item) => <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden="true" style={{ width: 10, height: 3, borderRadius: 2, background: item.color }} />{item.label}: <b>{(item.key === "created" ? created : resolved).series[hover]}</b>
        </div>)}
      </div>}
    </div>}
  </div>;
}

// Ranked horizontal bars for one measure; values written beside each bar.
export function BarList({ items, empty, color = SERIES.created, onSelect }: { items: { label: string; value: number }[]; empty: string; color?: string; onSelect?: (label: string) => void }) {
  if (!items.length) return <s-text color="subdued">{empty}</s-text>;
  const max = Math.max(...items.map((item) => item.value));
  return <div style={{ display: "grid", gap: 10 }}>
    {items.slice(0, 6).map((item) => {
      const row = <div style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, color: INK }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span><b>{item.value}</b>
        </div>
        <div aria-hidden="true" style={{ height: 8, borderRadius: 4, background: "#F1F2F4" }}>
          <div style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, height: "100%", borderRadius: 4, background: color }} />
        </div>
      </div>;
      return onSelect ? <s-clickable key={item.label} onClick={() => onSelect(item.label)} accessibilityLabel={`${item.label}: ${item.value}`}>{row}</s-clickable> : <div key={item.label}>{row}</div>;
    })}
  </div>;
}
