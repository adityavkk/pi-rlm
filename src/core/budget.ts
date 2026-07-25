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
import { MAX_CALL_TOKENS } from "./usage.ts";

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

/** Settle an attempt. Invalid accounting leaves the ledger unchanged. */
export const settleAttempt = (
  ledger: Ledger,
  reservedTokens: number,
  actualTokens: number,
): Result<Ledger, CallError> => {
  if (!Number.isSafeInteger(ledger.usage.tokensReserved) || ledger.usage.tokensReserved < 0
    || !Number.isSafeInteger(ledger.usage.tokensUsed) || ledger.usage.tokensUsed < 0)
    return err(callError("INVALID_RESULT", "invalid ledger accounting"));
  if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0 || reservedTokens > ledger.usage.tokensReserved)
    return err(callError("INVALID_RESULT", "invalid token reservation settlement"));
  if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || actualTokens > reservedTokens
    || ledger.usage.tokensUsed > Number.MAX_SAFE_INTEGER - actualTokens)
    return err(callError("INVALID_RESULT", "invalid reported token usage"));
  return ok(patch(ledger, {
    tokensReserved: ledger.usage.tokensReserved - reservedTokens,
    tokensUsed: ledger.usage.tokensUsed + actualTokens,
  }));
};

/** Try to acquire a leaf concurrency slot. `"saturated"` means the scheduler must wait. */
export const acquireLeaf = (ledger: Ledger): Ledger | "saturated" => {
  if (ledger.usage.activeLeafCalls + 1 > ledger.limits.maxConcurrency) return "saturated";
  return patch(ledger, { activeLeafCalls: ledger.usage.activeLeafCalls + 1 });
};

export const releaseLeaf = (ledger: Ledger): Ledger =>
  patch(ledger, { activeLeafCalls: Math.max(0, ledger.usage.activeLeafCalls - 1) });

/** Reserve host-stored bytes for a context/artifact snapshot. */
export const reserveBytes = (ledger: Ledger, bytes: number): Result<Ledger, CallError> => {
  if (ledger.usage.storedBytes + bytes > ledger.limits.storedByteLimit)
    return err(callError("BUDGET_BYTES", `stored byte limit ${ledger.limits.storedByteLimit} reached`));
  return ok(patch(ledger, { storedBytes: ledger.usage.storedBytes + bytes }));
};

/** Release a prior stored-byte reservation after a context commit fails. */
export const releaseBytes = (ledger: Ledger, bytes: number): Ledger =>
  patch(ledger, { storedBytes: Math.max(0, ledger.usage.storedBytes - bytes) });

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
    reportedTokensReserved: usage.tokensReserved,
    ...(limits.tokenLimit !== undefined ? { reportedTokenLimit: limits.tokenLimit } : {}),
    storedBytesUsed: usage.storedBytes,
    storedByteLimit: limits.storedByteLimit,
    deadlineMs: limits.deadlineMs,
  };
};
