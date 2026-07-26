import type {
  SubagentDelegationV2Request,
  SubagentDelegationV2ResultRequest,
  SubagentDelegationV2Thinking,
  SubagentDelegationV2Usage,
} from "pi-subagents/delegation";
import type { JsonObject, JsonValue } from "../../core/json.ts";
import { cloneBoundedJson, dataProperty, isMissing, isPlainArray, isPlainRecord } from "./bounded-json.ts";

export const SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION = 2 as const;
export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

export const DELEGATION_V2_LIMITS = Object.freeze({
  idChars: 256,
  taskBytes: 256 * 1024,
  cwdBytes: 8 * 1024,
  shortTextBytes: 1024,
  schemaBytes: 32 * 1024,
  resultBytes: 2 * 1024 * 1024,
  updateBytes: 16 * 1024,
  errorBytes: 4 * 1024,
  maxUpdates: 256,
  maxJsonNodes: 100_000,
  maxJsonDepth: 100,
  maxUsageCount: 1_000_000_000,
  maxCostUsd: 1_000_000,
  maxDurationMs: 2_147_483_647,
  defaultStartTimeoutMs: 1_000,
} as const);

export const DELEGATION_JSON_LIMITS = (maxBytes: number) => ({
  maxBytes,
  maxNodes: DELEGATION_V2_LIMITS.maxJsonNodes,
  maxDepth: DELEGATION_V2_LIMITS.maxJsonDepth,
});

export interface DelegationEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface DelegationV2CallSpec {
  readonly requestId: string;
  readonly ownerRunId: string;
  readonly nodeId: string;
  readonly agent: string;
  readonly task: string;
  readonly context: "fresh" | "fork";
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: SubagentDelegationV2Thinking;
  readonly timeoutMs?: number;
  readonly turnBudget?: { readonly maxTurns: number; readonly graceTurns?: number };
  readonly toolBudget?: { readonly soft?: number; readonly hard: number; readonly block?: readonly string[] | "*" };
  readonly skill?: string | readonly string[] | boolean;
  readonly artifacts?: boolean;
  readonly result: { readonly kind: "text" } | { readonly kind: "structured"; readonly schema: JsonObject };
}

export interface DelegationV2Update {
  readonly currentTool?: string;
  readonly recentOutput?: string;
  readonly model?: string;
  readonly toolCount?: number;
  readonly durationMs?: number;
  readonly tokens?: number;
}

export interface DelegationV2Success {
  readonly ok: true;
  readonly status: "completed";
  readonly value: JsonValue;
  readonly usage?: SubagentDelegationV2Usage;
  readonly runId?: string;
  readonly agent?: string;
  readonly model?: string;
}

export type DelegationV2FailureCode =
  | "CANCELLED"
  | "TIMEOUT"
  | "UNAVAILABLE_CONTEXT"
  | "INVALID_REQUEST"
  | "DUPLICATE_NODE"
  | "TURN_BUDGET_EXHAUSTED"
  | "TOOL_BUDGET_EXHAUSTED"
  | "INVALID_RESULT"
  | "FAILED";

export interface DelegationV2Failure {
  readonly ok: false;
  readonly code: DelegationV2FailureCode;
  readonly status: string;
  readonly usage?: SubagentDelegationV2Usage;
}

export type DelegationV2Outcome = DelegationV2Success | DelegationV2Failure;
type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const boundedString = (value: unknown, maxBytes: number, nonEmpty = false): value is string =>
  typeof value === "string" && (!nonEmpty || value.trim().length > 0) && byteLength(value) <= maxBytes;
const validId = (value: unknown): value is string =>
  typeof value === "string"
  && value.trim().length > 0
  && value.length <= DELEGATION_V2_LIMITS.idChars
  && !/[\r\n]/.test(value);
const boundedInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const onlyKeys = (input: Record<string, unknown>, supported: ReadonlySet<string>): boolean => {
  let count = 0;
  for (const key in input) {
    if (!Object.hasOwn(input, key)) continue;
    count += 1;
    if (count > supported.size || !supported.has(key)) return false;
  }
  return true;
};

