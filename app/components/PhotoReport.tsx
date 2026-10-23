import { useEffect, useId, useRef, type ReactNode } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { serializeScan } from "../services/image-scan/scan.server";
import { TONES, type Tone } from "./HelpDeskUi";

// The full AI photo check report, opened in a popup from a photo's result
// badge: the verdict and what to do, every issue as its own card, then each
// check the scan ran with what it looked at and what it found.

export type PhotoScan = NonNullable<ReturnType<typeof serializeScan>>;
type Severity = "critical" | "warning" | "info" | "success";
type CheckStatus = "issue" | "warning" | "clear" | "note" | "skipped" | "failed";
type IconType = "alert-octagon" | "alert-triangle" | "info" | "check-circle" | "minus-circle" | "x-circle" | "lock" | "image-magic" | "file" | "duplicate" | "wand" | "edit";
type Finding = { severity: Severity; title: string; detail: string; href?: string; hrefLabel?: string };
type Check = { key: string; icon: IconType; name: string; what: string; status: CheckStatus; summary: string; findings: Finding[]; extra?: ReactNode };

const SEVERITY: Record<Severity, { tone: Tone; icon: IconType; label: string }> = {
  critical: { tone: "red", icon: "alert-octagon", label: "AI evidence" },
  warning: { tone: "amber", icon: "alert-triangle", label: "Suspicious" },
  info: { tone: "gray", icon: "info", label: "Note" },
  success: { tone: "green", icon: "check-circle", label: "Good sign" },
};

const STATUS: Record<CheckStatus, { tone: Tone; label: string; badge: "critical" | "warning" | "success" | "neutral" | "info" }> = {
  issue: { tone: "red", label: "AI evidence found", badge: "critical" },
  warning: { tone: "amber", label: "Suspicious", badge: "warning" },
  clear: { tone: "green", label: "Passed", badge: "success" },
  note: { tone: "blue", label: "Info only", badge: "info" },
  skipped: { tone: "gray", label: "Not run", badge: "neutral" },
  failed: { tone: "gray", label: "Couldn't check", badge: "neutral" },
};

export const PHOTO_VERDICT: Record<string, { label: string; tone: Tone; badge: "critical" | "warning" | "caution" | "success" | "neutral"; icon: IconType; meaning: string; advice: string }> = {
  likely_ai: {
    label: "Likely AI-generated", tone: "red", badge: "critical", icon: "alert-octagon",
    meaning: "Strong signs this image was made or changed with an AI tool.",
    advice: "Don't approve the request on this photo alone. Ask the customer for a new photo of the item, for example next to a note with today's date or their order number.",
  },
  duplicate: {
    label: "Reused photo", tone: "amber", badge: "warning", icon: "duplicate",
    meaning: "The same photo, or a near copy of it, was already sent with another request to your store.",
    advice: "Open the other ticket and compare. If it's a different order, ask the customer for a fresh photo.",
  },
  uncertain: {
    label: "Can't confirm", tone: "amber", badge: "caution", icon: "minus-circle",
    meaning: "No clear sign of AI, but the checks couldn't confirm the photo is a genuine original either.",
    advice: "Use your judgement. For a high-value claim, ask the customer for another photo from a different angle.",
  },
  likely_real: {
    label: "Likely genuine", tone: "green", badge: "success", icon: "check-circle",
    meaning: "No signs of AI generation or reuse. This looks like a genuine photo.",
    advice: "Nothing to worry about from the photo. Continue with the request as normal.",
  },
  error: {
    label: "Couldn't check", tone: "gray", badge: "neutral", icon: "x-circle",
    meaning: "The check couldn't read this file.",
    advice: "Use Re-scan to try again.",
  },
};

