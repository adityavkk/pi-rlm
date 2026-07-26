import { AGENT_REQUEST_IDENTITY_VERSION, type RlmEvent } from "../core/journal.ts";
import { callError, type CallErrorCode } from "../core/errors.ts";
import { deriveCallId } from "../core/ids.ts";
import { canonicalStringify, isJsonObject, type JsonObject, type JsonValue } from "../core/json.ts";
import { normalizeJsonSchema, validateAgainstSchema } from "../core/schema.ts";
import { type CallUsage, ZERO_CALL_USAGE } from "../core/usage.ts";
import type { ContextDescriptor, ContextFileReference } from "../shell/context-store.ts";
import {
  normalizeDelegationV2Outcome,
  normalizeDelegationV2Request,
  type DelegationV2CallSpec,
  type DelegationV2FailureCode,
  type DelegationV2Outcome,
} from "../shell/delegation/index.ts";
import type { ThinkingLevel } from "../shell/model/client.ts";
import { authorizeAgent, isAgentName, type AgentApprovalDecision } from "./agent-delegation.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./abort.ts";
import { errResult, type GuestCallResult, okResult } from "./call-result.ts";
import { createModelOperation, ModelInvocationError } from "./provider.ts";
import type { FrameRef, RunState } from "./state.ts";
import { JournalAppendError } from "../shell/journal-store.ts";

const MAX_AGENT_TASK_BYTES = 128 * 1024;
const MAX_AGENT_TURNS = 40;
const MAX_AGENT_GRACE_TURNS = 4;
const MAX_AGENT_TOOL_CALLS = 100;
const AGENT_TASK_MANIFEST_VERSION = "pi-rlm.agent-context.v1";

export interface AgentCallHost {
  bindIdentity(key: string, identity: JsonValue): Promise<void>;
  retain(
    result: GuestCallResult,
    event: Extract<RlmEvent, { type: "call_committed" }>,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<GuestCallResult>;
}

class AgentDslError extends Error {
  override readonly name = "RlmDslError";
  constructor(readonly code: string, message: string) { super(message); }
}

const reqStr = (spec: JsonObject, key: string): string => {
  const value = spec[key];
  if (typeof value !== "string" || value.length === 0)
    throw new AgentDslError("INVALID_SPEC", `"${key}" must be a non-empty string`);
  return value;
};

const exactFields = (spec: JsonObject): void => {
  const supported = new Set([
    "key", "agent", "task", "context", "model", "schema", "timeoutMs", "piContext", "turnBudget", "toolBudget",
  ]);
  const unsupported = Object.keys(spec).find((key) => !supported.has(key));
  if (unsupported) throw new AgentDslError("INVALID_SPEC", `agent field "${unsupported}" is not supported`);
};

const resolveContexts = (state: RunState, value: JsonValue | undefined): ContextDescriptor[] => {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (!isJsonObject(item) || typeof item["id"] !== "string" || item["id"].length === 0)
      throw new AgentDslError("INVALID_SPEC", "context must contain context handles");
    const descriptor = state.store.get(item["id"]);
    if (!descriptor) throw new AgentDslError("INVALID_STATE", `context ${item["id"]} not found`);
    return descriptor;
  });
};

const resolveAgentModel = (
  state: RunState,
  selector: JsonValue | undefined,
): { model?: string; thinking?: ThinkingLevel } => {
  if (selector === undefined) return {};
  if (!isJsonObject(selector)) throw new AgentDslError("INVALID_SPEC", "model must be a model selector object");
  const fields = Object.keys(selector);
  if (fields.some((field) => field !== "tier" && field !== "thinking"))
    throw new AgentDslError("INVALID_SPEC", "agent model supports only tier and thinking");
  const tier = selector["tier"];
  if (tier !== "small" && tier !== "medium" && tier !== "large")
    throw new AgentDslError("INVALID_SPEC", "agent model tier must be small, medium, or large");
  const thinking = selector["thinking"];
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (thinking !== undefined && (typeof thinking !== "string" || !thinkingLevels.has(thinking)))
    throw new AgentDslError("INVALID_SPEC", "agent thinking level is invalid");
  return {
    model: state.profile.models[tier],
    ...(typeof thinking === "string" ? { thinking: thinking as ThinkingLevel } : {}),
  };
};

