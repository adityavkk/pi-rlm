/** Shared, mutable run state threaded through the broker and frame runners. */

import type { Ledger } from "../core/budget.ts";
import type { Hasher } from "../core/ids.ts";
import type { RlmProgram, RlmOutputField } from "../core/program.ts";
import type { ContextDescriptor, ContextStore } from "../shell/context-store.ts";
import type { Clock } from "../shell/clock.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import type { GuestCallResult } from "./call-result.ts";
import type { Profile } from "./profile.ts";
import type { Semaphore } from "./semaphore.ts";

export interface ArtifactDescriptor {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType: string;
}

export interface FrameRef {
  readonly frameId: string;
  readonly depth: number;
  readonly objective: string;
  readonly inputs: Readonly<Record<string, ContextDescriptor>>;
  readonly outputs: readonly RlmOutputField[];
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
  readonly semaphore: Semaphore;
  readonly contextSemaphore: Semaphore;
  readonly frameSeq: { current: number };
}
