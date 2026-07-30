/** Bounded rlm_run call/result rendering without answer or error text. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { BudgetUsage } from "../../core/index.ts";
import type { RlmResultMetadata } from "../result.ts";
import {
  displayIdentitySuffix,
  sanitizeDisplayText,
  truncateDisplayLine,
} from "../run-display.ts";
import {
  fitStyledLine,
  plainVisualStyle,
  statusGlyph,
  visualStyleForTheme,
  type VisualStyle,
} from "./visual-style.ts";

const SAFE_CODE = /^[A-Z][A-Z0-9_-]{0,63}$/;
const SAFE_RUN_ID = /^run_[a-f0-9]{64}$/;
const MAX_WARNING_CODES = 8;
const MAX_RESULT_CONTENT_BYTES = 128 * 1024;
const COLLAPSED_BODY_LINES = 6;
const EXPANDED_BODY_LINES = 40;

interface ResultDisplayModel {
  readonly valid: boolean;
  readonly runId: string | null;
  readonly status: RlmResultMetadata["status"];
  readonly mode: RlmResultMetadata["mode"];
  readonly errorCode?: string;
  readonly warningCodes: readonly string[];
  readonly usage: BudgetUsage | null;
  readonly truncation: RlmResultMetadata["truncation"];
}

interface ResultDisplayBody {
  readonly kind: "answer" | "error";
  readonly lines: readonly string[];
}

const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const code = (value: unknown, fallback: string): string =>
  typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;

const integer = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const compact = (value: unknown): string => {
  const safe = integer(value);
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}k`;
  if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}m`;
  return `${(safe / 1_000_000_000).toFixed(1)}b`;
};

const usageFields = [
  "framesOpened", "logicalCalls", "attempts", "controllerTurns", "activeLeafCalls",
  "tokensReserved", "tokensUsed", "inputTokensUsed", "outputTokensUsed",
  "costUsd", "providerDurationMs", "storedBytes",
] as const satisfies readonly (keyof BudgetUsage)[];

const copyUsage = (value: unknown): BudgetUsage | null => {
  if (value === null || typeof value !== "object") return null;
  const copied = Object.fromEntries(usageFields.map((key) => [
    key,
    key === "costUsd" ? finite(own(value, key)) : integer(own(value, key)),
  ])) as unknown as BudgetUsage;
  return Object.freeze(copied);
};

const copyWarnings = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return Object.freeze([]);
  const warnings: string[] = [];
  const length = Math.min(integer(own(value, "length")), MAX_WARNING_CODES);
  for (let index = 0; index < length; index += 1)
    warnings.push(code(own(value, String(index)), "RLM_WARNING"));
  return Object.freeze(warnings);
};

const invalidModel = (): ResultDisplayModel => Object.freeze({
  valid: false,
  runId: null,
  status: "failed",
  mode: null,
  errorCode: "RLM_RESULT_INVALID",
  warningCodes: Object.freeze([]),
  usage: null,
  truncation: Object.freeze({ truncated: false, originalBytes: 0, omittedBytes: 0 }),
});

/** Copy validated own scalar data. Accessors and throwing proxies fail to a constant model. */
const projectMetadata = (value: unknown): ResultDisplayModel => {
  try {
    const runId = own(value, "runId");
    const rawStatus = own(value, "status");
    const rawMode = own(value, "mode");
    const validMode = rawMode === "answer" || rawMode === "fallback_extract";
    const status = rawStatus === "completed"
      ? (validMode ? "completed" : "failed")
      : rawStatus === "cancelled" ? "cancelled" : "failed";
    const truncation = own(value, "truncation");
    const rawErrorCode = own(value, "errorCode");
    const validRunId = typeof runId === "string" && SAFE_RUN_ID.test(runId);
    const bindableIdentity = validRunId && (
      (rawStatus === "completed" && validMode)
      || ((rawStatus === "failed" || rawStatus === "cancelled") && rawMode === null
        && typeof rawErrorCode === "string" && SAFE_CODE.test(rawErrorCode))
    );
    return Object.freeze({
      valid: bindableIdentity,
      runId: validRunId
        ? sanitizeDisplayText(runId, 256)
        : null,
      status,
      mode: status === "completed" ? rawMode as ResultDisplayModel["mode"] : null,
      ...(status !== "completed" ? {
        errorCode: status !== rawStatus
          ? "RLM_RESULT_INVALID"
          : code(rawErrorCode, status === "cancelled" ? "CANCELLED" : "RLM_RUN_FAILED"),
      } : {}),
      warningCodes: copyWarnings(own(value, "warningCodes")),
      usage: copyUsage(own(value, "usage")),
      truncation: Object.freeze({
        truncated: own(truncation, "truncated") === true,
        originalBytes: integer(own(truncation, "originalBytes")),
        omittedBytes: integer(own(truncation, "omittedBytes")),
      }),
    });
  } catch { return invalidModel(); }
};