const parseStringArray = (
  input: unknown,
  maxEntries: number,
  maxBytes: number,
): string[] | undefined => {
  if (!isPlainArray(input) || input.length < 1 || input.length > maxEntries) return undefined;
  const cloned = cloneBoundedJson(input, DELEGATION_JSON_LIMITS(maxBytes));
  if (!cloned.ok || !Array.isArray(cloned.value)
    || !cloned.value.every((entry) => boundedString(entry, DELEGATION_V2_LIMITS.shortTextBytes, true))) return undefined;
  return cloned.value as string[];
};

const parseTurnBudget = (input: unknown): ParseResult<{ maxTurns: number; graceTurns?: number }> => {
  if (!isPlainRecord(input) || !onlyKeys(input, new Set(["maxTurns", "graceTurns"]))) return { ok: false };
  const maxTurns = dataProperty(input, "maxTurns");
  const graceTurns = dataProperty(input, "graceTurns");
  if (!boundedInteger(maxTurns, DELEGATION_V2_LIMITS.maxUsageCount, 1)) return { ok: false };
  if (!isMissing(graceTurns) && !boundedInteger(graceTurns, DELEGATION_V2_LIMITS.maxUsageCount)) return { ok: false };
  return { ok: true, value: { maxTurns, ...(isMissing(graceTurns) ? {} : { graceTurns }) } };
};

const parseToolBudget = (input: unknown): ParseResult<{ soft?: number; hard: number; block?: string[] | "*" }> => {
  if (!isPlainRecord(input) || !onlyKeys(input, new Set(["soft", "hard", "block"]))) return { ok: false };
  const hard = dataProperty(input, "hard");
  const soft = dataProperty(input, "soft");
  const block = dataProperty(input, "block");
  if (!boundedInteger(hard, DELEGATION_V2_LIMITS.maxUsageCount)) return { ok: false };
  if (!isMissing(soft) && !boundedInteger(soft, hard)) return { ok: false };
  let parsedBlock: string[] | "*" | undefined;
  if (!isMissing(block)) {
    if (block === "*") parsedBlock = "*";
    else {
      const parsed = parseStringArray(block, 256, 256 * (DELEGATION_V2_LIMITS.shortTextBytes + 3));
      if (parsed === undefined) return { ok: false };
      parsedBlock = parsed;
    }
  }
  return {
    ok: true,
    value: { ...(isMissing(soft) ? {} : { soft }), hard, ...(parsedBlock === undefined ? {} : { block: parsedBlock }) },
  };
};

const parseResultRequest = (input: unknown): ParseResult<SubagentDelegationV2ResultRequest> => {
  if (!isPlainRecord(input)) return { ok: false };
  const kind = dataProperty(input, "kind");
  if (kind === "text" && onlyKeys(input, new Set(["kind"]))) return { ok: true, value: { kind: "text" } };
  if (kind !== "structured" || !onlyKeys(input, new Set(["kind", "schema"]))) return { ok: false };
  const schema = cloneBoundedJson(dataProperty(input, "schema"), DELEGATION_JSON_LIMITS(DELEGATION_V2_LIMITS.schemaBytes));
  return schema.ok && isPlainRecord(schema.value)
    ? { ok: true, value: { kind: "structured", schema: schema.value } }
    : { ok: false };
};

const optionalString = (
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
): boolean => {
  const value = dataProperty(input, key);
  if (isMissing(value)) return true;
  if (!boundedString(value, DELEGATION_V2_LIMITS.shortTextBytes, true)) return false;
  output[key] = value;
  return true;
};

