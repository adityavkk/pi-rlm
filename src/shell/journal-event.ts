import { isProxy } from "node:util/types";
import { interpreterError, type InterpreterError } from "../core/errors.ts";
import type { RlmEvent } from "../core/journal.ts";
import {
  deriveOperationIntentId,
  OPERATION_JOURNAL_SCHEMA_VERSION,
  operationRequestVersionAllowed,
  type OperationIntentIdentity,
} from "../core/operation.ts";
import { err, ok, type Result } from "../core/result.ts";
import { MAX_CALL_TOKENS } from "../core/usage.ts";
import { sha256 } from "./hash.ts";

const MAX_EVENT_DEPTH = 5;
const MAX_EVENT_NODES = 20_000;
const MAX_EVENT_ARRAY = 10_000;
const MAX_EVENT_STRING = 1_048_576;
const MAX_EVENT_KEYS = 32;
const HASH = /^[0-9a-f]{64}$/;
const OPERATION_INTENT_ID = /^op_[0-9a-f]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTEXT_REF = /^ctx_[0-9a-f]{64}$/;
const CALL_KINDS = new Set(["llm", "agent", "recurse", "tool", "artifact", "context"]);
const COMPLETION_MODES = new Set(["answer", "fallback_extract"]);
const FRAME_STATES = new Set(["open", "answered", "closed", "failed", "cancelled"]);
const OPERATION_KINDS = new Set(["controller", "llm", "extractor", "agent"]);
const AGENT_APPROVAL_DECISIONS = new Set(["allowlisted", "approved", "denied"]);
const OPERATION_OUTCOMES = new Set(["ok", "error", "cancelled", "invalid_result"]);

type RecordValue = Record<string, unknown>;
const own = (value: RecordValue, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Getter-, proxy-, and prototype-free bounded snapshot of an injectable value. */
const snapshot = (input: unknown): unknown | undefined => {
  let nodes = 0;
  const walk = (value: unknown, depth: number): unknown | undefined => {
    if (++nodes > MAX_EVENT_NODES || depth > MAX_EVENT_DEPTH) return undefined;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return value.length <= MAX_EVENT_STRING ? value : undefined;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value !== "object") return undefined;
    try {
      if (isProxy(value)) return undefined;
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_EVENT_ARRAY) return undefined;
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1 || !keys.includes("length")) return undefined;
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
          const item = walk(descriptor.value, depth + 1);
          if (item === undefined) return undefined;
          result.push(item);
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_EVENT_KEYS || keys.some((key) => typeof key !== "string")) return undefined;
      const result = Object.create(null) as RecordValue;
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
        const item = walk(descriptor.value, depth + 1);
        if (item === undefined) return undefined;
        result[key] = item;
      }
      return result;
    } catch {
      return undefined;
    }
  };
  return walk(input, 0);
};

const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const exact = (value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => own(value, key)) && keys.every((key) => allowed.has(key));
};
const string = (value: RecordValue, key: string, empty = true): boolean =>
  typeof value[key] === "string" && (empty || (value[key] as string).length > 0);
const boolean = (value: RecordValue, key: string): boolean => typeof value[key] === "boolean";
const integer = (value: RecordValue, key: string, positive = false): boolean =>
  typeof value[key] === "number" && Number.isSafeInteger(value[key]) && (positive ? (value[key] as number) > 0 : (value[key] as number) >= 0);
const hash = (value: RecordValue, key: string): boolean => string(value, key, false) && HASH.test(value[key] as string);
const contextRef = (value: RecordValue, key: string): boolean => string(value, key, false) && CONTEXT_REF.test(value[key] as string);
const optional = (value: RecordValue, key: string, validate: () => boolean): boolean => !own(value, key) || validate();
const oneOf = (value: RecordValue, key: string, values: ReadonlySet<string>): boolean =>
  string(value, key, false) && values.has(value[key] as string);