const EDIT_TITLES: Record<string, string> = {
  metadata_editor: "Edited in an editing app", photoshop_segment: "Photoshop data in the file", iptc_metadata_block: "Standard metadata block",
  adobe_encoder: "Saved by Adobe software", xmp_editor: "Editing app recorded in the file", comment_editor: "Editing app named in the file",
  png_editor: "Editing app recorded in the file", png_software: "Saved by software", design_frame: "Made in a design tool (such as Canva)",
  dimension_mismatch: "Resized or cropped after it was taken", camera_hardware_signature: "Camera hardware signature verified",
  modified_after_capture: "Timestamp changed after capture", minimal_camera_data: "Limited camera data", software_encoder: "Re-saved by software",
  no_camera_data: "No camera data", non_camera_format: "Not a camera photo format", thumbnail_mismatch: "Picture changed after it was taken",
  visual_manipulation: "AI detector sees manipulation",
};

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const formatDate = (value: unknown) => {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const formatBytes = (bytes?: number | null) => (!bytes ? "" : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function statusOf(findings: Finding[], fallback: CheckStatus): CheckStatus {
  if (findings.some((finding) => finding.severity === "critical")) return "issue";
  if (findings.some((finding) => finding.severity === "warning")) return "warning";
  return fallback;
}

function ScoreBar({ value, label }: { value: number; label: string }) {
  const tone = value >= 70 ? TONES.red : value >= 40 ? TONES.amber : TONES.green;
  return <div style={{ display: "grid", gap: 6 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <s-text color="subdued">{label}</s-text>
      <s-text type="strong">{value}%</s-text>
    </div>
    <div aria-hidden="true" style={{ position: "relative", height: 10, borderRadius: 10, background: "linear-gradient(90deg, #E3F5EA 0 40%, #FFF4D6 40% 70%, #FDECE9 70% 100%)" }}>
      <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, Math.max(2, value))}%`, borderRadius: 10, background: tone.accent }} />
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#616161" }}>
      <span>Genuine</span><span>Unsure</span><span>AI-generated</span>
    </div>
  </div>;
}

// Every check the scan ran, in the order it ran, each with its own findings.
export function buildChecks(scan: PhotoScan, links: { ticket: (ticketId: string) => string; settings: string }): Check[] {
  const { c2pa, watermark, exif, hash, classifier, editing } = scan.layers;
  const checks: Check[] = [];

  // 1. Content Credentials
  {
    const findings: Finding[] = [];
    if (c2pa?.isAiGenerated) {
      findings.push({ severity: "critical", title: "Content Credentials say it's AI-generated",
        detail: `The file's signed provenance record declares it ${c2pa.aiActions?.[0]?.toLowerCase() || "AI-generated"}${c2pa.claimGenerator ? ` by ${c2pa.claimGenerator}` : ""}${c2pa.generatedAt ? ` on ${c2pa.generatedAt.slice(0, 10)}` : ""}.` });
    } else if (c2pa?.present) {
      findings.push({ severity: "info", title: "Has Content Credentials",
        detail: `Made or edited${c2pa.claimGenerator ? ` with ${c2pa.claimGenerator}` : " with a tool that writes provenance"}${c2pa.actions?.length ? ` (${c2pa.actions.join(", ")})` : ""}. Nothing in them says AI.` });
    }
    checks.push({
      key: "c2pa", icon: "lock", name: "Content Credentials (C2PA)", what: "A signed record that AI tools such as ChatGPT, Gemini and Adobe Firefly attach, saying how the image was made.",
      status: !c2pa ? "skipped" : statusOf(findings, c2pa.present ? "note" : "clear"), findings,
      summary: !c2pa ? "Not checked." : c2pa.isAiGenerated ? "The image declares itself AI-generated." : c2pa.present ? "Present, and it doesn't mention AI." : "None in the file. That's normal: most phone photos don't carry them.",
    });
  }

  // 2. Watermarks
  {
    const findings: Finding[] = [];
    if (watermark?.detected) {
      findings.push({
        severity: "critical",
        title: watermark.generatorSignature ? `${watermark.generatorSignature.tool} generation record in the file` : watermark.visibleMark ? `Visible ${watermark.visibleMark.generator} watermark` : "Invisible AI watermark declared",
        detail: sentence(watermark.reason),
      });
    }
    checks.push({
      key: "watermark", icon: "image-magic", name: "AI watermarks", what: "Looks for generator signatures hidden in the file and visible marks such as Gemini's sparkle in the corner.",
      status: !watermark ? "skipped" : statusOf(findings, "clear"), findings,
      summary: !watermark ? "Not checked." : watermark.detected ? "An AI watermark or signature was found." : "No AI watermark or signature found. Invisible pixel watermarks such as Google's SynthID can't be checked offline.",
    });
  }

  // 3. Metadata
  {
    const findings: Finding[] = [];
    if (exif?.suspiciousSoftwareMatch) findings.push({ severity: "critical", title: "AI tool named in the metadata", detail: `The file's software or creator field says "${exif.suspiciousSoftwareMatch}".` });
    if (exif?.xmpDigitalSourceType) findings.push({ severity: "critical", title: "Metadata labels it AI-made", detail: `Its source type is "${exif.xmpDigitalSourceType}", the standard label for AI-generated media.` });
    if (exif?.generatorMetadata && !watermark?.generatorSignature) findings.push({ severity: "critical", title: "AI generation record", detail: `The file carries an embedded ${exif.generatorMetadata.tool} generation record.` });
    if (exif?.suspiciousFileNameMatch) findings.push({ severity: "critical", title: "File name looks AI-generated", detail: "The file name matches the pattern an AI generator uses when it saves images." });
    if (exif?.generatorSizeMatch) findings.push({ severity: "warning", title: "Image size matches an AI generator", detail: `${exif.image?.width}×${exif.image?.height} is a standard ${exif.generatorSizeMatch.generator} output size. Phone cameras rarely produce this exact size.` });
    if (exif?.metadataStripped) findings.push({ severity: "info", title: "No metadata at all", detail: "No camera, software or date details. WhatsApp and other messaging apps remove these, so on its own this doesn't count against the photo." });
    else if (exif && !exif.hasCameraMetadata) findings.push({ severity: "info", title: "No camera details", detail: "No camera make or model saved. Common for screenshots, downloads and forwarded photos." });
    const camera = [exif?.camera?.make, exif?.camera?.model].filter(Boolean).join(" ");
    checks.push({
      key: "metadata", icon: "file", name: "Photo metadata (EXIF)", what: "Reads the camera, software and date details saved inside the file.",
      status: !exif ? "skipped" : statusOf(findings, exif.hasCameraMetadata ? "clear" : "note"), findings,
      summary: !exif ? "Not checked." : findings.some((finding) => finding.severity === "critical") ? "The metadata points to an AI tool."
        : camera ? `Taken with ${camera}${exif.dateTimeOriginal ? ` on ${formatDate(exif.dateTimeOriginal)}` : ""}.` : "No camera details to confirm or rule anything out.",
    });
  }

  // 4. Reuse
  {
    const findings: Finding[] = [];
    const match = hash?.match;
    if (match) {
      const copy = match.matchType === "exact" ? "An identical copy" : `A near-identical copy (${match.distance} of 64 bits differ)`;
      findings.push({
        severity: match.sameTicket ? "info" : match.previousVerdict === "likely_ai" ? "critical" : "warning",
        title: match.sameTicket ? "Same photo sent twice on this ticket" : match.previousVerdict === "likely_ai" ? "Copy of a photo already flagged as AI" : `Already used on ticket #${match.ticketNumber}`,
        detail: `${copy} of "${match.fileName}" was sent ${match.sameTicket ? "earlier on this same ticket" : `with ticket #${match.ticketNumber}`}${match.uploadedAt ? ` on ${formatDate(match.uploadedAt)}` : ""}${match.previousVerdict === "likely_ai" ? ", and that photo was identified as AI-generated" : ""}.`,
        ...(match.sameTicket ? {} : { href: links.ticket(match.ticketId), hrefLabel: `Open ticket #${match.ticketNumber}` }),
      });
    }
    checks.push({
      key: "reuse", icon: "duplicate", name: "Reused photo check", what: "Compares this image with every photo customers have sent your store, including resized and re-saved copies.",
      status: !hash ? "skipped" : statusOf(findings, match ? "note" : "clear"), findings,
      summary: !hash ? "Not checked." : !match ? "Not seen on any other request." : match.sameTicket ? "Only repeated on this ticket, which is normal." : `Also sent with ticket #${match.ticketNumber}.`,
    });
  }

  // 5. AI detector
  {
    const findings: Finding[] = [];
    let status: CheckStatus = "skipped";
    let summary = "Didn't run on this photo.";
    let extra: ReactNode;
    const label = classifier?.providerLabel || "AI detector";
    if (typeof classifier?.aiProbability === "number") {
      const score = classifier.aiProbability;
      findings.push({
        severity: score >= 70 ? "critical" : score >= 40 ? "warning" : "success",
        title: score >= 70 ? `Detector says likely AI (${score}%)` : score >= 40 ? `Detector is unsure (${score}%)` : `Detector says likely genuine (${score}% AI)`,
        detail: `${classifier.reasoning || `${label} rates this ${score}% likely AI-generated.`}${classifier.reused ? " This is the earlier result for the same image, so no new check was used." : ""}`,
      });
      status = statusOf(findings, "clear");
      summary = `${label} scored it ${score}% likely AI-generated.`;
      const generators = (classifier.generators || []).filter((generator) => generator.score >= 5).slice(0, 4);
      extra = <div style={{ display: "grid", gap: 12 }}>
        <ScoreBar value={score} label="Chance it's AI-generated" />
        {generators.length > 0 && score >= 40 && <div style={{ display: "grid", gap: 4 }}>
          <s-text color="subdued">Most likely made with</s-text>
          {generators.map((generator) => <div key={generator.name} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><s-text>{generator.name}</s-text><s-text color="subdued">{generator.score}%</s-text></div>)}
        </div>}
        {typeof classifier.editProbability === "number" && <s-text color="subdued">Manipulation score: {classifier.editProbability}% (counted as editing at 70% or more)</s-text>}
      </div>;
    } else if (classifier?.error) {
      status = "failed";
      summary = "The detector didn't return a result.";
      findings.push({ severity: "warning", title: classifier.errorTitle || "The AI detector failed", detail: classifier.errorHint || classifier.error });
    } else if (classifier?.missingApiKey) {
      summary = "No AI detector is connected, so only the free checks ran.";
      findings.push({ severity: "info", title: "AI detector not connected", detail: "Add your Sightengine or TruthScan key so photos the free checks can't settle get a specialist AI verdict.", href: links.settings, hrefLabel: "Connect detector" });
    } else if (classifier?.skipped) {
      summary = classifier.skipReason === "camera_original" ? "Not needed: this is a genuine camera photo." : classifier.skipReason === "manual" ? "Set to run only when you ask." : "Not needed: the checks above already settled it.";
      if (classifier.reason) findings.push({ severity: classifier.skipReason === "camera_original" ? "success" : "info", title: "Why it didn't run", detail: sentence(classifier.reason) });
    }
    checks.push({ key: "detector", icon: "wand", name: classifier?.providerLabel ? `AI detector (${classifier.providerLabel})` : "AI detector", what: "A specialist AI model looks at the pixels themselves and scores how likely the image is AI-made.", status, summary, findings, extra });
  }

  // 6. Editing
  {
    const findings: Finding[] = (editing?.signals ?? []).map((signal) => ({
      severity: signal.strength === "strong" ? "warning" : signal.id === "camera_hardware_signature" ? "success" : "info",
      title: signal.strength === "info" && signal.id === "photoshop_segment" ? "Photoshop data (not evidence on its own)"
        : signal.strength === "info" && signal.id === "thumbnail_mismatch" ? "Preview mismatch (normal on phones)" : EDIT_TITLES[signal.id] || "Editing sign",
      detail: sentence(signal.detail),
    }));
    const level = editing?.level;
    checks.push({
      key: "editing", icon: "edit", name: "Edit check", what: "Looks for signs the photo was edited, cropped or re-saved after it was taken. Editing isn't AI, but it means the photo isn't the original.",
      status: !editing ? "skipped" : statusOf(findings, level === "consistent" ? "clear" : "note"), findings,
      summary: !editing ? "Not checked." : level === "edited" ? `Edited after it was taken${editing.editor ? ` (${editing.editor})` : ""}.`
        : level === "not_original" ? "Not a camera original: re-saved by an app, a screenshot or a download."
        : level === "consistent" ? "Camera original with no signs of editing." : level === "limited" ? "Limited camera data, no signs of editing." : "Not enough data in the file to tell.",
    });
  }
  return checks;
}

