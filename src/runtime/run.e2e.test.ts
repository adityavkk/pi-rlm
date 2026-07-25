import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { interpreterError } from "../core/errors.ts";
import type { RlmEvent } from "../core/journal.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { ContextStore } from "../shell/context-store.ts";
import type { CellEvalOptions, CellEvalOutcome, InterpreterBackend } from "../shell/interpreter/backend.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";
import { MockController } from "./mock-controller.ts";
import { FunctionExtractor } from "./extractor.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { runProgram } from "./run.ts";
import { registerControllerTurnObserverForTest } from "./testing/controller-turn-observer.ts";

const modelIdentity = (fixture: string) => ({ id: "test/mock-model-handler", version: "1", configuration: { fixture } } as const);
const extractorIdentity = (fixture: string) => ({
  closure: { id: "test/extractor-closure", version: "1", configuration: { fixture } },
  configuration: { fixture },
  modelRoute: "test/model",
  providerPrompt: { id: "test/extractor-prompt", version: "1", configuration: { fixture } },
} as const);
const controllerIdentity = (fixture: string) => ({ id: "test/mock-controller-fork", version: "1", configuration: { fixture } } as const);

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-e2e-"));
const journalEvents = async (dir: string): Promise<RlmEvent[]> =>
  (await readFile(join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RlmEvent);

const program = (overrides: Partial<RlmProgram> = {}): RlmProgram => {
  const base = normalizeProgram({
    objective: overrides.objective ?? "test",
    profile: "default",
    inputs: [{ name: "context", adapter: "text", description: "corpus" }],
    outputs: overrides.outputs ?? [{ name: "answer", schema: { type: "string" } }],
  });
  if (!base.ok) throw new Error("bad program");
  return base.value;
};

describe("runProgram e2e", () => {
  test("map/reduce with llm.batch, workspace, and typed answer", async () => {
    const model = new MockModelClient((req) => (req.prompt.includes("count") ? JSON.stringify({ n: 1 }) : "ok"), modelIdentity("src/runtime/run.e2e.test.ts:41"));
    const controller = new MockController([
      {
        reasoning: "chunk, classify, reduce",
        code: `
          phase('classify');
          const chunks = await input.chunks({ targetTokens: 50, maxChunks: 10 });
          const mapped = await llm.batch({
            key: 'classify',
            items: chunks.map((c) => ({
              key: 'c:' + c.sha256,
              prompt: 'count categories',
              context: c,
              schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
            })),
          });
          let total = 0;
          for (const r of mapped) if (r.ok) total += r.value.n;
          workspace.total = total;
          answer({ total });
          'done'`,
      },
    ]);
    const dir = await tmp();
    const result = await runProgram({
      program: program({ objective: "count", outputs: [{ name: "total", schema: { type: "integer" } }] }),
      sources: { context: "0".repeat(200) + "1".repeat(200) + "2".repeat(100) },
      controller,
      model,
      backend,
      dir,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.runId).toMatch(/^run_[0-9a-f]{64}$/);
    expect(result.completionMode).toBe("answer");
    expect(result.answer).toEqual({ total: 3 });
    expect(model.callCount).toBe(3);
    expect(result.ledger.usage.logicalCalls).toBe(3);

    const events = await journalEvents(dir);
    const started = events.find((event) => event.type === "run_started");
    const workspace = events.find((event) => event.type === "workspace_committed");
    const calls = events.filter((event) => event.type === "call_committed");
    const answer = events.find((event) => event.type === "answer_committed");
    expect(started?.type === "run_started" && started.inputRefs).toHaveLength(1);
    expect(workspace?.type === "workspace_committed" && workspace.workspaceRef).toMatch(/^ctx_[0-9a-f]{64}$/);
    expect(calls).toHaveLength(3);
    expect(calls.every((event) => event.type === "call_committed" && /^ctx_[0-9a-f]{64}$/.test(event.outputRef ?? ""))).toBe(true);
    expect(answer?.type === "answer_committed" && answer.outputRef).toMatch(/^ctx_[0-9a-f]{64}$/);

    const references = [
      ...(started?.type === "run_started" ? started.inputRefs ?? [] : []),
      ...(workspace?.type === "workspace_committed" ? [{
        id: workspace.workspaceRef, sha256: workspace.workspaceSha256, bytes: workspace.workspaceBytes,
      }] : []),
      ...calls.flatMap((event) => event.type === "call_committed" && event.outputRef && event.outputSha256
        ? [{ id: event.outputRef, sha256: event.outputSha256, bytes: event.outputBytes! }]
        : []),
      ...(answer?.type === "answer_committed" ? [{
        id: answer.outputRef, sha256: answer.outputSha256!, bytes: answer.outputBytes!,
      }] : []),
    ];
    const restarted = new ContextStore(dir);
    for (const reference of references) {
      expect(reference.id).toBe(`ctx_${reference.sha256}`);
      expect((await restarted.loadFromDisk(reference)).length).toBe(reference.bytes);
    }
  });

  test("recurse opens a child frame whose answer flows back to the parent", async () => {
    const model = new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:81"));
    const controller = new MockController(
      [
        {
          reasoning: "delegate then answer",
          code: `
            const r = await recurse({ key: 'k', objective: 'sub-objective', context: input });
            answer({ answer: r.ok ? r.value : 'child-failed' });
            'root-done'`,
        },
      ],
      () => new MockController([{ reasoning: "child", code: "answer('child-result'); 'child-done'" }]), controllerIdentity("src/runtime/run.e2e.test.ts:82")
    );
    const result = await runProgram({
      program: program({ objective: "parent" }),
      sources: { context: "hello" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "child-result" });
    expect(result.ledger.usage.framesOpened).toBe(1);
  });

  test("parent cell cancellation detaches a delayed child controller without late mutations", async () => {
    let markChildStarted!: () => void;
    let releaseChild!: () => void;
    let markChildSettled!: () => void;
    const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve; });
    const childRelease = new Promise<void>((resolve) => { releaseChild = resolve; });
    const childSettled = new Promise<void>((resolve) => { markChildSettled = resolve; });

    class DelayedChildController implements ControllerDriver {
  readonly identity = { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run.e2e.test.ts:109" } } as const;
      calls = 0;
      aborted = false;

      async next(_state: FrameState, signal?: AbortSignal): Promise<Cell> {
        this.calls += 1;
        signal?.addEventListener("abort", () => { this.aborted = true; }, { once: true });
        markChildStarted();
        await childRelease;
        markChildSettled();
        return { reasoning: "late child cell", code: "1" };
      }

      fork(): ControllerDriver {
        return new DelayedChildController();
      }
    }

    class CancellingBackend implements InterpreterBackend {
      readonly id = "cancelling-test-backend";
      readonly version = "1";

      async evalCell(options: CellEvalOptions): Promise<CellEvalOutcome> {
        const cellEpoch = new AbortController();
        const recurse = options.dispatch(
          "recurse",
          { key: "slow", objective: "slow child" },
          cellEpoch.signal,
          options.deadlineMs,
        );
        await childStarted;
        cellEpoch.abort();
        void recurse.catch(() => {});
        return { kind: "terminal", error: interpreterError("CPU_LIMIT", "cell deadline reached") };
      }

      async dispose(): Promise<void> {}
    }

    const observedControllerTurns: number[] = [];
    const child = new DelayedChildController();
    const controller = new MockController(
      [{
        reasoning: "delegate",
        code: "await recurse({ key: 'slow', objective: 'slow child', context: input }); 'done'",
      }],
      () => child, controllerIdentity("src/runtime/run.e2e.test.ts:129")
    );
    const dir = await tmp();
    const owner = new AbortController();
    const unregisterObserver = registerControllerTurnObserverForTest(owner.signal, (controllerTurns) => {
      observedControllerTurns.push(controllerTurns);
      throw new Error("observer failure must be isolated");
    });
    try {
      const result = await runProgram({
        program: program({ objective: "cancel child" }),
        sources: { context: "hello" },
        controller,
        model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:deterministic-cancellation")),
        backend: new CancellingBackend(),
        dir,
        signal: owner.signal,
      });

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("CPU_LIMIT");
      expect(child.aborted).toBe(true);
      expect(child.calls).toBe(1);
      expect(result.ledger.usage.controllerTurns).toBe(2);
      const eventsAtFinalization = await readFile(join(dir, "events.jsonl"), "utf8");
      const observedCountAtFinalization = observedControllerTurns.length;
      const observedTurnsAtFinalization = observedControllerTurns.at(-1);
      expect(observedCountAtFinalization).toBe(2);
      expect(observedTurnsAtFinalization).toBe(2);

      releaseChild();
      await childSettled;
      await Promise.resolve();
      expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(eventsAtFinalization);
      expect(observedControllerTurns).toHaveLength(observedCountAtFinalization);
      expect(observedControllerTurns.at(-1)).toBe(observedTurnsAtFinalization);
      expect(child.calls).toBe(1);
    } finally {
      releaseChild();
      unregisterObserver();
    }
  }, 5_000);

  test("duplicate llm keys coalesce to one model call (cache)", async () => {
    let n = 0;
    const model = new MockModelClient(() => `r${++n}`, modelIdentity("src/runtime/run.e2e.test.ts:166"));
    const controller = new MockController([
      {
        reasoning: "call twice same key",
        code: `
          const a = await llm({ key: 'k', prompt: 'p' });
          const b = await llm({ key: 'k', prompt: 'p' });
          answer({ answer: a.value === b.value ? 'same' : 'diff' });
          'x'`,
      },
    ]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.answer).toEqual({ answer: "same" });
    expect(model.callCount).toBe(1);
  });

  test("turn exhaustion triggers fallback extraction", async () => {
    const model = new MockModelClient(() => "ok", modelIdentity("src/runtime/run.e2e.test.ts:191"));
    const controller = new MockController([
      { reasoning: "noop 1", code: "workspace.a = (workspace.a ?? 0) + 1; workspace.a" },
      { reasoning: "noop 2", code: "workspace.a = (workspace.a ?? 0) + 1; workspace.a" },
    ]);
    const extractor = new FunctionExtractor((evidence) => ({
      ok: true,
      value: { answer: `fallback:${JSON.stringify(evidence.workspaceValues)}` },
      evidenceRefs: [evidence.workspaceValues[0]!.evidenceId!],
    }), "external", extractorIdentity("src/runtime/run.e2e.test.ts:196"));
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 2 },
      extractor,
    });
    expect(result.status).toBe("completed");
    expect(result.completionMode).toBe("fallback_extract");
    expect((result.answer as { answer: string }).answer).toContain("fallback");
  });

  test("exhaustion without an extractor fails with NO_ANSWER", async () => {
    const model = new MockModelClient(() => "ok", modelIdentity("src/runtime/run.e2e.test.ts:218"));
    const controller = new MockController([{ reasoning: "noop", code: "1 + 1" }]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 1 },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("NO_ANSWER");
  });

  test("budget exhaustion returns a catchable CallResult, not a throw", async () => {
    const model = new MockModelClient(() => "ok", modelIdentity("src/runtime/run.e2e.test.ts:235"));
    const controller = new MockController([
      {
        reasoning: "two distinct calls under a 1-call budget",
        code: `
          const a = await llm({ key: 'k1', prompt: 'one' });
          const b = await llm({ key: 'k2', prompt: 'two' });
          answer({ answer: (a.ok ? 'ok' : 'a?') + ':' + (b.ok ? 'ok' : b.error.code) });
          'x'`,
      },
    ]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxLogicalCalls: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "ok:BUDGET_CALLS" });
    expect(model.callCount).toBe(1);
  });

  test("invalid answer is recoverable; the controller corrects on the next turn", async () => {
    const model = new MockModelClient(() => "ok", modelIdentity("src/runtime/run.e2e.test.ts:262"));
    const controller = new MockController([
      { reasoning: "wrong shape", code: "answer({ wrong: 1 }); 'first'" },
      { reasoning: "corrected", code: "answer({ answer: 'fixed' }); 'second'" },
    ]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "fixed" });
  });

  test("zero answer effects remain exploratory and one snapshotted answer commits", async () => {
    const controller = new MockController([
      { reasoning: "explore", code: "workspace.step = 'explored'; 'zero'" },
      {
        reasoning: "answer once",
        code: "const submitted = { answer: 'first' }; answer(submitted); submitted.answer = 'mutated'; 'one'",
      },
    ]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "c" }, controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:291")), backend, dir,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "first" });
    const events = await journalEvents(dir);
    const cells = events.filter((event) => event.type === "cell_committed");
    expect(cells).toHaveLength(2);
    expect(cells[0]?.error).toBeUndefined();
    expect(events.filter((event) => event.type === "answer_committed")).toHaveLength(1);
  });

  test("same, conflicting, multiple, and undefined submissions reject deterministically then recover", async () => {
    const cases = [
      {
        name: "same",
        code: "answer({ answer: 'same' }); answer({ answer: 'same' }); 'duplicate'",
        message: "cell submitted 2 answer effects; exactly one is allowed",
      },
      {
        name: "conflicting",
        code: "answer({ answer: 'first' }); answer({ answer: 'second' }); 'conflict'",
        message: "cell submitted 2 answer effects; exactly one is allowed",
      },
      {
        name: "multiple",
        code: "answer({ answer: 'one' }); answer({ answer: 'two' }); answer({ answer: 'three' }); 'many'",
        message: "cell submitted 3 answer effects; exactly one is allowed",
      },
      {
        name: "undefined",
        code: "answer(undefined); 'missing'",
        message: "answer value must be strict JSON",
      },
    ];

    for (const entry of cases) {
      const seen: FrameState[] = [];
      const cells: Cell[] = [
        { reasoning: entry.name, code: entry.code },
        { reasoning: "recover", code: `answer({ answer: '${entry.name}:fixed' }); 'recovered'` },
      ];
      let index = 0;
      const controller: ControllerDriver = {
        identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run.e2e.test.ts:335" } },
        async next(state) {
          seen.push(state);
          return cells[index++] as Cell;
        },
        fork() { return this; },
      };
      const dir = await tmp();
      const result = await runProgram({
        program: program(), sources: { context: "c" }, controller,
        model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:345")), backend, dir,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      expect(result.answer).toEqual({ answer: `${entry.name}:fixed` });
      expect(seen[1]?.trajectory.entries.at(-1)?.error?.code).toBe("INVALID_RESULT");
      expect(seen[1]?.trajectory.entries.at(-1)?.error?.message).toBe(entry.message);
      const events = await journalEvents(dir);
      const committedCells = events.filter((event) => event.type === "cell_committed");
      expect(committedCells[0]?.error).toEqual({ code: "INVALID_RESULT", message: entry.message });
      expect(committedCells[0]?.outputRef).toBeUndefined();
      expect(events.filter((event) => event.type === "answer_committed")).toHaveLength(1);
    }
  });

  test("forged and unsafe answer snapshots persist nothing and recover on the next cell", async () => {
    const cases = [
      {
        name: "forged-undefined",
        code: `JSON.stringify = () => '{"value":{"answer":"forged"}}'; JSON.parse = () => ({ value: { answer: "forged" } }); answer(undefined); 'invalid'`,
      },
      {
        name: "cycle",
        code: "const value = { answer: 'cycle' }; value.self = value; answer(value); 'invalid'",
      },
      {
        name: "accessor",
        code: `const value = {}; Object.defineProperty(value, "answer", { enumerable: true, get() { while (true) {} } }); answer(value); 'invalid'`,
      },
      {
        name: "proxy",
        code: `const value = new Proxy({}, { ownKeys() { while (true) {} } }); answer(value); 'invalid'`,
      },
    ];

    for (const entry of cases) {
      const seen: FrameState[] = [];
      const cells: Cell[] = [
        { reasoning: entry.name, code: entry.code },
        { reasoning: "recover", code: `answer({ answer: '${entry.name}:fixed' }); 'recovered'` },
      ];
      let index = 0;
      const controller: ControllerDriver = {
        identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run.e2e.test.ts:388" } },
        async next(state) { seen.push(state); return cells[index++] as Cell; },
        fork() { return this; },
      };
      const dir = await tmp();
      const result = await runProgram({
        program: program(), sources: { context: "c" }, controller,
        model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:395")), backend, dir,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      expect(result.answer).toEqual({ answer: `${entry.name}:fixed` });
      expect(seen[1]?.trajectory.entries.at(-1)?.error).toMatchObject({
        code: "INVALID_RESULT",
        message: "answer value must be strict JSON",
      });
      const events = await journalEvents(dir);
      const committedCells = events.filter((event) => event.type === "cell_committed");
      expect(committedCells[0]?.outputRef).toBeUndefined();
      expect(events.filter((event) => event.type === "answer_committed")).toHaveLength(1);
      expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(3);
    }
  });

  test("prototype-poisoned accessor descriptors remain invalid without running getters", async () => {
    const seen: FrameState[] = [];
    const cells: Cell[] = [
      {
        reasoning: "poison descriptor inspection",
        code: `
          let getterCount = 0;
          const value = {};
          Object.defineProperty(value, "answer", {
            enumerable: true,
            get() { getterCount += 100; return "forged"; },
          });
          Object.defineProperty(Object.prototype, "value", {
            configurable: true,
            get() { getterCount += 1; return "forged"; },
          });
          Object.prototype.hasOwnProperty = () => true;
          Function.prototype.call = () => true;
          answer(value);
          emit({ message: String(getterCount) });
          'invalid'`,
      },
      { reasoning: "recover", code: "answer({ answer: 'fixed' }); 'recovered'" },
    ];
    let index = 0;
    const controller: ControllerDriver = {
      identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run.e2e.test.ts:438" } },
      async next(state) { seen.push(state); return cells[index++] as Cell; },
      fork() { return this; },
    };
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "c" }, controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:445")), backend, dir,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "fixed" });
    expect(seen[1]?.trajectory.entries.at(-1)?.error).toMatchObject({
      code: "INVALID_RESULT",
      message: "answer value must be strict JSON",
    });
    const events = await journalEvents(dir);
    const committedCells = events.filter((event) => event.type === "cell_committed");
    expect(events.find((event) => event.type === "emit")).toBeUndefined();
    expect(committedCells[0]?.outputRef).toBeUndefined();
    expect(events.filter((event) => event.type === "answer_committed")).toHaveLength(1);
    expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(3);
  });

  test("a thrown cell discards its earlier answer effect before recovery", async () => {
    const dir = await tmp();
    const controller = new MockController([
      { reasoning: "answer then throw", code: "answer({ answer: 'discarded' }); throw new Error('after answer')" },
      { reasoning: "recover", code: "answer({ answer: 'kept' }); 'done'" },
    ]);
    const result = await runProgram({
      program: program(), sources: { context: "c" }, controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:471")), backend, dir,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "kept" });
    const events = await journalEvents(dir);
    const cells = events.filter((event) => event.type === "cell_committed");
    expect(cells[0]?.error).toMatchObject({ code: "FAILED" });
    expect(cells[0]?.outputRef).toBeUndefined();
    expect(events.filter((event) => event.type === "answer_committed")).toHaveLength(1);
  });

  test("answer output-byte denial persists nothing and is recoverable", async () => {
    const dir = await tmp();
    const seen: FrameState[] = [];
    const cells: Cell[] = [
      { reasoning: "too large", code: "answer({ answer: 'x'.repeat(50) }); 'large'" },
      { reasoning: "fit remaining bytes", code: "answer({ answer: 'ok' }); 'small'" },
    ];
    let index = 0;
    const controller: ControllerDriver = {
      identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run.e2e.test.ts:492" } },
      async next(state) { seen.push(state); return cells[index++] as Cell; },
      fork() { return this; },
    };
    const result = await runProgram({
      program: program(), sources: { context: "c" }, controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:498")), backend, dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, storedByteLimit: 20 },
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "ok" });
    expect(result.ledger.usage.storedBytes).toBe(
      1 + Buffer.byteLength(JSON.stringify({})) + Buffer.byteLength(JSON.stringify({ answer: "ok" })),
    );
    expect(seen[1]?.trajectory.entries.at(-1)?.error).toMatchObject({ code: "BUDGET_BYTES" });
    const events = await journalEvents(dir);
    const cellsCommitted = events.filter((event) => event.type === "cell_committed");
    expect(cellsCommitted[0]?.error).toEqual({
      code: "BUDGET_BYTES",
      message: "answer output exceeds remaining stored-byte budget",
    });
    expect(cellsCommitted[0]?.outputRef).toBeUndefined();
    expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(3);
  });

  test("inherited output values do not satisfy the answer contract", async () => {
    const model = new MockModelClient(() => "ok", modelIdentity("src/runtime/run.e2e.test.ts:518"));
    const controller = new MockController([
      { reasoning: "missing own value", code: "answer({}); 'first'" },
      { reasoning: "own value", code: "answer({ toString: 'fixed' }); 'second'" },
    ]);
    const result = await runProgram({
      program: program({ outputs: [{ name: "toString", schema: { type: "string" } }] }),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ toString: "fixed" });
  });

  test("context limit and unsupported syntax errors are typed and guest-catchable", async () => {
    const model = new MockModelClient(() => "ok", modelIdentity("src/runtime/run.e2e.test.ts:537"));
    const controller = new MockController([{
      reasoning: "recover from invalid context options",
      code: `
        const codes = [];
        try { await input.grep({ pattern: '(a+)+$', syntax: 're2', maxMatches: 1 }); }
        catch (error) { codes.push(error.code); }
        try { await input.grep({ pattern: 'a', maxMatches: Infinity }); }
        catch (error) { codes.push(error.code); }
        answer({ answer: codes.join(',') });`,
    }]);
    const result = await runProgram({
      program: program(),
      sources: { context: `${"a".repeat(100_000)}!` },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "INVALID_SPEC,INVALID_SPEC" });
  });

  test("changed llm and batch-child identities fail before provider spend", async () => {
    const model = new MockModelClient(() => "only-result", modelIdentity("src/runtime/run.e2e.test.ts:562"));
    const controller = new MockController([
      {
        reasoning: "establish identity",
        code: "workspace.first = await llm({ key: 'owned', prompt: 'first' }); 'bound'",
      },
      {
        reasoning: "reject changed identities",
        code: `
          const codes = [];
          try { await llm({ key: 'owned', prompt: 'changed' }); }
          catch (error) { codes.push(error.code); }
          try {
            await llm.batch({
              key: 'group',
              items: [
                { key: 'unlaunched', prompt: 'must not launch' },
                { key: 'owned', prompt: 'also changed' },
              ],
            });
          } catch (error) { codes.push(error.code); }
          answer({ answer: codes.join(',') });`,
      },
    ]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.answer).toEqual({ answer: "KEY_IDENTITY_CHANGED,KEY_IDENTITY_CHANGED" });
    expect(model.callCount).toBe(1);
    expect(result.ledger.usage.logicalCalls).toBe(1);
  });

  test("concurrent and batch duplicate llm identities coalesce", async () => {
    const model = new MockModelClient(() => "shared", modelIdentity("src/runtime/run.e2e.test.ts:601"));
    const controller = new MockController([{
      reasoning: "coalesce duplicates",
      code: `
        const concurrent = await Promise.all([
          llm({ key: 'concurrent', prompt: 'same' }),
          llm({ key: 'concurrent', prompt: 'same' }),
        ]);
        const batch = await llm.batch({
          key: 'group',
          items: [
            { key: 'batch-child', prompt: 'same child' },
            { key: 'batch-child', prompt: 'same child' },
          ],
        });
        answer({ answer: [concurrent[0].callId === concurrent[1].callId, batch[0].callId === batch[1].callId].join(',') });`,
    }]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.answer).toEqual({ answer: "true,true" });
    expect(model.callCount).toBe(2);
    expect(result.ledger.usage.logicalCalls).toBe(2);
  });

  test("recurse keys reuse one child and reject changed identity", async () => {
    const controller = new MockController(
      [{
        reasoning: "reuse child",
        code: `
          const [a, b] = await Promise.all([
            recurse({ key: 'child', objective: 'same', context: input }),
            recurse({ key: 'child', objective: 'same', context: input }),
          ]);
          let code = 'none';
          try { await recurse({ key: 'child', objective: 'changed', context: input }); }
          catch (error) { code = error.code; }
          answer({ answer: (a.callId === b.callId) + ':' + code });`,
      }],
      () => new MockController([{ reasoning: "child", code: "answer('child-result')" }]), controllerIdentity("src/runtime/run.e2e.test.ts:633")
    );
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:652")),
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.answer).toEqual({ answer: "true:KEY_IDENTITY_CHANGED" });
    expect(result.ledger.usage.framesOpened).toBe(1);
    expect(result.ledger.usage.logicalCalls).toBe(1);
  });

  test("invalid recurse context leaves its key reusable without opening a frame", async () => {
    const controller = new MockController(
      [{
        reasoning: "validate child inputs first",
        code: `
          let code = 'none';
          try { await recurse({ key: 'child-ref', objective: 'same', context: { id: 'missing' } }); }
          catch (error) { code = error.code; }
          const child = await recurse({ key: 'child-ref', objective: 'same', context: input });
          answer({ answer: code + ':' + child.value });`,
      }],
      () => new MockController([{ reasoning: "child", code: "answer('child-ok')" }]), controllerIdentity("src/runtime/run.e2e.test.ts:663")
    );
    const dir = await tmp();
    const result = await runProgram({
      program: program(),
      sources: { context: "valid" },
      controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:680")),
      backend,
      dir,
      signal: new AbortController().signal,
    });
    expect(result.answer).toEqual({ answer: "INVALID_STATE:child-ok" });
    expect(result.ledger.usage.framesOpened).toBe(1);
    expect(result.ledger.usage.logicalCalls).toBe(1);
    const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; kind?: string; key?: string });
    expect(events.filter((event) => event.type === "key_bound" && event.kind === "recurse" && event.key === "child-ref")).toHaveLength(1);
  });

  test("context and artifact keys reuse equal identities and reject changes", async () => {
    const controller = new MockController([{
      reasoning: "check keyed producers",
      code: `
        const codes = [];
        const d1 = await contexts.derive({ key: 'derive', value: { b: 2, a: 1 } });
        const d2 = await contexts.derive({ key: 'derive', value: { a: 1, b: 2 } });
        try { await contexts.derive({ key: 'derive', value: { a: 2 } }); }
        catch (error) { codes.push(error.code); }
        const c1 = await contexts.concat({ key: 'concat', refs: [input], separator: '' });
        const c2 = await contexts.concat({ key: 'concat', refs: [input], separator: '' });
        try { await contexts.concat({ key: 'concat', refs: [input, input], separator: '' }); }
        catch (error) { codes.push(error.code); }
        const a1 = await artifacts.write({ key: 'artifact', name: 'data.json', value: { b: 2, a: 1 } });
        const a2 = await artifacts.write({ key: 'artifact', name: 'data.json', value: { a: 1, b: 2 } });
        try { await artifacts.write({ key: 'artifact', name: 'data.json', value: { a: 2 } }); }
        catch (error) { codes.push(error.code); }
        answer({ answer: [d1.id === d2.id, c1.id === c2.id, a1.id === a2.id, ...codes].join(',') });`,
    }]);
    const result = await runProgram({
      program: program(),
      sources: { context: "source" },
      controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:715")),
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
    });
    expect(result.answer).toEqual({
      answer: "true,true,true,KEY_IDENTITY_CHANGED,KEY_IDENTITY_CHANGED,KEY_IDENTITY_CHANGED",
    });
  });

  test("denied context producers leave ledger, entries, and files unchanged", async () => {
    const dir = await tmp();
    const model = new MockModelClient(() => "ok", modelIdentity("src/runtime/run.e2e.test.ts:727"));
    const controller = new MockController([{
      reasoning: "exercise tiny stored-byte budget",
      code: `
        const codes = [];
        for (let i = 0; i < 2; i++) {
          try { await contexts.derive({ key: 'denied', value: 'x'.repeat(67) }); }
          catch (error) { codes.push(error.code); }
        }
        try { await contexts.concat({ key: 'concat', refs: [input, input], separator: '' }); }
        catch (error) { codes.push(error.code); }
        try { await input.chunks({ targetTokens: 20, maxChunks: 2 }); }
        catch (error) { codes.push(error.code); }
        answer({ answer: codes.join(',') });`,
    }]);
    const result = await runProgram({
      program: program(),
      sources: { context: "x".repeat(100) },
      controller,
      model,
      backend,
      dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, storedByteLimit: 166 },
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({
      answer: "BUDGET_BYTES,BUDGET_BYTES,BUDGET_BYTES,BUDGET_BYTES",
    });
    expect(result.ledger.usage.storedBytes).toBe(166);
    expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(3);
  });

  test("oversized initial sources fail before payload state or files commit", async () => {
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "xx" },
      controller: new MockController([{ reasoning: "must not run", code: "answer({ answer: 'bad' })" }]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:765")), backend, dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, storedByteLimit: 1 },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BUDGET_BYTES");
    expect(result.ledger.usage.storedBytes).toBe(0);
    expect(await readdir(dir)).not.toContain("contexts");
    expect((await journalEvents(dir)).some((event) => event.type === "run_started")).toBe(false);
  });

  test("denied artifacts stay denied on retry and concurrent producers dedupe exactly", async () => {
    const dir = await tmp();
    const controller = new MockController([{
      reasoning: "reserve every retained producer",
      code: `
        const denied = [];
        for (let i = 0; i < 2; i++) {
          try { await artifacts.write({ key: 'denied', name: 'large', value: 'x'.repeat(27) }); }
          catch (error) { denied.push(error.code); }
        }
        const [d1, d2] = await Promise.all([
          contexts.derive({ key: 'd1', value: 'same' }),
          contexts.derive({ key: 'd2', value: 'same' }),
        ]);
        const [a1, a2] = await Promise.all([
          artifacts.write({ key: 'a1', name: 'one', value: 'same' }),
          artifacts.write({ key: 'a2', name: 'two', value: 'same' }),
        ]);
        answer({ answer: denied.join(',') === 'BUDGET_BYTES,BUDGET_BYTES' && d1.id === d2.id && a1.id === a2.id ? 'ok' : 'bad' });`,
    }]);
    const result = await runProgram({
      program: program(), sources: { context: "s" }, controller,
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:798")), backend, dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, storedByteLimit: 26 },
    });
    expect(result.answer).toEqual({ answer: "ok" });
    expect(result.ledger.usage.storedBytes).toBe(26); // source 1 + context 4 + artifact 4 + workspace 2 + answer 15
    expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(4);
  });

  test("fallback answers use the same denied transaction without residue", async () => {
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "x" }, controller: new MockController([]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/run.e2e.test.ts:811")), backend, dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0, storedByteLimit: 1 },
      extractor: new FunctionExtractor((evidence) => ({
        ok: true,
        value: { answer: "oversized" },
        evidenceRefs: [evidence.handles[0]!.evidenceId!],
      }), "external", extractorIdentity("src/runtime/run.e2e.test.ts:814")),
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BUDGET_BYTES");
    expect(result.ledger.usage.storedBytes).toBe(1);
    expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
    expect((await journalEvents(dir)).some((event) => event.type === "answer_committed")).toBe(false);
  });
});
