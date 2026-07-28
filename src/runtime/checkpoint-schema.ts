/** Strict bounded parser for canonical version-1 run checkpoints. */

import { CALL_ERROR_CODES, INTERPRETER_ERROR_CODES, isRetryable } from "../core/errors.ts";
import { canonicalStringify, isJsonObject, type JsonObject, type JsonValue } from "../core/json.ts";
import { sha256 as sha256Text } from "../shell/hash.ts";
import { normalizeProgram } from "../core/program.ts";
import { normalizeCallUsage, type CallUsage } from "../core/usage.ts";
import { validateWorkspace } from "../core/workspace.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";
import type { RunManifestDocument } from "./run-manifest.ts";
import {
  MAX_RUN_CHECKPOINT_ITEMS,
  MAX_RUN_CHECKPOINT_STRING_BYTES,
  RUN_CHECKPOINT_SCHEMA_VERSION,
  RUN_CHECKPOINT_VERSION,
  type CheckpointArtifactV1,
  type CheckpointCallCacheEntryV1,
  type CheckpointFrameV1,
  type CheckpointKeyBindingV1,
  type CheckpointOrdinalEntryV1,
  type CheckpointUsageEntryV1,
  type RunCheckpointPayloadV1,
} from "./checkpoint-types.ts";
import type { ArtifactDescriptor } from "./state.ts";

const HASH = /^[a-f0-9]{64}$/;
const CONTEXT = /^ctx_[a-f0-9]{64}$/;
const RUN = /^run_[a-f0-9]{64}$/;
const CALL = /^call_(?:llm|agent|recurse|tool|artifact|context)_[a-f0-9]{64}$/;
const CALL_CODES = new Set<string>(CALL_ERROR_CODES);
const INTERPRETER_CODES = new Set<string>(INTERPRETER_ERROR_CODES);
const TOKEN_ESTIMATOR = "utf8-bytes/4";

export class RunCheckpointValidationError extends TypeError {
  override readonly name = "RunCheckpointValidationError";
}

const invalid = (path: string, message = "is invalid"): never => {
  throw new RunCheckpointValidationError(`${path} ${message}`);
};
const object = (
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (!isJsonObject(value)) return invalid(path, "must be an object");
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || required.some((key) => !keys.includes(key))
    || keys.some((key) => !allowed.has(key))) invalid(path, "has invalid fields");
  return value as Record<string, unknown>;
};
const list = (value: unknown, path: string, maximum = MAX_RUN_CHECKPOINT_ITEMS): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) return invalid(path, "must be a bounded array");
  return value as unknown[];
};
const text = (value: unknown, path: string, allowEmpty = true, maximum = MAX_RUN_CHECKPOINT_STRING_BYTES): string => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum) return invalid(path, "must be a bounded string");
  return value as string;
};
const integer = (value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return invalid(path, "must be a bounded safe integer");
  return value as number;
};
const digest = (value: unknown, path: string): string => {
  const result = text(value, path, false, 64);
  if (!HASH.test(result)) invalid(path, "must be a lowercase SHA-256 digest");
  return result;
};
const sortedUnique = <T>(items: readonly T[], key: (item: T) => string, path: string): void => {
  let prior: string | undefined;
  for (const item of items) {
    const current = key(item);
    if (prior !== undefined && current <= prior) invalid(path, "must be strictly sorted and unique");
    prior = current;
  }
};
const same = (left: unknown, right: unknown): boolean =>
  canonicalStringify(left as JsonValue) === canonicalStringify(right as JsonValue);

const usage = (value: unknown, path: string, document: RunManifestDocument): CallUsage => {
  const item = object(value, path, ["attempts", "durationMs"], ["inputTokens", "outputTokens", "totalTokens", "costUsd"]);
  const normalized = normalizeCallUsage(item, {
    maxAttempts: document.manifest.limits.maxAttempts,
    maxTokens: Number.MAX_SAFE_INTEGER,
    maxCostUsd: 10_000_000_000,
    maxDurationMs: Number.MAX_SAFE_INTEGER,
  });
  const result = normalized.ok ? normalized.value : invalid(path);
  const parts = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  if (result.totalTokens !== undefined && parts > result.totalTokens) invalid(path);
  return result;
};