function Glyph({ icon, tone, size = 32 }: { icon: IconType; tone: Tone; size?: number }) {
  return <span aria-hidden="true" style={{ flex: "none", display: "grid", placeItems: "center", width: size, height: size, borderRadius: 10, background: TONES[tone].soft, color: TONES[tone].ink }}>
    <s-icon type={icon} />
  </span>;
}

function FindingCard({ finding, source }: { finding: Finding; source?: string }) {
  const severity = SEVERITY[finding.severity];
  const tone = TONES[severity.tone];
  return <div style={{ display: "flex", gap: 12, padding: "12px 14px", borderRadius: 12, background: "#fff", border: "1px solid #E3E3E3", borderLeft: `4px solid ${tone.accent}` }}>
    <Glyph icon={severity.icon} tone={severity.tone} size={28} />
    <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <s-text type="strong">{finding.title}</s-text>
        <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: tone.soft, color: tone.ink, whiteSpace: "nowrap" }}>{severity.label}</span>
      </div>
      <s-text>{finding.detail}</s-text>
      {(source || finding.href) && <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        {source && <s-text color="subdued">Found by: {source}</s-text>}
        {finding.href && <s-link href={finding.href}>{finding.hrefLabel || "Open"}</s-link>}
      </div>}
    </div>
  </div>;
}

