/**
 * Authoritative event journal and status fold (pure).
 *
 * `events.jsonl` is the durable source of truth. `RunStatus` is a rebuildable
 * projection produced by folding the ordered event list. The fold is idempotent
 * for the identifiers that matter on restart replay: duplicate committed calls
 * (by callId) and duplicate cells (by frame + iteration) fold once.
 */

import type { BudgetLimits } from "./budget.ts";
import type { CallKind } from "./ids.ts";
import type { CallUsage } from "./usage.ts";

export type ProviderOperationKind = "controller" | "llm" | "extractor";

export type CompletionMode = "answer" | "fallback_extract";
export type RunState = "running" | "completed" | "failed" | "cancelled";
export type FrameState = "open" | "answered" | "closed" | "failed" | "cancelled";

export interface EventErrorInfo {
  readonly code: string;
  readonly message: string;
}

export type RlmEvent =
  | {
      readonly type: "run_started";
      readonly runId: string;
      readonly manifestHash: string;
      readonly limits: BudgetLimits;
      /** Durable content references only. Recovery policy remains owned by #25. */
      readonly inputRefs?: readonly { readonly name: string; readonly id: string; readonly sha256: string; readonly bytes: number }[];
    }
  | { readonly type: "frame_opened"; readonly frameId: string; readonly parentFrameId: string | null; readonly depth: number; readonly objective: string }
  | { readonly type: "phase"; readonly frameId: string; readonly ordinal: number; readonly name: string }
  | { readonly type: "emit"; readonly frameId: string; readonly ordinal: number; readonly message: string }
  | {
      readonly type: "key_bound";
      readonly frameId: string;
      readonly kind: CallKind;
      readonly key: string;
      readonly identityHash: string;
    }
  | {
      readonly type: "cell_committed";
      readonly frameId: string;
      readonly iteration: number;
      readonly reasoning: string;
      readonly codeHash: string;
      readonly hasResult: boolean;
      readonly outputPreview: string;
      readonly outputBytes?: number;
      readonly outputOmittedBytes?: number;
      readonly usage?: CallUsage;
      readonly outputRef?: string;
      readonly outputRefSha256?: string;
      readonly outputRefBytes?: number;
      readonly error?: EventErrorInfo;
    }
  | {
      readonly type: "workspace_committed";
      readonly frameId: string;
      readonly iteration: number;
      readonly workspaceRef: string;
      readonly workspaceSha256: string;
      readonly workspaceBytes: number;
    }
  | {
      readonly type: "fallback_evidence_projected";
      readonly frameId: string;
      readonly projectionVersion: string;
      readonly projectionHash: string;
      readonly projectedBytes: number;
      readonly maxBytes: number;
      readonly omittedBytes: number;
      readonly omittedItems: number;
      readonly truncatedItems: number;
      readonly evidenceIdCount: number;
      readonly evidenceIdsHash: string;
      readonly truncated: boolean;
    }
  | {
      readonly type: "fallback_evidence_cited";
      readonly frameId: string;
      readonly evidenceRefs: readonly string[];
      readonly evidenceRefsHash: string;
    }
  | {
      readonly type: "provider_attempted";
      readonly frameId: string;
      readonly operationId: string;
      readonly kind: ProviderOperationKind;
      readonly key: string;
      readonly attempt: number;
      readonly outcome: "ok" | "error" | "cancelled" | "invalid_result";
      readonly usage: CallUsage;
      /** Present for every provider request; omitted only for opaque external operations. */
      readonly requestIdentityVersion?: string;
      readonly requestSha256?: string;
      readonly errorCode?: string;
    }
  | {
      readonly type: "call_committed";
      readonly frameId: string;
      readonly callId: string;
      readonly kind: CallKind;
      readonly key: string;
      readonly cached: boolean;
      readonly ok: boolean;
      readonly usage: CallUsage;
      readonly outputRef?: string;
      readonly outputSha256?: string;
      readonly outputBytes?: number;
    }
  | {
      readonly type: "answer_committed";
      readonly frameId: string;
      readonly completionMode: CompletionMode;
      readonly outputRef: string;
      readonly outputSha256?: string;
      readonly outputBytes?: number;
    }
  | { readonly type: "frame_closed"; readonly frameId: string; readonly state: FrameState }
  | { readonly type: "run_completed"; readonly runId: string; readonly completionMode: CompletionMode; readonly outputRef?: string }
  | { readonly type: "run_failed"; readonly runId: string; readonly code: string; readonly message: string }
  | { readonly type: "run_cancelled"; readonly runId: string; readonly code: "CANCELLED"; readonly message: string };

export interface FrameStatus {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly depth: number;
  readonly objective: string;
  readonly iterations: number;
  readonly calls: number;
  readonly phase?: string;
  readonly lastOutputPreview?: string;
  readonly state: FrameState;
}

