/** Strict selection and exact validation of one resumable root-frame checkpoint. */

import { createHash } from "node:crypto";
import type { BudgetUsage } from "../core/budget.ts";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, isJsonObject, parseJsonValue, type JsonValue } from "../core/json.ts";
import type { CallUsage } from "../core/usage.ts";
import type { ContextDescriptor, ContextOperationControl, ContextStore } from "../shell/context-store.ts";
import { sha256, sha256Bytes } from "../shell/hash.ts";
import type { JournalStore, JournalTailInspection } from "../shell/journal-store.ts";
import { checkpointControlFailure } from "./checkpoint-failure.ts";
import { parseRunCheckpointPayload, RunCheckpointValidationError } from "./checkpoint-schema.ts";
import {
  RUN_CHECKPOINT_SCHEMA_VERSION,
  RUN_CHECKPOINT_VERSION,
  type CheckpointFrameV1,
  runCheckpointPayloadByteLimit,
  type RunCheckpointPayloadV1,
} from "./checkpoint-types.ts";
import { RunCheckpointStore } from "./checkpoint-store.ts";
import { validateRecoveryJournal } from "./run-recovery-journal.ts";
import { RunRecoveryError } from "./run-recovery-types.ts";
import type { RunManifestDocument } from "./run-manifest.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const same = (left: unknown, right: unknown): boolean =>
  canonicalStringify(left as JsonValue) === canonicalStringify(right as JsonValue);
const invalid = (message: string, cause?: unknown): never => {
  throw new RunRecoveryError("RECOVERY_CHECKPOINT_INVALID", message, cause);
};
const unsupported = (message: string): never => {
  throw new RunRecoveryError("RECOVERY_UNSUPPORTED_STATE", message);
};
const preserveControlFailure = (cause: unknown): void => {
  const control = checkpointControlFailure(cause);
  if (control !== undefined) throw control;
};

const parseCanonicalPayload = (bytes: Uint8Array, document: RunManifestDocument): RunCheckpointPayloadV1 => {
  try {
    const text = decoder.decode(bytes);
    const raw = JSON.parse(text) as unknown;
    const json = parseJsonValue(raw);
    if (!json.ok || canonicalStringify(json.value) !== text) throw new TypeError("checkpoint payload is not canonical strict JSON");
    return parseRunCheckpointPayload(json.value, document);
  } catch (cause) {
    if (cause instanceof RunCheckpointValidationError) return invalid(cause.message, cause);
    return invalid("checkpoint payload is invalid", cause);
  }
};

const frameLineage = (runId: string, frameId: string): string => {
  if (frameId === `${runId}:f0`) return frameId;
  const prefix = `${runId}:frame:`;
  const match = frameId.startsWith(prefix)
    ? /^(call_recurse_[a-f0-9]{64}):e([1-9][0-9]*)$/.exec(frameId.slice(prefix.length))
    : null;
  if (!match?.[1]) return invalid("checkpoint journal has an invalid recurse frame identity");
  return match[1];
};

const frameSnapshots = (runId: string, events: readonly RlmEvent[]): CheckpointFrameV1[] => {
  const opened = new Map<string, Extract<RlmEvent, { type: "frame_opened" }>>();
  const closed = new Map<string, Extract<RlmEvent, { type: "frame_closed" }>["state"]>();
  const answered = new Set<string>();
  const cells = new Map<string, Set<number>>();
  for (const event of events) {
    if (event.type === "frame_opened" && !opened.has(event.frameId)) opened.set(event.frameId, event);
    else if (event.type === "frame_closed") closed.set(event.frameId, event.state);
    else if (event.type === "answer_committed") answered.add(event.frameId);
    else if (event.type === "cell_committed") {
      const iterations = cells.get(event.frameId) ?? new Set<number>();
      iterations.add(event.iteration);
      cells.set(event.frameId, iterations);
    }
  }
  return [...opened.values()].map((event): CheckpointFrameV1 => ({
    frameId: event.frameId,
    lineage: frameLineage(runId, event.frameId),
    parentFrameId: event.parentFrameId,
    depth: event.depth,
    objective: event.objective,
    state: closed.get(event.frameId) ?? (answered.has(event.frameId) ? "answered" : "open"),
    nextIteration: (cells.get(event.frameId)?.size ?? 0) + 1,
  })).sort((left, right) => compare(left.frameId, right.frameId));
};

