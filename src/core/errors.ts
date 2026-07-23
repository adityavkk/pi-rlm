/**
 * Error taxonomy shared by the guest DSL, broker, and interpreter.
 *
 * Recoverable errors surface to the controller as trajectory observations so
 * it can correct course. Terminal errors fail the cell and cannot be caught by
 * guest code. Budget errors are non-retryable unless a human raises a limit.
 */

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

export interface CallError {
  readonly code: CallErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export const callError = (code: CallErrorCode, message: string): CallError => ({
  code,
  message,
  retryable: isRetryable(code),
});

export interface InterpreterError {
  readonly code: InterpreterErrorCode;
  readonly message: string;
}

export const interpreterError = (code: InterpreterErrorCode, message: string): InterpreterError => ({
  code,
  message,
});