function CheckRow({ check, index }: { check: Check; index: number }) {
  const status = STATUS[check.status];
  const open = check.status === "issue" || check.status === "warning" || check.status === "failed";
  return <details open={open} style={{ borderRadius: 12, border: "1px solid #E3E3E3", background: "#fff", overflow: "hidden" }}>
    <summary style={{ listStyle: "none", cursor: "pointer", display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderLeft: `4px solid ${TONES[status.tone].accent}` }}>
      <Glyph icon={check.icon} tone={status.tone} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <s-text type="strong">{index + 1}. {check.name}</s-text>
        <div><s-text color="subdued">{check.summary}</s-text></div>
      </div>
      <s-badge tone={status.badge}>{status.label}</s-badge>
    </summary>
    <div style={{ display: "grid", gap: 10, padding: "4px 14px 14px 18px" }}>
      <div style={{ padding: "8px 12px", borderRadius: 8, background: "#F7F7F8" }}>
        <s-text color="subdued">What this check does: {check.what}</s-text>
      </div>
      {check.extra}
      {check.findings.map((finding, i) => <FindingCard key={i} finding={finding} />)}
      {!check.findings.length && !check.extra && <s-text color="subdued">Nothing found by this check.</s-text>}
    </div>
  </details>;
}

function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
    <s-heading>{children}</s-heading>
    {typeof count === "number" && <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#EEF0F3", color: "#4A4F5C" }}>{count}</span>}
  </div>;
}