const exactMapEntries = (entries: ReadonlyMap<string, number>) => [...entries]
  .map(([key, value]) => ({ key, value }))
  .sort((left, right) => compare(left.key, right.key));

interface DerivedJournalState {
  readonly frames: readonly CheckpointFrameV1[];
  readonly ledgerUsage: BudgetUsage;
  readonly keyBindings: readonly { readonly registryId: string; readonly identityHash: string }[];
  readonly operationAttempts: readonly { readonly key: string; readonly value: number }[];
  readonly agentAttempts: readonly { readonly key: string; readonly value: number }[];
  readonly recurseExecutions: readonly { readonly key: string; readonly value: number }[];
  readonly callEvents: ReadonlyMap<string, Extract<RlmEvent, { type: "call_committed" }>>;
  readonly rootCells: readonly Extract<RlmEvent, { type: "cell_committed" }>[];
  readonly latestRootWorkspace?: Extract<RlmEvent, { type: "workspace_committed" }>;
}

const addUsage = (usage: BudgetUsage, settled: CallUsage): BudgetUsage => {
  const input = settled.inputTokens ?? 0;
  const output = settled.outputTokens ?? 0;
  const total = settled.totalTokens ?? input + output;
  return {
    ...usage,
    tokensUsed: usage.tokensUsed + total,
    inputTokensUsed: usage.inputTokensUsed + input,
    outputTokensUsed: usage.outputTokensUsed + output,
    costUsd: usage.costUsd + (settled.costUsd ?? 0),
    providerDurationMs: usage.providerDurationMs + settled.durationMs,
  };
};

