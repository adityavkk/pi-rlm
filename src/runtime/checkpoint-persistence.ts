/** Guarded payload-first checkpoint publication at a globally quiescent root boundary. */

import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import type { ContextStore } from "../shell/context-store.ts";
import type { RunManifestDocument } from "./run-manifest.ts";
import { validateRecoveryJournal } from "./run-recovery-journal.ts";
import type { InternalRunState } from "./state.ts";
import { throwIfAborted } from "./abort.ts";
import { parseRunCheckpointPayload } from "./checkpoint-schema.ts";
import {
  MAX_RUN_CHECKPOINT_BYTES,
  RUN_CHECKPOINT_SCHEMA_VERSION,
  RUN_CHECKPOINT_VERSION,
  type CheckpointFrameV1,
  type FrameCheckpointContinuation,
  type RunCheckpointPayloadV1,
} from "./checkpoint-types.ts";

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const mapEntries = (map: ReadonlyMap<string, number>) => [...map]
  .map(([key, value]) => ({ key, value }))
  .sort((left, right) => compare(left.key, right.key));

const frameLineage = (runId: string, frameId: string): string => {
  if (frameId === `${runId}:f0`) return frameId;
  const match = new RegExp(`^${runId}:frame:(call_recurse_[a-f0-9]{64}):e[1-9][0-9]*$`).exec(frameId);
  if (!match?.[1]) throw new Error("checkpoint frame has no deterministic recurse lineage");
  return match[1];
};

const frameSnapshots = (runId: string, events: readonly RlmEvent[]): CheckpointFrameV1[] => {
  const opened = new Map<string, Extract<RlmEvent, { type: "frame_opened" }>>();
  const closed = new Map<string, Extract<RlmEvent, { type: "frame_closed" }>["state"]>();
  const answered = new Set<string>();
  const cells = new Map<string, number>();
  for (const event of events) {
    if (event.type === "frame_opened") opened.set(event.frameId, event);
    else if (event.type === "frame_closed") closed.set(event.frameId, event.state);
    else if (event.type === "answer_committed") answered.add(event.frameId);
    else if (event.type === "cell_committed") cells.set(event.frameId, Math.max(cells.get(event.frameId) ?? 0, event.iteration));
  }
  return [...opened.values()].map((event): CheckpointFrameV1 => ({
    frameId: event.frameId,
    lineage: frameLineage(runId, event.frameId),
    parentFrameId: event.parentFrameId,
    depth: event.depth,
    objective: event.objective,
    state: closed.get(event.frameId) ?? (answered.has(event.frameId) ? "answered" : "open"),
    nextIteration: (cells.get(event.frameId) ?? 0) + 1,
  })).sort((left, right) => compare(left.frameId, right.frameId));
};

const exactStoredBytes = (state: InternalRunState): number => {
  let total = 0;
  for (const context of state.store.snapshotDescriptors()) {
    if (total > Number.MAX_SAFE_INTEGER - context.bytes) throw new Error("checkpoint context byte total overflowed");
    total += context.bytes;
  }
  for (const artifact of state.artifacts.values()) {
    if (total > Number.MAX_SAFE_INTEGER - artifact.descriptor.bytes) throw new Error("checkpoint artifact byte total overflowed");
    total += artifact.descriptor.bytes;
  }
  return total;
};

export interface RunCheckpointWriterOptions {
  readonly state: InternalRunState;
  readonly document: RunManifestDocument;
  readonly checkpointStore: ContextStore;
  readonly signal: AbortSignal;
}

export class RunCheckpointWriter {
  constructor(private readonly options: RunCheckpointWriterOptions) {}