export function PhotoThumb({ id, name, size = 64 }: { id: string; name: string; size?: number }) {
  const fetcher = useFetcher<{ url?: string; error?: string }>();
  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) void fetcher.load(`/app/help-desk-attachment?thumb=1&id=${encodeURIComponent(id)}`);
  }, [fetcher, id]);
  return <div style={{ width: size, height: size, borderRadius: 10, overflow: "hidden", background: "#F1F2F4", display: "grid", placeItems: "center", flex: "none" }}>
    {fetcher.data?.url ? <img src={fetcher.data.url} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : fetcher.data?.error ? <s-icon type="image" /> : <s-spinner size="base" />}
  </div>;
}

function Report({ file, scan, ticketLink }: { file: { id: string; name: string }; scan: PhotoScan | null; ticketLink: (ticketId: string) => string }) {
  if (!scan || scan.status === "pending") {
    return <s-stack gap="base" alignItems="center"><s-spinner size="large" /><s-text color="subdued">{scan ? "Checking this photo now. The report appears here when it's done." : "This photo hasn't been checked yet. Use Re-scan to check it."}</s-text></s-stack>;
  }
  if (scan.status === "failed") {
    return <s-banner tone="warning" heading="The check didn't finish">{scan.error || "Use Re-scan to try again."}</s-banner>;
  }
  const verdict = PHOTO_VERDICT[scan.overallVerdict || "error"] ?? PHOTO_VERDICT.error;
  const tone = TONES[verdict.tone];
  const checks = buildChecks(scan, { ticket: ticketLink, settings: "/app/help-desk?settings=1&part=photos" });
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2, success: 3 };
  const issues = checks.flatMap((check) => check.findings.filter((finding) => finding.severity === "critical" || finding.severity === "warning").map((finding) => ({ finding, source: check.name })))
    .sort((a, b) => rank[a.finding.severity] - rank[b.finding.severity]);
  const passed = checks.filter((check) => check.status === "clear").length;
  const confidence = typeof scan.overallConfidence === "number" && scan.overallVerdict !== "error" ? Math.round(scan.overallConfidence * 100) : null;
  const { exif, editing } = scan.layers;
  const details = [
    ["Size", exif?.image?.width && exif.image.height ? `${exif.image.width} × ${exif.image.height} px (${exif.image.megapixels} MP)` : ""],
    ["Format", exif?.image?.format?.toUpperCase() || ""],
    ["File size", formatBytes(exif?.image?.fileSize)],
    ["Camera", [exif?.camera?.make, exif?.camera?.model].filter(Boolean).join(" ") || "Not recorded"],
    ["Taken", formatDate(exif?.dateTimeOriginal || exif?.createDate) || "Not recorded"],
    ["Software", exif?.software || exif?.creatorTool || "Not recorded"],
    ["Location data", exif ? (exif.hasGps ? "Yes" : "No") : ""],
    ["Camera signature", editing?.cameraCoherence?.attested ? "Verified" : ""],
  ].filter(([, value]) => value);

  return <div style={{ display: "grid", gap: 18 }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", padding: 16, borderRadius: 14, background: tone.soft, border: `1px solid ${tone.accent}33` }}>
      <PhotoThumb id={file.id} name={file.name} size={96} />
      <div style={{ flex: "1 1 260px", minWidth: 0, display: "grid", gap: 6 }}>
        <s-text color="subdued">{file.name}</s-text>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Glyph icon={verdict.icon} tone={verdict.tone} size={36} />
          <span style={{ fontSize: 22, fontWeight: 700, color: tone.ink, lineHeight: 1.2 }}>{verdict.label}</span>
        </div>
        <s-text>{verdict.meaning}</s-text>
        {confidence !== null && <div style={{ display: "flex", alignItems: "center", gap: 10, maxWidth: 360 }}>
          <div aria-hidden="true" style={{ flex: 1, height: 8, borderRadius: 8, background: "#ffffffaa", overflow: "hidden" }}>
            <div style={{ width: `${confidence}%`, height: "100%", borderRadius: 8, background: tone.accent }} />
          </div>
          <s-text type="strong">{confidence}% confidence</s-text>
        </div>}
      </div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
      {[
        { label: "Issues found", value: issues.length, tone: issues.length ? (issues.some((issue) => issue.finding.severity === "critical") ? TONES.red : TONES.amber) : TONES.green },
        { label: "Checks passed", value: `${passed} of ${checks.length}`, tone: TONES.green },
        { label: "Checks not run", value: checks.filter((check) => check.status === "skipped" || check.status === "failed").length, tone: TONES.gray },
      ].map((stat) => <div key={stat.label} style={{ padding: "10px 12px", borderRadius: 10, background: "#F7F7F8", borderTop: `3px solid ${stat.tone.accent}` }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#1A1A1A" }}>{stat.value}</div>
        <s-text color="subdued">{stat.label}</s-text>
      </div>)}
    </div>

    <div style={{ display: "flex", gap: 12, padding: "12px 14px", borderRadius: 12, background: "#E9EDFB", border: "1px solid #C9D3F5" }}>
      <Glyph icon="info" tone="blue" size={28} />
      <div style={{ display: "grid", gap: 2 }}>
        <s-text type="strong">What to do</s-text>
        <s-text>{verdict.advice}</s-text>
      </div>
    </div>

    <div style={{ display: "grid", gap: 10 }}>
      <SectionTitle count={issues.length}>Issues found</SectionTitle>
      {issues.length ? issues.map((issue, index) => <FindingCard key={index} finding={issue.finding} source={issue.source} />)
        : <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 12, background: TONES.green.soft }}>
          <Glyph icon="check-circle" tone="green" size={28} />
          <s-text>No issues found. None of the checks found signs of AI generation, reuse or editing.</s-text>
        </div>}
    </div>

    <div style={{ display: "grid", gap: 10 }}>
      <SectionTitle count={checks.length}>Every check, step by step</SectionTitle>
      <s-text color="subdued">The free checks (1-4) run first. The AI detector (5) is used only when they can&apos;t settle it. Click a check to see what it looked at.</s-text>
      {checks.map((check, index) => <CheckRow key={check.key} check={check} index={index} />)}
    </div>

    {details.length > 0 && <div style={{ display: "grid", gap: 10 }}>
      <SectionTitle>Photo details</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
        {details.map(([label, value]) => <div key={label} style={{ padding: "8px 12px", borderRadius: 8, background: "#F7F7F8", overflowWrap: "anywhere" }}>
          <s-text color="subdued">{label}</s-text>
          <div><s-text>{value}</s-text></div>
        </div>)}
      </div>
    </div>}

    <s-text color="subdued">A finding is evidence, not proof. Use it to decide whether to ask the customer for more photos. Messaging apps often remove metadata, so missing metadata never counts against a photo by itself.</s-text>
  </div>;
}