const boundedInteger = (value: JsonValue | undefined, field: string, maximum: number, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new AgentDslError("INVALID_SPEC", `${field} must be an integer between 0 and ${maximum}`);
  return value;
};

const normalizeTurnBudget = (value: JsonValue | undefined): { maxTurns: number; graceTurns: number } => {
  if (value === undefined) return { maxTurns: MAX_AGENT_TURNS, graceTurns: MAX_AGENT_GRACE_TURNS };
  if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "maxTurns" && key !== "graceTurns"))
    throw new AgentDslError("INVALID_SPEC", "turnBudget must contain maxTurns and optional graceTurns");
  const maxTurns = boundedInteger(value["maxTurns"], "turnBudget.maxTurns", MAX_AGENT_TURNS, MAX_AGENT_TURNS);
  if (maxTurns < 1) throw new AgentDslError("INVALID_SPEC", "turnBudget.maxTurns must be positive");
  return {
    maxTurns,
    graceTurns: boundedInteger(value["graceTurns"], "turnBudget.graceTurns", MAX_AGENT_GRACE_TURNS, MAX_AGENT_GRACE_TURNS),
  };
};

const normalizeBlock = (value: JsonValue | undefined): string[] | "*" | undefined => {
  if (value === undefined || value === "*") return value;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64
    || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 256))
    throw new AgentDslError("INVALID_SPEC", "toolBudget.block must be * or a bounded string array");
  return [...new Set(value as string[])];
};

const normalizeToolBudget = (
  value: JsonValue | undefined,
): { soft?: number; hard: number; block?: string[] | "*" } => {
  if (value === undefined) return { soft: 80, hard: MAX_AGENT_TOOL_CALLS };
  if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "soft" && key !== "hard" && key !== "block"))
    throw new AgentDslError("INVALID_SPEC", "toolBudget has unsupported fields");
  const hard = boundedInteger(value["hard"], "toolBudget.hard", MAX_AGENT_TOOL_CALLS, MAX_AGENT_TOOL_CALLS);
  const soft = boundedInteger(value["soft"], "toolBudget.soft", hard, Math.min(80, hard));
  const block = normalizeBlock(value["block"]);
  return { soft, hard, ...(block === undefined ? {} : { block }) };
};

interface NormalizedAgentSpec {
  readonly key: string;
  readonly agent: string;
  readonly task: string;
  readonly contexts: readonly ContextDescriptor[];
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly schema?: JsonObject;
  readonly timeoutMs: number;
  readonly piContext: "fresh" | "fork";
  readonly turnBudget: { readonly maxTurns: number; readonly graceTurns: number };
  readonly toolBudget: { readonly soft?: number; readonly hard: number; readonly block?: string[] | "*" };
  readonly identity: JsonValue;
}

const normalizeAgentSpec = (
  state: RunState,
  spec: JsonObject,
  deadlineMs: number,
): NormalizedAgentSpec => {
  exactFields(spec);
  const key = reqStr(spec, "key");
  const agent = reqStr(spec, "agent");
  const task = reqStr(spec, "task");
  if (task.trim().length === 0) throw new AgentDslError("INVALID_SPEC", "agent task must not be blank");
  if (!isAgentName(agent))
    throw new AgentDslError("INVALID_SPEC", "agent must be a bounded identifier");
  if (Buffer.byteLength(task, "utf8") > MAX_AGENT_TASK_BYTES)
    throw new AgentDslError("INVALID_SPEC", "agent task exceeds 128 KiB");
  const contexts = resolveContexts(state, spec["context"]);
  const { model, thinking } = resolveAgentModel(state, spec["model"]);
  let schema: JsonObject | undefined;
  if (spec["schema"] !== undefined) {
    const normalized = normalizeJsonSchema(spec["schema"]);
    if (!normalized.ok)
      throw new AgentDslError("INVALID_SPEC", `invalid JSON schema: ${normalized.error.map((error) => `${error.path}: ${error.message}`).join("; ")}`);
    schema = normalized.value;
  }
  const remainingMs = deadlineMs - state.clock.now();
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0)
    throw new AgentDslError("BUDGET_DEADLINE", "deadline reached during agent call");
  const requestedTimeout = spec["timeoutMs"];
  if (requestedTimeout !== undefined
    && (typeof requestedTimeout !== "number" || !Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1))
    throw new AgentDslError("INVALID_SPEC", "timeoutMs must be a positive safe integer");
  const timeoutMs = Math.min(remainingMs, (requestedTimeout as number | undefined) ?? remainingMs);
  const piContext = spec["piContext"] ?? "fresh";
  if (piContext !== "fresh" && piContext !== "fork")
    throw new AgentDslError("INVALID_SPEC", "piContext must be fresh or fork");
  const turnBudget = normalizeTurnBudget(spec["turnBudget"]);
  const toolBudget = normalizeToolBudget(spec["toolBudget"]);
  const identity: JsonValue = {
    agent,
    task,
    contexts: contexts.map((context) => context.sha256),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(schema ? { schema } : {}),
    timeoutMs: requestedTimeout ?? null,
    piContext,
    turnBudget,
    toolBudget,
    artifacts: true,
  };
  return {
    key,
    agent,
    task,
    contexts,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(schema ? { schema } : {}),
    timeoutMs,
    piContext,
    turnBudget,
    toolBudget,
    identity,
  };
};