const deriveJournalState = (
  document: RunManifestDocument,
  events: readonly RlmEvent[],
  storedBytes: number,
): DerivedJournalState => {
  const runId = document.manifest.run.id;
  const rootFrameId = `${runId}:f0`;
  const childFrames = new Set<string>();
  const cells = new Map<string, Extract<RlmEvent, { type: "cell_committed" }>>();
  const rootCells = new Map<number, Extract<RlmEvent, { type: "cell_committed" }>>();
  const keys = new Map<string, string>();
  const operationAttempts = new Map<string, number>();
  const agentAttempts = new Map<string, number>();
  const recurseExecutions = new Map<string, number>();
  const callEvents = new Map<string, Extract<RlmEvent, { type: "call_committed" }>>();
  const intents = new Map<string, Extract<RlmEvent, { type: "operation_intended" }>>();
  let latestRootWorkspace: Extract<RlmEvent, { type: "workspace_committed" }> | undefined;
  let usage: BudgetUsage = {
    framesOpened: 0,
    logicalCalls: 0,
    attempts: 0,
    controllerTurns: 0,
    activeLeafCalls: 0,
    tokensReserved: 0,
    tokensUsed: 0,
    inputTokensUsed: 0,
    outputTokensUsed: 0,
    costUsd: 0,
    providerDurationMs: 0,
    storedBytes,
  };

  for (const event of events) {
    switch (event.type) {
      case "frame_opened": {
        if (event.parentFrameId !== null && !childFrames.has(event.frameId)) {
          childFrames.add(event.frameId);
          usage = { ...usage, framesOpened: usage.framesOpened + 1, logicalCalls: usage.logicalCalls + 1 };
          const prefix = `${runId}:frame:`;
          const match = event.frameId.startsWith(prefix)
            ? /^(call_recurse_[a-f0-9]{64}):e([1-9][0-9]*)$/.exec(event.frameId.slice(prefix.length))
            : null;
          if (!match?.[1] || !match[2]) return invalid("checkpoint journal has an invalid recurse execution identity");
          const callId = match[1];
          const ordinal = Number(match[2]);
          if (!Number.isSafeInteger(ordinal)) return invalid("checkpoint journal recurse execution ordinal is invalid");
          recurseExecutions.set(callId, Math.max(recurseExecutions.get(callId) ?? 0, ordinal));
        }
        break;
      }
      case "cell_committed": {
        const id = `${event.frameId}\0${event.iteration}`;
        if (!cells.has(id)) {
          cells.set(id, event);
          usage = { ...usage, controllerTurns: usage.controllerTurns + 1 };
          if (event.frameId === rootFrameId) rootCells.set(event.iteration, event);
        }
        break;
      }
      case "workspace_committed":
        if (event.frameId === rootFrameId
          && (!latestRootWorkspace || event.iteration > latestRootWorkspace.iteration)) latestRootWorkspace = event;
        break;
      case "key_bound": {
        const lineage = frameLineage(runId, event.frameId);
        const registryId = event.kind === "recurse"
          ? `${event.kind}\0${lineage}\0${event.key}`
          : `${event.kind}\0${event.key}`;
        const prior = keys.get(registryId);
        if (prior !== undefined && prior !== event.identityHash)
          invalid("checkpoint journal contains conflicting global key bindings");
        keys.set(registryId, event.identityHash);
        break;
      }
      case "operation_intended": {
        usage = {
          ...usage,
          logicalCalls: usage.logicalCalls + event.reservation.logicalCalls,
          attempts: usage.attempts + event.reservation.attempts,
          tokensReserved: usage.tokensReserved + event.reservation.tokens,
        };
        const attemptKey = `${event.frameId}\0${event.operationId}`;
        operationAttempts.set(attemptKey, event.attempt);
        intents.set(event.intentId, event);
        if (event.kind === "agent") agentAttempts.set(event.operationId, (agentAttempts.get(event.operationId) ?? 0) + 1);
        break;
      }
      case "operation_settled": {
        const intended = intents.get(event.intentId);
        if (!intended) return invalid("checkpoint settlement has no intent");
        usage = addUsage({ ...usage, tokensReserved: usage.tokensReserved - intended.reservation.tokens }, event.usage);
        break;
      }
      case "call_committed":
        callEvents.set(event.callId, event);
        break;
      default:
        break;
    }
  }

  const keyBindings = [...keys].map(([registryId, identityHash]) => ({ registryId, identityHash }))
    .sort((left, right) => compare(left.registryId, right.registryId));
  return {
    frames: frameSnapshots(runId, events),
    ledgerUsage: usage,
    keyBindings,
    operationAttempts: exactMapEntries(operationAttempts),
    agentAttempts: exactMapEntries(agentAttempts),
    recurseExecutions: exactMapEntries(recurseExecutions),
    callEvents,
    rootCells: [...rootCells.values()].sort((left, right) => left.iteration - right.iteration),
    ...(latestRootWorkspace ? { latestRootWorkspace } : {}),
  };
};

const contentJson = async (
  store: ContextStore,
  reference: { readonly id: string; readonly sha256: string; readonly bytes: number },
  label: string,
  control: ContextOperationControl,
): Promise<JsonValue> => {
  try {
    const bytes = await store.loadFromDisk(reference, control);
    const text = decoder.decode(bytes);
    const parsed = parseJsonValue(JSON.parse(text) as unknown);
    if (!parsed.ok || canonicalStringify(parsed.value) !== text) throw new TypeError(`${label} is not canonical strict JSON`);
    return parsed.value;
  } catch (cause) {
    preserveControlFailure(cause);
    return invalid(`${label} content is missing or invalid`, cause);
  }
};

