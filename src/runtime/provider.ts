/**
 * Central model invocation and accounting boundary.
 *
 * Every provider completion enters here. One logical operation may make more
 * than one provider attempt (for example, structured-output repair). Logical,
 * attempt, token, and concurrency capacity are committed atomically before the
 * provider effect; reported usage is settled before the slot is released.
 */

import {
  acquireLeaf,
  releaseLeaf,
  reserveAttempt,
  reserveLogicalCall,
  settleAttempt,
  settleAttemptUsage,
} from "../core/budget.ts";
import { type CallError, callError, ERROR_DETAIL_MAX_LENGTH } from "../core/errors.ts";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify } from "../core/json.ts";
import type { CallUsage, CallUsageLimits } from "../core/usage.ts";
import {
  addUsage,
  MAX_CALL_ATTEMPTS,
  MAX_CALL_COST_USD,
  MAX_CALL_DURATION_MS,
  MAX_CALL_TOKENS,
  normalizeCallUsage,
  ZERO_CALL_USAGE,
} from "../core/usage.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { PiModelError } from "../shell/model/pi-model.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./abort.ts";
import type { FrameRef, RunState } from "./state.ts";

export const DEFAULT_MAX_OUTPUT_TOKENS = 512;

export type ModelOperationKind = "controller" | "llm" | "extractor";

export interface ModelOperationOptions {
  readonly operationId: string;
  readonly kind: ModelOperationKind;
  readonly key: string;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export class ModelInvocationError extends Error {
  override readonly name = "ModelInvocationError";

  constructor(
    readonly callError: CallError,
    readonly usage: CallUsage,
  ) {
    super(callError.message);
  }
}

export interface ModelOperation {
  readonly usage: CallUsage;
  readonly attemptCount: number;
  complete(client: ModelClient, request: ModelRequest): Promise<ModelResponse>;
  runExternal<T>(effect: () => Promise<T> | T): Promise<T>;
}

type TokenReservationRequest = Pick<ModelRequest, "prompt" | "system" | "context" | "schema" | "maxOutputTokens">;

/** Conservative complete-request estimate: all canonical request bytes plus enforced output cap. */
export const tokenReservation = (request: TokenReservationRequest): number | undefined => {
  const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > MAX_CALL_TOKENS)
    return undefined;
  const inputs = [request.prompt, ...(request.system === undefined ? [] : [request.system]), ...(request.context ?? [])];
  if (request.schema !== undefined) {
    try {
      inputs.push(canonicalStringify(request.schema));
    } catch {
      return undefined;
    }
  }
  let inputBytes = 0;
  for (const input of inputs) {
    const bytes = Buffer.byteLength(input, "utf8");
    if (inputBytes > Number.MAX_SAFE_INTEGER - bytes) return undefined;
    inputBytes += bytes;
  }
  const inputTokens = Math.ceil(inputBytes / 4);
  return inputTokens <= MAX_CALL_TOKENS - maxOutputTokens ? inputTokens + maxOutputTokens : undefined;
};

const usageLimits = (state: RunState): CallUsageLimits => ({
  maxAttempts: MAX_CALL_ATTEMPTS,
  maxTokens: MAX_CALL_TOKENS,
  maxCostUsd: MAX_CALL_COST_USD,
  maxDurationMs: Math.min(MAX_CALL_DURATION_MS, state.profile.wallMs),
});

const ownDataValue = (value: object, key: string): { readonly found: boolean; readonly value?: unknown } => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { found: false };
    return "value" in descriptor ? { found: true, value: descriptor.value } : { found: true };
  } catch {
    return { found: true };
  }
};

const boundedOwnString = (value: object, key: string): string | undefined => {
  const property = ownDataValue(value, key);
  return property.found
    && typeof property.value === "string"
    && property.value.length > 0
    && property.value.length <= ERROR_DETAIL_MAX_LENGTH
    ? property.value
    : undefined;
};