const approvalEvent = async (
  state: RunState,
  frame: FrameRef,
  callId: string,
  agent: string,
  decision: AgentApprovalDecision,
): Promise<void> => {
  const appended = await state.journal.append({
    type: "agent_approval",
    frameId: frame.frameId,
    callId,
    agent,
    policyId: state.agentDelegation?.approval?.id ?? "allowlist-only",
    decision,
  });
  if (appended.event !== "committed") throw new Error("agent approval journal event was not committed");
  if (appended.statusCache.state === "failed") throw appended.statusCache.error;
};

interface DelegatedTask {
  readonly text: string;
  readonly references: readonly ContextFileReference[];
}

const delegatedTask = async (state: RunState, normalized: NormalizedAgentSpec, signal: AbortSignal): Promise<DelegatedTask> => {
  const references = await waitForAbort(
    Promise.all(normalized.contexts.map((context) => state.store.fileReference(context.id))),
    signal,
  );
  if (references.length === 0) return { text: normalized.task, references };
  const manifest = canonicalStringify({
    version: AGENT_TASK_MANIFEST_VERSION,
    contexts: references.map((reference) => ({
      id: reference.id,
      label: reference.label,
      path: reference.path,
      bytes: reference.bytes,
      sha256: reference.sha256,
      mimeType: reference.mimeType,
    })),
  });
  return {
    text: `${normalized.task}\n\nThe following JSON manifest lists verified pi-rlm input files. Read only the files needed for this task and preserve their SHA-256 references in your result when relevant.\n${manifest}`,
    references,
  };
};