const validateTrajectory = (
  payload: RunCheckpointPayloadV1,
  state: DerivedJournalState,
): void => {
  if (payload.root.trajectory.length !== state.rootCells.length) invalid("checkpoint trajectory length does not match the root journal");
  for (let index = 0; index < state.rootCells.length; index++) {
    const cell = state.rootCells[index]!;
    const entry = payload.root.trajectory[index]!;
    const entryError = entry.error ? { code: entry.error.code, message: entry.error.message } : undefined;
    if (entry.iteration !== cell.iteration || entry.reasoning !== cell.reasoning || sha256(entry.code) !== cell.codeHash
      || entry.hasResult !== cell.hasResult || entry.outputPreview !== cell.outputPreview
      || entry.outputBytes !== cell.outputBytes || entry.outputOmittedBytes !== cell.outputOmittedBytes
      || entry.outputRef !== cell.outputRef || !same(entry.usage ?? null, cell.usage ?? null)
      || !same(entryError ?? null, cell.error ?? null)) invalid("checkpoint trajectory does not match committed root cells");
  }
  const last = payload.root.trajectory.at(-1);
  const expected = !last
    ? undefined
    : last.error
      ? last.error.code === "PARSE_ERROR"
        ? { kind: "parse_error", message: last.error.message }
        : { kind: "error", message: last.error.message }
      : { kind: "value", preview: last.outputPreview };
  if (!same(payload.root.lastOutcome ?? null, expected ?? null)) invalid("checkpoint last outcome does not match its trajectory");
};

const validateCallCache = async (
  payload: RunCheckpointPayloadV1,
  state: DerivedJournalState,
  store: ContextStore,
  descriptors: ReadonlyMap<string, ContextDescriptor>,
  control: ContextOperationControl,
): Promise<void> => {
  const expected = [...state.callEvents.values()].filter((event) => event.ok)
    .sort((left, right) => compare(left.callId, right.callId));
  if (payload.callCache.length !== expected.length) invalid("checkpoint call cache is not exact");
  for (let index = 0; index < expected.length; index++) {
    const event = expected[index]!;
    const entry = payload.callCache[index]!;
    if (entry.callId !== event.callId || !event.outputRef || !event.outputSha256 || event.outputBytes === undefined
      || entry.descriptor.id !== event.outputRef || entry.descriptor.sha256 !== event.outputSha256
      || entry.descriptor.bytes !== event.outputBytes || !same(entry.descriptor, descriptors.get(entry.descriptor.id)))
      invalid("checkpoint call cache identity does not match its journal event");
    const stored = await contentJson(store, entry.descriptor, `call ${entry.callId}`, control);
    if (!isJsonObject(stored)) return invalid("checkpoint call cache content is not an object");
    const expectedResult = { ...stored, outputRef: entry.descriptor.id } as JsonValue;
    if (!same(entry.result, expectedResult)) invalid("checkpoint call cache result does not match retained content");
  }
};

const validateRuntimeContent = async (
  payload: RunCheckpointPayloadV1,
  document: RunManifestDocument,
  events: readonly RlmEvent[],
  store: ContextStore,
  control: ContextOperationControl,
): Promise<number> => {
  const descriptors = new Map(payload.contexts.map((descriptor) => [descriptor.id, descriptor] as const));
  let storedBytes = 0;
  for (const descriptor of payload.contexts) storedBytes += descriptor.bytes;
  for (const artifact of payload.artifacts) storedBytes += artifact.descriptor.bytes;
  if (!Number.isSafeInteger(storedBytes) || storedBytes > document.manifest.limits.storedByteLimit)
    invalid("checkpoint retained-byte catalog exceeds the run limit");
  const model = validateRecoveryJournal(document, events);
  try { await store.hydrateFromDisk(payload.contexts, control); }
  catch (cause) {
    preserveControlFailure(cause);
    invalid("checkpoint context catalog could not be hydrated", cause);
  }

  for (const reference of model.content) {
    if (reference.role === "checkpoint") continue;
    const descriptor = descriptors.get(reference.id);
    if (!descriptor || descriptor.sha256 !== reference.sha256 || descriptor.bytes !== reference.bytes)
      invalid("checkpoint context catalog omits journal-authoritative content");
  }
  for (const input of document.manifest.inputs) {
    const expected = {
      id: `ctx_${input.sha256}`,
      label: input.name,
      bytes: input.bytes,
      estimatedTokens: Math.ceil(input.bytes / 4),
      tokenEstimator: "utf8-bytes/4",
      mimeType: "text/plain",
      sha256: input.sha256,
    };
    if (!same(payload.root.frame.inputs[input.name], expected)
      || !same(descriptors.get(expected.id), expected)) invalid("checkpoint root input descriptors do not match the manifest");
  }
  return storedBytes;
};