const normalizeOwnedUsage = (value: unknown, limits: CallUsageLimits): CallUsage | undefined => {
  const normalized = normalizeCallUsage(value, limits);
  if (!normalized.ok) return undefined;
  const usage = { ...normalized.value, attempts: 1 };
  const parts = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (!Number.isSafeInteger(parts) || (usage.totalTokens !== undefined && parts > usage.totalTokens)) return undefined;
  return usage;
};

const normalizeModelResponse = (value: unknown, limits: CallUsageLimits): ModelResponse | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const text = ownDataValue(value, "text");
  const rawUsage = ownDataValue(value, "usage");
  if (!text.found || typeof text.value !== "string" || !rawUsage.found) return undefined;
  const usage = normalizeOwnedUsage(rawUsage.value, limits);
  return usage ? Object.assign(Object.create(null), { text: text.value, usage }) as ModelResponse : undefined;
};

const PI_ERROR_CODES = new Set(["CANCELLED", "PROVIDER_ERROR", "OUTPUT_TRUNCATED", "UNEXPECTED_TOOL_USE", "MISSING_TEXT"]);
const PI_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

interface NormalizedPiFailure {
  readonly code: string;
  readonly stopReason: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: CallUsage;
}

const normalizePiFailure = (error: PiModelError, limits: CallUsageLimits): NormalizedPiFailure | undefined => {
  const code = boundedOwnString(error, "code");
  const stopReason = boundedOwnString(error, "stopReason");
  const provider = boundedOwnString(error, "provider");
  const model = boundedOwnString(error, "model");
  const usageProperty = ownDataValue(error, "usage");
  const usage = usageProperty.found ? normalizeOwnedUsage(usageProperty.value, limits) : undefined;
  if (!code || !PI_ERROR_CODES.has(code) || !stopReason || !PI_STOP_REASONS.has(stopReason) || !provider || !model || !usage)
    return undefined;
  return Object.assign(Object.create(null), { code, stopReason, provider, model, usage }) as NormalizedPiFailure;
};

const piFailure = (error: NormalizedPiFailure): CallError => {
  const code = error.code === "CANCELLED"
    ? "CANCELLED"
    : error.code === "PROVIDER_ERROR"
      ? "FAILED"
      : "INVALID_RESULT";
  return callError(
    code,
    code === "CANCELLED"
      ? "model completion cancelled"
      : code === "FAILED"
        ? "model provider failed"
        : "model completion returned an invalid result",
    error,
  );
};

const elapsedMs = (startedMs: number, completedMs: number): number => {
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs <= startedMs) return 0;
  return Math.min(Math.floor(completedMs - startedMs), MAX_CALL_DURATION_MS);
};

const validateRequest = (request: ModelRequest): CallError | undefined => {
  if (typeof request.prompt !== "string") return callError("INVALID_REQUEST", "model prompt must be a string");
  if (request.system !== undefined && typeof request.system !== "string")
    return callError("INVALID_REQUEST", "model system prompt must be a string");
  if (request.context !== undefined && (!Array.isArray(request.context) || request.context.some((value) => typeof value !== "string")))
    return callError("INVALID_REQUEST", "model context must contain strings");
  if (request.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > MAX_CALL_TOKENS))
    return callError("INVALID_REQUEST", `maxOutputTokens must be a positive safe integer at most ${MAX_CALL_TOKENS}`);
  return undefined;
};

export const hasAttemptCapacity = (state: RunState): boolean =>
  state.ledger.current.usage.attempts < state.ledger.current.limits.maxAttempts;