export interface KeyBindingStatus {
  readonly frameId: string;
  readonly kind: CallKind;
  readonly key: string;
  readonly identityHash: string;
}

export interface RunStatus {
  readonly runId?: string;
  readonly manifestHash?: string;
  readonly state: RunState;
  readonly completionMode?: CompletionMode;
  readonly outputRef?: string;
  readonly error?: EventErrorInfo;
  readonly frames: Readonly<Record<string, FrameStatus>>;
  readonly frameOrder: readonly string[];
  readonly committedCallIds: readonly string[];
  readonly keyBindings: readonly KeyBindingStatus[];
}

interface MutableFrame {
  frameId: string;
  parentFrameId: string | null;
  depth: number;
  objective: string;
  iterations: number;
  calls: number;
  phase?: string;
  lastOutputPreview?: string;
  state: FrameState;
  seenIterations: Set<number>;
}

/** Fold an ordered event list into a run status projection. */
export const reduceStatus = (events: readonly RlmEvent[]): RunStatus => {
  let runId: string | undefined;
  let manifestHash: string | undefined;
  let state: RunState = "running";
  let completionMode: CompletionMode | undefined;
  let outputRef: string | undefined;
  let error: EventErrorInfo | undefined;
  let terminal = false;
  const frames = new Map<string, MutableFrame>();
  const frameOrder: string[] = [];
  const committedCallIds = new Set<string>();
  const keyBindings = new Map<string, KeyBindingStatus>();

  const frame = (id: string): MutableFrame | undefined => frames.get(id);

  for (const event of events) {
    switch (event.type) {
      case "run_started":
        runId = event.runId;
        manifestHash = event.manifestHash;
        break;
      case "frame_opened":
        if (!frames.has(event.frameId)) {
          frames.set(event.frameId, {
            frameId: event.frameId,
            parentFrameId: event.parentFrameId,
            depth: event.depth,
            objective: event.objective,
            iterations: 0,
            calls: 0,
            state: "open",
            seenIterations: new Set<number>(),
          });
          frameOrder.push(event.frameId);
        }
        break;
      case "phase": {
        const f = frame(event.frameId);
        if (f) f.phase = event.name;
        break;
      }
      case "emit":
      case "workspace_committed":
      case "fallback_evidence_projected":
      case "fallback_evidence_cited":
      case "provider_attempted":
        break;
      case "key_bound": {
        const registryKey = `${event.frameId}\u0000${event.kind}\u0000${event.key}`;
        if (!keyBindings.has(registryKey)) keyBindings.set(registryKey, {
          frameId: event.frameId,
          kind: event.kind,
          key: event.key,
          identityHash: event.identityHash,
        });
        break;
      }
      case "cell_committed": {
        const f = frame(event.frameId);
        if (f && !f.seenIterations.has(event.iteration)) {
          f.seenIterations.add(event.iteration);
          f.iterations += 1;
          f.lastOutputPreview = event.outputPreview;
        }
        break;
      }
      case "call_committed": {
        const f = frame(event.frameId);
        if (f && !committedCallIds.has(event.callId)) {
          committedCallIds.add(event.callId);
          f.calls += 1;
        }
        break;
      }
      case "answer_committed": {
        const f = frame(event.frameId);
        if (f) f.state = "answered";
        break;
      }
      case "frame_closed": {
        const f = frame(event.frameId);
        if (f) f.state = event.state;
        break;
      }
      case "run_completed":
        if (!terminal) {
          terminal = true;
          state = "completed";
          completionMode = event.completionMode;
          if (event.outputRef !== undefined) outputRef = event.outputRef;
        }
        break;
      case "run_failed":
        if (!terminal) {
          terminal = true;
          state = "failed";
          error = { code: event.code, message: event.message };
        }
        break;
      case "run_cancelled":
        if (!terminal) {
          terminal = true;
          state = "cancelled";
          error = { code: event.code, message: event.message };
        }
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  const frameStatuses: Record<string, FrameStatus> = {};
  for (const [id, f] of frames) {
    frameStatuses[id] = {
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      depth: f.depth,
      objective: f.objective,
      iterations: f.iterations,
      calls: f.calls,
      ...(f.phase !== undefined ? { phase: f.phase } : {}),
      ...(f.lastOutputPreview !== undefined ? { lastOutputPreview: f.lastOutputPreview } : {}),
      state: f.state,
    };
  }

  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(manifestHash !== undefined ? { manifestHash } : {}),
    state,
    ...(completionMode !== undefined ? { completionMode } : {}),
    ...(outputRef !== undefined ? { outputRef } : {}),
    ...(error !== undefined ? { error } : {}),
    frames: frameStatuses,
    frameOrder,
    committedCallIds: [...committedCallIds],
    keyBindings: [...keyBindings.values()],
  };
};