const REQUEST_FIELDS = new Set([
  "requestId", "ownerRunId", "nodeId", "agent", "task", "context", "cwd", "model", "thinking",
  "timeoutMs", "turnBudget", "toolBudget", "skill", "artifacts", "result",
]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const normalizeDelegationV2Request = (input: unknown): ParseResult<SubagentDelegationV2Request> => {
  if (!isPlainRecord(input) || !onlyKeys(input, REQUEST_FIELDS)) return { ok: false };
  const requestId = dataProperty(input, "requestId");
  const ownerRunId = dataProperty(input, "ownerRunId");
  const nodeId = dataProperty(input, "nodeId");
  const agent = dataProperty(input, "agent");
  const task = dataProperty(input, "task");
  const context = dataProperty(input, "context");
  const cwd = dataProperty(input, "cwd");
  if (!validId(requestId) || !validId(ownerRunId) || !validId(nodeId)
    || !boundedString(agent, DELEGATION_V2_LIMITS.shortTextBytes, true)
    || !boundedString(task, DELEGATION_V2_LIMITS.taskBytes, true)
    || (context !== "fresh" && context !== "fork")
    || !boundedString(cwd, DELEGATION_V2_LIMITS.cwdBytes, true)) return { ok: false };

  const output: Record<string, unknown> = {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId,
    ownerRunId,
    nodeId,
    agent,
    task,
    context,
    cwd,
  };
  if (!optionalString(input, output, "model")) return { ok: false };
  const thinking = dataProperty(input, "thinking");
  if (!isMissing(thinking)) {
    if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking)) return { ok: false };
    output["thinking"] = thinking;
  }
  const timeoutMs = dataProperty(input, "timeoutMs");
  if (!isMissing(timeoutMs)) {
    if (!boundedInteger(timeoutMs, DELEGATION_V2_LIMITS.maxDurationMs, 1)) return { ok: false };
    output["timeoutMs"] = timeoutMs;
  }
  const turnBudget = dataProperty(input, "turnBudget");
  if (!isMissing(turnBudget)) {
    const parsed = parseTurnBudget(turnBudget);
    if (!parsed.ok) return parsed;
    output["turnBudget"] = parsed.value;
  }
  const toolBudget = dataProperty(input, "toolBudget");
  if (!isMissing(toolBudget)) {
    const parsed = parseToolBudget(toolBudget);
    if (!parsed.ok) return parsed;
    output["toolBudget"] = parsed.value;
  }
  const skill = dataProperty(input, "skill");
  if (!isMissing(skill)) {
    if (typeof skill === "boolean") output["skill"] = skill;
    else if (boundedString(skill, DELEGATION_V2_LIMITS.shortTextBytes, true)) output["skill"] = skill;
    else {
      const parsed = parseStringArray(skill, 256, 64 * 1024);
      if (parsed === undefined || parsed.reduce((total, entry) => total + byteLength(entry), 0) > 64 * 1024)
        return { ok: false };
      output["skill"] = parsed;
    }
  }
  const artifacts = dataProperty(input, "artifacts");
  if (!isMissing(artifacts)) {
    if (typeof artifacts !== "boolean") return { ok: false };
    output["artifacts"] = artifacts;
  }
  const result = parseResultRequest(dataProperty(input, "result"));
  if (!result.ok) return result;
  output["result"] = result.value;
  return { ok: true, value: output as unknown as SubagentDelegationV2Request };
};

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns", "toolCalls", "durationMs"] as const;
const parseUsage = (input: unknown): ParseResult<SubagentDelegationV2Usage | undefined> => {
  if (isMissing(input)) return { ok: true, value: undefined };
  if (!isPlainRecord(input) || !onlyKeys(input, new Set(USAGE_FIELDS))) return { ok: false };
  const values = Object.fromEntries(USAGE_FIELDS.map((key) => [key, dataProperty(input, key)])) as Record<typeof USAGE_FIELDS[number], unknown>;
  if (!boundedInteger(values.input, DELEGATION_V2_LIMITS.maxUsageCount)
    || !boundedInteger(values.output, DELEGATION_V2_LIMITS.maxUsageCount)
    || !boundedInteger(values.cacheRead, DELEGATION_V2_LIMITS.maxUsageCount)
    || !boundedInteger(values.cacheWrite, DELEGATION_V2_LIMITS.maxUsageCount)
    || typeof values.cost !== "number" || !Number.isFinite(values.cost)
    || values.cost < 0 || values.cost > DELEGATION_V2_LIMITS.maxCostUsd
    || !boundedInteger(values.turns, DELEGATION_V2_LIMITS.maxUsageCount)
    || !boundedInteger(values.toolCalls, DELEGATION_V2_LIMITS.maxUsageCount)
    || !boundedInteger(values.durationMs, DELEGATION_V2_LIMITS.maxDurationMs)) return { ok: false };
  return { ok: true, value: values as unknown as SubagentDelegationV2Usage };
};

