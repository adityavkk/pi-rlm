/**
 * Bridge broker (imperative shell): the single trusted place where guest calls
 * become real effects. It enforces spec validity, call identity and caching,
 * tree-wide budget reservations, leaf concurrency, structured-output validation
 * with one repair attempt, and authoritative journaling. Spec errors throw
 * (guest-catchable); call failures return a typed CallResult.
 */

import { releaseLogicalCall, reserveLogicalCall } from "../core/budget.ts";
import { callError } from "../core/errors.ts";
import { deriveCallId, identityHash, type CallKind } from "../core/ids.ts";
import type { RlmEvent } from "../core/journal.ts";
import type { JsonObject, JsonValue } from "../core/json.ts";
import { canonicalStringify, isJsonObject } from "../core/json.ts";
import { normalizeJsonSchema, validateAgainstSchema } from "../core/schema.ts";
import { MAX_CALL_TOKENS, type CallUsage, ZERO_CALL_USAGE } from "../core/usage.ts";
import { ContextBudgetError, type ContextDescriptor, type ContextOperationControl, type ContextStoreTransaction } from "../shell/context-store.ts";
import { JournalAppendError } from "../shell/journal-store.ts";
import type { ModelRequest, ThinkingLevel } from "../shell/model/client.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./abort.ts";
import { errResult, type GuestCallResult, okResult } from "./call-result.ts";
import { agentCall } from "./agent-call.ts";
import { createModelOperation, DEFAULT_MAX_OUTPUT_TOKENS, ModelInvocationError } from "./provider.ts";
export { tokenReservation } from "./provider.ts";
import type { FrameRef, KeyIdentityBinding, RunState } from "./state.ts";
import { remainingStoredBytes, reserveStoredBytes } from "./stored-bytes.ts";

export type RecurseFn = (args: JsonValue, signal: AbortSignal, deadlineMs: number) => Promise<GuestCallResult>;

class DslError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RlmDslError";
  }
}

const asObject = (value: JsonValue): JsonObject => {
  if (!isJsonObject(value)) throw new DslError("INVALID_SPEC", "call spec must be an object");
  return value;
};

const reqStr = (obj: JsonObject, key: string): string => {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw new DslError("INVALID_SPEC", `"${key}" must be a non-empty string`);
  return v;
};

export const resolveContextRefs = (
  state: RunState,
  value: JsonValue | undefined,
  field: string,
): ContextDescriptor[] => {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (!isJsonObject(item) || typeof item["id"] !== "string" || item["id"].length === 0)
      throw new DslError("INVALID_SPEC", `${field} must contain context handles`);
    const descriptor = state.store.get(item["id"]);
    if (!descriptor) throw new DslError("INVALID_STATE", `context ${item["id"]} not found`);
    return descriptor;
  });
};

const resolveModel = (state: RunState, selector: JsonValue | undefined): { model: string; thinking?: ThinkingLevel } => {
  const { models } = state.profile;
  if (isJsonObject(selector)) {
    if (typeof selector["tier"] === "string") {
      const tier = selector["tier"];
      const model = tier === "small" ? models.small : tier === "large" ? models.large : models.medium;
      return { model };
    }
    if (typeof selector["model"] === "string") {
      const thinking = selector["thinking"];
      return { model: selector["model"], ...(typeof thinking === "string" ? { thinking: thinking as ThinkingLevel } : {}) };
    }
  }
  return { model: models.medium };
};

const strictJson = (text: string): { ok: true; value: JsonValue } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text.trim()) as JsonValue };
  } catch {
    return { ok: false };
  }
};

const now = (state: RunState): number => state.clock.now();

const checkpointCall = (state: RunState, signal: AbortSignal, deadlineMs?: number): void => {
  throwIfAborted(signal);
  if (deadlineMs !== undefined && state.clock.now() >= deadlineMs)
    throw new DslError("BUDGET_DEADLINE", "deadline reached during call");
};

