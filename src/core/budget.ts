/**
 * Tree-wide budget ledger (pure).
 *
 * One ledger governs an entire run tree: recursion depth, frames, logical calls,
 * attempts, controller turns, leaf concurrency, reported tokens, stored bytes,
 * and a wall-clock deadline. Every mutation returns a new ledger or a typed
 * budget error. Concurrency saturation is a scheduling signal, not an error.
 */

import { type CallError, callError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import { MAX_CALL_COST_USD, MAX_CALL_DURATION_MS, MAX_CALL_TOKENS, type CallUsage } from "./usage.ts";

export interface BudgetLimits {
  readonly maxDepth: number;
  readonly maxFrames: number;
  readonly maxLogicalCalls: number;
  readonly maxAttempts: number;
  readonly maxControllerTurns: number;
  readonly maxConcurrency: number;
  readonly tokenLimit?: number;
  readonly storedByteLimit: number;
  readonly deadlineMs: number;
}

export interface BudgetUsage {
  readonly framesOpened: number;
  readonly logicalCalls: number;
  readonly attempts: number;
  readonly controllerTurns: number;
  readonly activeLeafCalls: number;
  readonly tokensReserved: number;
  readonly tokensUsed: number;
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
  readonly costUsd: number;
  readonly providerDurationMs: number;
  readonly storedBytes: number;
}

export interface Ledger {
  readonly limits: BudgetLimits;
  readonly usage: BudgetUsage;
}

export const ZERO_USAGE: BudgetUsage = {
  framesOpened: 0,
  logicalCalls: 0,
  attempts: 0,
  controllerTurns: 0,
  activeLeafCalls: 0,
  tokensReserved: 0,
  tokensUsed: 0,
  inputTokensUsed: 0,
  outputTokensUsed: 0,
  costUsd: 0,
  providerDurationMs: 0,
  storedBytes: 0,
};

export const createLedger = (limits: BudgetLimits): Ledger => ({ limits, usage: ZERO_USAGE });

const patch = (ledger: Ledger, delta: Partial<BudgetUsage>): Ledger => ({
  limits: ledger.limits,
  usage: { ...ledger.usage, ...delta },
});

const deadlinePassed = (ledger: Ledger, now: number): boolean => now >= ledger.limits.deadlineMs;

/** Open a child frame at `childDepth` (root = 0). */
export const openFrame = (ledger: Ledger, childDepth: number): Result<Ledger, CallError> => {
  if (childDepth > ledger.limits.maxDepth)
    return err(callError("BUDGET_DEPTH", `depth ${childDepth} exceeds max ${ledger.limits.maxDepth}`));
  if (ledger.usage.framesOpened + 1 > ledger.limits.maxFrames)
    return err(callError("BUDGET_FRAMES", `frame limit ${ledger.limits.maxFrames} reached`));
  return ok(patch(ledger, { framesOpened: ledger.usage.framesOpened + 1 }));
};

export type TurnResult = Result<Ledger, { readonly code: "CONTROLLER_TURNS_EXHAUSTED" | "DEADLINE" }>;

/** Reserve one controller provider response. */
export const reserveControllerTurn = (ledger: Ledger, now: number): TurnResult => {
  if (deadlinePassed(ledger, now)) return err({ code: "DEADLINE" });
  if (ledger.usage.controllerTurns + 1 > ledger.limits.maxControllerTurns)
    return err({ code: "CONTROLLER_TURNS_EXHAUSTED" });
  return ok(patch(ledger, { controllerTurns: ledger.usage.controllerTurns + 1 }));
};

/** Reserve a distinct logical call (skipped on cache hits). */
export const reserveLogicalCall = (ledger: Ledger, now: number): Result<Ledger, CallError> => {
  if (deadlinePassed(ledger, now)) return err(callError("BUDGET_DEADLINE", "run deadline reached"));
  if (ledger.usage.logicalCalls + 1 > ledger.limits.maxLogicalCalls)
    return err(callError("BUDGET_CALLS", `logical call limit ${ledger.limits.maxLogicalCalls} reached`));
  return ok(patch(ledger, { logicalCalls: ledger.usage.logicalCalls + 1 }));
};

export const releaseLogicalCall = (ledger: Ledger): Ledger =>
  patch(ledger, { logicalCalls: Math.max(0, ledger.usage.logicalCalls - 1) });

/** Reserve one attempt plus its optimistic token reservation. */
export const reserveAttempt = (
  ledger: Ledger,
  now: number,
  reserveTokens = 0,
): Result<Ledger, CallError> => {
  if (deadlinePassed(ledger, now)) return err(callError("BUDGET_DEADLINE", "run deadline reached"));
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0 || reserveTokens > MAX_CALL_TOKENS)
    return err(callError("INVALID_REQUEST", "invalid attempt token reservation"));
  if (!Number.isSafeInteger(ledger.usage.attempts) || ledger.usage.attempts < 0
    || !Number.isSafeInteger(ledger.usage.tokensReserved) || ledger.usage.tokensReserved < 0
    || !Number.isSafeInteger(ledger.usage.tokensUsed) || ledger.usage.tokensUsed < 0)
    return err(callError("INVALID_RESULT", "invalid ledger accounting"));
  if (ledger.usage.attempts >= ledger.limits.maxAttempts)
    return err(callError("BUDGET_ATTEMPTS", `attempt limit ${ledger.limits.maxAttempts} reached`));
  if (ledger.usage.tokensReserved > Number.MAX_SAFE_INTEGER - reserveTokens)
    return err(callError("BUDGET_TOKENS", "token reservation overflow"));
  const nextReserved = ledger.usage.tokensReserved + reserveTokens;
  if (ledger.limits.tokenLimit !== undefined
    && (ledger.usage.tokensUsed > ledger.limits.tokenLimit - nextReserved))
    return err(callError("BUDGET_TOKENS", `token limit ${ledger.limits.tokenLimit} reached`));
  return ok(patch(ledger, { attempts: ledger.usage.attempts + 1, tokensReserved: nextReserved }));
};