const statusFailureCode = (status: string): DelegationV2FailureCode => {
  switch (status) {
    case "cancelled":
    case "interrupted": return "CANCELLED";
    case "timed_out": return "TIMEOUT";
    case "unavailable_context": return "UNAVAILABLE_CONTEXT";
    case "invalid_request": return "INVALID_REQUEST";
    case "duplicate_node": return "DUPLICATE_NODE";
    case "turn_budget_exhausted": return "TURN_BUDGET_EXHAUSTED";
    case "tool_budget_exhausted": return "TOOL_BUDGET_EXHAUSTED";
    case "structured_output_failed": return "INVALID_RESULT";
    default: return "FAILED";
  }
};
const STATUSES = new Set([
  "completed", "failed", "timed_out", "cancelled", "interrupted", "turn_budget_exhausted",
  "tool_budget_exhausted", "structured_output_failed", "acceptance_failed", "invalid_request",
  "unavailable_context", "duplicate_node",
]);
const TERMINAL_FIELDS = new Set([
  "version", "requestId", "ownerRunId", "nodeId", "status", "error", "runId", "agent", "model",
  "thinking", "exitCode", "result", "usage",
]);

const OUTCOME_FIELDS = new Set(["ok", "status", "value", "usage", "runId", "agent", "model", "code"]);
const FAILURE_CODES = new Set<DelegationV2FailureCode>([
  "CANCELLED", "TIMEOUT", "UNAVAILABLE_CONTEXT", "INVALID_REQUEST", "DUPLICATE_NODE",
  "TURN_BUDGET_EXHAUSTED", "TOOL_BUDGET_EXHAUSTED", "INVALID_RESULT", "FAILED",
]);

/** Getter-free normalization for custom AgentDelegator implementations. */
export const normalizeDelegationV2Outcome = (
  input: unknown,
  requestedResult: "text" | "structured",
): DelegationV2Outcome | undefined => {
  const cloned = cloneBoundedJson(input, DELEGATION_JSON_LIMITS(DELEGATION_V2_LIMITS.resultBytes + 64 * 1024));
  if (!cloned.ok || !isPlainRecord(cloned.value) || !onlyKeys(cloned.value, OUTCOME_FIELDS)) return undefined;
  const ok = dataProperty(cloned.value, "ok");
  const status = dataProperty(cloned.value, "status");
  if (typeof status !== "string" || !boundedString(status, DELEGATION_V2_LIMITS.shortTextBytes, true)) return undefined;
  const usage = parseUsage(dataProperty(cloned.value, "usage"));
  if (!usage.ok) return undefined;
  if (ok === false) {
    const code = dataProperty(cloned.value, "code");
    if (typeof code !== "string" || !FAILURE_CODES.has(code as DelegationV2FailureCode)
      || Object.hasOwn(cloned.value, "value") || Object.hasOwn(cloned.value, "runId")
      || Object.hasOwn(cloned.value, "agent") || Object.hasOwn(cloned.value, "model")) return undefined;
    return {
      ok: false,
      code: code as DelegationV2FailureCode,
      status,
      ...(usage.value ? { usage: usage.value } : {}),
    };
  }
  if (ok !== true || status !== "completed" || !Object.hasOwn(cloned.value, "value")
    || Object.hasOwn(cloned.value, "code")) return undefined;
  const value = dataProperty(cloned.value, "value");
  if (isMissing(value) || (requestedResult === "text" && typeof value !== "string")) return undefined;
  const metadata: { runId?: string; agent?: string; model?: string } = {};
  for (const key of ["runId", "agent", "model"] as const) {
    const field = dataProperty(cloned.value, key);
    if (!isMissing(field)) {
      if (!boundedString(field, DELEGATION_V2_LIMITS.shortTextBytes, true)) return undefined;
      metadata[key] = field;
    }
  }
  return {
    ok: true,
    status: "completed",
    value: value as JsonValue,
    ...(usage.value ? { usage: usage.value } : {}),
    ...metadata,
  };
};

