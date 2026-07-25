/**
 * Bridge broker (imperative shell): the single trusted place where guest calls
 * become real effects. It enforces spec validity, call identity and caching,
 * tree-wide budget reservations, leaf concurrency, structured-output validation
 * with one repair attempt, and authoritative journaling. Spec errors throw
 * (guest-catchable); call failures return a typed CallResult.
 */

import { releaseBytes, releaseLogicalCall, reserveAttempt, reserveBytes, reserveLogicalCall, settleAttempt } from "../core/budget.ts";
import { callError } from "../core/errors.ts";
import { deriveCallId } from "../core/ids.ts";
import type { JsonObject, JsonValue } from "../core/json.ts";
import { isJsonObject } from "../core/json.ts";
import { normalizeJsonSchema, validateAgainstSchema } from "../core/schema.ts";
import type { CallUsage } from "../core/usage.ts";
import { addUsage, ZERO_CALL_USAGE } from "../core/usage.ts";
import type { ContextOperationControl } from "../shell/context-store.ts";
import type { ModelRequest, ThinkingLevel } from "../shell/model/client.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./abort.ts";
import { errResult, type GuestCallResult, okResult } from "./call-result.ts";
import type { FrameRef, RunState } from "./state.ts";

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

const contextIds = (value: JsonValue | undefined): string[] => {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const item of list) {
    if (isJsonObject(item) && typeof item["id"] === "string") ids.push(item["id"]);
  }
  return ids;
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
      return llm(state, frame, asObject(args), signal);
    case "llm.batch":
      return llmBatch(state, frame, asObject(args), recurse, signal);
    case "recurse":
      return recurse(args, signal, deadlineMs);
    case "agent": {
      const spec = asObject(args);
      const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "agent", key: reqStr(spec, "key"), identity: spec });
      return errResult(callId, callError("UNAVAILABLE_CONTEXT", "agent() requires pi-subagents delegation (Phase 2)"), ZERO_CALL_USAGE, false) as unknown as JsonValue;
    }
    case "tools.call": {
      const spec = asObject(args);
      const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "tool", key: reqStr(spec, "key"), identity: spec });
      return errResult(callId, callError("DENIED", "tools.call requires an allowlisted profile (Phase 3)"), ZERO_CALL_USAGE, false) as unknown as JsonValue;
    }
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
    case "contexts.derive":
      return withContextMutation(state, () =>
        state.store.derive(deriveSpec(asObject(args)), contextControl(state, deadlineMs, signal, true)), signal) as unknown as JsonValue;
    case "contexts.concat":
      return withContextMutation(state, () =>
        state.store.concat(concatSpec(asObject(args)), contextControl(state, deadlineMs, signal, true)), signal) as unknown as JsonValue;
    case "contexts.open": {
      const id = reqStr(asObject(args), "id");
      const desc = state.store.get(id);
      if (!desc) throw new DslError("INVALID_STATE", `context ${id} not found`);
      return desc as unknown as JsonValue;
    }
    case "artifacts.write":
      return writeArtifact(state, asObject(args)) as unknown as JsonValue;
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
        maxOutputBytes: Math.max(0, state.ledger.current.limits.storedByteLimit - state.ledger.current.usage.storedBytes),
        reserveBytes: (bytes: number) => {
          const reserved = reserveBytes(state.ledger.current, bytes);
          if (!reserved.ok) throw new DslError(reserved.error.code, reserved.error.message);
          state.ledger.current = reserved.value;
          let active = true;
          return {
            rollback: () => {
              if (!active) return;
              active = false;
              state.ledger.current = releaseBytes(state.ledger.current, bytes);
            },
          };
        },
      }
    : {}),
});

const deriveSpec = (spec: JsonObject): { key: string; value: string | JsonValue; label?: string } => {
  const label = spec["label"];
  return { key: reqStr(spec, "key"), value: spec["value"] as JsonValue, ...(typeof label === "string" ? { label } : {}) };
};