const bodyLines = (value: string): readonly string[] => Object.freeze(value
  .split(/\r\n|\r|\n/u)
  .slice(0, 256)
  .map((line) => sanitizeDisplayText(line, 4 * 1024)));

const answerText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const answer = own(value, "answer");
    if (keys.length === 1 && typeof answer === "string") return answer;
  }
  try { return JSON.stringify(value, null, 2); }
  catch { return undefined; }
};

/** Bind bounded human-readable content to the same status and run identity as metadata. */
const projectBody = (content: unknown, metadata: ResultDisplayModel): ResultDisplayBody | undefined => {
  try {
    if (!metadata.valid || metadata.runId === null) return undefined;
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_RESULT_CONTENT_BYTES) return undefined;
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (own(parsed, "status") !== metadata.status || own(parsed, "runId") !== metadata.runId) return undefined;
    if (metadata.status === "completed") {
      const raw = own(parsed, "answer") ?? own(parsed, "answerPreview");
      const text = answerText(raw);
      return text === undefined ? undefined : Object.freeze({ kind: "answer", lines: bodyLines(text) });
    }
    const error = own(parsed, "error");
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    const rawCode = own(error, "code");
    const message = own(error, "message");
    if (typeof message !== "string" || typeof rawCode !== "string"
      || code(rawCode, "RLM_RUN_FAILED") !== code(metadata.errorCode, "RLM_RUN_FAILED")) return undefined;
    return Object.freeze({ kind: "error", lines: bodyLines(message) });
  } catch { return undefined; }
};

const textContent = (value: unknown): string | undefined => {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) return undefined;
    const first = own(value, "0");
    if (!first || typeof first !== "object" || Array.isArray(first)
      || own(first, "type") !== "text") return undefined;
    const text = own(first, "text");
    return typeof text === "string" ? text : undefined;
  } catch { return undefined; }
};

const statusText = (metadata: ResultDisplayModel, style: VisualStyle): string => {
  const identity = metadata.runId
    ? style.tone("accent", `#${displayIdentitySuffix("", metadata.runId)}`)
    : "";
  if (metadata.status === "completed") {
    const mode = metadata.mode === "fallback_extract" ? "fallback extract" : "answer";
    return [statusGlyph("completed", style), style.strong("RLM completed"), identity, style.tone("muted", mode)]
      .filter(Boolean).join("  ");
  }
  if (metadata.status === "cancelled")
    return [statusGlyph("cancelled", style), style.strong("RLM cancelled"), identity].filter(Boolean).join("  ");
  return [
    statusGlyph("failed", style),
    style.strong("RLM failed"),
    identity,
    style.tone("error", code(metadata.errorCode, "RLM_RUN_FAILED")),
  ].filter(Boolean).join("  ");
};

const usageText = (usage: BudgetUsage): string => {
  const segments = [
    `calls ${integer(usage.logicalCalls)}`,
    `frames ${integer(usage.framesOpened)}`,
    `${compact(usage.tokensUsed)} tok`,
  ];
  const cost = finite(usage.costUsd);
  if (cost > 0) segments.push(`$${cost.toFixed(4)}`);
  const duration = integer(usage.providerDurationMs);
  if (duration > 0) segments.push(`provider ${(duration / 1_000).toFixed(1)}s`);
  return segments.join(" · ");
};

