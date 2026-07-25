/**
 * Error taxonomy shared by the guest DSL, broker, and interpreter.
 *
 * Recoverable errors surface to the controller as trajectory observations so
 * it can correct course. Terminal errors fail the cell and cannot be caught by
 * guest code. Budget errors are non-retryable unless a human raises a limit.
 */

import { normalizeCallUsage } from "./usage.ts";

export const CALL_ERROR_CODES = [
  "FAILED",
  "DENIED",
  "CANCELLED",
  "INTERRUPTED",
  "TIMED_OUT",
  "ACCEPTANCE_FAILED",
  "INVALID_REQUEST",
  "INVALID_RESULT",
  "UNAVAILABLE_CONTEXT",
  "SOURCE_CHANGED",
  "UNKNOWN_EFFECT",
  "BUDGET_DEPTH",
  "BUDGET_FRAMES",
  "BUDGET_CALLS",
  "BUDGET_ATTEMPTS",
  "BUDGET_TOKENS",
  "BUDGET_BYTES",
  "BUDGET_DEADLINE",
] as const;
export type CallErrorCode = (typeof CALL_ERROR_CODES)[number];

const BUDGET_CODES = new Set<CallErrorCode>([
  "BUDGET_DEPTH",
  "BUDGET_FRAMES",
  "BUDGET_CALLS",
  "BUDGET_ATTEMPTS",
  "BUDGET_TOKENS",
  "BUDGET_BYTES",
  "BUDGET_DEADLINE",
]);

export const isBudgetCode = (code: CallErrorCode): boolean => BUDGET_CODES.has(code);

/** Whether a broker error is safe to retry automatically without human approval. */
export const isRetryable = (code: CallErrorCode): boolean =>
  code === "FAILED" || code === "TIMED_OUT" || code === "INVALID_RESULT";

/** Guest-catchable specification errors thrown before any budget is reserved. */
export const DSL_ERROR_CODES = [
  "INVALID_SPEC",
  "DUPLICATE_KEY",
  "KEY_IDENTITY_CHANGED",
  "INVALID_STATE",
  "UNAWAITED_WORK",
] as const;
export type DslErrorCode = (typeof DSL_ERROR_CODES)[number];

/** Host interpreter failures. Guest code cannot catch these; the cell fails. */
export const INTERPRETER_ERROR_CODES = [
  "CPU_LIMIT",
  "HEAP_LIMIT",
  "WORKER_EXIT",
  "JOURNAL_CORRUPT",
  "LATE_CALLBACK",
  "UNHANDLED_REJECTION",
  "PARSE_ERROR",
  "DISPOSED",
] as const;
export type InterpreterErrorCode = (typeof INTERPRETER_ERROR_CODES)[number];

export const ERROR_MESSAGE_MAX_LENGTH = 2_048;
export const ERROR_DETAIL_MAX_LENGTH = 256;

export interface SafeErrorUsage {
  readonly attempts: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly durationMs: number;
}

export interface CallErrorDetails {
  readonly stopReason?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: SafeErrorUsage;
}

const ownData = (value: object, key: string): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

const boundedString = (value: unknown, maxLength: number): string | undefined =>
  typeof value === "string" ? value.slice(0, maxLength) : undefined;

const normalizeSafeUsage = (value: unknown): SafeErrorUsage | undefined => {
  const normalized = normalizeCallUsage(value);
  return normalized.ok ? normalized.value : undefined;
};

/** Copy only bounded, data-only fields that are safe to expose to a guest. */
export const normalizeCallErrorDetails = (value: unknown): CallErrorDetails | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const stopReason = boundedString(ownData(value, "stopReason"), ERROR_DETAIL_MAX_LENGTH);
  const provider = boundedString(ownData(value, "provider"), ERROR_DETAIL_MAX_LENGTH);
  const model = boundedString(ownData(value, "model"), ERROR_DETAIL_MAX_LENGTH);
  const usage = normalizeSafeUsage(ownData(value, "usage"));
  if (stopReason === undefined && provider === undefined && model === undefined && usage === undefined) return undefined;
  return {
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
};

export interface CallError {
  readonly code: CallErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: CallErrorDetails;
}

export const callError = (code: CallErrorCode, message: string, details?: unknown): CallError => {
  const safeDetails = normalizeCallErrorDetails(details);
  return {
    code,
    message: message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
    retryable: isRetryable(code),
    ...(safeDetails ? { details: safeDetails } : {}),
  };
};

export interface InterpreterError {
  readonly code: InterpreterErrorCode;
  readonly message: string;
}

export const interpreterError = (code: InterpreterErrorCode, message: string): InterpreterError => ({
  code,
  message,
});
