/** Per-call usage accounting. Token and cost fields are optional because some
 * providers report them late or not at all; the ledger must tolerate absence. */

import { err, ok, type Result } from "./result.ts";

export interface CallUsage {
  readonly attempts: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly durationMs: number;
}

export interface CallUsageLimits {
  readonly maxAttempts: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly maxDurationMs: number;
}

export interface UsageError {
  readonly code: "INVALID_USAGE";
  readonly message: string;
}

/** Defensive maxima for one ModelClient completion. */
export const MAX_CALL_TOKENS = 10_000_000;
export const MAX_CALL_COST_USD = 10_000;
export const MAX_CALL_DURATION_MS = 24 * 60 * 60 * 1_000;
export const MAX_CALL_ATTEMPTS = 1;

export const CALL_USAGE_LIMITS: CallUsageLimits = {
  maxAttempts: MAX_CALL_ATTEMPTS,
  maxTokens: MAX_CALL_TOKENS,
  maxCostUsd: MAX_CALL_COST_USD,
  maxDurationMs: MAX_CALL_DURATION_MS,
};

const ADD_USAGE_LIMITS: CallUsageLimits = {
  maxAttempts: Number.MAX_SAFE_INTEGER,
  maxTokens: Number.MAX_SAFE_INTEGER,
  maxCostUsd: MAX_CALL_COST_USD * 1_000_000,
  maxDurationMs: Number.MAX_SAFE_INTEGER,
};

export const ZERO_CALL_USAGE: CallUsage = { attempts: 0, durationMs: 0 };

const INVALID_DATA = Symbol("invalid usage data");

const ownData = (value: object, key: string): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    return "value" in descriptor ? descriptor.value : INVALID_DATA;
  } catch {
    return INVALID_DATA;
  }
};

const invalid = (field: string): Result<never, UsageError> =>
  err({ code: "INVALID_USAGE", message: `invalid usage field ${field}` });

/** Getter-free snapshot of untrusted provider usage. */
export const normalizeCallUsage = (
  value: unknown,
  limits: CallUsageLimits = CALL_USAGE_LIMITS,
): Result<CallUsage, UsageError> => {
  if (!value || typeof value !== "object") return invalid("usage");
  const integer = (key: "attempts" | "inputTokens" | "outputTokens" | "totalTokens" | "durationMs", max: number) => {
    const candidate = ownData(value, key);
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= max
      ? candidate
      : undefined;
  };
  const attempts = integer("attempts", limits.maxAttempts);
  const durationMs = integer("durationMs", limits.maxDurationMs);
  if (attempts === undefined || durationMs === undefined) return invalid(attempts === undefined ? "attempts" : "durationMs");

  const optionalInteger = (key: "inputTokens" | "outputTokens" | "totalTokens"): Result<number | undefined, UsageError> => {
    const candidate = ownData(value, key);
    if (candidate === undefined) return ok(undefined);
    const normalized = integer(key, limits.maxTokens);
    return normalized === undefined ? invalid(key) : ok(normalized);
  };
  const inputTokens = optionalInteger("inputTokens");
  if (!inputTokens.ok) return inputTokens;
  const outputTokens = optionalInteger("outputTokens");
  if (!outputTokens.ok) return outputTokens;
  const totalTokens = optionalInteger("totalTokens");
  if (!totalTokens.ok) return totalTokens;

  const rawCost = ownData(value, "costUsd");
  if (rawCost !== undefined && (typeof rawCost !== "number" || !Number.isFinite(rawCost) || rawCost < 0 || rawCost > limits.maxCostUsd))
    return invalid("costUsd");
  return ok({
    attempts,
    durationMs,
    ...(inputTokens.value !== undefined ? { inputTokens: inputTokens.value } : {}),
    ...(outputTokens.value !== undefined ? { outputTokens: outputTokens.value } : {}),
    ...(totalTokens.value !== undefined ? { totalTokens: totalTokens.value } : {}),
    ...(rawCost !== undefined ? { costUsd: rawCost } : {}),
  });
};

const checkedIntegerSum = (a: number, b: number, max: number): number | undefined => {
  if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0 || a > max - b) return undefined;
  return a + b;
};

const addOptionalInteger = (a: number | undefined, b: number | undefined, max: number): number | undefined | "invalid" => {
  if (a === undefined && b === undefined) return undefined;
  return checkedIntegerSum(a ?? 0, b ?? 0, max) ?? "invalid";
};

/** Checked cumulative addition. Invalid input or overflow is a typed failure. */
export const addUsage = (
  a: CallUsage,
  b: CallUsage,
  limits: CallUsageLimits = ADD_USAGE_LIMITS,
): Result<CallUsage, UsageError> => {
  const left = normalizeCallUsage(a, limits);
  if (!left.ok) return left;
  const right = normalizeCallUsage(b, limits);
  if (!right.ok) return right;
  const attempts = checkedIntegerSum(left.value.attempts, right.value.attempts, limits.maxAttempts);
  const durationMs = checkedIntegerSum(left.value.durationMs, right.value.durationMs, limits.maxDurationMs);
  const inputTokens = addOptionalInteger(left.value.inputTokens, right.value.inputTokens, limits.maxTokens);
  const outputTokens = addOptionalInteger(left.value.outputTokens, right.value.outputTokens, limits.maxTokens);
  const totalTokens = addOptionalInteger(left.value.totalTokens, right.value.totalTokens, limits.maxTokens);
  const costUsd = (left.value.costUsd ?? 0) + (right.value.costUsd ?? 0);
  if (attempts === undefined || durationMs === undefined || inputTokens === "invalid" || outputTokens === "invalid"
    || totalTokens === "invalid" || !Number.isFinite(costUsd) || costUsd > limits.maxCostUsd)
    return invalid("aggregate");
  return ok({
    attempts,
    durationMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(left.value.costUsd !== undefined || right.value.costUsd !== undefined ? { costUsd } : {}),
  });
};