const validateExactState = async (
  payload: RunCheckpointPayloadV1,
  document: RunManifestDocument,
  events: readonly RlmEvent[],
  store: ContextStore,
  control: ContextOperationControl,
): Promise<void> => {
  if (payload.scopeUsage.length !== 0) unsupported("checkpoint retains active recurse usage scopes");
  if (payload.ledger.usage.activeLeafCalls !== 0 || payload.ledger.usage.tokensReserved !== 0)
    unsupported("checkpoint retains active leaves or outstanding token reservations");
  const openFrames = payload.frames.filter((frame) => frame.state === "open");
  if (openFrames.length !== 1 || openFrames[0]?.frameId !== payload.run.rootFrameId)
    unsupported("checkpoint retains nested or ambiguous active frames");

  const storedBytes = await validateRuntimeContent(payload, document, events, store, control);
  const state = deriveJournalState(document, events, storedBytes);
  if (!same(payload.frames, state.frames)) invalid("checkpoint frame catalog does not match the journal");
  if (!same(payload.keyBindings, state.keyBindings)) invalid("checkpoint key bindings do not match the journal");
  if (!same(payload.ordinals.operationAttempts, state.operationAttempts)
    || !same(payload.ordinals.agentAttempts, state.agentAttempts)
    || !same(payload.ordinals.recurseExecutions, state.recurseExecutions)
    || payload.ordinals.frameSequence !== state.frames.length)
    invalid("checkpoint runtime ordinals do not match the journal");
  if (!same(payload.ledger.usage, state.ledgerUsage)) invalid("checkpoint ledger does not match authoritative journal and retained state");
  if (payload.run.nextControllerTurn !== payload.ledger.usage.controllerTurns + 1)
    invalid("checkpoint next controller turn does not match the ledger");
  validateTrajectory(payload, state);

  const descriptors = new Map(payload.contexts.map((descriptor) => [descriptor.id, descriptor] as const));
  await validateCallCache(payload, state, store, descriptors, control);
  const expectedWorkspace = state.latestRootWorkspace
    ? await contentJson(store, {
        id: state.latestRootWorkspace.workspaceRef,
        sha256: state.latestRootWorkspace.workspaceSha256,
        bytes: state.latestRootWorkspace.workspaceBytes,
      }, "root workspace", control)
    : {};
  if (!same(payload.root.workspace, expectedWorkspace)) invalid("checkpoint workspace does not match the latest committed root workspace");
}

export interface RecoveredRunCheckpoint {
  readonly payload: RunCheckpointPayloadV1;
  readonly event: Extract<RlmEvent, { type: "checkpoint_committed" }>;
  readonly events: readonly RlmEvent[];
  readonly repairedTailBytes: number;
  readonly incompleteTailBytes: number;
}

export interface RunCheckpointRecoveryOptions {
  readonly repair?: boolean;
  readonly checkpoint?: () => void;
  readonly validateControllerState?: (
    state: JsonValue,
    boundary: { readonly frameId: string; readonly nextIteration: number; readonly trajectoryLength: number },
  ) => void;
}

export interface RunCheckpointAuthorityInspection {
  readonly runId: string;
  readonly manifestHash: string;
  readonly checkpointSequence: number;
  readonly checkpointSha256: string;
  readonly checkpointPrefixSha256: string;
  readonly journalPrefixSha256: string;
  readonly nextIteration: number;
  readonly nextControllerTurn: number;
  readonly incompleteTailBytes: number;
}

const checkpointEventIdentity = (event: Extract<RlmEvent, { type: "checkpoint_committed" }>) => ({
  schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
  checkpointVersion: RUN_CHECKPOINT_VERSION,
  runId: event.runId,
  frameId: event.frameId,
  manifestHash: event.manifestHash,
  checkpointSequence: event.checkpointSequence,
  checkpointRef: event.checkpointRef,
  checkpointSha256: event.checkpointSha256,
  checkpointBytes: event.checkpointBytes,
  journalPrefixSha256: event.journalPrefixSha256,
  journalPrefixBytes: event.journalPrefixBytes,
  journalPrefixEventCount: event.journalPrefixEventCount,
  nextIteration: event.nextIteration,
  nextControllerTurn: event.nextControllerTurn,
} as const);

