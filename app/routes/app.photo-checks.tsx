import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { serializeScan } from "../services/image-scan/scan.server";
import { IconTile, TONES, type Tone } from "../components/HelpDeskUi";
import { PhotoCheckButton, PhotoReportModal, PhotoThumb } from "../components/PhotoReport";

// Every customer photo the AI photo check has looked at, newest first, with a
// filter per verdict, so the team can review flagged evidence in one place.

const PAGE_SIZE = 24;
const VERDICTS = {
  "": { label: "All photos", tone: "navy", badge: "neutral" },
  likely_ai: { label: "Likely AI-generated", tone: "red", badge: "critical" },
  duplicate: { label: "Reused photo", tone: "amber", badge: "warning" },
  uncertain: { label: "Can't confirm", tone: "gray", badge: "caution" },
  likely_real: { label: "Likely genuine", tone: "green", badge: "success" },
} as const;
type Verdict = keyof typeof VERDICTS;

// The single most useful reason for a verdict, in plain words.
function mainReason(scan: ReturnType<typeof serializeScan>) {
  if (!scan) return "";
  if (scan.status === "pending") return "Checking this photo now.";
  if (scan.status === "failed") return scan.error || "The check didn't finish. Re-scan it from the ticket.";
  const { c2pa, watermark, exif, hash, classifier, editing } = scan.layers;
  if (c2pa?.isAiGenerated) return `Content Credentials say it was AI-generated${c2pa.claimGenerator ? ` by ${c2pa.claimGenerator}` : ""}.`;
  if (watermark?.detected) return watermark.reason;
  const match = hash?.match;
  if (match && !match.sameTicket) return `${match.matchType === "exact" ? "Same photo" : "Near-identical photo"} as on ticket #${match.ticketNumber}${match.previousVerdict === "likely_ai" ? ", which was identified as AI" : ""}.`;
  const strong = exif?.findings?.find((finding) => /AI tool|source type|generation record|naming pattern/.test(finding));
  if (strong) return `${strong}.`;
  if (typeof classifier?.aiProbability === "number") return classifier.reasoning || `AI detector: ${classifier.aiProbability}% likely AI.`;
  if (classifier?.skipReason === "camera_original") return "Genuine camera photo with intact camera data.";
  const edited = editing?.signals?.find((signal) => signal.strength === "strong");
  if (edited) return `${edited.detail}.`;
  if (classifier?.missingApiKey) return "No signs of AI or reuse in the free checks. Connect an AI detector for a deeper check.";
  return "No signs of AI generation or reuse found.";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;
  const url = new URL(request.url);
  const verdict = ((url.searchParams.get("verdict") || "") in VERDICTS ? url.searchParams.get("verdict") || "" : "") as Verdict;
  const page = Math.max(1, Math.min(10000, Number(url.searchParams.get("page")) || 1));
  const where: Prisma.HelpDeskImageScanWhereInput = { shop, ...(verdict ? { overallVerdict: verdict } : {}) };
  const [scans, count, groups, settings, recent] = await Promise.all([
    db.helpDeskImageScan.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      include: { attachment: { select: { id: true, name: true, ticket: { select: { id: true, number: true, name: true, topic: true } } } } },
    }),
    db.helpDeskImageScan.count({ where }),
    db.helpDeskImageScan.groupBy({ by: ["overallVerdict"], where: { shop }, _count: { _all: true } }),
    db.helpDeskSettings.findUnique({ where: { shop } }),
    // The latest detector outcomes, to show whether the AI detector is working.
    db.helpDeskImageScan.findMany({ where: { shop, status: "completed" }, orderBy: { updatedAt: "desc" }, take: 100, select: { classifierResult: true, updatedAt: true } }),
  ]);
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const health = { checked30d: 0, lastScoredAt: null as Date | null, lastError: null as { title: string; hint: string; at: Date } | null, waitingForKey: 0 };
  for (const row of recent) {
    let result: { aiProbability?: number; reused?: boolean; error?: string; errorTitle?: string; errorHint?: string; missingApiKey?: boolean } = {};
    try { result = JSON.parse(row.classifierResult || "{}"); } catch { /* unreadable: skip */ }
    if (typeof result.aiProbability === "number" && !result.reused) {
      if (row.updatedAt.getTime() >= since) health.checked30d++;
      health.lastScoredAt ||= row.updatedAt;
    }
    if (result.error && !health.lastError) health.lastError = { title: result.errorTitle || "The AI detector failed", hint: result.errorHint || result.error, at: row.updatedAt };
    if (result.missingApiKey) health.waitingForKey++;
  }
  // An error older than the last good result has been fixed since.
  if (health.lastError && health.lastScoredAt && health.lastScoredAt > health.lastError.at) health.lastError = null;
  const totals = Object.fromEntries(groups.map((group) => [group.overallVerdict || "", group._count._all])) as Record<string, number>;
  return data({
    verdict, page, count,
    totals: { all: Object.values(totals).reduce((sum, value) => sum + value, 0), likely_ai: totals.likely_ai ?? 0, duplicate: totals.duplicate ?? 0, uncertain: totals.uncertain ?? 0, likely_real: totals.likely_real ?? 0 },
    enabled: settings?.aiDetectionEnabled ?? true,
    detectorConnected: settings?.aiDetectionProvider === "truthscan" ? Boolean(settings?.truthscanKey) : Boolean(settings?.sightengineUser && settings?.sightengineSecret),
    mode: settings?.aiDetectorMode ?? "always",
    provider: settings?.aiDetectionProvider === "truthscan" ? "TruthScan" : "Sightengine",
    health,
    photos: scans.map((scan) => {
      const parsed = serializeScan(scan);
      return {
        id: scan.attachment.id, name: scan.attachment.name, ticket: scan.attachment.ticket, status: scan.status, verdict: scan.overallVerdict,
        confidence: scan.overallConfidence, checkedAt: scan.updatedAt, reason: mainReason(parsed),
        edited: parsed?.layers.editing?.level === "edited", scan: parsed,
      };
    }),
  }, { headers: { "Cache-Control": "private, no-store" } });
};

