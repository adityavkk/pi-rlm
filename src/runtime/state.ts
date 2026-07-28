/** Shared, mutable run state threaded through the broker and frame runners. */

import type { Ledger } from "../core/budget.ts";
import type { CallUsage } from "../core/usage.ts";
import type { Hasher } from "../core/ids.ts";
import type { RlmProgram, RlmOutputField } from "../core/program.ts";
import type { ContextDescriptor, ContextStore } from "../shell/context-store.ts";
import type { Clock } from "../shell/clock.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import type { GuestCallResult } from "./call-result.ts";
import type { AgentDelegationRuntime } from "./agent-delegation.ts";
import type { Profile } from "./profile.ts";
import type { RunOperationAuthority } from "./operation-authority.ts";
import type { RunProgressTracker } from "./run-progress.ts";
import type { Semaphore } from "./semaphore.ts";
import type { FrameCheckpointContinuation } from "./checkpoint-types.ts";

export interface ArtifactDescriptor {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType: string;
}

export interface KeyIdentityBinding {
  /** Present for live claims; recovered durable bindings retain only their non-secret hash. */
  readonly canonicalIdentity?: string;
  readonly identityHash: string;
  readonly ready: Promise<void>;
  state: "pending" | "durable" | "durable_failed";
  error?: unknown;
}

export interface FrameRef {
  readonly frameId: string;
  /** Deterministic recurse ancestry; unlike scheduling ordinals, stable for identity and controller forks. */
  readonly lineage?: string;
  readonly depth: number;
  readonly objective: string;
  readonly inputs: Readonly<Record<string, ContextDescriptor>>;
  readonly outputs: readonly RlmOutputField[];
  /** Recurse results that receive this frame's provider usage without re-settlement. */
  readonly usageScopes?: readonly string[];
}

export interface RunState {
  readonly runId: string;
  readonly startMs: number;
  readonly profile: Profile;
  readonly clock: Clock;
  readonly hasher: Hasher;
  readonly program: RlmProgram;
  readonly ledger: { current: Ledger };
  readonly store: ContextStore;
  readonly artifacts: Map<string, { descriptor: ArtifactDescriptor; text: string }>;
  readonly model: ModelClient;
  readonly journal: JournalStore;
  readonly backend: InterpreterBackend;
  readonly callCache: Map<string, GuestCallResult>;
  readonly inflight: Map<string, Promise<GuestCallResult>>;
  readonly keyIdentities: Map<string, KeyIdentityBinding>;
  readonly scopeUsage: Map<string, CallUsage>;
  /** Highest durable-attempt ordinal reserved for each frame and operation identity. */
  readonly operationAttempts: Map<string, number>;
  /** Present for top-level runs; closed before frame/run terminalization starts. */
  readonly operationAuthority?: RunOperationAuthority;
  readonly semaphore: Semaphore;
  readonly contextSemaphore: Semaphore;
  readonly agentDelegation?: AgentDelegationRuntime;
  readonly agentAttempts: Map<string, number>;
  /** Stable per-call recurse execution ordinal. Retries must not reopen one frame identity. */
  readonly recurseExecutions: Map<string, number>;
  readonly frameSeq: { current: number };
  /** Managed root-frame checkpoint sink. Returns false when global quiescence is not proven. */
  readonly checkpoint?: { commit(continuation: FrameCheckpointContinuation): Promise<boolean> };
  readonly progress?: RunProgressTracker;
}

/** Runtime-private state used only by the top-level and frame runners. */
export interface InternalRunState extends RunState {
  readonly controllerTurnObserver?: (controllerTurns: number) => void;
}
