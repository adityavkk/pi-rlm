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
import {
  deriveOperationIntentId,
  EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION,
  OPERATION_JOURNAL_SCHEMA_VERSION,
  operationRequestVersionAllowed,
  PROVIDER_REQUEST_IDENTITY_VERSION,
  type OperationIntendedEvent,
  type OperationKind,
  type OperationOutcome,
  type OperationRequestIdentityVersion,
  type OperationReservation,
} from "../core/operation.ts";
import { canonicalStringify, type JsonObject, type JsonValue } from "../core/json.ts";
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
import { sha256 } from "../shell/hash.ts";
import { JournalAppendError } from "../shell/journal-store.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { PiModelError } from "../shell/model/pi-model.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./abort.ts";
import type { FrameRef, RunState } from "./state.ts";

export const DEFAULT_MAX_OUTPUT_TOKENS = 512;
export { PROVIDER_REQUEST_IDENTITY_VERSION };

interface PreparedModelRequest {
  readonly request: ModelRequest;
  readonly canonicalIdentity: string;
}

const strictJsonSnapshot = (input: unknown, label: string): JsonValue => {
  const active = new WeakSet<object>();
  const copy = (value: unknown, path: string): JsonValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new TypeError(`${label} is not strict JSON at ${path}`);
    if (active.has(value)) throw new TypeError(`${label} is cyclic at ${path}`);
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} has a non-plain array at ${path}`);
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key))))
          throw new TypeError(`${label} has an invalid array field at ${path}`);
        const result: JsonValue[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            throw new TypeError(`${label} has an accessor or hole at ${path}[${index}]`);
          result.push(copy(descriptor.value, `${path}[${index}]`));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError(`${label} has a non-plain object at ${path}`);
      const result = Object.create(null) as Record<string, JsonValue>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new TypeError(`${label} has a symbol field at ${path}`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw new TypeError(`${label} has an accessor or non-enumerable field at ${path}.${key}`);
        result[key] = copy(descriptor.value, `${path}.${key}`);
      }
      return result;
    } finally {
      active.delete(value);
    }
  };
  return copy(input, "$");
};

const ownData = (value: object, key: string, label: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new TypeError(`${label}.${key} must be an own data property`);
  return descriptor.value;
};

const prepareModelRequest = (client: ModelClient, input: ModelRequest): PreparedModelRequest => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("model request must be a plain object");
  const requestInput = Object.create(null) as Record<string, unknown>;
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    throw new TypeError("model request must be a plain object");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw new TypeError("model request has a symbol field");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError(`model request has an accessor or non-enumerable field at $.${key}`);
    // Owner cancellation is transport control supplied by this boundary, not provider request content.
    if (key !== "signal") requestInput[key] = descriptor.value;
  }
  const requestJson = strictJsonSnapshot(requestInput, "model request") as JsonObject;
  const normalizedJson = Object.assign(Object.create(null), requestJson, {
    maxOutputTokens: requestJson["maxOutputTokens"] ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }) as JsonObject;
  const clientId = ownData(client, "id", "model client");
  const clientIdentity = ownData(client, "identity", "model client");
  if (typeof clientId !== "string" || clientId.length === 0) throw new TypeError("model client.id must be a nonempty string");
  const identity = strictJsonSnapshot({
    version: PROVIDER_REQUEST_IDENTITY_VERSION,
    modelClient: { id: clientId, identity: clientIdentity },
    request: normalizedJson,
  }, "provider request identity");
  return {
    request: Object.assign(Object.create(null), normalizedJson) as unknown as ModelRequest,
    canonicalIdentity: canonicalStringify(identity),
  };
};

/** Pure hash of the exact provider-affecting ModelRequest snapshot. */
export const providerRequestIdentity = (
  client: ModelClient,
  request: ModelRequest,
): ExternalRequestIdentity => {
  const prepared = prepareModelRequest(client, request);
  return { version: PROVIDER_REQUEST_IDENTITY_VERSION, sha256: sha256(prepared.canonicalIdentity) };
};

/** Hash-only identity for the exact immutable projection passed to an opaque extractor. */
export const externalExtractorRequestIdentity = (
  manifestHash: string,
  projectionVersion: string,
  projectionSha256: string,
): ExternalRequestIdentity => {
  if (!/^[0-9a-f]{64}$/.test(manifestHash) || !/^[0-9a-f]{64}$/.test(projectionSha256)
    || typeof projectionVersion !== "string" || projectionVersion.length === 0)
    throw new TypeError("external extractor request identity is invalid");
  return {
    version: EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION,
    sha256: sha256(canonicalStringify({
      version: EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION,
      manifestHash,
      projectionVersion,
      projectionSha256,
    })),
  };
};

export type ModelOperationKind = OperationKind;

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

export interface ExternalOperationResult<T> {
  readonly value: T;
  readonly usage?: CallUsage;
  readonly outcome: OperationOutcome;
  readonly errorCode?: string;
}

export interface ExternalRequestIdentity {
  readonly version: OperationRequestIdentityVersion;
  readonly sha256: string;
}

export interface ModelOperation {
  readonly usage: CallUsage;
  readonly attemptCount: number;
  /** True only after this distinct operation consumed logical-call capacity. */
  readonly logicalCallReserved: boolean;
  /** True only when no launched external effect remains in flight. */
  readonly idle: boolean;
  /** Resolves only after every launched external effect reaches a terminal outcome. */
  waitForIdle(): Promise<void>;
  complete(client: ModelClient, request: ModelRequest): Promise<ModelResponse>;
  runExternal<T>(
    effect: () => Promise<T> | T,
    requestIdentity: ExternalRequestIdentity,
  ): Promise<T>;
  runExternalReported<T>(
    effect: () => Promise<ExternalOperationResult<T>> | ExternalOperationResult<T>,
    requestIdentity: ExternalRequestIdentity,
  ): Promise<T>;
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
  let poisoned: unknown;
  const pendingFinalizers = new Set<Promise<unknown>>();
  const attemptKey = `${frame.frameId}\0${options.operationId}`;
  let attemptOrdinal = state.operationAttempts.get(attemptKey) ?? 0;

  const ensureUsable = (): void => {
    if (poisoned !== undefined) throw poisoned;
  };
  const poison = (error: unknown): void => { if (poisoned === undefined) poisoned = error; };
  const trackFinalizer = <T>(work: Promise<T>): Promise<T> => {
    pendingFinalizers.add(work);
    void work.then(
      () => { pendingFinalizers.delete(work); },
      () => { pendingFinalizers.delete(work); },
    );
    // The caller-facing abort race may detach. Always observe the authoritative finalizer.
    void work.catch(() => {});
    return work;
  };
  const waitForIdle = async (): Promise<void> => {
    while (pendingFinalizers.size > 0) await Promise.allSettled([...pendingFinalizers]);
  };
  const hasAuthority = (): boolean => state.operationAuthority?.active !== false;

  const checkpoint = (): void => {
    ensureUsable();
    throwIfAborted(options.signal);
    if (state.clock.now() >= options.deadlineMs)
      throw new ModelInvocationError(callError("BUDGET_DEADLINE", "run deadline reached"), aggregate);
  };

  const reserve = (
    tokens: number,
  ): { readonly ok: true; readonly value: OperationReservation } | { readonly ok: false; readonly error: CallError } => {
    const base = state.ledger.current;
    const reservesLogicalCall = !logicalReserved;
    const logical = logicalReserved ? { ok: true as const, value: base } : reserveLogicalCall(base, state.clock.now());
    if (!logical.ok) return { ok: false, error: logical.error };
    const attempt = reserveAttempt(logical.value, state.clock.now(), tokens);
    if (!attempt.ok) return { ok: false, error: attempt.error };
    state.ledger.current = attempt.value;
    logicalReserved = true;
    attemptOrdinal += 1;
    state.operationAttempts.set(attemptKey, attemptOrdinal);
    return {
      ok: true,
      value: { logicalCalls: reservesLogicalCall ? 1 : 0, attempts: 1, tokens },
    };
  };

  const addAccounting = (usage: CallUsage): CallError | undefined => {
    const combined = addUsage(aggregate, usage);
    if (!combined.ok) return callError("INVALID_RESULT", combined.error.message);
    const scopedUpdates: Array<{ scope: string; usage: CallUsage }> = [];
    for (const scope of frame.usageScopes ?? []) {
      const scoped = addUsage(state.scopeUsage.get(scope) ?? ZERO_CALL_USAGE, usage);
      if (!scoped.ok) return callError("INVALID_RESULT", scoped.error.message);
      scopedUpdates.push({ scope, usage: scoped.value });
    }
    aggregate = combined.value;
    for (const update of scopedUpdates) state.scopeUsage.set(update.scope, update.usage);
    return undefined;
  };

  const appendIntent = async (
    requestIdentity: ExternalRequestIdentity,
    reservation: OperationReservation,
  ): Promise<OperationIntendedEvent> => {
    if (!operationRequestVersionAllowed(options.kind, requestIdentity.version)
      || !/^[0-9a-f]{64}$/.test(requestIdentity.sha256))
      throw new ModelInvocationError(callError("INVALID_REQUEST", "external request identity is invalid"), aggregate);
    const identity = {
      schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
      runId: state.runId,
      frameId: frame.frameId,
      operationId: options.operationId,
      kind: options.kind,
      key: options.key,
      attempt: attemptOrdinal,
      requestIdentityVersion: requestIdentity.version,
      requestSha256: requestIdentity.sha256,
      reservation,
    } as const;
    const event: OperationIntendedEvent = {
      type: "operation_intended",
      ...identity,
      intentId: deriveOperationIntentId(state.hasher, identity),
    };
    try {
      const appended = await state.journal.append(event);
      if (appended?.event !== undefined && appended.event !== "committed")
        throw new JournalAppendError("event", appended.event === "deduplicated", new Error("operation intent was not newly committed"));
      if (appended?.statusCache?.state === "failed") throw appended.statusCache.error;
      return event;
    } catch (error) {
      poison(error);
      throw error;
    }
  };

  const appendSettlement = async (
    intent: OperationIntendedEvent,
    outcome: OperationOutcome,
    usage: CallUsage,
    errorCode?: string,
  ): Promise<void> => {
    try {
      const appended = await state.journal.append({
        type: "operation_settled",
        schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
        runId: state.runId,
        frameId: frame.frameId,
        intentId: intent.intentId,
        outcome,
        usage,
        ...(errorCode ? { errorCode } : {}),
      });
      if (appended?.event !== undefined && appended.event !== "committed")
        throw new JournalAppendError("event", appended.event === "deduplicated", new Error("operation settlement was not newly committed"));
      if (appended?.statusCache?.state === "failed") throw appended.statusCache.error;
    } catch (error) {
      poison(error);
      throw error;
    }
  };

  const accountUsage = (reservedTokens: number, usage: CallUsage): CallError | undefined => {
    const settled = settleAttemptUsage(state.ledger.current, reservedTokens, usage);
    if (!settled.ok) {
      const released = settleAttempt(state.ledger.current, reservedTokens, 0);
      if (released.ok) state.ledger.current = released.value;
      return settled.error;
    }
    state.ledger.current = settled.value;
    return addAccounting(usage);
  };

  const complete = async (client: ModelClient, request: ModelRequest): Promise<ModelResponse> => {
    let prepared: PreparedModelRequest;
    try {
      prepared = prepareModelRequest(client, request);
    } catch (error) {
      throw new ModelInvocationError(callError("INVALID_REQUEST", error instanceof Error ? error.message : "model request cannot be canonicalized"), aggregate);
    }
    const invalid = validateRequest(prepared.request);
    if (invalid) throw new ModelInvocationError(invalid, aggregate);
    const normalizedRequest = Object.assign(Object.create(null), prepared.request, { signal: options.signal }) as ModelRequest;
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
    let intent: OperationIntendedEvent;
    try {
      checkpoint();
      const reserved = reserve(reservedTokens);
      if (!reserved.ok) throw new ModelInvocationError(reserved.error, aggregate);
      pendingTokens = reservedTokens;
      const acquired = acquireLeaf(state.ledger.current);
      if (acquired === "saturated")
        throw new ModelInvocationError(callError("INVALID_RESULT", "model concurrency accounting diverged"), aggregate);
      state.ledger.current = acquired;
      active = true;
      checkpoint();
      intent = await appendIntent({
        version: PROVIDER_REQUEST_IDENTITY_VERSION,
        sha256: sha256(prepared.canonicalIdentity),
      }, reserved.value);
    } catch (error) {
      if (pendingTokens > 0) {
        const settled = settleAttempt(state.ledger.current, pendingTokens, 0);
        if (settled.ok) state.ledger.current = settled.value;
      }
      if (active) state.ledger.current = releaseLeaf(state.ledger.current);
      release();
      throw error;
    }

    const startedMs = state.clock.now();
    let external: Promise<unknown>;
    try { external = Promise.resolve(client.complete(normalizedRequest)); }
    catch (error) { external = Promise.reject(error); }
    let settleLedger = false;
    const finalizer = trackFinalizer((async (): Promise<ModelResponse> => {
      try {
        let raw: unknown;
        try {
          raw = await external;
        } catch (error) {
          if (!hasAuthority()) throw error;
          settleLedger = true;
          const typed = error instanceof PiModelError ? normalizePiFailure(error, usageLimits(state)) : undefined;
          const usage: CallUsage = typed?.usage ?? {
            attempts: 1,
            durationMs: elapsedMs(startedMs, state.clock.now()),
          };
          const accountingError = accountUsage(pendingTokens, usage);
          pendingTokens = 0;
          const providerFailure = typed
            ? piFailure(typed)
            : wasAborted(error, options.signal)
              ? callError("CANCELLED", "model completion cancelled")
              : callError("FAILED", "model completion failed");
          const failure = accountingError ?? providerFailure;
          await appendSettlement(intent, accountingError
            ? "invalid_result"
            : failure.code === "CANCELLED" ? "cancelled" : "error", usage, failure.code);
          throw new ModelInvocationError(failure, aggregate);
        }

        if (!hasAuthority()) return raw as ModelResponse;
        settleLedger = true;
        const response = normalizeModelResponse(raw, usageLimits(state));
        if (!response) {
          const usage: CallUsage = { attempts: 1, durationMs: elapsedMs(startedMs, state.clock.now()) };
          const failure = accountUsage(pendingTokens, usage) ?? callError("INVALID_RESULT", "model returned invalid usage");
          pendingTokens = 0;
          await appendSettlement(intent, "invalid_result", usage, failure.code);
          throw new ModelInvocationError(failure, aggregate);
        }
        const accountingError = accountUsage(pendingTokens, response.usage);
        pendingTokens = 0;
        if (accountingError) {
          await appendSettlement(intent, "invalid_result", response.usage, accountingError.code);
          throw new ModelInvocationError(accountingError, aggregate);
        }
        await appendSettlement(intent, "ok", response.usage);
        return response;
      } finally {
        if (settleLedger) {
          if (pendingTokens > 0) {
            const settled = settleAttempt(state.ledger.current, pendingTokens, 0);
            if (settled.ok) state.ledger.current = settled.value;
          }
          if (active) state.ledger.current = releaseLeaf(state.ledger.current);
        }
        release();
      }
    })());
    return waitForAbort(finalizer, options.signal);
  };

  const runExternal = async <T>(
    effect: () => Promise<T> | T,
    requestIdentity: ExternalRequestIdentity,
  ): Promise<T> => {
    checkpoint();
    const release = await state.semaphore.acquire(options.signal);
    if (!release) {
      checkpoint();
      throw new ModelInvocationError(callError("CANCELLED", "external model operation cancelled"), aggregate);
    }
    let active = false;
    let intent: OperationIntendedEvent;
    try {
      checkpoint();
      const reserved = reserve(0);
      if (!reserved.ok) throw new ModelInvocationError(reserved.error, aggregate);
      const acquired = acquireLeaf(state.ledger.current);
      if (acquired === "saturated")
        throw new ModelInvocationError(callError("INVALID_RESULT", "model concurrency accounting diverged"), aggregate);
      state.ledger.current = acquired;
      active = true;
      intent = await appendIntent(requestIdentity, reserved.value);
    } catch (error) {
      if (active) state.ledger.current = releaseLeaf(state.ledger.current);
      release();
      throw error;
    }

    const startedMs = state.clock.now();
    let external: Promise<T>;
    try { external = Promise.resolve(effect()); }
    catch (error) { external = Promise.reject(error); }
    let settleLedger = false;
    const finalizer = trackFinalizer((async (): Promise<T> => {
      try {
        let value: T;
        try {
          value = await external;
        } catch (error) {
          if (!hasAuthority()) throw error;
          settleLedger = true;
          const usage: CallUsage = { attempts: 1, durationMs: elapsedMs(startedMs, state.clock.now()) };
          const cancelled = wasAborted(error, options.signal);
          const accountingError = accountUsage(0, usage);
          const failure = accountingError ?? callError(cancelled ? "CANCELLED" : "FAILED", cancelled
            ? "external operation cancelled"
            : "external operation failed");
          await appendSettlement(intent, accountingError ? "invalid_result" : cancelled ? "cancelled" : "error", usage, failure.code);
          if (accountingError) throw new ModelInvocationError(accountingError, aggregate);
          throw error;
        }
        if (!hasAuthority()) return value;
        settleLedger = true;
        const usage: CallUsage = { attempts: 1, durationMs: elapsedMs(startedMs, state.clock.now()) };
        const accountingError = accountUsage(0, usage);
        if (accountingError) {
          await appendSettlement(intent, "invalid_result", usage, accountingError.code);
          throw new ModelInvocationError(accountingError, aggregate);
        }
        await appendSettlement(intent, "ok", usage);
        return value;
      } finally {
        if (settleLedger && active) state.ledger.current = releaseLeaf(state.ledger.current);
        release();
      }
    })());
    return waitForAbort(finalizer, options.signal);
  };

  const runExternalReported = async <T>(
    effect: () => Promise<ExternalOperationResult<T>> | ExternalOperationResult<T>,
    requestIdentity: ExternalRequestIdentity,
  ): Promise<T> => {
    checkpoint();
    const release = await state.semaphore.acquire(options.signal);
    if (!release) {
      checkpoint();
      throw new ModelInvocationError(callError("CANCELLED", "external operation cancelled"), aggregate);
    }
    let active = false;
    let intent: OperationIntendedEvent;
    try {
      checkpoint();
      const reserved = reserve(0);
      if (!reserved.ok) throw new ModelInvocationError(reserved.error, aggregate);
      const acquired = acquireLeaf(state.ledger.current);
      if (acquired === "saturated")
        throw new ModelInvocationError(callError("INVALID_RESULT", "model concurrency accounting diverged"), aggregate);
      state.ledger.current = acquired;
      active = true;
      intent = await appendIntent(requestIdentity, reserved.value);
    } catch (error) {
      if (active) state.ledger.current = releaseLeaf(state.ledger.current);
      release();
      throw error;
    }

    const startedMs = state.clock.now();
    const measuredUsage = (): CallUsage => ({ attempts: 1, durationMs: elapsedMs(startedMs, state.clock.now()) });
    let external: Promise<ExternalOperationResult<T>>;
    try { external = Promise.resolve(effect()); }
    catch (error) { external = Promise.reject(error); }
    let settleLedger = false;
    const finalizer = trackFinalizer((async (): Promise<T> => {
      try {
        let result: ExternalOperationResult<T>;
        try {
          result = await external;
        } catch (error) {
          if (!hasAuthority()) throw error;
          settleLedger = true;
          const usage = measuredUsage();
          const accountingError = accountUsage(0, usage);
          const cancelled = wasAborted(error, options.signal);
          const failure = accountingError ?? callError(cancelled ? "CANCELLED" : "FAILED", cancelled
            ? "external operation cancelled"
            : "external operation failed");
          await appendSettlement(intent, accountingError ? "invalid_result" : cancelled ? "cancelled" : "error", usage, failure.code);
          throw new ModelInvocationError(failure, aggregate);
        }
        if (!hasAuthority()) return result.value;
        settleLedger = true;
        let usage = measuredUsage();
        if (result.usage !== undefined) {
          const normalized = normalizeCallUsage(result.usage, usageLimits(state));
          if (!normalized.ok) {
            const failure = accountUsage(0, usage) ?? callError("INVALID_RESULT", "external operation returned invalid usage");
            await appendSettlement(intent, "invalid_result", usage, failure.code);
            throw new ModelInvocationError(failure, aggregate);
          }
          usage = { ...normalized.value, attempts: 1 };
        }
        const validOutcome = result.outcome === "ok" || result.outcome === "error"
          || result.outcome === "cancelled" || result.outcome === "invalid_result";
        const validErrorCode = result.outcome === "ok"
          ? result.errorCode === undefined
          : typeof result.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.errorCode);
        if (!validOutcome || !validErrorCode) {
          const failure = accountUsage(0, usage) ?? callError("INVALID_RESULT", "external operation returned an invalid outcome");
          await appendSettlement(intent, "invalid_result", usage, failure.code);
          throw new ModelInvocationError(failure, aggregate);
        }
        const accountingError = accountUsage(0, usage);
        if (accountingError) {
          await appendSettlement(intent, "invalid_result", usage, accountingError.code);
          throw new ModelInvocationError(accountingError, aggregate);
        }
        await appendSettlement(intent, result.outcome, usage, result.errorCode);
        return result.value;
      } finally {
        if (settleLedger && active) state.ledger.current = releaseLeaf(state.ledger.current);
        release();
      }
    })());
    return waitForAbort(finalizer, options.signal);
  };

  return {
    get usage() { return aggregate; },
    get attemptCount() { return attemptOrdinal; },
    get logicalCallReserved() { return logicalReserved; },
    get idle() { return pendingFinalizers.size === 0; },
    waitForIdle,
    complete,
    runExternal,
    runExternalReported,
  };
};