const validError = (value: unknown): boolean => {
  const item = record(value);
  return item !== undefined && exact(item, ["code", "message"]) && string(item, "code", false) && string(item, "message");
};

const validUsage = (value: unknown): boolean => {
  const usage = record(value);
  if (!usage || !exact(usage, ["attempts", "durationMs"], ["inputTokens", "outputTokens", "totalTokens", "costUsd"])) return false;
  if (!integer(usage, "attempts") || !integer(usage, "durationMs")) return false;
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (!optional(usage, key, () => integer(usage, key))) return false;
  }
  return optional(usage, "costUsd", () => typeof usage["costUsd"] === "number"
    && Number.isFinite(usage["costUsd"]) && (usage["costUsd"] as number) >= 0 && (usage["costUsd"] as number) <= 1_000_000_000_000);
};

const validLimits = (value: unknown): boolean => {
  const limits = record(value);
  const required = ["maxDepth", "maxFrames", "maxLogicalCalls", "maxAttempts", "maxControllerTurns", "maxConcurrency", "storedByteLimit", "deadlineMs"];
  if (!limits || !exact(limits, required, ["tokenLimit"]) || !integer(limits, "maxDepth")
    || !integer(limits, "maxFrames", true) || !integer(limits, "maxLogicalCalls") || !integer(limits, "maxAttempts")
    || !integer(limits, "maxControllerTurns") || !integer(limits, "maxConcurrency", true)
    || !integer(limits, "storedByteLimit") || !integer(limits, "deadlineMs")) return false;
  return optional(limits, "tokenLimit", () => integer(limits, "tokenLimit"));
};

const validInputRefs = (value: unknown): boolean => Array.isArray(value) && value.every((raw) => {
  const item = record(raw);
  return item !== undefined && exact(item, ["name", "id", "sha256", "bytes"])
    && string(item, "name", false) && contextRef(item, "id") && hash(item, "sha256") && integer(item, "bytes")
    && item["id"] === `ctx_${item["sha256"]}`;
});

const validStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

const validOperationReservation = (value: unknown): boolean => {
  const reservation = record(value);
  return reservation !== undefined && exact(reservation, ["logicalCalls", "attempts", "tokens"])
    && (reservation["logicalCalls"] === 0 || reservation["logicalCalls"] === 1)
    && reservation["attempts"] === 1 && integer(reservation, "tokens")
    && (reservation["tokens"] as number) <= MAX_CALL_TOKENS;
};

const validOptionalOutput = (
  value: RecordValue,
  refKey: "outputRef",
  hashKey: "outputRefSha256" | "outputSha256",
  bytesKey: "outputRefBytes" | "outputBytes",
): boolean => {
  const count = [refKey, hashKey, bytesKey].filter((key) => own(value, key)).length;
  return count === 0 || (count === 1 && own(value, refKey) && contextRef(value, refKey))
    || (count === 3 && contextRef(value, refKey) && hash(value, hashKey) && integer(value, bytesKey)
      && value[refKey] === `ctx_${value[hashKey]}`);
};