  async commit(continuation: FrameCheckpointContinuation): Promise<boolean> {
    const { state, document, checkpointStore, signal } = this.options;
    if (continuation.frame.depth !== 0 || continuation.frame.frameId !== `${state.runId}:f0`
      || state.inflight.size !== 0 || state.scopeUsage.size !== 0
      || state.ledger.current.usage.activeLeafCalls !== 0 || state.ledger.current.usage.tokensReserved !== 0
      || !state.semaphore.isIdle() || !state.contextSemaphore.isIdle()
      || state.store.orphanedBytes() !== 0 || state.operationAuthority?.active === false
      || state.agentDelegation?.pendingApprovals.size) return false;
    for (const binding of state.keyIdentities.values()) if (binding.state !== "durable") return false;
    throwIfAborted(signal);

    const release = await state.contextSemaphore.acquire(signal);
    if (!release) { throwIfAborted(signal); return false; }
    try {
      await state.journal.drain();
      throwIfAborted(signal);
      if (state.inflight.size !== 0 || state.scopeUsage.size !== 0 || !state.semaphore.isIdle()
        || state.ledger.current.usage.activeLeafCalls !== 0 || state.ledger.current.usage.tokensReserved !== 0
        || state.agentDelegation?.pendingApprovals.size || state.store.orphanedBytes() !== 0) return false;
      if (exactStoredBytes(state) !== state.ledger.current.usage.storedBytes)
        throw new Error("checkpoint stored-byte ledger does not match retained runtime payloads");

      const journal = await state.journal.authoritySnapshot();
      const model = validateRecoveryJournal(document, journal.events);
      if (model.terminal) return false;
      const frames = frameSnapshots(state.runId, journal.events);
      const open = frames.filter((frame) => frame.state === "open");
      if (open.length !== 1 || open[0]?.frameId !== continuation.frame.frameId) return false;
      const last = journal.events.at(-1);
      if (last?.type !== "cell_committed" || last.frameId !== continuation.frame.frameId
        || last.iteration + 1 !== continuation.nextIteration) return false;

      const checkpointSequence = journal.events.filter((event) => event.type === "checkpoint_committed").length + 1;
      const contexts = state.store.snapshotDescriptors();
      const callCache = [...state.callCache].map(([callId, result]) => {
        if (!result.outputRef) throw new Error("checkpoint call cache entry lacks its retained content descriptor");
        const descriptor = state.store.get(result.outputRef);
        if (!descriptor) throw new Error("checkpoint call cache content is unavailable");
        return { callId, result, descriptor };
      }).sort((left, right) => compare(left.callId, right.callId));
      const keyBindings = [...state.keyIdentities].map(([registryId, binding]) => ({
        registryId, identityHash: binding.identityHash,
      })).sort((left, right) => compare(left.registryId, right.registryId));
      const artifacts = [...state.artifacts.values()].map(({ descriptor, text }) => ({ descriptor, text }))
        .sort((left, right) => compare(left.descriptor.id, right.descriptor.id));
      const scopeUsage = [...state.scopeUsage].map(([scope, usage]) => ({ scope, usage }))
        .sort((left, right) => compare(left.scope, right.scope));
      const payload: RunCheckpointPayloadV1 = {
        schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
        checkpointVersion: RUN_CHECKPOINT_VERSION,
        identity: {
          runId: state.runId,
          manifestHash: document.manifestHash,
          manifestSchemaVersion: document.manifest.schemaVersion,
          checkpointSequence,
        },
        run: {
          startMs: state.startMs,
          rootFrameId: continuation.frame.frameId,
          nextControllerTurn: state.ledger.current.usage.controllerTurns + 1,
        },
        journalPrefix: {
          sha256: journal.prefixSha256,
          bytes: journal.verifiedBytes,
          eventCount: journal.events.length,
        },
        frames,
        root: {
          frame: {
            frameId: continuation.frame.frameId,
            lineage: continuation.frame.lineage ?? continuation.frame.frameId,
            depth: 0,
            objective: continuation.frame.objective,
            inputs: continuation.frame.inputs,
            outputs: continuation.frame.outputs,
          },
          nextIteration: continuation.nextIteration,
          workspace: continuation.workspace,
          trajectory: continuation.entries,
          ...(continuation.lastOutcome ? { lastOutcome: continuation.lastOutcome } : {}),
        },
        contexts, callCache, keyBindings, artifacts,
        ledger: state.ledger.current,
        scopeUsage,
        ordinals: {
          frameSequence: state.frameSeq.current,
          operationAttempts: mapEntries(state.operationAttempts),
          agentAttempts: mapEntries(state.agentAttempts),
          recurseExecutions: mapEntries(state.recurseExecutions),
        },
      };
      const canonicalPayload = parseRunCheckpointPayload(payload as unknown as JsonValue, document);
      const checkpoint = await checkpointStore.derive(
        {
          key: `checkpoint:${state.runId}:${checkpointSequence}`,
          value: canonicalPayload as unknown as JsonValue,
          label: `checkpoint:${state.runId}:${checkpointSequence}`,
        },
        {
          checkpoint: () => throwIfAborted(signal),
          maxOutputBytes: MAX_RUN_CHECKPOINT_BYTES,
        },
      );
      // Payload is intentionally committed before the journal gains authority over it.
      throwIfAborted(signal);
      const identity = {
        schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
        checkpointVersion: RUN_CHECKPOINT_VERSION,
        runId: state.runId,
        frameId: continuation.frame.frameId,
        manifestHash: document.manifestHash,
        checkpointSequence,
        checkpointRef: checkpoint.id,
        checkpointSha256: checkpoint.sha256,
        checkpointBytes: checkpoint.bytes,
        journalPrefixSha256: journal.prefixSha256,
        journalPrefixBytes: journal.verifiedBytes,
        journalPrefixEventCount: journal.events.length,
        nextIteration: continuation.nextIteration,
        nextControllerTurn: state.ledger.current.usage.controllerTurns + 1,
      } as const;
      const checkpointId = `cp_${state.hasher(canonicalStringify(identity as unknown as JsonValue))}`;
      const appended = await state.journal.append({ type: "checkpoint_committed", checkpointId, ...identity });
      if (appended.event !== "committed") throw new Error("checkpoint commit event was not newly authoritative");
      return true;
    } finally {
      release();
    }
  }
}