const renderModel = (
  safe: ResultDisplayModel,
  width: number,
  style: VisualStyle = plainVisualStyle,
  body?: ResultDisplayBody,
  expanded = false,
): string[] => {
  const lines = [statusText(safe, style)];
  if (safe.usage) lines.push(`  ${style.tone("muted", usageText(safe.usage))}`);
  if (body) {
    lines.push(`  ${style.strong(body.kind === "answer" ? "Answer" : "Error")}`);
    const bodyWidth = Math.max(1, Math.floor(width) - 4);
    const wrapped = body.lines.flatMap((line) => {
      const rendered = wrapTextWithAnsi(style.tone("text", line), bodyWidth);
      return rendered.length > 0 ? rendered : [""];
    });
    const lineLimit = expanded ? EXPANDED_BODY_LINES : COLLAPSED_BODY_LINES;
    wrapped.slice(0, lineLimit).forEach((line) => lines.push(`    ${line}`));
    if (wrapped.length > lineLimit) lines.push(`    ${style.tone("muted", "… expand to view more")}`);
  }
  if (safe.warningCodes.length > 0)
    lines.push(`  ${statusGlyph("approval", style)} ${style.tone("warning", `${safe.warningCodes.length} warning${safe.warningCodes.length === 1 ? "" : "s"}`)}  ${style.tone("muted", safe.warningCodes.join(", "))}`);
  if (safe.truncation.truncated)
    lines.push(`  ${statusGlyph("approval", style)} ${style.tone("warning", "Result truncated")}  ${style.tone("muted", `${compact(safe.truncation.originalBytes)} bytes · ${compact(safe.truncation.omittedBytes)} omitted`)}`);
  return lines.map((line) => fitStyledLine(line, width)).filter((line) => line.length > 0);
};

/** Render result details from bounded metadata only, never content/error text or output refs. */
export const renderRlmRunResult = (metadata: unknown, width: number): string[] =>
  renderModel(projectMetadata(metadata), width);

export const renderRlmRunCall = (width: number): string[] =>
  [truncateDisplayLine("RLM run", width)].filter((line) => line.length > 0);

export class RlmRunCallComponent implements Component {
  private readonly style: VisualStyle;
  constructor(theme?: Theme) { this.style = visualStyleForTheme(theme); }
  render(width: number): string[] { return [fitStyledLine(this.style.strong("RLM run"), width)].filter(Boolean); }
  invalidate(): void {}
}

export class RlmRunResultComponent implements Component {
  private readonly metadata: ResultDisplayModel;
  private readonly style: VisualStyle;
  private readonly body?: ResultDisplayBody;
  private readonly expanded: boolean;
  constructor(metadata: unknown, theme?: Theme, content?: unknown, expanded = false) {
    this.metadata = projectMetadata(metadata);
    this.style = visualStyleForTheme(theme);
    this.body = projectBody(content, this.metadata);
    this.expanded = expanded;
  }
  render(width: number): string[] {
    return renderModel(this.metadata, width, this.style, this.body, this.expanded);
  }
  invalidate(): void {}
}

export const renderRlmRunCallComponent = (theme?: Theme): Component => new RlmRunCallComponent(theme);
export const renderRlmRunResultComponent = (metadata: unknown, theme?: Theme): Component =>
  new RlmRunResultComponent(metadata, theme);

/** Custom-message adapter. Human-readable bounded content is identity-bound to details. */
export const renderRlmMessageResultComponent = (
  message: unknown,
  expanded: boolean,
  theme?: Theme,
): Component => {
  try { return new RlmRunResultComponent(own(message, "details"), theme, own(message, "content"), expanded); }
  catch { return new RlmRunResultComponent(undefined, theme); }
};

/** No-throw Pi adapter. It projects the first bounded text result and never permits raw fallback. */
export const renderRlmToolResultComponent = (
  result: unknown,
  theme?: Theme,
  expanded = false,
): Component => {
  try {
    return new RlmRunResultComponent(
      own(result, "details"),
      theme,
      textContent(own(result, "content")),
      expanded,
    );
  } catch { return new RlmRunResultComponent(undefined, theme); }
};