/** Settle an attempt. Actual usage may exceed its optimistic reservation. */
export const settleAttempt = (
  ledger: Ledger,
  reservedTokens: number,
  actualTokens: number,
): Result<Ledger, CallError> => settleAccounting(ledger, reservedTokens, actualTokens, 0, 0, 0, 0);

const settleAccounting = (
  ledger: Ledger,
  reservedTokens: number,
  actualTokens: number,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  durationMs: number,
): Result<Ledger, CallError> => {
  if (!Number.isSafeInteger(ledger.usage.tokensReserved) || ledger.usage.tokensReserved < 0
    || !Number.isSafeInteger(ledger.usage.tokensUsed) || ledger.usage.tokensUsed < 0
    || !Number.isSafeInteger(ledger.usage.inputTokensUsed) || ledger.usage.inputTokensUsed < 0
    || !Number.isSafeInteger(ledger.usage.outputTokensUsed) || ledger.usage.outputTokensUsed < 0
    || !Number.isFinite(ledger.usage.costUsd) || ledger.usage.costUsd < 0
    || !Number.isSafeInteger(ledger.usage.providerDurationMs) || ledger.usage.providerDurationMs < 0)
    return err(callError("INVALID_RESULT", "invalid ledger accounting"));
  if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0 || reservedTokens > ledger.usage.tokensReserved)
    return err(callError("INVALID_RESULT", "invalid token reservation settlement"));
  if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || actualTokens > MAX_CALL_TOKENS
    || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > MAX_CALL_TOKENS
    || !Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > MAX_CALL_TOKENS
    || inputTokens + outputTokens > actualTokens
    || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > MAX_CALL_COST_USD
    || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_CALL_DURATION_MS
    || ledger.usage.tokensUsed > Number.MAX_SAFE_INTEGER - actualTokens
    || ledger.usage.inputTokensUsed > Number.MAX_SAFE_INTEGER - inputTokens
    || ledger.usage.outputTokensUsed > Number.MAX_SAFE_INTEGER - outputTokens
    || ledger.usage.providerDurationMs > Number.MAX_SAFE_INTEGER - durationMs
    || !Number.isFinite(ledger.usage.costUsd + costUsd))
    return err(callError("INVALID_RESULT", "invalid reported provider usage"));
  return ok(patch(ledger, {
    tokensReserved: ledger.usage.tokensReserved - reservedTokens,
    tokensUsed: ledger.usage.tokensUsed + actualTokens,
    inputTokensUsed: ledger.usage.inputTokensUsed + inputTokens,
    outputTokensUsed: ledger.usage.outputTokensUsed + outputTokens,
    costUsd: ledger.usage.costUsd + costUsd,
    providerDurationMs: ledger.usage.providerDurationMs + durationMs,
  }));
};

