/** Bounded, Pi-neutral live progress projected from trusted in-memory state. */

import type { BudgetLimits, Ledger } from "../core/budget.ts";

export const RUN_PROGRESS_PHASES = Object.freeze([
  "initializing",
  "source_capture",
  "allocating",
  "manifest",
  "source",
  "journal",
  "controller",
  "extractor",
  "context",
  "finalizing",
] as const);

export type RunProgressPhase = (typeof RUN_PROGRESS_PHASES)[number];
export type RunProgressStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunProgressSnapshot {
  readonly sequence: number;
  readonly runId?: string;
  readonly phase: RunProgressPhase;
  readonly status: RunProgressStatus;
  readonly elapsedMs: number;
  readonly calls: {
    readonly total: number;
    readonly active: number;
    readonly failed: number;
    readonly limit: number;
  };
  readonly frames: {
    readonly total: number;
    readonly active: number;
    readonly limit: number;
  };
  readonly budgets: {
    readonly tokensUsed: number;
    readonly inputTokensUsed: number;
    readonly outputTokensUsed: number;
    readonly tokensReserved: number;
    readonly tokenLimit?: number;
    readonly costUsd: number;
    readonly providerDurationMs: number;
    readonly storedBytes: number;
    readonly storedByteLimit: number;
    readonly deadlineMs: number;
  };
}

export type RunProgressObserver = (snapshot: RunProgressSnapshot) => void;

export interface RunProgressSource {
  /** Re-project current mutable state. Failures return the last valid snapshot. */
  getSnapshot(): RunProgressSnapshot;
}

interface RuntimeCounters {
  readonly activeCalls: number;
}

export interface RunProgressTracker {
  readonly source: RunProgressSource;
  bindRunId(runId: string): void;
  setPhase(phase: RunProgressPhase): void;
  setRuntimeGetter(getter: () => RuntimeCounters): void;
  frameOpened(): void;
  frameClosed(): void;
  callFailed(callId: string): void;
  publish(): void;
  finish(status: Exclude<RunProgressStatus, "running">): void;
}

export interface RunProgressTrackerOptions {
  readonly startMs: number;
  readonly limits: BudgetLimits;
  readonly ledger: () => Ledger;
  readonly now: () => number;
  readonly observer?: RunProgressObserver;
}

const PHASES = new Set<string>(RUN_PROGRESS_PHASES);
const RUN_ID = /^run_[a-f0-9]{64}$/;
const integer = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
const finite = (value: number): number => Number.isFinite(value) && value >= 0 ? value : 0;

const freezeSnapshot = (snapshot: RunProgressSnapshot): RunProgressSnapshot => {
  Object.freeze(snapshot.calls);
  Object.freeze(snapshot.frames);
  Object.freeze(snapshot.budgets);
  return Object.freeze(snapshot);
};

const same = (left: RunProgressSnapshot, right: Omit<RunProgressSnapshot, "sequence">): boolean =>
  left.runId === right.runId && left.phase === right.phase && left.status === right.status
  && left.elapsedMs === right.elapsedMs
  && left.calls.total === right.calls.total && left.calls.active === right.calls.active
  && left.calls.failed === right.calls.failed && left.calls.limit === right.calls.limit
  && left.frames.total === right.frames.total && left.frames.active === right.frames.active
  && left.frames.limit === right.frames.limit
  && left.budgets.tokensUsed === right.budgets.tokensUsed
  && left.budgets.inputTokensUsed === right.budgets.inputTokensUsed
  && left.budgets.outputTokensUsed === right.budgets.outputTokensUsed
  && left.budgets.tokensReserved === right.budgets.tokensReserved
  && left.budgets.tokenLimit === right.budgets.tokenLimit
  && left.budgets.costUsd === right.budgets.costUsd
  && left.budgets.providerDurationMs === right.budgets.providerDurationMs
  && left.budgets.storedBytes === right.budgets.storedBytes
  && left.budgets.storedByteLimit === right.budgets.storedByteLimit
  && left.budgets.deadlineMs === right.budgets.deadlineMs;

/**
 * Mutable accounting stays private. Every read returns a deeply frozen,
 * scalar-only snapshot. Observer code runs outside accounting and is ignored on
 * failure, so it cannot replace or interrupt runtime work.
 */
