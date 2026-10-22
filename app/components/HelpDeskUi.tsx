import type { ReactNode } from "react";

// Shared building blocks for the Help Desk admin pages: feature cards, stat
// tiles and the setup checklist. Colours follow the Zion Cases brand (red
// #EF3A24, navy #172351, blue #334FB4) on top of Polaris web components.

export const TONES = {
  red: { accent: "#EF3A24", soft: "#FDECE9", ink: "#B3261E" },
  navy: { accent: "#172351", soft: "#E8EBF5", ink: "#172351" },
  blue: { accent: "#334FB4", soft: "#E9EDFB", ink: "#2A409A" },
  green: { accent: "#0C7A43", soft: "#E3F5EA", ink: "#0C5132" },
  amber: { accent: "#D98F00", soft: "#FFF4D6", ink: "#7A5600" },
  gray: { accent: "#8A8F9C", soft: "#F1F2F4", ink: "#4A4F5C" },
} as const;
export type Tone = keyof typeof TONES;

const card = (accent?: string): React.CSSProperties => ({
  position: "relative", overflow: "hidden", height: "100%", background: "#fff", border: "1px solid #E3E3E3", borderRadius: 14,
  boxShadow: "0 1px 0 rgba(26,26,26,.05)", ...(accent ? { borderTop: `4px solid ${accent}` } : {}),
});

type IconName = Parameters<typeof IconTile>[0]["icon"];

export function IconTile({ icon, tone, size = 40 }: { icon: "chat" | "image" | "wand" | "notification" | "email" | "team" | "store" | "settings" | "check-circle" | "alert-triangle" | "clock" | "person" | "order" | "flag"; tone: Tone; size?: number }) {
  return <div aria-hidden="true" style={{ flex: "none", display: "grid", placeItems: "center", width: size, height: size, borderRadius: 12, background: TONES[tone].soft, color: TONES[tone].ink }}>
    <s-icon type={icon as never} />
  </div>;
}

// A highlighted product area (Live chat, Chatbot, AI photo check) with its
// status, key numbers and the next thing to do.
export function FeatureCard({ tone, icon, title, status, statusTone, description, metrics, children }: {
  tone: Tone; icon: IconName; title: string; status: string; statusTone: "success" | "warning" | "critical" | "info" | "neutral";
  description: string; metrics: { label: string; value: string }[]; children?: ReactNode;
}) {
  return <div style={card(TONES[tone].accent)}>
    <div style={{ padding: 18, display: "grid", gap: 14, height: "100%", alignContent: "start" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
          <IconTile icon={icon} tone={tone} />
          <s-heading>{title}</s-heading>
        </div>
        <s-badge tone={statusTone}>{status}</s-badge>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))`, gap: 8 }}>
        {metrics.map((metric) => (
          <div key={metric.label} style={{ padding: "10px 12px", borderRadius: 10, background: "#F7F7F8" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1A1A1A", lineHeight: 1.2 }}>{metric.value}</div>
            <s-text color="subdued">{metric.label}</s-text>
          </div>
        ))}
      </div>
      <s-text color="subdued">{description}</s-text>
      {children && <s-stack direction="inline" gap="small-200">{children}</s-stack>}
    </div>
  </div>;
}

// A number with a coloured marker, for metric rows.
export function StatTile({ label, value, detail, tone = "navy", icon }: { label: string; value: string; detail?: string; tone?: Tone; icon?: IconName }) {
  return <div style={{ ...card(), display: "flex", gap: 12, alignItems: "center", padding: "14px 16px" }}>
    {icon ? <IconTile icon={icon} tone={tone} size={38} /> : <span aria-hidden="true" style={{ alignSelf: "stretch", width: 4, borderRadius: 4, background: TONES[tone].accent }} />}
    <div style={{ minWidth: 0 }}>
      <s-text color="subdued">{label}</s-text>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#1A1A1A", lineHeight: 1.25 }}>{value}</div>
      {detail && <s-text color="subdued">{detail}</s-text>}
    </div>
  </div>;
}

export type ChecklistItem = { id: string; title: string; description: string; done: boolean; action?: ReactNode };

// "Get Help Desk ready": what's set up, what's left, and a button for each step.
export function SetupChecklist({ items, title = "Get your Help Desk ready" }: { items: ChecklistItem[]; title?: string }) {
  const done = items.filter((item) => item.done).length;
  const percent = Math.round((done / items.length) * 100);
  return <s-section>
    <s-stack gap="base">
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack gap="small-100">
          <s-heading>{title}</s-heading>
          <s-text color="subdued">{done === items.length ? "Everything is set up. Nice work!" : `${done} of ${items.length} steps done`}</s-text>
        </s-stack>
        <s-badge tone={done === items.length ? "success" : "warning"}>{percent}% complete</s-badge>
      </s-stack>
      <div aria-hidden="true" style={{ height: 8, borderRadius: 8, background: "#EEF0F3", overflow: "hidden" }}>
        <div style={{ width: `${percent}%`, height: "100%", borderRadius: 8, background: done === items.length ? TONES.green.accent : `linear-gradient(90deg, ${TONES.red.accent}, #FF8A5C)` }} />
      </div>
      <div style={{ display: "grid", gap: 2 }}>
        {items.map((item) => (
          <div key={item.id} style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "12px 4px", borderTop: "1px solid #F1F1F1" }}>
            <span aria-label={item.done ? "Done" : "To do"} style={{
              flex: "none", display: "grid", placeItems: "center", width: 24, height: 24, marginTop: 1, borderRadius: "50%", fontSize: 13, fontWeight: 700,
              background: item.done ? TONES.green.accent : "#fff", color: "#fff", border: item.done ? "none" : "2px dashed #B5B9C3",
            }}>{item.done ? "✓" : ""}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <s-text type="strong">{item.title}</s-text>
              <div><s-text color="subdued">{item.description}</s-text></div>
            </div>
            {item.action && <div style={{ flex: "none" }}>{item.action}</div>}
          </div>
        ))}
      </div>
    </s-stack>
  </s-section>;
}

// "2 minutes ago" for "last seen" style statuses.
export function since(value: string | Date | null | undefined) {
  if (!value) return "";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}