export const createModelOperation = (
  state: RunState,
  frame: FrameRef,
  options: ModelOperationOptions,
): ModelOperation => {
  let logicalReserved = false;
  let aggregate: CallUsage = ZERO_CALL_USAGE;
  let attemptOrdinal = 0;

  const checkpoint = (): void => {
    throwIfAborted(options.signal);
    if (state.clock.now() >= options.deadlineMs)
      throw new ModelInvocationError(callError("BUDGET_DEADLINE", "run deadline reached"), aggregate);
  };

  const reserve = (tokens: number): CallError | undefined => {
    const base = state.ledger.current;
    const logical = logicalReserved ? { ok: true as const, value: base } : reserveLogicalCall(base, state.clock.now());
    if (!logical.ok) return logical.error;
    const attempt = reserveAttempt(logical.value, state.clock.now(), tokens);
    if (!attempt.ok) return attempt.error;
    state.ledger.current = attempt.value;
    logicalReserved = true;
    attemptOrdinal += 1;
    return undefined;
  };

  const addAccounting = (usage: CallUsage): CallError | undefined => {
    const combined = addUsage(aggregate, usage);
    if (!combined.ok) return callError("INVALID_RESULT", combined.error.message);
    aggregate = combined.value;
    for (const scope of frame.usageScopes ?? []) {
      const scoped = addUsage(state.scopeUsage.get(scope) ?? ZERO_CALL_USAGE, usage);
      if (!scoped.ok) return callError("INVALID_RESULT", scoped.error.message);
      state.scopeUsage.set(scope, scoped.value);
    }
    return undefined;
  };

  const journal = async (
    outcome: Extract<RlmEvent, { type: "provider_attempted" }>["outcome"],
    usage: CallUsage,
    errorCode?: string,
  ): Promise<void> => {
    const appended = await state.journal.append({
      type: "provider_attempted",
      frameId: frame.frameId,
      operationId: options.operationId,
      kind: options.kind,
      key: options.key,
      attempt: attemptOrdinal,
      outcome,
      usage,
      ...(errorCode ? { errorCode } : {}),
    });
    if (appended?.statusCache?.state === "failed") throw appended.statusCache.error;
  };

  const complete = async (client: ModelClient, request: ModelRequest): Promise<ModelResponse> => {
    const invalid = validateRequest(request);
    if (invalid) throw new ModelInvocationError(invalid, aggregate);
    const normalizedRequest: ModelRequest = {
      ...request,
      maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      signal: options.signal,
    };
    const reservedTokens = tokenReservation(normalizedRequest);
    if (reservedTokens === undefined)
      throw new ModelInvocationError(callError("INVALID_REQUEST", "call token reservation exceeds per-call maximum"), aggregate);

    checkpoint();
    const release = await state.semaphore.acquire(options.signal);
    if (!release) {
      checkpoint();
      throw new ModelInvocationError(callError("CANCELLED", "model completion cancelled"), aggregate);
    }
    let pendingTokens = 0;
    let active = false;
    try {
      checkpoint();
      const reservationError = reserve(reservedTokens);
      if (reservationError) throw new ModelInvocationError(reservationError, aggregate);
      pendingTokens = reservedTokens;
      const acquired = acquireLeaf(state.ledger.current);
      if (acquired === "saturated")
        throw new ModelInvocationError(callError("INVALID_RESULT", "model concurrency accounting diverged"), aggregate);
      state.ledger.current = acquired;
      active = true;

      checkpoint();
      const startedMs = state.clock.now();
      let raw: unknown;
      try {
        raw = await waitForAbort(client.complete(normalizedRequest), options.signal);
      } catch (error) {
        const typed = error instanceof PiModelError ? normalizePiFailure(error, usageLimits(state)) : undefined;
        const usage: CallUsage = typed?.usage ?? {
          attempts: 1,
          durationMs: elapsedMs(startedMs, state.clock.now()),
        };
        const settled = settleAttemptUsage(state.ledger.current, pendingTokens, usage);
        if (!settled.ok) {
          const released = settleAttempt(state.ledger.current, pendingTokens, 0);
          if (released.ok) state.ledger.current = released.value;
          pendingTokens = 0;
          throw new ModelInvocationError(settled.error, aggregate);
        }
        state.ledger.current = settled.value;
        pendingTokens = 0;
        const accountingError = addAccounting(usage);
        const failure = accountingError ?? (typed
          ? piFailure(typed)
          : wasAborted(error, options.signal)
            ? callError("CANCELLED", "model completion cancelled")
            : callError("FAILED", "model completion failed"));
        await journal(failure.code === "CANCELLED" ? "cancelled" : "error", usage, failure.code);
        throw new ModelInvocationError(failure, aggregate);
      }

      const response = normalizeModelResponse(raw, usageLimits(state));
      if (!response) {
        const usage: CallUsage = { attempts: 1, durationMs: elapsedMs(startedMs, state.clock.now()) };
        const settled = settleAttemptUsage(state.ledger.current, pendingTokens, usage);
        if (settled.ok) state.ledger.current = settled.value;
        else {
          const released = settleAttempt(state.ledger.current, pendingTokens, 0);
          if (released.ok) state.ledger.current = released.value;
        }
        pendingTokens = 0;
        const failure = addAccounting(usage) ?? callError("INVALID_RESULT", "model returned invalid usage");
        await journal("invalid_result", usage, failure.code);
        throw new ModelInvocationError(failure, aggregate);
      }

      const settled = settleAttemptUsage(state.ledger.current, pendingTokens, response.usage);
      if (!settled.ok) {
        const released = settleAttempt(state.ledger.current, pendingTokens, 0);
        if (released.ok) state.ledger.current = released.value;
        pendingTokens = 0;
        throw new ModelInvocationError(settled.error, aggregate);
      }
      state.ledger.current = settled.value;
      pendingTokens = 0;
      const accountingError = addAccounting(response.usage);
      if (accountingError) throw new ModelInvocationError(accountingError, aggregate);
      await journal("ok", response.usage);
      return response;
    } finally {
      if (pendingTokens > 0) {
        const released = settleAttempt(state.ledger.current, pendingTokens, 0);
        if (released.ok) state.ledger.current = released.value;
      }
      if (active) state.ledger.current = releaseLeaf(state.ledger.current);
      release();
    }
  };

  const runExternal = async <T>(effect: () => Promise<T> | T): Promise<T> => {
    checkpoint();
    const release = await state.semaphore.acquire(options.signal);
    if (!release) {
      checkpoint();
      throw new ModelInvocationError(callError("CANCELLED", "external model operation cancelled"), aggregate);
    }
    let active = false;
    let settled = false;
    const startedMs = state.clock.now();
    const settleExternal = (): CallUsage => {
      if (settled)
        throw new ModelInvocationError(callError("INVALID_RESULT", "external model operation settled more than once"), aggregate);
      const usage: CallUsage = { attempts: 1, durationMs: elapsedMs(startedMs, state.clock.now()) };
      const settlement = settleAttemptUsage(state.ledger.current, 0, usage);
      if (!settlement.ok) throw new ModelInvocationError(settlement.error, aggregate);
      state.ledger.current = settlement.value;
      settled = true;
      const accountingError = addAccounting(usage);
      if (accountingError) throw new ModelInvocationError(accountingError, aggregate);
      return usage;
    };
    try {
      checkpoint();
      const reservationError = reserve(0);
      if (reservationError) throw new ModelInvocationError(reservationError, aggregate);
      const acquired = acquireLeaf(state.ledger.current);
      if (acquired === "saturated")
        throw new ModelInvocationError(callError("INVALID_RESULT", "model concurrency accounting diverged"), aggregate);
      state.ledger.current = acquired;
      active = true;

      let value: T;
      try {
        value = await waitForAbort(Promise.resolve(effect()), options.signal);
      } catch (error) {
        const usage = settleExternal();
        const cancelled = wasAborted(error, options.signal);
        await journal(cancelled ? "cancelled" : "error", usage, cancelled ? "CANCELLED" : "FAILED");
        throw error;
      }
      const usage = settleExternal();
      await journal("ok", usage);
      return value;
    } finally {
      if (active) state.ledger.current = releaseLeaf(state.ledger.current);
      release();
    }
  };

  return {
    get usage() { return aggregate; },
    get attemptCount() { return attemptOrdinal; },
    complete,
    runExternal,
  };
};