export default function PhotoChecks() {
  const { photos, totals, verdict, page, count, enabled, detectorConnected, mode, provider, health } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [reportId, setReportId] = useState<string | null>(null);
  const report = reportId ? photos.find((photo) => photo.id === reportId) ?? null : null;
  const [params] = useSearchParams();
  const go = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    if (!("page" in changes)) next.delete("page");
    navigate(`/app/photo-checks${next.toString() ? `?${next}` : ""}`);
  };
  const filters: { key: Verdict; value: number; tone: Tone }[] = [
    { key: "", value: totals.all, tone: "navy" },
    { key: "likely_ai", value: totals.likely_ai, tone: "red" },
    { key: "duplicate", value: totals.duplicate, tone: "amber" },
    { key: "uncertain", value: totals.uncertain, tone: "gray" },
    { key: "likely_real", value: totals.likely_real, tone: "green" },
  ];
  return <s-page heading="Photo checks" inlineSize="large">
    <s-link slot="breadcrumb-actions" href="/app/help-desk">Help Desk</s-link>
    <s-button slot="secondary-actions" icon="settings" href="/app/help-desk?settings=1&part=photos">AI photo check settings</s-button>

    <s-section>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <IconTile icon="image" tone="green" size={44} />
        <s-stack gap="small-200">
          <s-heading>Every customer photo, checked automatically</s-heading>
          <s-paragraph color="subdued">
            Photos sent with requests and replies go through six checks: Content Credentials, AI watermarks (including Gemini&apos;s), photo metadata,
            reuse from another request, the AI detector and signs of editing. Click any photo&apos;s result to see its full report.
          </s-paragraph>
        </s-stack>
      </div>
    </s-section>

    {(() => {
      const state = !enabled ? "off" : !detectorConnected ? "disconnected" : health.lastError ? "error" : health.lastScoredAt ? "working" : "ready";
      const look = {
        off: { tone: "gray", badge: "Off", title: "AI photo check is switched off", text: "New customer photos aren't being checked." },
        disconnected: { tone: "amber", badge: "Not connected", title: "The AI detector isn't connected", text: `Only the free checks are running, so an AI image with its labels removed can get through as "Can't confirm". Add your Sightengine or TruthScan key to turn on the AI detector.${health.waitingForKey ? ` ${health.waitingForKey} recent photo${health.waitingForKey === 1 ? " is" : "s are"} waiting for it and will be re-checked when you connect.` : ""}` },
        error: { tone: "red", badge: "Needs attention", title: health.lastError?.title || "The AI detector failed", text: health.lastError?.hint || "" },
        working: { tone: "green", badge: "Working", title: `${provider} is connected and working`, text: `Photos the free checks can't decide are sent to ${provider} (${mode === "always" ? "every undecided photo" : mode === "manual" ? "only when you click \"Check with AI detector\"" : "skipping clear camera originals"}).` },
        ready: { tone: "blue", badge: "Connected", title: `${provider} is connected`, text: "No photo has needed the detector yet. Its first result will show here." },
      }[state] as { tone: Tone; badge: string; title: string; text: string };
      const tone = TONES[look.tone];
      const stats = [
        { label: "Detector", value: detectorConnected ? provider : "None" },
        { label: "Detector checks (30 days)", value: String(health.checked30d) },
        { label: "Last detector result", value: health.lastScoredAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(health.lastScoredAt)) : "None yet" },
      ];
      return <s-section padding="none">
        <div style={{ borderRadius: 12, overflow: "hidden", borderTop: `4px solid ${tone.accent}` }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: tone.soft }}>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flex: "1 1 360px", minWidth: 0 }}>
              <IconTile icon="wand" tone={look.tone} size={44} />
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <s-text color="subdued">AI detector status</s-text>
                  <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: "#fff", color: tone.ink, border: `1px solid ${tone.accent}66` }}>{look.badge}</span>
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: tone.ink }}>{look.title}</div>
                <s-text>{look.text}</s-text>
              </div>
            </div>
            <s-button variant={state === "working" || state === "ready" ? "secondary" : "primary"} icon="settings" href="/app/help-desk?settings=1&part=photos">
              {state === "off" ? "Turn on" : state === "disconnected" ? "Connect AI detector" : state === "error" ? "Fix in settings" : "Detector settings"}
            </s-button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", borderTop: "1px solid #E3E3E3" }}>
            {stats.map((stat, index) => <div key={stat.label} style={{ padding: "12px 18px", borderLeft: index ? "1px solid #E3E3E3" : "none" }}>
              <s-text color="subdued">{stat.label}</s-text>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{stat.value}</div>
            </div>)}
          </div>
        </div>
      </s-section>;
    })()}

    <s-section padding="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
        {filters.map((filter) => {
          const active = verdict === filter.key;
          const tone = TONES[filter.tone];
          return <s-clickable key={filter.key || "all"} onClick={() => go({ verdict: filter.key })} accessibilityLabel={`Show ${VERDICTS[filter.key].label.toLowerCase()}`} borderRadius="base">
            <div style={{ padding: "14px 16px", borderRadius: 12, border: `1px solid ${active ? tone.accent : "#E3E3E3"}`, background: active ? tone.soft : "#fff", boxShadow: active ? `0 0 0 1px ${tone.accent}` : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: tone.accent }} />
                <s-text color="subdued">{VERDICTS[filter.key].label}</s-text>
              </div>
              <div style={{ marginTop: 4, fontSize: 24, fontWeight: 700, color: active ? tone.ink : "#1A1A1A" }}>{filter.value}</div>
            </div>
          </s-clickable>;
        })}
      </s-grid>
    </s-section>

    <s-section padding="none">
      {photos.length === 0 ? (
        <s-box padding="large-200">
          <s-stack gap="small-200" alignItems="center">
            <IconTile icon="image" tone="gray" size={48} />
            <s-heading>{verdict ? "No photos with this result" : "No photos checked yet"}</s-heading>
            <s-paragraph color="subdued">{verdict ? "Try another filter." : "Photos customers send with requests and replies will show up here, with their check result."}</s-paragraph>
          </s-stack>
        </s-box>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Photo</s-table-header>
            <s-table-header>Result</s-table-header>
            <s-table-header>Why</s-table-header>
            <s-table-header listSlot="secondary">Ticket</s-table-header>
            <s-table-header>Checked</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {photos.map((photo) => (
              <s-table-row key={photo.id} clickDelegate={`report-${photo.id}`}>
                <s-table-cell>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <PhotoThumb id={photo.id} name={photo.name} />
                    <s-text>{photo.name}</s-text>
                  </div>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-100">
                    <PhotoCheckButton scan={photo.scan} onOpen={() => setReportId(photo.id)} />
                    {typeof photo.confidence === "number" && photo.verdict && photo.verdict !== "error" && <s-text color="subdued">{Math.round(photo.confidence * 100)}% confidence</s-text>}
                    {photo.edited && <s-badge tone="warning">Edited</s-badge>}
                    <s-button id={`report-${photo.id}`} variant="tertiary" icon="view" onClick={() => setReportId(photo.id)}>Full report</s-button>
                  </s-stack>
                </s-table-cell>
                <s-table-cell><div style={{ maxWidth: 380, whiteSpace: "normal" }}><s-text>{photo.reason}</s-text></div></s-table-cell>
                <s-table-cell>
                  <s-stack gap="none">
                    <s-link href={`/app/help-desk?ticket=${encodeURIComponent(photo.ticket.id)}`}>#{photo.ticket.number} {photo.ticket.topic}</s-link>
                    <s-text color="subdued">{photo.ticket.name}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell><span suppressHydrationWarning>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(photo.checkedAt))}</span></s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
      {count > PAGE_SIZE && <s-box padding="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">Page {page} of {Math.ceil(count / PAGE_SIZE)}</s-text>
          <s-stack direction="inline" gap="small-200">
            <s-button icon="chevron-left" accessibilityLabel="Previous page" disabled={page <= 1} onClick={() => go({ page: String(page - 1) })} />
            <s-button icon="chevron-right" accessibilityLabel="Next page" disabled={page * PAGE_SIZE >= count} onClick={() => go({ page: String(page + 1) })} />
          </s-stack>
        </s-stack>
      </s-box>}
    </s-section>

    <PhotoReportModal file={report} onClose={() => setReportId(null)} ticketLink={(ticketId) => `/app/help-desk?ticket=${encodeURIComponent(ticketId)}`} />
  </s-page>;
}
