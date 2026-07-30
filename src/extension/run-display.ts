/** Pure, terminal-safe display projection for coordinated runs. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CoordinatedRun, CoordinatedRunState } from "./run-coordinator.ts";
import type { PendingAgentApprovalProjection } from "./agent-approval-coordinator.ts";
import type { RunProgressSnapshot } from "../runtime/index.ts";
import {
  fitStyledLine,
  plainVisualStyle,
  renderPanel,
  statusGlyph,
  type VisualStyle,
} from "./tui/visual-style.ts";

export const DISPLAY_TEXT_MAX_BYTES = 4 * 1024;
export const RUN_DISPLAY_MAX_ROWS = 3;
export const RUN_DISPLAY_COMPACT_WIDTH = 60;
export const RUN_DISPLAY_MAX_INPUTS = 48;

const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const C0_OR_C1 = /[\u0000-\u001f\u007f-\u009f]/u;
const COLLAPSIBLE = /[\t\n\r\u2028\u2029]/u;

const consumeStringControl = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
};

const consumeCsi = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
};

const consumeEscape = (value: string, escape: number): number => {
  const next = value.charCodeAt(escape + 1);
  if (next === 0x5b) return consumeCsi(value, escape + 2);
  if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f)
    return consumeStringControl(value, escape + 2);
  let index = escape + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) { index += 1; continue; }
    return index + 1;
  }
  return index;
};

const safeByteLimit = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, DISPLAY_TEXT_MAX_BYTES) : DISPLAY_TEXT_MAX_BYTES;

/**
 * Remove terminal escape/control and bidi state, collapse line-like whitespace,
 * and cut only between Unicode code points at a fixed UTF-8 byte bound.
 */
export const sanitizeDisplayText = (value: unknown, maxBytes = DISPLAY_TEXT_MAX_BYTES): string => {
  if (typeof value !== "string") return "";
  const limit = safeByteLimit(maxBytes);
  let output = "";
  let bytes = 0;
  let pendingSpace = false;
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) { index = consumeEscape(value, index); continue; }
    if (code === 0x9b) { index = consumeCsi(value, index + 1); continue; }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = consumeStringControl(value, index + 1);
      continue;
    }
    const point = String.fromCodePoint(value.codePointAt(index)!);
    index += point.length;
    if (COLLAPSIBLE.test(point)) { pendingSpace = output.length > 0; continue; }
    if (C0_OR_C1.test(point) || BIDI.test(point)) continue;
    if (pendingSpace) {
      if (bytes + 1 > limit) break;
      output += " ";
      bytes += 1;
      pendingSpace = false;
    }
    const size = Buffer.byteLength(point, "utf8");
    if (size > limit - bytes) break;
    output += point;
    bytes += size;
  }
  return output;
};

/** Sanitize and truncate one final terminal line by visible columns. */
export const truncateDisplayLine = (value: unknown, width: number): string => {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (limit === 0) return "";
  const safe = sanitizeDisplayText(value);
  return visibleWidth(safe) <= limit
    ? safe
    : sanitizeDisplayText(truncateToWidth(safe, limit, "…"));
};

export const displayIdentitySuffix = (localId: unknown, runId?: unknown): string => {
  const selected = sanitizeDisplayText(typeof runId === "string" && runId ? runId : localId, 256);
  return Array.from(selected).slice(-8).join("") || "unknown";
};

export interface RunDisplayItem {
  readonly localId: string;
  readonly runId?: string;
  readonly state: Extract<CoordinatedRunState, "running" | "cancelling">;
  readonly progress?: RunProgressSnapshot;
  readonly pendingApproval?: PendingAgentApprovalProjection;
}

const safeInteger = (value: number | undefined): number =>
  Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;

const priority = (left: RunDisplayItem, right: RunDisplayItem): number => {
  if (!!left.pendingApproval !== !!right.pendingApproval) return left.pendingApproval ? -1 : 1;
  if (left.state !== right.state) return left.state === "cancelling" ? -1 : 1;
  const sequence = safeInteger(right.progress?.sequence) - safeInteger(left.progress?.sequence);
  return sequence || left.localId.localeCompare(right.localId);
};

/** Copy only display-safe fields; never retain session, authority, paths, or objective text. */
export const projectRunDisplayItems = (runs: readonly CoordinatedRun[]): readonly RunDisplayItem[] =>
  Object.freeze(runs
    .filter((run) => run.state === "running" || run.state === "cancelling")
    .map((run) => Object.freeze({
      localId: run.localId,
      ...(run.runId ? { runId: run.runId } : {}),
      state: run.state as RunDisplayItem["state"],
      ...(run.progress ? { progress: run.progress } : {}),
      ...(run.pendingApproval ? { pendingApproval: Object.freeze({
        requestSha256: sanitizeDisplayText(run.pendingApproval.requestSha256, 64),
        agent: sanitizeDisplayText(run.pendingApproval.agent, 128),
        taskSha256: sanitizeDisplayText(run.pendingApproval.taskSha256, 64),
        context: run.pendingApproval.context,
        ...(run.pendingApproval.model ? { model: sanitizeDisplayText(run.pendingApproval.model, 256) } : {}),
        ...(run.pendingApproval.thinking ? { thinking: sanitizeDisplayText(run.pendingApproval.thinking, 256) } : {}),
        count: safeInteger(run.pendingApproval.count),
      }) } : {}),
    }))
    .sort(priority)
    .slice(0, RUN_DISPLAY_MAX_INPUTS));