const descriptor = (value: unknown, path: string): ContextDescriptor => {
  const item = object(value, path, ["id", "label", "bytes", "estimatedTokens", "tokenEstimator", "mimeType", "sha256"]);
  const id = text(item["id"], `${path}.id`, false, 68);
  const sha256 = digest(item["sha256"], `${path}.sha256`);
  const bytes = integer(item["bytes"], `${path}.bytes`);
  const result = {
    id,
    label: text(item["label"], `${path}.label`),
    bytes,
    estimatedTokens: integer(item["estimatedTokens"], `${path}.estimatedTokens`),
    tokenEstimator: text(item["tokenEstimator"], `${path}.tokenEstimator`, false, 64),
    mimeType: text(item["mimeType"], `${path}.mimeType`, false, 1024),
    sha256,
  };
  if (!CONTEXT.test(id) || id !== `ctx_${sha256}` || result.estimatedTokens !== Math.ceil(bytes / 4)
    || result.tokenEstimator !== TOKEN_ESTIMATOR) invalid(path);
  return result;
};

const errorDetails = (value: unknown, path: string, document: RunManifestDocument): JsonObject => {
  const item = object(value, path, [], ["stopReason", "provider", "model", "usage"]);
  if (Object.keys(item).length === 0) invalid(path);
  for (const key of ["stopReason", "provider", "model"])
    if (item[key] !== undefined) text(item[key], `${path}.${key}`, true, 256);
  if (item["usage"] !== undefined) usage(item["usage"], `${path}.usage`, document);
  return item as JsonObject;
};
const callError = (value: unknown, path: string, document: RunManifestDocument): JsonObject => {
  const item = object(value, path, ["code", "message", "retryable"], ["details"]);
  const code = text(item["code"], `${path}.code`, false, 64);
  if (!CALL_CODES.has(code) || typeof item["retryable"] !== "boolean"
    || item["retryable"] !== isRetryable(code as Parameters<typeof isRetryable>[0])) invalid(path);
  text(item["message"], `${path}.message`, true, 2048);
  if (item["details"] !== undefined) errorDetails(item["details"], `${path}.details`, document);
  return item as JsonObject;
};
const trajectoryError = (value: unknown, path: string, document: RunManifestDocument): JsonObject => {
  const item = object(value, path, ["code", "message"], ["retryable", "details"]);
  const code = text(item["code"], `${path}.code`, false, 64);
  if (item["retryable"] === undefined) {
    if (!INTERPRETER_CODES.has(code) || item["details"] !== undefined) invalid(path);
  } else {
    callError(item, path, document);
  }
  text(item["message"], `${path}.message`, true, 2048);
  return item as JsonObject;
};

const callResult = (value: unknown, path: string, document: RunManifestDocument) => {
  const base = object(value, path, ["ok", "callId", "usage", "cached", "outputRef"], ["value", "error"]);
  if (typeof base["ok"] !== "boolean" || typeof base["cached"] !== "boolean") invalid(path);
  const callId = text(base["callId"], `${path}.callId`, false, 256);
  const outputRef = text(base["outputRef"], `${path}.outputRef`, false, 68);
  if (!CALL.test(callId) || !CONTEXT.test(outputRef) || base["cached"] !== false) invalid(path);
  if (base["ok"]) {
    if (!("value" in base) || base["error"] !== undefined) invalid(path);
  } else {
    if (base["value"] !== undefined || base["error"] === undefined) invalid(path);
    callError(base["error"], `${path}.error`, document);
  }
  return { ...base, callId, outputRef, usage: usage(base["usage"], `${path}.usage`, document) };
};

const artifact = (value: unknown, path: string): CheckpointArtifactV1 => {
  const item = object(value, path, ["descriptor", "text"]);
  const raw = object(item["descriptor"], `${path}.descriptor`, ["id", "name", "bytes", "sha256", "mimeType"]);
  const sha256 = digest(raw["sha256"], `${path}.descriptor.sha256`);
  const descriptorValue: ArtifactDescriptor = {
    id: text(raw["id"], `${path}.descriptor.id`, false, 68),
    name: text(raw["name"], `${path}.descriptor.name`, false),
    bytes: integer(raw["bytes"], `${path}.descriptor.bytes`),
    sha256,
    mimeType: text(raw["mimeType"], `${path}.descriptor.mimeType`, false, 1024),
  };
  const artifactText = text(item["text"], `${path}.text`, true, Number.MAX_SAFE_INTEGER);
  if (descriptorValue.id !== `art_${sha256}` || sha256 !== sha256Text(artifactText)
    || Buffer.byteLength(artifactText, "utf8") !== descriptorValue.bytes)
    invalid(path);
  return { descriptor: descriptorValue, text: artifactText };
};