type ScanResponse = { errors: Record<string, string> };

// One popup per page: open it with the photo to show, it closes itself.
export function PhotoReportModal({ file, onClose, ticketLink }: {
  file: { id: string; name: string; scan: PhotoScan | null } | null; onClose: () => void; ticketLink: (ticketId: string) => string;
}) {
  const id = `photo-report-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const modal = useRef<{ showOverlay: () => void }>(null);
  const fetcher = useFetcher<ScanResponse>();
  const shopify = useAppBridge();
  const lastForce = useRef(false);
  const pending = fetcher.state !== "idle";
  useEffect(() => { if (file) modal.current?.showOverlay(); }, [file?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const errors = Object.values(fetcher.data.errors);
    shopify.toast.show(errors[0] || (lastForce.current ? "Checked with the AI detector" : "Photo re-scanned"), { isError: Boolean(errors.length) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
  const run = (force: boolean) => {
    if (!file) return;
    lastForce.current = force;
    void fetcher.submit({ intent: "scan", id: file.id, force: String(force) }, { method: "post", action: "/app/help-desk" });
  };
  const classifier = file?.scan?.layers.classifier;
  const detectorRan = typeof classifier?.aiProbability === "number" && !classifier.reused;
  return <s-modal ref={modal as never} id={id} heading="AI photo check report" size="large" onHide={onClose}>
    {file && <Report file={file} scan={file.scan} ticketLink={ticketLink} />}
    <s-button slot="secondary-actions" icon="refresh" loading={pending && !lastForce.current} disabled={pending || !file} onClick={() => run(false)}>Re-scan</s-button>
    {file && !detectorRan && <s-button slot="secondary-actions" icon="wand" loading={pending && lastForce.current} disabled={pending} onClick={() => run(true)}>Check with AI detector</s-button>}
    <s-button slot="primary-action" variant="primary" commandFor={id} command="--hide">Done</s-button>
  </s-modal>;
}

// The clickable result under a photo: verdict plus "View report".
export function PhotoCheckButton({ scan, onOpen }: { scan: PhotoScan | null; onOpen: () => void }) {
  const verdict = scan?.status === "completed" ? PHOTO_VERDICT[scan.overallVerdict || "error"] ?? PHOTO_VERDICT.error : null;
  const label = !scan ? "Not checked" : scan.status === "pending" ? "Checking photo" : scan.status === "failed" ? "Scan incomplete" : verdict!.label;
  const tone = TONES[verdict?.tone || "gray"];
  return <s-clickable onClick={onOpen} accessibilityLabel={`${label}. View the photo check report`} borderRadius="base">
    <div style={{ display: "grid", gap: 2, padding: "6px 10px", borderRadius: 10, background: tone.soft, color: tone.ink, fontSize: 12, lineHeight: 1.3, border: `1px solid ${tone.accent}40` }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <span aria-hidden="true" style={{ flex: "none", width: 8, height: 8, borderRadius: "50%", background: tone.accent }} />
        {label}
      </span>
      <span style={{ textDecoration: "underline" }}>View report ›</span>
    </div>
  </s-clickable>;
}