const verifyDelegatedContexts = async (
  state: RunState,
  references: readonly ContextFileReference[],
  signal: AbortSignal,
): Promise<void> => {
  const verified = await waitForAbort(
    Promise.all(references.map((reference) => state.store.fileReference(reference.id))),
    signal,
  );
  for (let index = 0; index < references.length; index += 1) {
    const expected = references[index]!;
    const actual = verified[index]!;
    if (actual.path !== expected.path || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new Error("delegated context reference changed before launch");
  }
};

const nextRequestId = (state: RunState, callId: string): string => {
  const ordinal = (state.agentAttempts.get(callId) ?? 0) + 1;
  state.agentAttempts.set(callId, ordinal);
  return `req_${state.hasher(canonicalStringify({ callId, ordinal }))}`;
};

const delegationUsage = (outcome: DelegationV2Outcome): CallUsage | undefined => {
  if (!outcome.usage) return undefined;
  const inputTokens = outcome.usage.input + outcome.usage.cacheRead + outcome.usage.cacheWrite;
  const totalTokens = inputTokens + outcome.usage.output;
  return {
    attempts: 1,
    inputTokens,
    outputTokens: outcome.usage.output,
    totalTokens,
    costUsd: outcome.usage.cost,
    durationMs: outcome.usage.durationMs,
  };
};

const callCode = (code: DelegationV2FailureCode): CallErrorCode => {
  switch (code) {
    case "CANCELLED": return "CANCELLED";
    case "TIMEOUT": return "TIMED_OUT";
    case "UNAVAILABLE_CONTEXT": return "UNAVAILABLE_CONTEXT";
    case "INVALID_REQUEST": return "INVALID_REQUEST";
    case "INVALID_RESULT": return "INVALID_RESULT";
    case "DUPLICATE_NODE": return "UNKNOWN_EFFECT";
    case "TURN_BUDGET_EXHAUSTED":
    case "TOOL_BUDGET_EXHAUSTED": return "INTERRUPTED";
    default: return "FAILED";
  }
};

const callMessage = (code: CallErrorCode): string => {
  switch (code) {
    case "CANCELLED": return "delegated agent was cancelled";
    case "TIMED_OUT": return "delegated agent timed out";
    case "UNAVAILABLE_CONTEXT": return "pi-subagents delegation is unavailable";
    case "INVALID_REQUEST": return "delegated agent request was rejected";
    case "INVALID_RESULT": return "delegated agent returned an invalid result";
    case "UNKNOWN_EFFECT": return "delegated agent attempt has an unknown or duplicate effect";
    case "INTERRUPTED": return "delegated agent exhausted its turn or tool budget";
    default: return "delegated agent failed";
  }
};

interface AgentAttempt {
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly code?: CallErrorCode;
}

const attemptOutcome = (
  outcome: DelegationV2Outcome,
  schema: JsonObject | undefined,
): { value: AgentAttempt; outcome: "ok" | "error" | "cancelled" | "invalid_result"; errorCode?: string } => {
  if (!outcome.ok) {
    const code = callCode(outcome.code);
    return {
      value: { ok: false, code },
      outcome: code === "CANCELLED" ? "cancelled" : code === "INVALID_RESULT" || code === "INVALID_REQUEST" ? "invalid_result" : "error",
      errorCode: code,
    };
  }
  if (schema) {
    const errors = validateAgainstSchema(outcome.value, schema);
    if (errors.length > 0)
      return { value: { ok: false, code: "INVALID_RESULT" }, outcome: "invalid_result", errorCode: "INVALID_RESULT" };
  }
  return { value: { ok: true, value: outcome.value }, outcome: "ok" };
};

export const agentCall = async (
  state: RunState,
  frame: FrameRef,
  spec: JsonObject,
  signal: AbortSignal,
  deadlineMs: number,
  host: AgentCallHost,
): Promise<GuestCallResult> => {
  const normalized = normalizeAgentSpec(state, spec, deadlineMs);
  const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "agent", key: normalized.key, identity: normalized.identity });
  try {
    await host.bindIdentity(normalized.key, normalized.identity);
    throwIfAborted(signal);
  } catch (error) {
    if (error instanceof JournalAppendError || (error instanceof Error && error.name === "RlmDslError")) throw error;
    if (wasAborted(error, signal))
      return errResult(callId, callError("CANCELLED", "cell epoch closed"), ZERO_CALL_USAGE, false);
    throw error;
  }

  const cached = state.callCache.get(callId);
  if (cached) return { ...cached, cached: true };
  const pending = state.inflight.get(callId);
  if (pending) {
    try { return { ...(await waitForAbort(pending, signal)), cached: true }; }
    catch (error) {
      if (wasAborted(error, signal)) return errResult(callId, callError("CANCELLED", "cell epoch closed"), ZERO_CALL_USAGE, false);
      throw error;
    }
  }

  let task!: Promise<GuestCallResult>;
  task = (async (): Promise<GuestCallResult> => {
    const runtime = state.agentDelegation;
    let operation: ReturnType<typeof createModelOperation> | undefined;
    try {
      if (!runtime)
        return errResult(callId, callError("UNAVAILABLE_CONTEXT", "pi-subagents delegation is unavailable"), ZERO_CALL_USAGE, false);
      if (normalized.piContext === "fork" && !runtime.allowForkContext) {
        await approvalEvent(state, frame, callId, normalized.agent, "denied");
        return errResult(callId, callError("DENIED", "forked Pi context is not allowed for delegated agents"), ZERO_CALL_USAGE, false);
      }
      const decision = await authorizeAgent(runtime, {
        runId: state.runId,
        frameId: frame.frameId,
        callId,
        agent: normalized.agent,
        taskSha256: state.hasher(normalized.task),
        taskPreview: normalized.task.slice(0, 512),
        context: normalized.piContext,
        ...(normalized.model ? { model: normalized.model } : {}),
        ...(normalized.thinking ? { thinking: normalized.thinking } : {}),
      }, signal);
      await approvalEvent(state, frame, callId, normalized.agent, decision);
      if (decision === "denied")
        return errResult(callId, callError("DENIED", "delegated agent was not approved"), ZERO_CALL_USAGE, false);

      const delegated = await delegatedTask(state, normalized, signal);
      const request: DelegationV2CallSpec = {
        requestId: nextRequestId(state, callId),
        ownerRunId: state.runId,
        nodeId: callId,
        agent: normalized.agent,
        task: delegated.text,
        context: normalized.piContext,
        cwd: runtime.cwd,
        ...(normalized.model ? { model: normalized.model } : {}),
        ...(normalized.thinking ? { thinking: normalized.thinking } : {}),
        timeoutMs: normalized.timeoutMs,
        turnBudget: normalized.turnBudget,
        toolBudget: normalized.toolBudget,
        artifacts: true,
        result: normalized.schema ? { kind: "structured", schema: normalized.schema } : { kind: "text" },
      };
      const parsedRequest = normalizeDelegationV2Request(request);
      if (!parsedRequest.ok)
        return errResult(callId, callError("INVALID_REQUEST", "delegated agent request exceeds protocol limits"), ZERO_CALL_USAGE, false);
      const requestSha256 = state.hasher(canonicalStringify(parsedRequest.value as unknown as JsonValue));
      operation = createModelOperation(state, frame, {
        operationId: callId,
        kind: "agent",
        key: normalized.key,
        signal,
        deadlineMs,
      });
      const attempted = await operation.runExternalReported(async () => {
        await verifyDelegatedContexts(state, delegated.references, signal);
        const rawOutcome = await runtime.delegate(request, { signal });
        const outcome = normalizeDelegationV2Outcome(rawOutcome, request.result.kind) ?? {
          ok: false as const,
          code: "INVALID_RESULT" as const,
          status: "invalid_result",
        };
        const classified = attemptOutcome(outcome, normalized.schema);
        const usage = delegationUsage(outcome);
        return {
          value: classified.value,
          ...(usage ? { usage } : {}),
          outcome: classified.outcome,
          ...(classified.errorCode ? { errorCode: classified.errorCode } : {}),
        };
      }, { version: AGENT_REQUEST_IDENTITY_VERSION, sha256: requestSha256 });
      if (!attempted.ok) {
        const code = attempted.code ?? "FAILED";
        return errResult(callId, callError(code, callMessage(code)), operation.usage, false);
      }
      const result = okResult(callId, attempted.value as JsonValue, operation.usage, false);
      return host.retain(result, {
        type: "call_committed",
        frameId: frame.frameId,
        callId,
        kind: "agent",
        key: normalized.key,
        cached: false,
        ok: true,
        usage: operation.usage,
      }, runtime.runSignal, deadlineMs);
    } catch (error) {
      const usage = operation?.usage ?? ZERO_CALL_USAGE;
      if (error instanceof ModelInvocationError)
        return errResult(callId, error.callError, error.usage, false);
      if (wasAborted(error, signal) || (runtime && wasAborted(error, runtime.runSignal)))
        return errResult(callId, callError("CANCELLED", "cell epoch closed"), usage, false);
      if (error instanceof JournalAppendError) throw error;
      return errResult(callId, callError("FAILED", "delegated agent failed"), usage, false);
    }
  })();

  state.inflight.set(callId, task);
  void task.then(
    () => { if (state.inflight.get(callId) === task) state.inflight.delete(callId); },
    () => { if (state.inflight.get(callId) === task) state.inflight.delete(callId); },
  );
  try {
    return await waitForAbort(task, signal);
  } catch (error) {
    if (wasAborted(error, signal))
      return errResult(callId, callError("CANCELLED", "cell epoch closed"), ZERO_CALL_USAGE, false);
    throw error;
  }
};
