import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLedger, type BudgetLimits } from "../core/budget.ts";
import { normalizeProgram } from "../core/program.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import type { CellEvalOptions, CellEvalOutcome, InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ModelClient, ModelResponse } from "../shell/model/client.ts";
import type { Cell, ControllerDriver } from "./controller.ts";
import { createRunProgressTracker, type RunProgressSnapshot, type RunProgressSource } from "./run-progress.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { runProgram } from "./run.ts";

const limits: BudgetLimits = {
  maxDepth: 4,
  maxFrames: 8,
  maxLogicalCalls: 16,
  maxAttempts: 16,
  maxControllerTurns: 8,
  maxConcurrency: 3,
  tokenLimit: 1_000,
  storedByteLimit: 2_000,
  deadlineMs: 9_000,
};

const runId = `run_${"a".repeat(64)}`;

describe("run progress source", () => {
  test("projects immutable exact scalar accounting with monotonic sequence", () => {
    let now = 100;
    const ledger = { current: createLedger(limits) };
    let activeCalls = 0;
    let observations = 0;
    const tracker = createRunProgressTracker({
      startMs: 100,
      limits,
      ledger: () => ledger.current,
      now: () => now,
      observer: () => { observations += 1; throw new Error("observer is untrusted"); },
    });
    tracker.bindRunId(runId);
    tracker.setPhase("controller");
    tracker.setRuntimeGetter(() => ({ activeCalls }));
    tracker.frameOpened();
    tracker.frameOpened();
    tracker.callFailed("call-test");
    activeCalls = 2;
    ledger.current = {
      limits,
      usage: {
        framesOpened: 1,
        logicalCalls: 5,
        attempts: 4,
        controllerTurns: 2,
        activeLeafCalls: 1,
        tokensReserved: 70,
        tokensUsed: 125,
        inputTokensUsed: 80,
        outputTokensUsed: 45,
        costUsd: 0.125,
        providerDurationMs: 321,
        storedBytes: 456,
      },
    };
    now = 150;
    const snapshot = tracker.source.getSnapshot();
    expect(snapshot).toEqual({
      sequence: expect.any(Number),
      runId,
      phase: "controller",
      status: "running",
      elapsedMs: 50,
      calls: { total: 5, active: 2, failed: 1, limit: 16 },
      frames: { total: 3, active: 3, limit: 9 },
      budgets: {
        tokensUsed: 125,
        inputTokensUsed: 80,
        outputTokensUsed: 45,
        tokensReserved: 70,
        tokenLimit: 1_000,
        costUsd: 0.125,
        providerDurationMs: 321,
        storedBytes: 456,
        storedByteLimit: 2_000,
        deadlineMs: 9_000,
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.calls)).toBe(true);
    expect(Object.isFrozen(snapshot.budgets)).toBe(true);
    const sequence = snapshot.sequence;
    expect(tracker.source.getSnapshot()).toBe(snapshot);
    now = 151;
    const advanced = tracker.source.getSnapshot();
    expect(advanced.sequence).toBeGreaterThan(sequence);
    now = 120;
    expect(tracker.source.getSnapshot()).toBe(advanced);
    tracker.frameClosed();
    tracker.finish("cancelled");
    const terminal = tracker.source.getSnapshot();
    now = 500;
    expect(tracker.source.getSnapshot()).toBe(terminal);
    expect(terminal.status).toBe("cancelled");
    expect(terminal.calls.active).toBe(0);
    expect(terminal.frames.active).toBe(0);
    expect(observations).toBeGreaterThan(0);
    const terminalObservations = observations;
    tracker.publish();
    expect(observations).toBe(terminalObservations);
    expect(JSON.stringify(terminal)).not.toContain("objective");
  });

  test("invalid phases and identity rebinding fail before disclosure", () => {
    const ledger = { current: createLedger(limits) };
    const tracker = createRunProgressTracker({ startMs: 0, limits, ledger: () => ledger.current, now: () => 0 });
    expect(() => tracker.setPhase("provider secret" as never)).toThrow();
    tracker.bindRunId(runId);
    expect(() => tracker.bindRunId(`run_${"b".repeat(64)}`)).toThrow();
  });
});

const program = (() => {
  const result = normalizeProgram({
    objective: "root objective must not enter progress",
    profile: "default",
    inputs: [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
})();

class Controller implements ControllerDriver {
  readonly identity = { id: "test/progress-controller", version: "1", configuration: {} } as const;
  async next(): Promise<Cell> { return { reasoning: "fixture", code: "1" }; }
  fork(): ControllerDriver { return this; }
}

class Backend implements InterpreterBackend {
  readonly id = "test-progress-backend";
  readonly version = "1";
  async evalCell(options: CellEvalOptions): Promise<CellEvalOutcome> {
    const objective = String(options.globals.objective);
    if (objective.startsWith("root"))
      await options.dispatch("recurse", { key: "child", objective: "child secret" }, options.signal!, options.deadlineMs);
    options.effect("answer", { value: objective.startsWith("root") ? { answer: "done" } : {} });
    return { kind: "value", result: null, hasResult: true, workspace: {}, workspaceInvalidPaths: [] };
  }
  async dispose(): Promise<void> {}
}

const model: ModelClient = {
  id: "unused",
  identity: { id: "test/progress-model", version: "1", configuration: {} },
  async complete(): Promise<ModelResponse> { return { text: "unused", usage: ZERO_CALL_USAGE }; },
};

test("runProgram publishes root/child lifecycle and swallows observer failures", async () => {
  const snapshots: RunProgressSnapshot[] = [];
  let source: RunProgressSource | undefined;
  const result = await runProgram({
    program,
    sources: {},
    controller: new Controller(),
    model,
    backend: new Backend(),
    dir: await mkdtemp(join(tmpdir(), "pi-rlm-progress-")),
    signal: new AbortController().signal,
    onProgressSource: (value) => { source = value; throw new Error("capture failure"); },
    onProgress: (snapshot) => { snapshots.push(snapshot); throw new Error("observer failure"); },
  });
  expect(result.status).toBe("completed");
  expect(source?.getSnapshot().status).toBe("completed");
  expect(snapshots.some(({ frames }) => frames.total === 2 && frames.active === 2)).toBe(true);
  expect(snapshots.at(-1)).toMatchObject({ status: "completed", frames: { total: 2, active: 0 } });
  expect(JSON.stringify(snapshots)).not.toContain("secret");
});

class FailingCallBackend implements InterpreterBackend {
  readonly id = "test-failing-call-backend";
  readonly version = "1";
  constructor(private readonly kind: "llm" | "agent" | "recurse", private readonly coalesce = false) {}
  async evalCell(options: CellEvalOptions): Promise<CellEvalOutcome> {
    const root = String(options.globals.objective).startsWith("root");
    if (!root && this.kind === "recurse") throw new Error("child failure");
    if (root) {
      const spec = this.kind === "llm"
        ? { key: "shared", prompt: "fail" }
        : this.kind === "agent"
          ? { key: "shared", agent: "reviewer", task: "fail" }
          : { key: "shared", objective: "child failure" };
      const invoke = () => options.dispatch(this.kind, spec as never, options.signal!, options.deadlineMs);
      if (this.coalesce) await Promise.all([invoke(), invoke()]);
      else await invoke();
      options.effect("answer", { value: { answer: "done" } });
    }
    return { kind: "value", result: null, hasResult: true, workspace: {}, workspaceInvalidPaths: [] };
  }
  async dispose(): Promise<void> {}
}

const failingModel: ModelClient = {
  id: "failing-progress-model",
  identity: { id: "test/failing-progress-model", version: "1", configuration: {} },
  async complete(): Promise<ModelResponse> { throw new Error("provider failed"); },
};

const failingAgent = {
  identity: { id: "test/failing-progress-agent", version: "1", configuration: {} },
  async run() { return { ok: false as const, code: "FAILED" as const, status: "error" as const }; },
};

test.each(["llm", "agent", "recurse"] as const)(
  "real %s task failure counts one distinct logical settlement",
  async (kind) => {
    const snapshots: RunProgressSnapshot[] = [];
    const result = await runProgram({
      program,
      sources: {},
      controller: new Controller(),
      model: kind === "llm" ? failingModel : model,
      backend: new FailingCallBackend(kind, kind === "llm"),
      dir: await mkdtemp(join(tmpdir(), `pi-rlm-progress-${kind}-`)),
      signal: new AbortController().signal,
      onProgress: (snapshot) => snapshots.push(snapshot),
      ...(kind === "agent" ? {
        agentDelegation: { client: failingAgent, cwd: "/tmp", allowedAgents: ["reviewer"] },
      } : {}),
    });
    expect(result.status).toBe("completed");
    expect(result.ledger.usage.logicalCalls).toBe(1);
    expect(snapshots.at(-1)?.calls.failed).toBe(1);
    if (kind === "agent") expect(snapshots.some(({ calls }) => calls.active === 1)).toBe(true);
  },
);

test("agent caller cancellation settles one failed logical call before terminal progress", async () => {
  const owner = new AbortController();
  const snapshots: RunProgressSnapshot[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pendingAgent = {
    identity: { id: "test/pending-progress-agent", version: "1", configuration: {} },
    async run() {
      markStarted();
      return new Promise<never>(() => {});
    },
  };
  const work = runProgram({
    program, sources: {}, controller: new Controller(), model,
    backend: new FailingCallBackend("agent"),
    dir: await mkdtemp(join(tmpdir(), "pi-rlm-progress-agent-cancel-")),
    signal: owner.signal,
    onProgress: (snapshot) => snapshots.push(snapshot),
    agentDelegation: { client: pendingAgent, cwd: "/tmp", allowedAgents: ["reviewer"] },
  });
  await started;
  owner.abort();
  const result = await work;
  expect(result.status).toBe("cancelled");
  expect(result.ledger.usage.logicalCalls).toBe(1);
  expect(snapshots.at(-1)).toMatchObject({ status: "cancelled", calls: { failed: 1 } });
  await Promise.resolve();
  expect(snapshots.at(-1)?.calls.failed).toBe(1);
});

test("logical reservation denial is not a failed call", async () => {
  const snapshots: RunProgressSnapshot[] = [];
  const result = await runProgram({
    program, sources: {}, controller: new Controller(), model: failingModel,
    backend: new FailingCallBackend("llm"),
    dir: await mkdtemp(join(tmpdir(), "pi-rlm-progress-denial-")),
    signal: new AbortController().signal,
    profile: { ...DEFAULT_PROFILE, maxLogicalCalls: 0 },
    onProgress: (snapshot) => snapshots.push(snapshot),
  });
  expect(result.ledger.usage.logicalCalls).toBe(0);
  expect(snapshots.at(-1)?.calls.failed).toBe(0);
});

test("root is included in frame total/limit and closes before terminal progress", async () => {
  const snapshots: RunProgressSnapshot[] = [];
  await runProgram({
    program, sources: {}, controller: new Controller(), model, backend: new Backend(),
    dir: await mkdtemp(join(tmpdir(), "pi-rlm-progress-full-")),
    signal: new AbortController().signal,
    profile: { ...DEFAULT_PROFILE, maxFrames: 1 },
    onProgress: (snapshot) => snapshots.push(snapshot),
  });
  expect(snapshots.at(-1)?.frames).toEqual({ total: 2, active: 0, limit: 2 });
  expect(snapshots.some((snapshot) => snapshot.status === "running"
    && snapshot.phase === "finalizing" && snapshot.frames.active === 0)).toBe(true);

  const rootOnly: RunProgressSnapshot[] = [];
  const rootBackend = new Backend();
  await runProgram({
    program, sources: {}, controller: new Controller(), model,
    backend: { ...rootBackend, evalCell: async (options) => {
      options.effect("answer", { value: { answer: "done" } });
      return { kind: "value", result: null, hasResult: true, workspace: {}, workspaceInvalidPaths: [] };
    }, async dispose() {} },
    dir: await mkdtemp(join(tmpdir(), "pi-rlm-progress-root-")), signal: new AbortController().signal,
    profile: { ...DEFAULT_PROFILE, maxFrames: 0 }, onProgress: (snapshot) => rootOnly.push(snapshot),
  });
  expect(rootOnly.at(-1)?.frames).toEqual({ total: 1, active: 0, limit: 1 });
});

test("captured sources terminalize on claim and lifecycle failures", async () => {
  let claimed: RunProgressSource | undefined;
  const missing = join(await mkdtemp(join(tmpdir(), "pi-rlm-progress-claim-")), "missing", "run");
  const claimResult = await runProgram({
    program, sources: {}, controller: new Controller(), model, backend: new Backend(), dir: missing,
    signal: new AbortController().signal, onProgressSource: (source) => { claimed = source; },
  });
  expect(claimResult.status).toBe("failed");
  expect(claimed?.getSnapshot().status).toBe("failed");

  let lifecycle: RunProgressSource | undefined;
  await expect(runProgram({
    program, sources: {}, controller: new Controller(), model, backend: new Backend(),
    dir: await mkdtemp(join(tmpdir(), "pi-rlm-progress-lifecycle-")), signal: new AbortController().signal,
    onProgressSource: (source) => { lifecycle = source; },
    runLifecycle: { claimEntries: [], onManifest: async () => { throw new Error("lifecycle failed"); } },
  })).rejects.toThrow("lifecycle failed");
  expect(lifecycle?.getSnapshot().status).toBe("failed");
});