const compactNumber = (value: number | undefined): string => {
  const safe = safeInteger(value);
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}k`;
  if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}m`;
  return `${(safe / 1_000_000_000).toFixed(safe < 10_000_000_000 ? 1 : 0)}b`;
};

const elapsed = (elapsedMs: number | undefined): string => {
  const seconds = Math.floor(safeInteger(elapsedMs) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
};

const approvalRow = (run: RunDisplayItem, style: VisualStyle): string => {
  const approval = run.pendingApproval!;
  const identity = `#${displayIdentitySuffix(run.localId, run.runId)}`;
  const agent = sanitizeDisplayText(approval.agent, 128) || "unknown";
  return [
    statusGlyph("approval", style),
    style.tone("accent", identity),
    style.strong("Approval"),
    style.tone("text", agent),
    style.tone("muted", `${safeInteger(approval.count)} pending`),
  ].join("  ");
};

const progressRow = (run: RunDisplayItem, width: number, style: VisualStyle): string => {
  const progress = run.progress;
  const identity = `#${displayIdentitySuffix(run.localId, run.runId)}`;
  const phase = sanitizeDisplayText(progress?.phase ?? "initializing", 64) || "initializing";
  const calls = safeInteger(progress?.calls.total);
  const callsActive = safeInteger(progress?.calls.active);
  const callsFailed = safeInteger(progress?.calls.failed);
  const frames = safeInteger(progress?.frames.total);
  const framesActive = safeInteger(progress?.frames.active);
  const marker = statusGlyph(run.state, style);
  const elapsedText = style.tone("muted", elapsed(progress?.elapsedMs));
  const callText = style.tone("muted", `calls ${calls}`);
  const frameText = style.tone("muted", `frames ${frames}`);
  const segments = [
    marker,
    style.tone("accent", identity),
    style.strong(phase),
    callText,
    ...(callsActive ? [style.tone("warning", `${callsActive} active`)] : []),
    ...(callsFailed ? [style.tone("error", `${callsFailed} failed`)] : []),
    frameText,
    ...(framesActive ? [style.tone("warning", `${framesActive} active`)] : []),
    style.tone("muted", `${compactNumber(progress?.budgets.tokensUsed)} tok`),
    elapsedText,
  ];
  const minimum = [marker, style.tone("accent", identity), style.strong(phase), elapsedText].join("  ");
  if (visibleWidth(segments.join("  ")) <= width) return segments.join("  ");
  if (width < 76) return minimum;
  return [marker, style.tone("accent", identity), style.strong(phase), callText, frameText, elapsedText].join("  ");
};

const sorted = (runs: readonly RunDisplayItem[]): RunDisplayItem[] => [...runs].sort(priority);

/** Render active runs with one hierarchy, bounded rows, and a contextual footer. */
export const renderRunDisplay = (
  runs: readonly RunDisplayItem[],
  width: number,
  style: VisualStyle = plainVisualStyle,
): string[] => {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const active = sorted(runs.filter((run) => run.state === "running" || run.state === "cancelling"))
    .slice(0, RUN_DISPLAY_MAX_INPUTS);
  if (active.length === 0 || limit === 0) return [];
  const cancelling = active.filter((run) => run.state === "cancelling").length;
  const approvalCount = active.reduce((total, run) => total + safeInteger(run.pendingApproval?.count), 0);
  if (limit < RUN_DISPLAY_COMPACT_WIDTH) {
    const marker = approvalCount ? statusGlyph("approval", style)
      : cancelling ? statusGlyph("cancelling", style) : statusGlyph("running", style);
    const counts = [
      `${active.length} active`,
      ...(approvalCount ? [`${approvalCount} approval`] : []),
      ...(cancelling ? [`${cancelling} cancelling`] : []),
    ];
    return [fitStyledLine(`${marker} ${style.strong("RLM")} · ${counts.join(" · ")}`, limit)];
  }

  const shown = active.slice(0, RUN_DISPLAY_MAX_ROWS);
  const hidden = active.length - shown.length;
  const titleParts = [
    "RLM runs",
    `${active.length} active`,
    ...(approvalCount ? [`${approvalCount} approval`] : []),
    ...(hidden ? [`+${hidden} more`] : []),
  ];
  const bodyWidth = Math.max(0, limit - 6);
  const body = shown.map((run) => run.pendingApproval
    ? approvalRow(run, style)
    : progressRow(run, bodyWidth, style));
  return renderPanel({
    title: titleParts.join(" · "),
    body,
    width: limit,
    style,
    footer: "/rlm runs for details",
  });
};

export const renderCoordinatedRuns = (runs: readonly CoordinatedRun[], width: number): string[] =>
  renderRunDisplay(projectRunDisplayItems(runs), width);