const concatSpec = (spec: JsonObject): { key: string; refs: Array<{ id: string }>; separator?: string; label?: string } => {
  const refs = contextIds(spec["refs"]).map((id) => ({ id }));
  const sep = spec["separator"];
  const label = spec["label"];
  return { key: reqStr(spec, "key"), refs, ...(typeof sep === "string" ? { separator: sep } : {}), ...(typeof label === "string" ? { label } : {}) };
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

const writeArtifact = async (state: RunState, spec: JsonObject) => {
  const key = reqStr(spec, "key");
  const name = reqStr(spec, "name");
  const value = spec["value"] as JsonValue;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const sha = state.hasher(text);
  const id = `art_${sha.slice(0, 16)}`;
  const mimeType = typeof spec["mimeType"] === "string" ? (spec["mimeType"] as string) : typeof value === "string" ? "text/plain" : "application/json";
  const descriptor = { id, name, bytes: new TextEncoder().encode(text).length, sha256: sha, mimeType };
  if (!state.artifacts.has(id)) {
    state.artifacts.set(id, { descriptor, text });
    const reserved = reserveBytes(state.ledger.current, descriptor.bytes);
    if (reserved.ok) state.ledger.current = reserved.value;
  }
  void key;
  return descriptor;
};

const llm = async (state: RunState, frame: FrameRef, spec: JsonObject, signal: AbortSignal): Promise<GuestCallResult> => {
  const key = reqStr(spec, "key");
  const prompt = reqStr(spec, "prompt");
  const { model, thinking } = resolveModel(state, spec["model"]);
  const ctxIds = contextIds(spec["context"]);
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
  const maxOutputTokens = typeof spec["maxOutputTokens"] === "number" ? spec["maxOutputTokens"] : undefined;
  const identity: JsonValue = {
    prompt,
    model,
    ...(thinking ? { thinking } : {}),
    ...(schema ? { schema } : {}),
    contexts: ctxIds.map((id) => state.store.get(id)?.sha256 ?? id),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
  const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "llm", key, identity });

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

  let task!: Promise<GuestCallResult>;
  task = (async (): Promise<GuestCallResult> => {
    let release: (() => void) | undefined;
    let logicalReserved = false;
    let pendingTokenReservation = 0;
    let usage: CallUsage = ZERO_CALL_USAGE;
    try {
      throwIfAborted(signal);
      const reservedCall = reserveLogicalCall(state.ledger.current, now(state));
      if (!reservedCall.ok) return errResult(callId, reservedCall.error, usage, false);
      state.ledger.current = reservedCall.value;
      logicalReserved = true;

      release = await state.semaphore.acquire(signal);
      if (!release) return cancelled(usage);
      throwIfAborted(signal);

      const contexts = await waitForAbort(Promise.all(ctxIds.map((id) => state.store.load(id))), signal);
      throwIfAborted(signal);
      const request: ModelRequest = {
        prompt,
        context: contexts,
        model,
        ...(thinking ? { thinking } : {}),
        ...(schema ? { schema } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        signal,
      };
      const reserveTokens = Math.ceil(prompt.length / 4) + (maxOutputTokens ?? 512);
      const reservedAttempt = reserveAttempt(state.ledger.current, now(state), reserveTokens);
      if (!reservedAttempt.ok) return errResult(callId, reservedAttempt.error, usage, false);
      state.ledger.current = reservedAttempt.value;
      pendingTokenReservation = reserveTokens;

      const first = await waitForAbort(state.model.complete(request), signal);
      throwIfAborted(signal);
      usage = first.usage;
      state.ledger.current = settle(state, reserveTokens, first.usage.totalTokens ?? 0);
      pendingTokenReservation = 0;

      let value: JsonValue;
      if (schema) {
        const parsed = strictJson(first.text);
        let candidate = parsed.ok ? parsed.value : undefined;
        let errors = candidate === undefined ? ["not valid JSON"] : validateAgainstSchema(candidate, schema);
        if (candidate === undefined || errors.length > 0) {
          throwIfAborted(signal);
          const repairReserve = reserveAttempt(state.ledger.current, now(state), reserveTokens);
          if (repairReserve.ok) {
            state.ledger.current = repairReserve.value;
            pendingTokenReservation = reserveTokens;
            const repair = await waitForAbort(state.model.complete({
              ...request,
              prompt: `${prompt}\n\nReturn ONLY a JSON value that matches the required schema. Previous output was invalid (${errors.join("; ")}):\n${first.text}`,
            }), signal);
            throwIfAborted(signal);
            usage = addUsage(usage, repair.usage);
            state.ledger.current = settle(state, reserveTokens, repair.usage.totalTokens ?? 0);
            pendingTokenReservation = 0;
            const reparsed = strictJson(repair.text);
            candidate = reparsed.ok ? reparsed.value : undefined;
            errors = candidate === undefined ? ["not valid JSON"] : validateAgainstSchema(candidate, schema);
          }
        }
        if (candidate === undefined || errors.length > 0)
          return errResult(callId, callError("INVALID_RESULT", `structured output invalid: ${errors.join("; ")}`), usage, false);
        value = candidate;
      } else {
        value = first.text;
      }

      throwIfAborted(signal);
      const result = okResult(callId, value, usage, false);
      await state.journal.append({ type: "call_committed", frameId: frame.frameId, callId, kind: "llm", key, cached: false, ok: true, usage });
      throwIfAborted(signal);
      state.callCache.set(callId, result);
      logicalReserved = false;
      return result;
    } catch (error) {
      if (wasAborted(error, signal)) return cancelled(usage);
      logicalReserved = false;
      return errResult(callId, callError("FAILED", (error as Error).message), usage, false);
    } finally {
      if (pendingTokenReservation > 0) {
        state.ledger.current = settle(state, pendingTokenReservation, 0);
      }
      if (logicalReserved && signal.aborted) {
        state.ledger.current = releaseLogicalCall(state.ledger.current);
      }
      release?.();
    }
  })();

  state.inflight.set(callId, task);
  try {
    return await task;
  } finally {
    if (state.inflight.get(callId) === task) state.inflight.delete(callId);
  }
};

const settle = (state: RunState, reserved: number, actual: number) =>
  settleAttempt(state.ledger.current, reserved, actual);

const llmBatch = async (
  state: RunState,
  frame: FrameRef,
  spec: JsonObject,
  recurse: RecurseFn,
  signal: AbortSignal,
): Promise<unknown> => {
  void recurse;
  reqStr(spec, "key");
  const items = spec["items"];
  if (!Array.isArray(items)) throw new DslError("INVALID_SPEC", "llm.batch requires an items array");
  const concurrency = typeof spec["concurrency"] === "number" ? Math.max(1, spec["concurrency"]) : state.profile.maxConcurrency;
  const results: GuestCallResult[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    for (;;) {
      throwIfAborted(signal);
      const index = cursor++;
      if (index >= items.length) return;
      const result = await llm(state, frame, asObject(items[index] as JsonValue), signal);
      throwIfAborted(signal);
      results[index] = result;
    }
  });
  await waitForAbort(Promise.all(workers), signal);
  throwIfAborted(signal);
  return results as unknown as JsonValue;
};