interface KeyClaim {
  readonly frame: FrameRef;
  readonly kind: CallKind;
  readonly key: string;
  readonly identity: JsonValue;
}

const keyRegistryId = (kind: CallKind, key: string, frame: FrameRef): string =>
  kind === "recurse"
    ? `${kind}\u0000${frame.lineage ?? frame.frameId}\u0000${key}`
    : `${kind}\u0000${key}`;

/** Atomically validate and bind stable keys before any reservation or effect. */
export const bindKeys = async (state: RunState, claims: readonly KeyClaim[]): Promise<void> => {
  const requested = new Map<string, KeyClaim & { canonicalIdentity: string; identityHash: string }>();
  for (const claim of claims) {
    const canonicalIdentity = canonicalStringify(claim.identity);
    const normalized = { ...claim, canonicalIdentity, identityHash: identityHash(state.hasher, claim.identity) };
    const id = keyRegistryId(claim.kind, claim.key, claim.frame);
    const prior = requested.get(id);
    if (prior && prior.canonicalIdentity !== canonicalIdentity)
      throw new DslError("KEY_IDENTITY_CHANGED", `${claim.kind} key "${claim.key}" was reused with a different identity`);
    if (!prior) requested.set(id, normalized);
  }

  for (;;) {
    const pending: Promise<void>[] = [];
    const additions: Array<KeyClaim & { canonicalIdentity: string; identityHash: string }> = [];
    for (const [id, claim] of requested) {
      const bound = state.keyIdentities.get(id);
      if (bound && bound.canonicalIdentity !== claim.canonicalIdentity)
        throw new DslError("KEY_IDENTITY_CHANGED", `${claim.kind} key "${claim.key}" was reused with a different identity`);
      if (bound?.state === "durable_failed") throw bound.error;
      if (bound?.state === "pending") pending.push(bound.ready);
      if (!bound) additions.push(claim);
    }

    if (pending.length > 0) {
      await Promise.all(pending);
      continue;
    }
    if (additions.length === 0) return;

    const installed = additions.map((claim) => {
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const binding: KeyIdentityBinding = {
        canonicalIdentity: claim.canonicalIdentity,
        identityHash: claim.identityHash,
        ready,
        state: "pending",
      };
      state.keyIdentities.set(keyRegistryId(claim.kind, claim.key, claim.frame), binding);
      return { claim, binding, resolveReady, rejectReady };
    });
    // Observe every deferred before journal I/O can reject one. This also makes
    // the initiating caller receive the same failure as concurrent waiters.
    const installedReady = Promise.all(installed.map(({ binding }) => binding.ready));

    for (let index = 0; index < installed.length; index++) {
      const current = installed[index]!;
      const { claim, binding } = current;
      try {
        await state.journal.append({
          type: "key_bound",
          frameId: claim.frame.frameId,
          kind: claim.kind,
          key: claim.key,
          identityHash: claim.identityHash,
        });
        binding.state = "durable";
        current.resolveReady();
      } catch (error) {
        if (error instanceof JournalAppendError && error.eventDurable) {
          binding.state = "durable_failed";
          binding.error = error;
        } else if (state.keyIdentities.get(keyRegistryId(claim.kind, claim.key, claim.frame)) === binding) {
          state.keyIdentities.delete(keyRegistryId(claim.kind, claim.key, claim.frame));
        }
        current.rejectReady(error);
        for (const remaining of installed.slice(index + 1)) {
          const id = keyRegistryId(remaining.claim.kind, remaining.claim.key, remaining.claim.frame);
          if (state.keyIdentities.get(id) === remaining.binding) state.keyIdentities.delete(id);
          remaining.rejectReady(error);
        }
        await installedReady;
        return;
      }
    }
    await installedReady;
    return;
  }
};

interface NormalizedLlmSpec {
  readonly key: string;
  readonly prompt: string;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
  readonly contextIds: string[];
  readonly schema?: JsonObject;
  readonly maxOutputTokens: number;
  readonly identity: JsonValue;
}