export const createRunProgressTracker = (options: RunProgressTrackerOptions): RunProgressTracker => {
  const { startMs, limits, ledger, now } = options;
  let observer = options.observer;
  let phase: RunProgressPhase = "initializing";
  let status: RunProgressStatus = "running";
  let runId: string | undefined;
  let framesTotal = 1;
  let framesActive = 1;
  const failedCallIds = new Set<string>();
  let runtimeGetter: (() => RuntimeCounters) | undefined;
  let terminalNow: number | undefined;
  let elapsedHighWaterMs = 0;
  let sequence = 0;

  const project = (): Omit<RunProgressSnapshot, "sequence"> => {
    const currentLedger = ledger();
    const { usage } = currentLedger;
    const runtime = runtimeGetter?.();
    const elapsedEnd = terminalNow ?? now();
    elapsedHighWaterMs = Math.max(
      elapsedHighWaterMs,
      integer(Math.max(0, Math.floor(elapsedEnd - startMs))),
    );
    const activeCalls = status === "running"
      ? Math.max(integer(runtime?.activeCalls ?? 0), integer(usage.activeLeafCalls))
      : 0;
    return {
      ...(runId ? { runId } : {}),
      phase,
      status,
      elapsedMs: elapsedHighWaterMs,
      calls: {
        total: integer(usage.logicalCalls),
        active: activeCalls,
        failed: integer(failedCallIds.size),
        limit: integer(limits.maxLogicalCalls),
      },
      frames: {
        total: integer(framesTotal),
        active: status === "running" ? integer(framesActive) : 0,
        limit: integer(Math.min(Number.MAX_SAFE_INTEGER, limits.maxFrames + 1)),
      },
      budgets: {
        tokensUsed: integer(usage.tokensUsed),
        inputTokensUsed: integer(usage.inputTokensUsed),
        outputTokensUsed: integer(usage.outputTokensUsed),
        tokensReserved: integer(usage.tokensReserved),
        ...(limits.tokenLimit !== undefined ? { tokenLimit: integer(limits.tokenLimit) } : {}),
        costUsd: finite(usage.costUsd),
        providerDurationMs: integer(usage.providerDurationMs),
        storedBytes: integer(usage.storedBytes),
        storedByteLimit: integer(limits.storedByteLimit),
        deadlineMs: integer(limits.deadlineMs),
      },
    };
  };

  let last = freezeSnapshot({ sequence, ...project() });
  const getSnapshot = (): RunProgressSnapshot => {
    try {
      const next = project();
      if (same(last, next)) return last;
      sequence += 1;
      last = freezeSnapshot({ sequence, ...next });
    } catch {
      // Runtime-owned getters should not fail. Preserve the last safe value if they do.
    }
    return last;
  };
  const publish = (): void => {
    const snapshot = getSnapshot();
    try { observer?.(snapshot); } catch { /* Observers have no runtime authority. */ }
  };

  return {
    source: Object.freeze({ getSnapshot }),
    bindRunId: (value) => {
      if (!RUN_ID.test(value)) throw new TypeError("invalid run progress identity");
      if (runId !== undefined && runId !== value) throw new Error("run progress identity is already bound");
      if (runId === value) return;
      runId = value;
      publish();
    },
    setPhase: (value) => {
      if (!PHASES.has(value)) throw new TypeError("invalid run progress phase");
      if (status !== "running" || phase === value) return;
      phase = value;
      publish();
    },
    setRuntimeGetter: (getter) => {
      runtimeGetter = getter;
      publish();
    },
    frameOpened: () => {
      if (status !== "running") return;
      framesTotal += 1;
      framesActive += 1;
      publish();
    },
    frameClosed: () => {
      if (status !== "running" || framesActive === 0) return;
      framesActive -= 1;
      publish();
    },
    callFailed: (callId) => {
      if (status !== "running" || typeof callId !== "string" || callId.length === 0 || callId.length > 256
        || failedCallIds.has(callId) || failedCallIds.size >= options.limits.maxLogicalCalls) return;
      failedCallIds.add(callId);
      publish();
    },
    publish,
    finish: (value) => {
      if (status !== "running") return;
      status = value;
      terminalNow = now();
      publish();
      runtimeGetter = undefined;
      observer = undefined;
    },
  };
};
