/** Versioned, data-only runtime checkpoint wire model. */

import type { Ledger } from "../core/budget.ts";
import type { JsonValue } from "../core/json.ts";
import type { RlmOutputField } from "../core/program.ts";
import type { TrajectoryEntry } from "../core/trajectory.ts";
import type { CallUsage } from "../core/usage.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";
import type { GuestCallResult } from "./call-result.ts";
import type { ArtifactDescriptor, FrameRef } from "./state.ts";

export const RUN_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const RUN_CHECKPOINT_VERSION = "pi-rlm.checkpoint.v1" as const;
export const MAX_RUN_CHECKPOINT_BYTES = 256 * 1024 * 1024;
export const MAX_RUN_CHECKPOINT_ITEMS = 100_000;
export const MAX_RUN_CHECKPOINT_STRING_BYTES = 1024 * 1024;

export interface CheckpointJournalPrefixV1 {
  readonly sha256: string;
  readonly bytes: number;
  readonly eventCount: number;
}

export interface CheckpointFrameV1 {
  readonly frameId: string;
  readonly lineage: string;
  readonly parentFrameId: string | null;
  readonly depth: number;
  readonly objective: string;
  readonly state: "open" | "answered" | "closed" | "failed" | "cancelled";
  readonly nextIteration: number;
}

export interface CheckpointRootFrameV1 {
  readonly frameId: string;
  readonly lineage: string;
  readonly depth: 0;
  readonly objective: string;
  readonly inputs: Readonly<Record<string, ContextDescriptor>>;
  readonly outputs: readonly RlmOutputField[];
}

export interface CheckpointLastOutcomeV1 {
  readonly kind: string;
  readonly preview?: string;
  readonly message?: string;
}

export interface CheckpointCallCacheEntryV1 {
  readonly callId: string;
  readonly result: GuestCallResult;
  readonly descriptor: ContextDescriptor;
}

export interface CheckpointKeyBindingV1 {
  readonly registryId: string;
  readonly identityHash: string;
}

export interface CheckpointArtifactV1 {
  readonly descriptor: ArtifactDescriptor;
  readonly text: string;
}

export interface CheckpointUsageEntryV1 {
  readonly scope: string;
  readonly usage: CallUsage;
}

export interface CheckpointOrdinalEntryV1 {
  readonly key: string;
  readonly value: number;
}

export interface RunCheckpointPayloadV1 {
  readonly schemaVersion: typeof RUN_CHECKPOINT_SCHEMA_VERSION;
  readonly checkpointVersion: typeof RUN_CHECKPOINT_VERSION;
  readonly identity: {
    readonly runId: string;
    readonly manifestHash: string;
    readonly manifestSchemaVersion: number;
    readonly checkpointSequence: number;
  };
  readonly run: {
    readonly startMs: number;
    readonly rootFrameId: string;
    readonly nextControllerTurn: number;
  };
  readonly journalPrefix: CheckpointJournalPrefixV1;
  readonly frames: readonly CheckpointFrameV1[];
  readonly root: {
    readonly frame: CheckpointRootFrameV1;
    readonly nextIteration: number;
    readonly workspace: JsonValue;
    readonly trajectory: readonly TrajectoryEntry[];
    readonly lastOutcome?: CheckpointLastOutcomeV1;
  };
  readonly contexts: readonly ContextDescriptor[];
  readonly callCache: readonly CheckpointCallCacheEntryV1[];
  readonly keyBindings: readonly CheckpointKeyBindingV1[];
  readonly artifacts: readonly CheckpointArtifactV1[];
  readonly ledger: Ledger;
  readonly scopeUsage: readonly CheckpointUsageEntryV1[];
  readonly ordinals: {
    readonly frameSequence: number;
    readonly operationAttempts: readonly CheckpointOrdinalEntryV1[];
    readonly agentAttempts: readonly CheckpointOrdinalEntryV1[];
    readonly recurseExecutions: readonly CheckpointOrdinalEntryV1[];
  };
}

export interface FrameCheckpointContinuation {
  readonly frame: FrameRef;
  readonly nextIteration: number;
  readonly workspace: JsonValue;
  readonly entries: readonly TrajectoryEntry[];
  readonly lastOutcome?: CheckpointLastOutcomeV1;
}