const validateEveryCheckpointEvent = (
  document: RunManifestDocument,
  snapshot: JournalTailInspection,
  checkpoint: () => void,
): void => {
  const byteLimit = runCheckpointPayloadByteLimit(document.manifest.limits.storedByteLimit);
  const prefixes = snapshot.events.flatMap((event, index) =>
    event.type === "checkpoint_committed" ? [snapshot.eventPositions[index]?.prefixBytes] : [])
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  const digests = new Map<number, string>();
  const hash = createHash("sha256");
  let offset = 0;
  for (const end of prefixes) {
    while (offset < end) {
      checkpoint();
      const next = Math.min(end, offset + 64 * 1024);
      hash.update(snapshot.verifiedPrefix.subarray(offset, next));
      offset = next;
    }
    checkpoint();
    digests.set(end, hash.copy().digest("hex"));
  }
  for (let index = 0; index < snapshot.events.length; index++) {
    checkpoint();
    const event = snapshot.events[index]!;
    if (event.type !== "checkpoint_committed") continue;
    const position = snapshot.eventPositions[index];
    if (!position || position.eventIndex !== index
      || event.journalPrefixBytes !== position.prefixBytes || event.journalPrefixEventCount !== index
      || event.journalPrefixSha256 !== digests.get(position.prefixBytes))
      invalid("checkpoint event does not bind its exact journal prefix");
    if (event.checkpointBytes < 1 || event.checkpointBytes > byteLimit)
      invalid("checkpoint payload exceeds its profile-scaled byte limit");
    if (event.checkpointId !== `cp_${sha256(canonicalStringify(checkpointEventIdentity(event) as unknown as JsonValue))}`)
      invalid("checkpoint event identity hash is invalid");
    const anchor = snapshot.events[index - 1];
    if (!anchor || anchor.type !== "cell_committed" || anchor.frameId !== event.frameId
      || anchor.iteration + 1 !== event.nextIteration)
      invalid("checkpoint is not immediately anchored to its committed root cell");
  }
};

interface SelectedCheckpointAuthority {
  readonly snapshot: JournalTailInspection;
  readonly event: Extract<RlmEvent, { type: "checkpoint_committed" }>;
}

const selectCheckpointAuthority = async (
  document: RunManifestDocument,
  journal: JournalStore,
  checkpoint: () => void,
): Promise<SelectedCheckpointAuthority> => {
  checkpoint();
  let snapshot: JournalTailInspection;
  try { snapshot = await journal.inspectTail({ checkpoint }); }
  catch (cause) {
    preserveControlFailure(cause);
    throw new RunRecoveryError("RECOVERY_JOURNAL_CORRUPT", "run journal is corrupt", cause);
  }
  checkpoint();
  const model = validateRecoveryJournal(document, snapshot.events);
  if (model.terminal) throw new RunRecoveryError("RECOVERY_TERMINAL", "terminal runs are immutable and cannot be resumed");
  const selectedIndex = snapshot.events.findLastIndex((event) => event.type === "checkpoint_committed");
  if (selectedIndex < 0) throw new RunRecoveryError("RECOVERY_CHECKPOINT_MISSING", "run has no authoritative checkpoint");
  if (selectedIndex !== snapshot.events.length - 1)
    throw new RunRecoveryError("RECOVERY_UNSAFE_TAIL", "journal has authoritative events after its latest checkpoint");
  validateEveryCheckpointEvent(document, snapshot, checkpoint);
  const event = snapshot.events[selectedIndex] as Extract<RlmEvent, { type: "checkpoint_committed" }>;
  const position = snapshot.eventPositions[selectedIndex];
  if (!position || position.endBytes !== snapshot.verifiedBytes)
    invalid("latest checkpoint is not the complete verified journal tail");
  return { snapshot, event };
};