const normalizeLlmSpec = (state: RunState, spec: JsonObject): NormalizedLlmSpec => {
  const key = reqStr(spec, "key");
  const prompt = reqStr(spec, "prompt");
  const { model, thinking } = resolveModel(state, spec["model"]);
  const contexts = resolveContextRefs(state, spec["context"], "context");
  const ctxIds = contexts.map((context) => context.id);
  const schemaValue = spec["schema"];
  let schema: JsonObject | undefined;
  if (schemaValue !== undefined) {
    const normalized = normalizeJsonSchema(schemaValue);
    if (!normalized.ok)
      throw new DslError(
        "INVALID_SPEC",
        `invalid JSON schema: ${normalized.error.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
      );
    schema = normalized.value;
  }
  const rawMaxOutputTokens = spec["maxOutputTokens"];
  if (rawMaxOutputTokens !== undefined
    && (typeof rawMaxOutputTokens !== "number" || !Number.isSafeInteger(rawMaxOutputTokens)
      || rawMaxOutputTokens <= 0 || rawMaxOutputTokens > MAX_CALL_TOKENS))
    throw new DslError("INVALID_SPEC", `"maxOutputTokens" must be a positive safe integer at most ${MAX_CALL_TOKENS}`);
  const maxOutputTokens = (rawMaxOutputTokens as number | undefined) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const identity: JsonValue = {
    prompt,
    model,
    ...(thinking ? { thinking } : {}),
    ...(schema ? { schema } : {}),
    contexts: contexts.map((context) => context.sha256),
    maxOutputTokens,
  };
  return {
    key,
    prompt,
    model,
    ...(thinking ? { thinking } : {}),
    contextIds: ctxIds,
    ...(schema ? { schema } : {}),
    maxOutputTokens,
    identity,
  };
};

/** Handle one value-returning guest call. */
export const dispatchCall = async (
  state: RunState,
  frame: FrameRef,
  name: string,
  args: JsonValue,
  recurse: RecurseFn,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<unknown> => {
  throwIfAborted(signal);
  switch (name) {
    case "llm":
      return llm(state, frame, asObject(args), signal, false, deadlineMs);
    case "llm.batch":
      return llmBatch(state, frame, asObject(args), recurse, signal, deadlineMs);
    case "recurse":
      return recurse(args, signal, deadlineMs);
    case "agent":
      return agentCall(state, frame, asObject(args), signal, deadlineMs, {
        bindIdentity: (key, identity) => bindKeys(state, [{ frame, kind: "agent", key, identity }]),
        retain: (result, event, ownedSignal, ownedDeadlineMs) =>
          retainCallResult(state, result, event, ownedSignal, ownedDeadlineMs),
      });
    case "checkpoint":
      return "denied";
    case "context.read": {
      const o = objOpts(args) as { offsetBytes?: number; lengthBytes?: number };
      return state.store.read(reqStr(asObject(args), "id"), o, contextControl(state, deadlineMs, signal)) as unknown as JsonValue;
    }
    case "context.lines": {
      const o = objOpts(args) as { startLine?: number; count?: number };
      return state.store.lines(
        reqStr(asObject(args), "id"),
        {
          startLine: o.startLine === undefined ? 1 : o.startLine,
          count: o.count === undefined ? 100 : o.count,
        },
        contextControl(state, deadlineMs, signal),
      ) as unknown as JsonValue;
    }
    case "context.grep": {
      const o = objOpts(args) as { pattern?: string; maxMatches?: number; caseSensitive?: boolean; syntax?: "literal" };
      return state.store.grep(reqStr(asObject(args), "id"), {
        pattern: o.pattern === undefined ? "" : o.pattern,
        maxMatches: o.maxMatches === undefined ? 50 : o.maxMatches,
        ...(o.caseSensitive !== undefined ? { caseSensitive: o.caseSensitive } : {}),
        ...(o.syntax !== undefined ? { syntax: o.syntax } : {}),
      }, contextControl(state, deadlineMs, signal)) as unknown as JsonValue;
    }
    case "context.chunks": {
      const o = objOpts(args) as { targetTokens?: number; overlapTokens?: number; maxChunks?: number; boundary?: "line" | "none" };
      return withContextMutation(state, () =>
        state.store.chunks(reqStr(asObject(args), "id"), {
          targetTokens: o.targetTokens === undefined ? 4000 : o.targetTokens,
          maxChunks: o.maxChunks === undefined ? 32 : o.maxChunks,
          ...(o.overlapTokens !== undefined ? { overlapTokens: o.overlapTokens } : {}),
          ...(o.boundary !== undefined ? { boundary: o.boundary } : {}),
        }, contextControl(state, deadlineMs, signal, true)), signal,
      ) as unknown as JsonValue;
    }
    case "context.provenance":
      return [] as unknown as JsonValue;
    case "contexts.derive": {
      const spec = deriveSpec(asObject(args));
      const identity: JsonValue = { operation: "derive", value: spec.value, label: spec.label ?? `derived:${spec.key}` };
      await bindKeys(state, [{ frame, kind: "context", key: spec.key, identity }]);
      return withContextMutation(state, () =>
        state.store.derive(spec, contextControl(state, deadlineMs, signal, true)), signal) as unknown as JsonValue;
    }
    case "contexts.concat": {
      const { spec, descriptors } = concatSpec(state, asObject(args));
      const identity: JsonValue = {
        operation: "concat",
        refs: descriptors.map((descriptor) => descriptor.sha256),
        separator: spec.separator ?? "\n",
        label: spec.label ?? `concat:${spec.key}`,
      };
      await bindKeys(state, [{ frame, kind: "context", key: spec.key, identity }]);
      return withContextMutation(state, () =>
        state.store.concat(spec, contextControl(state, deadlineMs, signal, true)), signal) as unknown as JsonValue;
    }
    case "contexts.open": {
      const id = reqStr(asObject(args), "id");
      const desc = state.store.get(id);
      if (!desc) throw new DslError("INVALID_STATE", `context ${id} not found`);
      return desc as unknown as JsonValue;
    }
    case "artifacts.write":
      return writeArtifact(state, frame, asObject(args), signal) as unknown as JsonValue;
    case "artifacts.open": {
      const id = reqStr(asObject(args), "id");
      const entry = state.artifacts.get(id);
      if (!entry) throw new DslError("INVALID_STATE", `artifact ${id} not found`);
      return entry.descriptor as unknown as JsonValue;
    }
    case "artifacts.asContext": {
      const artifact = asObject(args)["artifact"];
      const id = isJsonObject(artifact) && typeof artifact["id"] === "string" ? artifact["id"] : "";
      const entry = state.artifacts.get(id);
      if (!entry) throw new DslError("INVALID_STATE", `artifact ${id} not found`);
      return withContextMutation(state, () =>
        state.store.ingestText(
          entry.descriptor.name,
          entry.text,
          entry.descriptor.mimeType,
          contextControl(state, deadlineMs, signal, true),
        ), signal) as unknown as JsonValue;
    }
    default:
      throw new DslError("INVALID_SPEC", `unknown bridge call "${name}"`);
  }
};

const objOpts = (args: JsonValue): Record<string, JsonValue> => {
  const o = asObject(args)["options"];
  return isJsonObject(o) ? o : {};
};

export const contextControl = (
  state: RunState,
  deadlineMs: number,
  signal?: AbortSignal,
  reserveOutput = false,
): ContextOperationControl => ({
  checkpoint: () => {
    throwIfAborted(signal);
    if (state.clock.now() >= deadlineMs)
      throw new DslError("BUDGET_DEADLINE", "deadline reached during context operation");
  },
  ...(reserveOutput
    ? {
        maxOutputBytes: remainingStoredBytes(state.ledger.current),
        reserveBytes: (bytes: number) => {
          const reserved = reserveStoredBytes(state.ledger, bytes);
          if (!reserved.ok) throw new DslError(reserved.error.code, reserved.error.message);
          return reserved.value;
        },
      }
    : {}),
});

const deriveSpec = (spec: JsonObject): { key: string; value: string | JsonValue; label?: string } => {
  const key = reqStr(spec, "key");
  if (!Object.prototype.hasOwnProperty.call(spec, "value"))
    throw new DslError("INVALID_SPEC", '"value" is required');
  const label = spec["label"];
  return { key, value: spec["value"] as JsonValue, ...(typeof label === "string" ? { label } : {}) };
};

const concatSpec = (
  state: RunState,
  value: JsonObject,
): {
  spec: { key: string; refs: Array<{ id: string }>; separator?: string; label?: string };
  descriptors: ContextDescriptor[];
} => {
  const key = reqStr(value, "key");
  const descriptors = resolveContextRefs(state, value["refs"], "refs");
  const refs = descriptors.map(({ id }) => ({ id }));
  const sep = value["separator"];
  const label = value["label"];
  return {
    spec: { key, refs, ...(typeof sep === "string" ? { separator: sep } : {}), ...(typeof label === "string" ? { label } : {}) },
    descriptors,
  };
};

export const withContextMutation = async <T>(
  state: RunState,
  op: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> => {
  if (signal) throwIfAborted(signal);
  const release = await state.contextSemaphore.acquire(signal);
  if (!release && signal) throwIfAborted(signal);
  try {
    return await op();
  } finally {
    release?.();
  }
};

const writeArtifact = async (
  state: RunState,
  frame: FrameRef,
  spec: JsonObject,
  signal: AbortSignal,
) => {
  const key = reqStr(spec, "key");
  const name = reqStr(spec, "name");
  if (!Object.prototype.hasOwnProperty.call(spec, "value"))
    throw new DslError("INVALID_SPEC", '"value" is required');
  const value = spec["value"] as JsonValue;
  const mimeType = typeof spec["mimeType"] === "string" ? (spec["mimeType"] as string) : typeof value === "string" ? "text/plain" : "application/json";
  const identity: JsonValue = { name, value, mimeType };
  await bindKeys(state, [{ frame, kind: "artifact", key, identity }]);
  throwIfAborted(signal);
  const text = typeof value === "string" ? value : canonicalStringify(value);
  const sha = state.hasher(text);
  const id = `art_${sha}`;
  const existing = state.artifacts.get(id);
  if (existing) return existing.descriptor;
  const descriptor = { id, name, bytes: Buffer.byteLength(text, "utf8"), sha256: sha, mimeType };
  const reserved = reserveStoredBytes(state.ledger, descriptor.bytes);
  if (!reserved.ok) throw new DslError(reserved.error.code, reserved.error.message);
  try {
    throwIfAborted(signal);
    state.artifacts.set(id, { descriptor, text });
    reserved.value.commit();
    return descriptor;
  } catch (error) {
    reserved.value.rollback();
    if (state.artifacts.get(id)?.descriptor === descriptor) state.artifacts.delete(id);
    throw error;
  }
};

export const retainCallResult = async (
  state: RunState,
  result: GuestCallResult,
  event: Extract<RlmEvent, { type: "call_committed" }>,
  signal: AbortSignal,
  deadlineMs?: number,
  cacheResult = true,
): Promise<GuestCallResult> => {
  checkpointCall(state, signal, deadlineMs);
  const release = await state.contextSemaphore.acquire(signal);
  if (!release) {
    checkpointCall(state, signal, deadlineMs);
    throw new Error("stored-byte persistence lock unavailable");
  }
  try {
    checkpointCall(state, signal, deadlineMs);
    const cached = state.callCache.get(result.callId);
    if (cached) return cached;

    let transaction: ContextStoreTransaction<ContextDescriptor>;
    try {
      transaction = await state.store.beginDerive(
        { key: `call-cache:${result.callId}`, value: result as unknown as JsonValue, label: `call-cache:${result.callId}` },
        contextControl(state, deadlineMs ?? state.ledger.current.limits.deadlineMs, signal, true),
      );
    } catch (error) {
      if ((error instanceof DslError && error.code === "BUDGET_BYTES") || error instanceof ContextBudgetError)
        return errResult(result.callId, callError("BUDGET_BYTES", error.message), result.usage, false);
      throw error;
    }

    const retained = { ...result, outputRef: transaction.value.id };
    let journalCommitted = false;
    let journalFailure: JournalAppendError | undefined;
    const appendWork = state.journal.append({
      ...event,
      outputRef: transaction.value.id,
      outputSha256: transaction.value.sha256,
      outputBytes: transaction.value.bytes,
    });
    try {
      const outcome = await waitForAbort(appendWork, signal) as Awaited<typeof appendWork> | undefined;
      journalCommitted = outcome?.event === undefined || outcome.event === "committed";
      if (outcome?.statusCache.state === "failed") journalFailure = outcome.statusCache.error;
    } catch (error) {
      if (wasAborted(error, signal)) {
        void appendWork.then(async (outcome) => {
          if (outcome.event === "committed") transaction.commit();
          else await transaction.rollback();
        }, async (appendError) => {
          if (appendError instanceof JournalAppendError && appendError.eventDurable) transaction.commit();
          else await transaction.rollback();
        }).catch(() => {});
        throw error;
      }
      journalCommitted = error instanceof JournalAppendError && error.eventDurable;
      if (journalCommitted) journalFailure = error as JournalAppendError;
      else {
        await transaction.rollback();
        throw error;
      }
    }
    if (!journalCommitted) {
      await transaction.rollback();
      throw new Error("call journal event ignored after terminal");
    }
    transaction.commit();
    if (!cacheResult) {
      if (journalFailure) throw journalFailure;
      return retained;
    }

    checkpointCall(state, signal, deadlineMs);
    state.callCache.set(result.callId, retained);
    state.progress?.publish();
    if (journalFailure) throw journalFailure;
    return retained;
  } finally {
    release();
  }
};

const llm = async (
  state: RunState,
  frame: FrameRef,
  spec: JsonObject,
  signal: AbortSignal,
  identityBound = false,
  deadlineMs?: number,
): Promise<GuestCallResult> => {
  const normalized = normalizeLlmSpec(state, spec);
  const { key, prompt, model, thinking, contextIds: ctxIds, schema, maxOutputTokens, identity } = normalized;
  const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "llm", key, identity });
  if (!identityBound) await bindKeys(state, [{ frame, kind: "llm", key, identity }]);

  const cancelled = (usage: CallUsage = ZERO_CALL_USAGE): GuestCallResult =>
    errResult(callId, callError("CANCELLED", "cell epoch closed"), usage, false);
  if (signal.aborted) return cancelled();

  const cached = state.callCache.get(callId);
  if (cached) return { ...cached, cached: true };
  const pending = state.inflight.get(callId);
  if (pending) {
    try {
      return { ...(await waitForAbort(pending, signal)), cached: true };
    } catch (error) {
      if (wasAborted(error, signal)) return cancelled();
      throw error;
    }
  }

  const operation = createModelOperation(state, frame, {
    operationId: callId,
    kind: "llm",
    key,
    signal,
    deadlineMs: deadlineMs ?? state.ledger.current.limits.deadlineMs,
  });
  let task!: Promise<GuestCallResult>;
  task = (async (): Promise<GuestCallResult> => {
    try {
      checkpointCall(state, signal, deadlineMs);
      const contexts = await waitForAbort(Promise.all(ctxIds.map((id) => state.store.load(id))), signal);
      checkpointCall(state, signal, deadlineMs);
      const request: ModelRequest = {
        prompt,
        context: contexts,
        model,
        ...(thinking ? { thinking } : {}),
        ...(schema ? { schema } : {}),
        maxOutputTokens,
        signal,
      };
      const first = await operation.complete(state.model, request);

      let value: JsonValue;
      if (schema) {
        const parsed = strictJson(first.text);
        let candidate = parsed.ok ? parsed.value : undefined;
        let errors = candidate === undefined ? ["not valid JSON"] : validateAgainstSchema(candidate, schema);
        if (candidate === undefined || errors.length > 0) {
          checkpointCall(state, signal, deadlineMs);
          const repairPrompt = `${prompt}

Return ONLY a JSON value that matches the required schema. Previous output was invalid (${errors.join("; ")}):
${first.text}`;
          const repair = await operation.complete(state.model, { ...request, prompt: repairPrompt });
          const reparsed = strictJson(repair.text);
          candidate = reparsed.ok ? reparsed.value : undefined;
          errors = candidate === undefined ? ["not valid JSON"] : validateAgainstSchema(candidate, schema);
        }
        if (candidate === undefined || errors.length > 0)
          return errResult(callId, callError("INVALID_RESULT", `structured output invalid: ${errors.join("; ")}`), operation.usage, false);
        value = candidate;
      } else {
        value = first.text;
      }

      checkpointCall(state, signal, deadlineMs);
      const usage = operation.usage;
      const result = okResult(callId, value, usage, false);
      return retainCallResult(state, result, {
        type: "call_committed",
        frameId: frame.frameId,
        callId,
        kind: "llm",
        key,
        cached: false,
        ok: true,
        usage,
      }, signal, deadlineMs);
    } catch (error) {
      if (error instanceof ModelInvocationError)
        return errResult(callId, error.callError, error.usage, false);
      if (wasAborted(error, signal)) return cancelled(operation.usage);
      if (error instanceof JournalAppendError) throw error;
      return errResult(callId, callError("FAILED", "model completion failed"), operation.usage, false);
    }
  })().then(
    (result) => {
      if (operation.logicalCallReserved && !result.ok) state.progress?.callFailed(callId);
      return result;
    },
    (error: unknown) => {
      if (operation.logicalCallReserved) state.progress?.callFailed(callId);
      throw error;
    },
  );

  state.inflight.set(callId, task);
  state.progress?.publish();
  try {
    return await task;
  } finally {
    if (state.inflight.get(callId) === task) state.inflight.delete(callId);
    state.progress?.publish();
  }
};

const llmBatch = async (
  state: RunState,
  frame: FrameRef,
  spec: JsonObject,
  recurse: RecurseFn,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<unknown> => {
  void recurse;
  reqStr(spec, "key");
  const items = spec["items"];
  if (!Array.isArray(items)) throw new DslError("INVALID_SPEC", "llm.batch requires an items array");
  const itemSpecs = items.map((item) => asObject(item));
  const normalizedItems = itemSpecs.map((item) => normalizeLlmSpec(state, item));
  const rawConcurrency = spec["concurrency"];
  if (rawConcurrency !== undefined
    && (typeof rawConcurrency !== "number" || !Number.isSafeInteger(rawConcurrency) || rawConcurrency <= 0))
    throw new DslError("INVALID_SPEC", '"concurrency" must be a positive safe integer');
  const concurrency = (rawConcurrency as number | undefined) ?? state.profile.maxConcurrency;
  await bindKeys(state, normalizedItems.map((item) => ({ frame, kind: "llm" as const, key: item.key, identity: item.identity })));
  const results: GuestCallResult[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    for (;;) {
      throwIfAborted(signal);
      const index = cursor++;
      if (index >= items.length) return;
      const result = await llm(state, frame, itemSpecs[index] as JsonObject, signal, true, deadlineMs);
      checkpointCall(state, signal, deadlineMs);
      results[index] = result;
    }
  });
  await waitForAbort(Promise.all(workers), signal);
  throwIfAborted(signal);
  return results as unknown as JsonValue;
};