const ordinalEntries = (value: unknown, path: string, maximum: number): CheckpointOrdinalEntryV1[] => {
  const result = list(value, path, maximum).map((raw, index) => {
    const item = object(raw, `${path}[${index}]`, ["key", "value"]);
    return {
      key: text(item["key"], `${path}[${index}].key`, false, 4096),
      value: integer(item["value"], `${path}[${index}].value`, 1),
    };
  });
  sortedUnique(result, (item) => item.key, path);
  return result;
};

export const parseRunCheckpointPayload = (
  input: JsonValue,
  document: RunManifestDocument,
): RunCheckpointPayloadV1 => {
  const root = object(input, "checkpoint", [
    "schemaVersion", "checkpointVersion", "identity", "run", "journalPrefix", "controller", "frames", "root", "contexts",
    "callCache", "keyBindings", "artifacts", "ledger", "scopeUsage", "ordinals",
  ]);
  if (root["schemaVersion"] !== RUN_CHECKPOINT_SCHEMA_VERSION || root["checkpointVersion"] !== RUN_CHECKPOINT_VERSION)
    invalid("checkpoint", "has an unsupported version");
  const identity = object(root["identity"], "checkpoint.identity", [
    "runId", "manifestHash", "manifestSchemaVersion", "checkpointSequence",
  ]);
  const runId = text(identity["runId"], "checkpoint.identity.runId", false, 128);
  const manifestHash = digest(identity["manifestHash"], "checkpoint.identity.manifestHash");
  const checkpointSequence = integer(identity["checkpointSequence"], "checkpoint.identity.checkpointSequence", 1);
  if (!RUN.test(runId) || runId !== document.manifest.run.id || manifestHash !== document.manifestHash
    || identity["manifestSchemaVersion"] !== document.manifest.schemaVersion) invalid("checkpoint.identity");

  const run = object(root["run"], "checkpoint.run", ["startMs", "rootFrameId", "nextControllerTurn"]);
  const startMs = integer(run["startMs"], "checkpoint.run.startMs");
  const rootFrameId = text(run["rootFrameId"], "checkpoint.run.rootFrameId", false, 512);
  const nextControllerTurn = integer(run["nextControllerTurn"], "checkpoint.run.nextControllerTurn", 1,
    document.manifest.limits.maxControllerTurns + 1);
  const profile = document.manifest.profile as unknown as { wallMs: number };
  if (rootFrameId !== `${runId}:f0` || startMs !== document.manifest.limits.deadlineMs - profile.wallMs)
    invalid("checkpoint.run");

  const prefix = object(root["journalPrefix"], "checkpoint.journalPrefix", ["sha256", "bytes", "eventCount"]);
  const journalPrefix = {
    sha256: digest(prefix["sha256"], "checkpoint.journalPrefix.sha256"),
    bytes: integer(prefix["bytes"], "checkpoint.journalPrefix.bytes", 1),
    eventCount: integer(prefix["eventCount"], "checkpoint.journalPrefix.eventCount", 1),
  };
  const controller = object(root["controller"], "checkpoint.controller", ["capability", "state"]);
  const capability = object(controller["capability"], "checkpoint.controller.capability", ["version", "strategy"]);
  if (document.manifest.components.controllerResume === null
    || !same(capability, document.manifest.components.controllerResume)) invalid("checkpoint.controller.capability");

  const frames: CheckpointFrameV1[] = list(root["frames"], "checkpoint.frames", document.manifest.limits.maxFrames + 1)
    .map((raw, index) => {
      const item = object(raw, `checkpoint.frames[${index}]`, [
        "frameId", "lineage", "parentFrameId", "depth", "objective", "state", "nextIteration",
      ]);
      const rawState = item["state"];
      if (rawState !== "open" && rawState !== "answered" && rawState !== "closed" && rawState !== "failed" && rawState !== "cancelled")
        invalid(`checkpoint.frames[${index}].state`);
      const state = rawState as CheckpointFrameV1["state"];
      const parent = item["parentFrameId"];
      if (parent !== null && typeof parent !== "string") invalid(`checkpoint.frames[${index}].parentFrameId`);
      return {
        frameId: text(item["frameId"], `checkpoint.frames[${index}].frameId`, false, 512),
        lineage: text(item["lineage"], `checkpoint.frames[${index}].lineage`, false, 512),
        parentFrameId: parent as string | null,
        depth: integer(item["depth"], `checkpoint.frames[${index}].depth`, 0, document.manifest.limits.maxDepth),
        objective: text(item["objective"], `checkpoint.frames[${index}].objective`),
        state,
        nextIteration: integer(item["nextIteration"], `checkpoint.frames[${index}].nextIteration`, 1),
      };
    });
  sortedUnique(frames, (item) => item.frameId, "checkpoint.frames");

  const rootState = object(root["root"], "checkpoint.root", ["frame", "nextIteration", "workspace", "trajectory"], ["lastOutcome"]);
  const frame = object(rootState["frame"], "checkpoint.root.frame", ["frameId", "lineage", "depth", "objective", "inputs", "outputs"]);
  const normalizedProgram = normalizeProgram(document.manifest.program);
  const program = normalizedProgram.ok ? normalizedProgram.value : invalid("checkpoint.root.frame.outputs");
  const inputObject = object(frame["inputs"], "checkpoint.root.frame.inputs", program.inputs.map(({ name }) => name));
  const inputs: Record<string, ContextDescriptor> = Object.create(null) as Record<string, ContextDescriptor>;
  for (const declared of program.inputs)
    inputs[declared.name] = descriptor(inputObject[declared.name], `checkpoint.root.frame.inputs.${declared.name}`);
  const outputs = frame["outputs"] as JsonValue;
  if (!same(outputs, program.outputs)) invalid("checkpoint.root.frame.outputs");
  if (frame["frameId"] !== rootFrameId || frame["lineage"] !== rootFrameId || frame["depth"] !== 0
    || frame["objective"] !== program.objective) invalid("checkpoint.root.frame");
  const nextIteration = integer(rootState["nextIteration"], "checkpoint.root.nextIteration", 1,
    document.manifest.limits.maxControllerTurns + 1);
  if (!isJsonObject(rootState["workspace"]) || !validateWorkspace(rootState["workspace"] as Record<string, unknown>).ok)
    invalid("checkpoint.root.workspace");
  const trajectory = list(rootState["trajectory"], "checkpoint.root.trajectory", document.manifest.limits.maxControllerTurns)
    .map((raw, index) => {
      const path = `checkpoint.root.trajectory[${index}]`;
      const item = object(raw, path, ["iteration", "reasoning", "code", "hasResult", "outputPreview"], [
        "outputBytes", "outputOmittedBytes", "usage", "outputRef", "error", "answerCandidate",
      ]);
      if (item["iteration"] !== index + 1 || typeof item["hasResult"] !== "boolean") invalid(path);
      text(item["reasoning"], `${path}.reasoning`); text(item["code"], `${path}.code`); text(item["outputPreview"], `${path}.outputPreview`);
      if (item["outputBytes"] !== undefined) integer(item["outputBytes"], `${path}.outputBytes`);
      if (item["outputOmittedBytes"] !== undefined) integer(item["outputOmittedBytes"], `${path}.outputOmittedBytes`);
      if (item["usage"] !== undefined) usage(item["usage"], `${path}.usage`, document);
      if (item["outputRef"] !== undefined && !CONTEXT.test(text(item["outputRef"], `${path}.outputRef`, false, 68))) invalid(path);
      if (item["error"] !== undefined) trajectoryError(item["error"], `${path}.error`, document);
      if (item["answerCandidate"] !== undefined) {
        const candidate = object(item["answerCandidate"], `${path}.answerCandidate`, ["value", "validationErrors"]);
        list(candidate["validationErrors"], `${path}.answerCandidate.validationErrors`, 10_000)
          .forEach((message, i) => text(message, `${path}.answerCandidate.validationErrors[${i}]`, true, 2048));
      }
      return item;
    });
  if (trajectory.length + 1 !== nextIteration) invalid("checkpoint.root.nextIteration");
  let lastOutcome: RunCheckpointPayloadV1["root"]["lastOutcome"];
  if (rootState["lastOutcome"] !== undefined) {
    const item = object(rootState["lastOutcome"], "checkpoint.root.lastOutcome", ["kind"], ["preview", "message"]);
    lastOutcome = {
      kind: text(item["kind"], "checkpoint.root.lastOutcome.kind", false, 128),
      ...(item["preview"] !== undefined ? { preview: text(item["preview"], "checkpoint.root.lastOutcome.preview") } : {}),
      ...(item["message"] !== undefined ? { message: text(item["message"], "checkpoint.root.lastOutcome.message", true, 2048) } : {}),
    };
  }

  const contexts = list(root["contexts"], "checkpoint.contexts").map((item, index) => descriptor(item, `checkpoint.contexts[${index}]`));
  sortedUnique(contexts, (item) => item.id, "checkpoint.contexts");
  const callCache: CheckpointCallCacheEntryV1[] = list(root["callCache"], "checkpoint.callCache", document.manifest.limits.maxLogicalCalls)
    .map((raw, index) => {
      const path = `checkpoint.callCache[${index}]`;
      const item = object(raw, path, ["callId", "result", "descriptor"]);
      const result = callResult(item["result"], `${path}.result`, document);
      const callId = text(item["callId"], `${path}.callId`, false, 256);
      const cacheDescriptor = descriptor(item["descriptor"], `${path}.descriptor`);
      if (callId !== result.callId || cacheDescriptor.id !== result.outputRef) invalid(path);
      return { callId, result, descriptor: cacheDescriptor } as CheckpointCallCacheEntryV1;
    });
  sortedUnique(callCache, (item) => item.callId, "checkpoint.callCache");
  const keyBindings: CheckpointKeyBindingV1[] = list(root["keyBindings"], "checkpoint.keyBindings")
    .map((raw, index) => {
      const item = object(raw, `checkpoint.keyBindings[${index}]`, ["registryId", "identityHash"]);
      return {
        registryId: text(item["registryId"], `checkpoint.keyBindings[${index}].registryId`, false, 4096),
        identityHash: digest(item["identityHash"], `checkpoint.keyBindings[${index}].identityHash`),
      };
    });
  sortedUnique(keyBindings, (item) => item.registryId, "checkpoint.keyBindings");
  const artifacts = list(root["artifacts"], "checkpoint.artifacts").map((item, index) => artifact(item, `checkpoint.artifacts[${index}]`));
  sortedUnique(artifacts, (item) => item.descriptor.id, "checkpoint.artifacts");

  const ledger = object(root["ledger"], "checkpoint.ledger", ["limits", "usage"]);
  if (!same(ledger["limits"], document.manifest.limits)) invalid("checkpoint.ledger.limits");
  const ledgerUsage = object(ledger["usage"], "checkpoint.ledger.usage", [
    "framesOpened", "logicalCalls", "attempts", "controllerTurns", "activeLeafCalls", "tokensReserved", "tokensUsed",
    "inputTokensUsed", "outputTokensUsed", "costUsd", "providerDurationMs", "storedBytes",
  ]);
  for (const key of Object.keys(ledgerUsage)) {
    if (key === "costUsd") {
      if (typeof ledgerUsage[key] !== "number" || !Number.isFinite(ledgerUsage[key]) || (ledgerUsage[key] as number) < 0) invalid(`checkpoint.ledger.usage.${key}`);
    } else integer(ledgerUsage[key], `checkpoint.ledger.usage.${key}`);
  }
  const scopeUsage: CheckpointUsageEntryV1[] = list(root["scopeUsage"], "checkpoint.scopeUsage", document.manifest.limits.maxLogicalCalls)
    .map((raw, index) => {
      const item = object(raw, `checkpoint.scopeUsage[${index}]`, ["scope", "usage"]);
      return { scope: text(item["scope"], `checkpoint.scopeUsage[${index}].scope`, false, 512), usage: usage(item["usage"], `checkpoint.scopeUsage[${index}].usage`, document) };
    });
  sortedUnique(scopeUsage, (item) => item.scope, "checkpoint.scopeUsage");
  const ordinals = object(root["ordinals"], "checkpoint.ordinals", ["frameSequence", "operationAttempts", "agentAttempts", "recurseExecutions"]);

  return {
    schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
    checkpointVersion: RUN_CHECKPOINT_VERSION,
    identity: { runId, manifestHash, manifestSchemaVersion: document.manifest.schemaVersion, checkpointSequence },
    run: { startMs, rootFrameId, nextControllerTurn }, journalPrefix,
    controller: {
      capability: document.manifest.components.controllerResume!,
      state: controller["state"] as JsonValue,
    },
    frames,
    root: {
      frame: { frameId: rootFrameId, lineage: rootFrameId, depth: 0, objective: program.objective, inputs, outputs: program.outputs },
      nextIteration, workspace: rootState["workspace"] as JsonValue, trajectory: trajectory as never,
      ...(lastOutcome ? { lastOutcome } : {}),
    },
    contexts, callCache, keyBindings, artifacts,
    ledger: { limits: document.manifest.limits, usage: ledgerUsage as never }, scopeUsage,
    ordinals: {
      frameSequence: integer(ordinals["frameSequence"], "checkpoint.ordinals.frameSequence", 1),
      operationAttempts: ordinalEntries(ordinals["operationAttempts"], "checkpoint.ordinals.operationAttempts", document.manifest.limits.maxAttempts),
      agentAttempts: ordinalEntries(ordinals["agentAttempts"], "checkpoint.ordinals.agentAttempts", document.manifest.limits.maxAttempts),
      recurseExecutions: ordinalEntries(ordinals["recurseExecutions"], "checkpoint.ordinals.recurseExecutions", document.manifest.limits.maxFrames),
    },
  };
};
