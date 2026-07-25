/** Bounded, mode-independent extension result projections. */

import { canonicalStringify, headTailPreview, headPreview, type BudgetUsage, type JsonValue } from "../core/index.ts";
import type { RunResult } from "../runtime/index.ts";

export const FULL_ANSWER_MAX_BYTES = 64 * 1024;
const PREVIEW_SLICE_BYTES = 30 * 1024;
const ERROR_MESSAGE_MAX_BYTES = 1024;

export interface ResultTruncation {
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly omittedBytes: number;
}

export interface RlmResultMetadata {
  readonly runId: string | null;
  readonly status: "completed" | "failed" | "cancelled";
  readonly mode: "answer" | "fallback_extract" | null;
  readonly output: { readonly ref: string; readonly sha256: string; readonly bytes: number } | null;
  readonly usage: BudgetUsage | null;
  readonly warningCodes: readonly string[];
  readonly truncation: ResultTruncation;
  readonly errorCode?: string;
}

export interface RlmResultProjection extends RlmResultMetadata {
  readonly answer?: JsonValue;
  readonly answerPreview?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

const safeCode = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/.test(value) ? value : fallback;

const boundedMessage = (message: unknown, fallback: string): string => {
  if (typeof message !== "string") return fallback;
  const projected = headPreview(message, ERROR_MESSAGE_MAX_BYTES);
  return projected.truncated ? `${projected.text}\n[message truncated]` : projected.text;
};

export const projectRunResult = (result: RunResult): RlmResultProjection => {
  const warningCodes = (result.warnings ?? []).slice(-8).map((warning) => safeCode(warning.code, "RLM_WARNING"));
  const common = {
    runId: typeof result.runId === "string" ? result.runId : null,
    status: result.status,
    mode: result.completionMode ?? null,
    output: result.output ?? null,
    usage: result.ledger?.usage ?? null,
    warningCodes,
  } as const;
  if (result.status !== "completed" || result.answer === undefined) {
    const code = safeCode(result.error?.code, result.status === "cancelled" ? "CANCELLED" : "RLM_RUN_FAILED");
    return {
      ...common,
      truncation: { truncated: false, originalBytes: 0, omittedBytes: 0 },
      errorCode: code,
      error: { code, message: boundedMessage(result.error?.message, "pi-rlm did not produce a result.") },
    };
  }
  let canonical: string;
  try { canonical = canonicalStringify(result.answer); }
  catch {
    return failureProjection("RLM_RESULT_INVALID", "Runtime answer was not strict JSON.", common.runId);
  }
  const originalBytes = Buffer.byteLength(canonical, "utf8");
  if (originalBytes <= FULL_ANSWER_MAX_BYTES) {
    return {
      ...common,
      truncation: { truncated: false, originalBytes, omittedBytes: 0 },
      answer: result.answer,
    };
  }
  const preview = headTailPreview(canonical, {
    headBytes: PREVIEW_SLICE_BYTES,
    tailBytes: PREVIEW_SLICE_BYTES,
  });
  return {
    ...common,
    truncation: {
      truncated: true,
      originalBytes: preview.originalBytes,
      omittedBytes: preview.omittedBytes,
    },
    answerPreview: preview.text,
  };
};

export const failureProjection = (
  codeValue: unknown,
  messageValue: unknown,
  runId: string | null = null,
  status: "failed" | "cancelled" = "failed",
): RlmResultProjection => {
  const code = safeCode(codeValue, status === "cancelled" ? "CANCELLED" : "RLM_RUN_FAILED");
  return {
    runId,
    status,
    mode: null,
    output: null,
    usage: null,
    warningCodes: [],
    truncation: { truncated: false, originalBytes: 0, omittedBytes: 0 },
    errorCode: code,
    error: { code, message: boundedMessage(messageValue, "pi-rlm did not produce a result.") },
  };
};

export const resultMetadata = (projection: RlmResultProjection): RlmResultMetadata => ({
  runId: projection.runId,
  status: projection.status,
  mode: projection.mode,
  output: projection.output,
  usage: projection.usage,
  warningCodes: projection.warningCodes,
  truncation: projection.truncation,
  ...(projection.errorCode ? { errorCode: projection.errorCode } : {}),
});

export const resultContent = (projection: RlmResultProjection): string =>
  canonicalStringify(projection as unknown as JsonValue);