export interface DelegationIdentity {
  readonly requestId: string;
  readonly ownerRunId: string;
  readonly nodeId: string;
}

const identityMatches = (input: Record<string, unknown>, expected: DelegationIdentity): boolean => {
  if (dataProperty(input, "version") !== SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION
    || dataProperty(input, "requestId") !== expected.requestId) return false;
  return dataProperty(input, "ownerRunId") === expected.ownerRunId
    && dataProperty(input, "nodeId") === expected.nodeId;
};

export type ParsedTerminal =
  | { readonly kind: "unrelated" }
  | { readonly kind: "invalid" }
  | { readonly kind: "outcome"; readonly value: DelegationV2Outcome };

export const parseDelegationV2Terminal = (
  input: unknown,
  expected: DelegationIdentity,
  requestedResult: "text" | "structured",
): ParsedTerminal => {
  if (!isPlainRecord(input) || !identityMatches(input, expected)) return { kind: "unrelated" };
  if (!onlyKeys(input, TERMINAL_FIELDS)) return { kind: "invalid" };
  const status = dataProperty(input, "status");
  if (typeof status !== "string" || !STATUSES.has(status)) return { kind: "invalid" };
  const usageInput = dataProperty(input, "usage");
  if (Object.hasOwn(input, "usage") && isMissing(usageInput)) return { kind: "invalid" };
  const usage = parseUsage(usageInput);
  if (!usage.ok) return { kind: "invalid" };

  const metadata: { runId?: string; agent?: string; model?: string } = {};
  for (const key of ["runId", "agent", "model"] as const) {
    const field = dataProperty(input, key);
    if (Object.hasOwn(input, key) && isMissing(field)) return { kind: "invalid" };
    if (!isMissing(field)) {
      if (!boundedString(field, DELEGATION_V2_LIMITS.shortTextBytes, true)) return { kind: "invalid" };
      metadata[key] = field;
    }
  }
  const error = dataProperty(input, "error");
  if (Object.hasOwn(input, "error") && (isMissing(error) || !boundedString(error, DELEGATION_V2_LIMITS.errorBytes)))
    return { kind: "invalid" };
  const thinking = dataProperty(input, "thinking");
  if (Object.hasOwn(input, "thinking") && (isMissing(thinking) || !boundedString(thinking, DELEGATION_V2_LIMITS.shortTextBytes)))
    return { kind: "invalid" };
  const exitCode = dataProperty(input, "exitCode");
  if (Object.hasOwn(input, "exitCode")
    && (isMissing(exitCode) || !boundedInteger(exitCode, DELEGATION_V2_LIMITS.maxDurationMs, -DELEGATION_V2_LIMITS.maxDurationMs)))
    return { kind: "invalid" };
  const resultInput = dataProperty(input, "result");
  if (status !== "completed") {
    if (Object.hasOwn(input, "result")) return { kind: "invalid" };
    return {
      kind: "outcome",
      value: { ok: false, code: statusFailureCode(status), status, ...(usage.value ? { usage: usage.value } : {}) },
    };
  }

  if (Object.hasOwn(input, "error") || !Object.hasOwn(input, "result") || isMissing(resultInput)) return { kind: "invalid" };
  const result = resultInput;
  if (!isPlainRecord(result) || dataProperty(result, "kind") !== requestedResult) return { kind: "invalid" };
  let value: JsonValue;
  if (requestedResult === "text") {
    if (!onlyKeys(result, new Set(["kind", "text"]))) return { kind: "invalid" };
    const text = dataProperty(result, "text");
    if (!boundedString(text, DELEGATION_V2_LIMITS.resultBytes)) return { kind: "invalid" };
    value = text;
  } else {
    if (!onlyKeys(result, new Set(["kind", "value"]))) return { kind: "invalid" };
    const cloned = cloneBoundedJson(dataProperty(result, "value"), DELEGATION_JSON_LIMITS(DELEGATION_V2_LIMITS.resultBytes));
    if (!cloned.ok) return { kind: "invalid" };
    value = cloned.value;
  }

  return {
    kind: "outcome",
    value: { ok: true, status: "completed", value, ...(usage.value ? { usage: usage.value } : {}), ...metadata },
  };
};