const validEvent = (event: RecordValue): boolean => {
  if (!string(event, "type", false)) return false;
  switch (event["type"]) {
    case "run_started":
      return exact(event, ["type", "runId", "manifestHash", "limits"], ["inputRefs"])
        && string(event, "runId", false) && hash(event, "manifestHash") && validLimits(event["limits"])
        && optional(event, "inputRefs", () => validInputRefs(event["inputRefs"]));
    case "frame_opened":
      return exact(event, ["type", "frameId", "parentFrameId", "depth", "objective"])
        && string(event, "frameId", false) && (event["parentFrameId"] === null || typeof event["parentFrameId"] === "string")
        && integer(event, "depth") && string(event, "objective");
    case "phase":
      return exact(event, ["type", "frameId", "iteration", "ordinal", "name"])
        && string(event, "frameId", false) && integer(event, "iteration", true) && integer(event, "ordinal") && string(event, "name");
    case "emit":
      return exact(event, ["type", "frameId", "iteration", "ordinal", "message"])
        && string(event, "frameId", false) && integer(event, "iteration", true) && integer(event, "ordinal") && string(event, "message");
    case "key_bound":
      return exact(event, ["type", "frameId", "kind", "key", "identityHash"])
        && string(event, "frameId", false) && oneOf(event, "kind", CALL_KINDS) && string(event, "key") && hash(event, "identityHash");
    case "agent_approval":
      return exact(event, ["type", "frameId", "callId", "agent", "policyId", "decision"])
        && string(event, "frameId", false) && string(event, "callId", false) && string(event, "agent", false)
        && string(event, "policyId", false) && oneOf(event, "decision", AGENT_APPROVAL_DECISIONS);
    case "cell_committed":
      return exact(event, ["type", "frameId", "iteration", "reasoning", "codeHash", "hasResult", "outputPreview"],
        ["outputBytes", "outputOmittedBytes", "usage", "outputRef", "outputRefSha256", "outputRefBytes", "error"])
        && string(event, "frameId", false) && integer(event, "iteration", true) && string(event, "reasoning") && hash(event, "codeHash")
        && boolean(event, "hasResult") && string(event, "outputPreview")
        && optional(event, "outputBytes", () => integer(event, "outputBytes"))
        && optional(event, "outputOmittedBytes", () => integer(event, "outputOmittedBytes"))
        && optional(event, "usage", () => validUsage(event["usage"])) && optional(event, "error", () => validError(event["error"]))
        && validOptionalOutput(event, "outputRef", "outputRefSha256", "outputRefBytes");
    case "workspace_committed":
      return exact(event, ["type", "frameId", "iteration", "workspaceRef", "workspaceSha256", "workspaceBytes"])
        && string(event, "frameId", false) && integer(event, "iteration", true) && contextRef(event, "workspaceRef")
        && hash(event, "workspaceSha256") && integer(event, "workspaceBytes") && event["workspaceRef"] === `ctx_${event["workspaceSha256"]}`;
    case "fallback_evidence_projected":
      return exact(event, ["type", "frameId", "projectionVersion", "projectionHash", "projectedBytes", "maxBytes", "omittedBytes",
        "omittedItems", "truncatedItems", "evidenceIdCount", "evidenceIdsHash", "truncated"])
        && string(event, "frameId", false) && string(event, "projectionVersion", false) && hash(event, "projectionHash")
        && integer(event, "projectedBytes") && integer(event, "maxBytes") && integer(event, "omittedBytes")
        && integer(event, "omittedItems") && integer(event, "truncatedItems") && integer(event, "evidenceIdCount")
        && hash(event, "evidenceIdsHash") && boolean(event, "truncated");
    case "fallback_evidence_cited":
      return exact(event, ["type", "frameId", "evidenceRefs", "evidenceRefsHash"])
        && string(event, "frameId", false) && validStringArray(event["evidenceRefs"]) && hash(event, "evidenceRefsHash");
    case "operation_intended": {
      if (!exact(event, ["type", "schemaVersion", "runId", "frameId", "operationId", "kind", "key", "attempt",
        "requestIdentityVersion", "requestSha256", "reservation", "intentId"])
        || event["schemaVersion"] !== OPERATION_JOURNAL_SCHEMA_VERSION
        || !string(event, "runId", false) || !string(event, "frameId", false) || !string(event, "operationId", false)
        || !oneOf(event, "kind", OPERATION_KINDS) || !string(event, "key") || !integer(event, "attempt", true)
        || !string(event, "requestIdentityVersion", false) || !hash(event, "requestSha256")
        || !validOperationReservation(event["reservation"])
        || !string(event, "intentId", false) || !OPERATION_INTENT_ID.test(event["intentId"] as string)
        || !operationRequestVersionAllowed(event["kind"] as OperationIntentIdentity["kind"], event["requestIdentityVersion"] as string))
        return false;
      const identity: OperationIntentIdentity = {
        schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
        runId: event["runId"] as string,
        frameId: event["frameId"] as string,
        operationId: event["operationId"] as string,
        kind: event["kind"] as OperationIntentIdentity["kind"],
        key: event["key"] as string,
        attempt: event["attempt"] as number,
        requestIdentityVersion: event["requestIdentityVersion"] as OperationIntentIdentity["requestIdentityVersion"],
        requestSha256: event["requestSha256"] as string,
        reservation: event["reservation"] as unknown as OperationIntentIdentity["reservation"],
      };
      return event["intentId"] === deriveOperationIntentId(sha256, identity);
    }
    case "operation_settled": {
      if (!exact(event, ["type", "schemaVersion", "runId", "frameId", "intentId", "outcome", "usage"], ["errorCode"])
        || event["schemaVersion"] !== OPERATION_JOURNAL_SCHEMA_VERSION
        || !string(event, "runId", false) || !string(event, "frameId", false)
        || !string(event, "intentId", false) || !OPERATION_INTENT_ID.test(event["intentId"] as string)
        || !oneOf(event, "outcome", OPERATION_OUTCOMES) || !validUsage(event["usage"])) return false;
      const usage = record(event["usage"]);
      if (usage?.["attempts"] !== 1) return false;
      const okOutcome = event["outcome"] === "ok";
      return okOutcome
        ? !own(event, "errorCode")
        : own(event, "errorCode") && string(event, "errorCode", false) && ERROR_CODE.test(event["errorCode"] as string);
    }
    case "call_committed":
      return exact(event, ["type", "frameId", "callId", "kind", "key", "cached", "ok", "usage"],
        ["outputRef", "outputSha256", "outputBytes"])
        && string(event, "frameId", false) && string(event, "callId", false) && oneOf(event, "kind", CALL_KINDS)
        && string(event, "key") && boolean(event, "cached") && boolean(event, "ok") && validUsage(event["usage"])
        && validOptionalOutput(event, "outputRef", "outputSha256", "outputBytes");
    case "answer_committed": {
      if (!exact(event, ["type", "frameId", "completionMode", "outputRef"], ["outputSha256", "outputBytes"])
        || !string(event, "frameId", false) || !oneOf(event, "completionMode", COMPLETION_MODES) || !contextRef(event, "outputRef")) return false;
      const metadata = Number(own(event, "outputSha256")) + Number(own(event, "outputBytes"));
      return metadata === 0 || (metadata === 2 && hash(event, "outputSha256") && integer(event, "outputBytes")
        && event["outputRef"] === `ctx_${event["outputSha256"]}`);
    }
    case "frame_closed":
      return exact(event, ["type", "frameId", "state"]) && string(event, "frameId", false) && oneOf(event, "state", FRAME_STATES);
    case "run_completed":
      return exact(event, ["type", "runId", "completionMode"], ["outputRef"])
        && string(event, "runId", false) && oneOf(event, "completionMode", COMPLETION_MODES)
        && optional(event, "outputRef", () => contextRef(event, "outputRef"));
    case "run_failed":
      return exact(event, ["type", "runId", "code", "message"])
        && string(event, "runId", false) && string(event, "code", false) && string(event, "message");
    case "run_cancelled":
      return exact(event, ["type", "runId", "code", "message"])
        && string(event, "runId", false) && event["code"] === "CANCELLED" && string(event, "message");
    default:
      return false;
  }
};

/** Exhaustive strict boundary used for both legacy records and batch members. Never throws. */
export const parseRlmEvent = (input: unknown): Result<RlmEvent, InterpreterError> => {
  try {
    const copied = snapshot(input);
    const event = record(copied);
    return event && validEvent(event)
      ? ok(event as unknown as RlmEvent)
      : err(interpreterError("JOURNAL_CORRUPT", "invalid journal event"));
  } catch {
    return err(interpreterError("JOURNAL_CORRUPT", "invalid journal event"));
  }
};
