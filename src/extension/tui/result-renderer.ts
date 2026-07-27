/** Bounded rlm_run call/result rendering without answer or error text. */

import type { Component } from "@earendil-works/pi-tui";
import type { BudgetUsage } from "../../core/index.ts";
import type { RlmResultMetadata } from "../result.ts";
import {
  displayIdentitySuffix,
  sanitizeDisplayText,
  truncateDisplayLine,
} from "../run-display.ts";

const SAFE_CODE = /^[A-Z][A-Z0-9_-]{0,63}$/;
const SAFE_RUN_ID = /^run_[a-f0-9]{64}$/;
const MAX_WARNING_CODES = 8;

interface ResultDisplayModel {
  readonly runId: string | null;
  readonly status: RlmResultMetadata["status"];
  readonly mode: RlmResultMetadata["mode"];
  readonly errorCode?: string;
  readonly warningCodes: readonly string[];
  readonly usage: BudgetUsage | null;
  readonly truncation: RlmResultMetadata["truncation"];
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
    return Object.freeze({
      runId: typeof runId === "string" && SAFE_RUN_ID.test(runId)
        ? sanitizeDisplayText(runId, 256)
        : null,
      status,
      mode: status === "completed" ? rawMode as ResultDisplayModel["mode"] : null,
      ...(status === "failed" ? {
        errorCode: status !== rawStatus
          ? "RLM_RESULT_INVALID"
          : code(rawErrorCode, "RLM_RUN_FAILED"),
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

const statusText = (metadata: ResultDisplayModel): string => {
  const identity = metadata.runId ? ` #${displayIdentitySuffix("", metadata.runId)}` : "";
  if (metadata.status === "completed") {
    const mode = metadata.mode === "fallback_extract" ? "fallback extract" : "answer";
    return `RLM completed${identity} · ${mode}`;
  }
  if (metadata.status === "cancelled") return `RLM cancelled${identity}`;
  return `RLM failed${identity} · ${code(metadata.errorCode, "RLM_RUN_FAILED")}`;
};

const usageText = (usage: BudgetUsage): string => {
  const segments = [
    `usage calls ${integer(usage.logicalCalls)}`,
    `frames ${integer(usage.framesOpened)}`,
    `tokens ${compact(usage.tokensUsed)}`,
  ];
  const cost = finite(usage.costUsd);
  if (cost > 0) segments.push(`$${cost.toFixed(4)}`);
  const duration = integer(usage.providerDurationMs);
  if (duration > 0) segments.push(`provider ${(duration / 1_000).toFixed(1)}s`);
  return segments.join(" · ");
};

const renderModel = (safe: ResultDisplayModel, width: number): string[] => {
  const lines = [statusText(safe)];
  if (safe.usage) lines.push(usageText(safe.usage));
  if (safe.warningCodes.length > 0)
    lines.push(`warnings ${safe.warningCodes.length}: ${safe.warningCodes.join(", ")}`);
  if (safe.truncation.truncated)
    lines.push(`result truncated · ${compact(safe.truncation.originalBytes)} bytes · ${compact(safe.truncation.omittedBytes)} omitted`);
  return lines.map((line) => truncateDisplayLine(line, width)).filter((line) => line.length > 0);
};

/** Render result details from bounded metadata only, never content/error text or output refs. */
export const renderRlmRunResult = (metadata: unknown, width: number): string[] =>
  renderModel(projectMetadata(metadata), width);

export const renderRlmRunCall = (width: number): string[] =>
  [truncateDisplayLine("RLM run", width)].filter((line) => line.length > 0);

export class RlmRunCallComponent implements Component {
  render(width: number): string[] { return renderRlmRunCall(width); }
  invalidate(): void {}
}

export class RlmRunResultComponent implements Component {
  private readonly metadata: ResultDisplayModel;
  constructor(metadata: unknown) { this.metadata = projectMetadata(metadata); }
  render(width: number): string[] { return renderModel(this.metadata, width); }
  invalidate(): void {}
}

export const renderRlmRunCallComponent = (): Component => new RlmRunCallComponent();
export const renderRlmRunResultComponent = (metadata: unknown): Component =>
  new RlmRunResultComponent(metadata);

/** No-throw Pi adapter. It never accesses result.content and never permits raw fallback. */
export const renderRlmToolResultComponent = (result: unknown): Component => {
  try { return new RlmRunResultComponent(own(result, "details")); }
  catch { return new RlmRunResultComponent(undefined); }
};