const UPDATE_FIELDS = new Set([
  "version", "requestId", "ownerRunId", "nodeId", "currentTool", "currentToolArgs", "recentOutput",
  "recentOutputLines", "recentTools", "model", "toolCount", "durationMs", "tokens",
]);
const STARTED_FIELDS = new Set(["version", "requestId", "ownerRunId", "nodeId"]);

export const parseDelegationV2Update = (input: unknown, expected: DelegationIdentity): DelegationV2Update | undefined => {
  const snapshot = cloneBoundedJson(input, DELEGATION_JSON_LIMITS(64 * 1024));
  if (!snapshot.ok || !isPlainRecord(snapshot.value)) return undefined;
  const update = snapshot.value;
  if (!onlyKeys(update, UPDATE_FIELDS)
    || dataProperty(update, "version") !== SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION
    || dataProperty(update, "requestId") !== expected.requestId
    || dataProperty(update, "ownerRunId") !== expected.ownerRunId
    || dataProperty(update, "nodeId") !== expected.nodeId) return undefined;
  for (const key of ["currentToolArgs"] as const) {
    const value = dataProperty(update, key);
    if (!isMissing(value) && !boundedString(value, DELEGATION_V2_LIMITS.updateBytes)) return undefined;
  }
  const recentOutputLines = dataProperty(update, "recentOutputLines");
  if (!isMissing(recentOutputLines)
    && (!Array.isArray(recentOutputLines) || recentOutputLines.length > 256
      || recentOutputLines.some((line) => typeof line !== "string"))) return undefined;
  const recentTools = dataProperty(update, "recentTools");
  if (!isMissing(recentTools) && (!Array.isArray(recentTools) || recentTools.length > 256
    || recentTools.some((item) => !isPlainRecord(item) || !onlyKeys(item, new Set(["tool", "args"]))
      || !boundedString(dataProperty(item, "tool"), DELEGATION_V2_LIMITS.shortTextBytes, true)
      || !boundedString(dataProperty(item, "args"), DELEGATION_V2_LIMITS.updateBytes)))) return undefined;
  const output: { currentTool?: string; recentOutput?: string; model?: string; toolCount?: number; durationMs?: number; tokens?: number } = {};
  for (const key of ["currentTool", "recentOutput", "model"] as const) {
    const value = dataProperty(update, key);
    if (Object.hasOwn(update, key) && isMissing(value)) return undefined;
    if (!isMissing(value)) {
      if (!boundedString(value, DELEGATION_V2_LIMITS.updateBytes)) return undefined;
      output[key] = value;
    }
  }
  for (const key of ["toolCount", "tokens"] as const) {
    const value = dataProperty(update, key);
    if (Object.hasOwn(update, key) && isMissing(value)) return undefined;
    if (!isMissing(value)) {
      if (!boundedInteger(value, DELEGATION_V2_LIMITS.maxUsageCount)) return undefined;
      output[key] = value;
    }
  }
  const duration = dataProperty(update, "durationMs");
  if (Object.hasOwn(update, "durationMs") && isMissing(duration)) return undefined;
  if (!isMissing(duration)) {
    if (!boundedInteger(duration, DELEGATION_V2_LIMITS.maxDurationMs)) return undefined;
    output.durationMs = duration;
  }
  return output;
};

export const isDelegationV2Started = (input: unknown, expected: DelegationIdentity): boolean =>
  isPlainRecord(input)
  && onlyKeys(input, STARTED_FIELDS)
  && dataProperty(input, "version") === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION
  && dataProperty(input, "requestId") === expected.requestId
  && dataProperty(input, "ownerRunId") === expected.ownerRunId
  && dataProperty(input, "nodeId") === expected.nodeId;