/** Metadata-only journal/checkpoint authority inspection. It never reads checkpoint payload content or repairs. */
export const inspectLatestRunCheckpointAuthority = async (
  document: RunManifestDocument,
  journal: JournalStore,
  options: Pick<RunCheckpointRecoveryOptions, "checkpoint"> = {},
): Promise<RunCheckpointAuthorityInspection> => {
  const selected = await selectCheckpointAuthority(document, journal, options.checkpoint ?? (() => {}));
  const { event, snapshot } = selected;
  return {
    runId: event.runId,
    manifestHash: event.manifestHash,
    checkpointSequence: event.checkpointSequence,
    checkpointSha256: event.checkpointSha256,
    checkpointPrefixSha256: event.journalPrefixSha256,
    journalPrefixSha256: snapshot.prefixSha256,
    nextIteration: event.nextIteration,
    nextControllerTurn: event.nextControllerTurn,
    incompleteTailBytes: snapshot.incompleteTailBytes,
  };
};

/** Validate one exact journal-tail checkpoint, optionally repairing only a proven torn final record. */
export const recoverLatestRunCheckpoint = async (
  document: RunManifestDocument,
  journal: JournalStore,
  runtimeStore: ContextStore,
  checkpointStore: RunCheckpointStore,
  options: RunCheckpointRecoveryOptions = {},
): Promise<RecoveredRunCheckpoint> => {
  const checkpoint = options.checkpoint ?? (() => {});
  const { snapshot, event } = await selectCheckpointAuthority(document, journal, checkpoint);

  let checkpointBytes: Uint8Array;
  try {
    checkpointBytes = await checkpointStore.read({
      checkpointSequence: event.checkpointSequence,
      id: event.checkpointRef,
      sha256: event.checkpointSha256,
      bytes: event.checkpointBytes,
    }, checkpoint);
  } catch (cause) {
    preserveControlFailure(cause);
    return invalid("checkpoint payload is missing or failed integrity validation", cause);
  }
  const payload = parseCanonicalPayload(checkpointBytes, document);
  if (payload.identity.checkpointSequence !== event.checkpointSequence
    || payload.run.rootFrameId !== event.frameId || payload.root.frame.frameId !== event.frameId
    || payload.root.nextIteration !== event.nextIteration || payload.run.nextControllerTurn !== event.nextControllerTurn
    || !same(payload.journalPrefix, {
      sha256: event.journalPrefixSha256,
      bytes: event.journalPrefixBytes,
      eventCount: event.journalPrefixEventCount,
    })) invalid("checkpoint payload identity does not match its commit event");
  await validateExactState(payload, document, snapshot.events, runtimeStore, { checkpoint });
  checkpoint();
  if (options.validateControllerState) {
    try {
      options.validateControllerState(payload.controller.state, {
        frameId: payload.root.frame.frameId,
        nextIteration: payload.root.nextIteration,
        trajectoryLength: payload.root.trajectory.length,
      });
    } catch (cause) {
      preserveControlFailure(cause);
      throw new RunRecoveryError("RECOVERY_CONTROLLER_STATE_INVALID", "controller checkpoint state is invalid", cause);
    }
  }
  checkpoint();
  if (options.repair === false) return {
    payload,
    event,
    events: snapshot.events,
    repairedTailBytes: 0,
    incompleteTailBytes: snapshot.incompleteTailBytes,
  };

  let repaired;
  try { repaired = await journal.repairIncompleteTail({ checkpoint }); }
  catch (cause) {
    preserveControlFailure(cause);
    throw new RunRecoveryError("RECOVERY_UNSTABLE", "validated journal tail could not be repaired", cause);
  }
  if (repaired.verifiedBytes !== snapshot.verifiedBytes || repaired.prefixSha256 !== snapshot.prefixSha256
    || repaired.events.length !== snapshot.events.length || repaired.removedBytes !== snapshot.incompleteTailBytes)
    throw new RunRecoveryError("RECOVERY_UNSTABLE", "run journal changed during checkpoint recovery");
  return {
    payload,
    event,
    events: repaired.events,
    repairedTailBytes: repaired.removedBytes,
    incompleteTailBytes: snapshot.incompleteTailBytes,
  };
};