/** Settle all finite provider-reported accounting for one reserved attempt. */
export const settleAttemptUsage = (
  ledger: Ledger,
  reservedTokens: number,
  usage: CallUsage,
): Result<Ledger, CallError> => {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  return settleAccounting(ledger, reservedTokens, total, input, output, usage.costUsd ?? 0, usage.durationMs);
};

/** Try to acquire a leaf concurrency slot. `"saturated"` means the scheduler must wait. */
export const acquireLeaf = (ledger: Ledger): Ledger | "saturated" => {
  if (ledger.usage.activeLeafCalls + 1 > ledger.limits.maxConcurrency) return "saturated";
  return patch(ledger, { activeLeafCalls: ledger.usage.activeLeafCalls + 1 });
};

export const releaseLeaf = (ledger: Ledger): Ledger =>
  patch(ledger, { activeLeafCalls: Math.max(0, ledger.usage.activeLeafCalls - 1) });

/** Reserve a finite, exact logical retained-byte delta. */
export const reserveBytes = (ledger: Ledger, bytes: number): Result<Ledger, CallError> => {
  if (!Number.isSafeInteger(bytes) || bytes < 0
    || !Number.isSafeInteger(ledger.usage.storedBytes) || ledger.usage.storedBytes < 0)
    return err(callError("INVALID_RESULT", "invalid stored-byte accounting"));
  if (bytes > ledger.limits.storedByteLimit - ledger.usage.storedBytes)
    return err(callError("BUDGET_BYTES", `stored byte limit ${ledger.limits.storedByteLimit} reached`));
  return ok(patch(ledger, { storedBytes: ledger.usage.storedBytes + bytes }));
};

/** Release one active stored-byte reservation after its retained mutation fails. */
export const releaseBytes = (ledger: Ledger, bytes: number): Ledger => {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ledger.usage.storedBytes)
    throw new Error("invalid stored-byte reservation rollback");
  return patch(ledger, { storedBytes: ledger.usage.storedBytes - bytes });
};

export interface BudgetView {
  readonly depth: number;
  readonly maxDepth: number;
  readonly logicalCallsUsed: number;
  readonly logicalCallsRemaining: number;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
  readonly activeLeafCalls: number;
  readonly maxConcurrency: number;
  readonly controllerTurnsUsed: number;
  readonly controllerTurnsRemaining: number;
  readonly reportedTokensUsed: number;
  readonly reportedInputTokensUsed: number;
  readonly reportedOutputTokensUsed: number;
  readonly reportedCostUsd: number;
  readonly providerDurationMs: number;
  readonly reportedTokensReserved: number;
  readonly reportedTokenLimit?: number;
  readonly storedBytesUsed: number;
  readonly storedByteLimit: number;
  readonly deadlineMs: number;
}

/** Read-only view exposed to the guest and TUI at a given frame depth. */
export const budgetView = (ledger: Ledger, depth: number): BudgetView => {
  const { limits, usage } = ledger;
  return {
    depth,
    maxDepth: limits.maxDepth,
    logicalCallsUsed: usage.logicalCalls,
    logicalCallsRemaining: Math.max(0, limits.maxLogicalCalls - usage.logicalCalls),
    attemptsUsed: usage.attempts,
    attemptsRemaining: Math.max(0, limits.maxAttempts - usage.attempts),
    activeLeafCalls: usage.activeLeafCalls,
    maxConcurrency: limits.maxConcurrency,
    controllerTurnsUsed: usage.controllerTurns,
    controllerTurnsRemaining: Math.max(0, limits.maxControllerTurns - usage.controllerTurns),
    reportedTokensUsed: usage.tokensUsed,
    reportedInputTokensUsed: usage.inputTokensUsed,
    reportedOutputTokensUsed: usage.outputTokensUsed,
    reportedCostUsd: usage.costUsd,
    providerDurationMs: usage.providerDurationMs,
    reportedTokensReserved: usage.tokensReserved,
    ...(limits.tokenLimit !== undefined ? { reportedTokenLimit: limits.tokenLimit } : {}),
    storedBytesUsed: usage.storedBytes,
    storedByteLimit: limits.storedByteLimit,
    deadlineMs: limits.deadlineMs,
  };
};
