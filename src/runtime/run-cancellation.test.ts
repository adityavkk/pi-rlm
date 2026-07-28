import { mkdtemp, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { reduceStatus, type RlmEvent } from "../core/journal.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import type { CellEvalOptions, CellEvalOutcome, InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalStore, type JournalFileHandle, type JournalFileSystem } from "../shell/journal-store.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../shell/model/client.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";
import { FunctionExtractor } from "./extractor.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { inspectRecoveredRun } from "./run-recovery.ts";
import { runProgram, type RunResult } from "./run.ts";

const extractorIdentity = (fixture: string) => ({
  closure: { id: "test/extractor-closure", version: "1", configuration: { fixture } },
  configuration: { fixture },
  modelRoute: "test/model",
  providerPrompt: { id: "test/extractor-prompt", version: "1", configuration: { fixture } },
} as const);

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-cancel-"));
const within = async <T>(work: Promise<T>, ms = 400): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`run exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const program = (withInput = false): RlmProgram => {
  const normalized = normalizeProgram({
    objective: "root",
    profile: "default",
    inputs: withInput ? [{ name: "context", adapter: "text", description: "source" }] : [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid test program");
  return normalized.value;
};

class OneCellController implements ControllerDriver {
  readonly identity = { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run-cancellation.test.ts:42" } } as const;
  constructor(
    private readonly cell: Cell = { reasoning: "run", code: "1" },
    private readonly child?: ControllerDriver,
  ) {}
  async next(): Promise<Cell> {
    return this.cell;
  }
  fork(): ControllerDriver {
    return this.child ?? this;
  }
}

class FunctionBackend implements InterpreterBackend {
  readonly id = "test-backend";
  readonly version = "1";
  constructor(private readonly fn: (options: CellEvalOptions) => Promise<CellEvalOutcome>) {}
  evalCell(options: CellEvalOptions): Promise<CellEvalOutcome> {
    return this.fn(options);
  }
  async dispose(): Promise<void> {}
}

const unusedModel: ModelClient = {
  identity: { id: "test/model-client", version: "1", configuration: { fixture: "src/runtime/run-cancellation.test.ts:65" } },
  id: "unused",
  async complete(): Promise<ModelResponse> {
    throw new Error("unexpected model call");
  },
};

const valueOutcome = (): CellEvalOutcome => ({
  kind: "value",
  result: null,
  hasResult: true,
  workspace: {},
  workspaceInvalidPaths: [],
});

const events = async (dir: string): Promise<RlmEvent[]> =>
  (await readFile(join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RlmEvent);

type TerminalStatusFault = "status write" | "status sync" | "status close" | "status rename" | "directory sync";

const terminalStatusFaultFileSystem = (root: string, fault: TerminalStatusFault): JournalFileSystem => {
  const eventsPath = join(root, "events.jsonl");
  const statusTmpPath = join(root, "status.json.tmp");
  const maybeFail = (operation: TerminalStatusFault): void => {
    if (operation === fault) throw new Error(`injected ${operation} failure`);
  };
  const wrap = (path: string, handle: JournalFileHandle): JournalFileHandle => ({
    appendFile: (data, encoding) => handle.appendFile(data, encoding),
    readFile: () => handle.readFile(),
    truncate: (length) => handle.truncate(length),
    writeFile: async (data, encoding) => {
      if (path === statusTmpPath) maybeFail("status write");
      await handle.writeFile(data, encoding);
    },
    sync: async () => {
      if (path === statusTmpPath) maybeFail("status sync");
      if (path === root) maybeFail("directory sync");
      await handle.sync();
    },
    close: async () => {
      await handle.close();
      if (path === statusTmpPath) maybeFail("status close");
    },
  });
  return {
    open: async (path, flags) => wrap(path, await open(path, flags)),
    readFile: async (path) => readFile(path),
    rename: async (oldPath, newPath) => {
      if (oldPath === statusTmpPath) maybeFail("status rename");
      await rename(oldPath, newPath);
    },
  };
};

const expectSingleTerminal = async (dir: string, result: RunResult): Promise<void> => {
  const journalEvents = await events(dir);
  expect(journalEvents.filter((event) =>
    event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled")).toHaveLength(1);
  const status = await new JournalStore(dir).status();
  expect(status.ok).toBe(true);
  if (status.ok) expect(status.value.state).toBe(result.status);
  expect(Object.values(status.ok ? status.value.frames : {}).every((frame) => frame.state !== "open")).toBe(true);
};

describe("run cancellation and terminal finalization", () => {
  test("abort before authoritative start leaves an orphan and schedules nothing", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    owner.abort();
    let calls = 0;
    const controller: ControllerDriver = {
      identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run-cancellation.test.ts:139" } },
      async next(): Promise<Cell> { calls += 1; return { reasoning: "late", code: "1" }; },
      fork() { return this; },
    };
    const result = await within(runProgram({
      program: program(), sources: {}, controller, model: unusedModel,
      backend: new FunctionBackend(async () => valueOutcome()), dir, signal: owner.signal,
    }));
    expect(result.status).toBe("cancelled");
    expect(calls).toBe(0);
    expect(await readdir(dir)).not.toContain("events.jsonl");
  });

  test("abort bounds an abort-ignoring controller", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const controller: ControllerDriver = {
      identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run-cancellation.test.ts:157" } },
      async next(_state: FrameState): Promise<Cell> {
        started();
        await new Promise(() => {});
        return { reasoning: "late", code: "1" };
      },
      fork() { return this; },
    };
    const run = runProgram({
      program: program(), sources: {}, controller, model: unusedModel,
      backend: new FunctionBackend(async () => valueOutcome()), dir, signal: owner.signal,
    });
    await pending;
    owner.abort();
    const result = await within(run);
    expect(result.status).toBe("cancelled");
    await expectSingleTerminal(dir, result);
  });

  test("abort retains unresolved model capacity and drops an abort-ignoring late result", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    let markStarted!: () => void;
    let resolveLate!: (response: ModelResponse) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const model: ModelClient = {
      identity: { id: "test/model-client", version: "1", configuration: { fixture: "src/runtime/run-cancellation.test.ts:183" } },
      id: "late-model",
      complete(request: ModelRequest): Promise<ModelResponse> {
        calls += 1;
        expect(request.signal).toBeDefined();
        markStarted();
        return new Promise((resolve) => { resolveLate = resolve; });
      },
    };
    const backend = new FunctionBackend(async (options) => {
      await Promise.all([
        options.dispatch("llm", { key: "one", prompt: "one" }, options.signal!, options.deadlineMs),
        options.dispatch("llm", { key: "two", prompt: "two" }, options.signal!, options.deadlineMs),
      ]);
      return valueOutcome();
    });
    const run = runProgram({
      program: program(), sources: {}, controller: new OneCellController(), model, backend, dir,
      signal: owner.signal, profile: { ...DEFAULT_PROFILE, maxConcurrency: 1 },
    });
    await started;
    owner.abort();
    const result = await within(run);
    expect(result.status).toBe("cancelled");
    expect(calls).toBe(1);
    expect(result.ledger.usage.logicalCalls).toBe(1);
    expect(result.ledger.usage.attempts).toBe(1);
    expect(result.ledger.usage.activeLeafCalls).toBe(1);
    expect(result.ledger.usage.tokensReserved).toBeGreaterThan(0);
    const operationEvents = await events(dir);
    expect(operationEvents.filter((event) => event.type === "operation_intended")).toHaveLength(1);
    expect(operationEvents.filter((event) => event.type === "operation_settled")).toHaveLength(0);
    await expect(inspectRecoveredRun(dir)).rejects.toMatchObject({ code: "RECOVERY_AMBIGUOUS" });
    const before = await readFile(join(dir, "events.jsonl"), "utf8");
    const ledgerBefore = JSON.stringify(result.ledger);
    resolveLate({ text: "late", usage: ZERO_CALL_USAGE });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(before);
    expect(JSON.stringify(result.ledger)).toBe(ledgerBefore);
    await expectSingleTerminal(dir, result);
  });

  test("abort retains unresolved external-extractor capacity until its ignored work terminates", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    let markStarted!: () => void;
    let releaseLate!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const extractor = new FunctionExtractor(async (evidence) => {
      markStarted();
      await new Promise<void>((resolve) => { releaseLate = resolve; });
      return { ok: true, value: { answer: "late" }, evidenceRefs: [evidence.handles[0]!.evidenceId!] };
    }, "external", extractorIdentity("noncooperative-external"));
    const run = runProgram({
      program: program(true), sources: { context: "evidence" }, controller: new OneCellController(), model: unusedModel,
      backend: new FunctionBackend(async () => valueOutcome()), dir, signal: owner.signal, extractor,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
    });
    await started;
    owner.abort();
    const result = await within(run);
    expect(result.status).toBe("cancelled");
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, activeLeafCalls: 1, tokensReserved: 0 });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "operation_intended")).toHaveLength(1);
    expect(journal.filter((event) => event.type === "operation_settled")).toHaveLength(0);
    await expect(inspectRecoveredRun(dir)).rejects.toMatchObject({ code: "RECOVERY_AMBIGUOUS" });
    const before = await readFile(join(dir, "events.jsonl"), "utf8");
    releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(before);
  });

  test("abort closes a pending recursive frame in child-first order", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    let childStarted!: () => void;
    const pending = new Promise<void>((resolve) => { childStarted = resolve; });
    const child: ControllerDriver = {
      identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run-cancellation.test.ts:226" } },
      async next(): Promise<Cell> { childStarted(); await new Promise(() => {}); return { reasoning: "late", code: "1" }; },
      fork() { return this; },
    };
    const backend = new FunctionBackend(async (options) => {
      await options.dispatch("recurse", { key: "child", objective: "child" }, options.signal!, options.deadlineMs);
      return valueOutcome();
    });
    const run = runProgram({
      program: program(), sources: {}, controller: new OneCellController({ reasoning: "recurse", code: "1" }, child),
      model: unusedModel, backend, dir, signal: owner.signal,
    });
    await pending;
    owner.abort();
    const result = await within(run);
    const closed = (await events(dir)).filter((event) => event.type === "frame_closed");
    expect(closed).toHaveLength(2);
    expect(closed[0]?.frameId).not.toBe(`${result.runId}:f0`);
    expect(closed[1]?.frameId).toBe(`${result.runId}:f0`);
    expect(closed.every((event) => event.type === "frame_closed" && event.state === "cancelled")).toBe(true);
    await expectSingleTerminal(dir, result);
  });

  test("abort bounds extractor, interpreter, and context entry", async () => {
    for (const kind of ["extractor", "interpreter", "context"] as const) {
      const dir = await tmp();
      const owner = new AbortController();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const extractor = kind === "extractor"
        ? new FunctionExtractor(async () => { markStarted(); await new Promise(() => {}); return { ok: false, code: "FAILED", message: "late" }; }, "external", extractorIdentity("src/runtime/run-cancellation.test.ts:256"))
        : undefined;
      const backend = new FunctionBackend(async (options) => {
        if (kind === "interpreter") { markStarted(); await new Promise(() => {}); }
        if (kind === "context") {
          markStarted();
          owner.abort();
          const input = (options.globals.inputs as Record<string, { id: string }>)["context"]!;
          await options.dispatch("context.chunks", { id: input.id, options: { targetTokens: 1, maxChunks: 8 } }, options.signal!, options.deadlineMs);
        }
        return valueOutcome();
      });
      const run = runProgram({
        program: program(kind === "context" || kind === "extractor"),
        sources: kind === "context" || kind === "extractor" ? { context: "abcdefgh" } : {},
        controller: new OneCellController(), model: unusedModel, backend, dir, signal: owner.signal,
        ...(extractor ? { extractor, profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 } } : {}),
      });
      await started;
      if (!owner.signal.aborted) owner.abort();
      const result = await within(run);
      expect(result.status).toBe("cancelled");
      await expectSingleTerminal(dir, result);
    }
  });

  test("controller and extractor exceptions become typed failures without exposing messages", async () => {
    const cases: Array<{ expected: string; controller: ControllerDriver; extractor?: FunctionExtractor }> = [
      {
        expected: "CONTROLLER_FAILED",
        controller: {
          identity: { id: "test/throwing-controller", version: "1", configuration: { fixture: "controller-exception" } },
          async next() { throw new Error("secret-controller-detail"); }, fork() { return this; },
        },
      },
      {
        expected: "EXTRACTOR_FAILED",
        controller: new OneCellController(),
        extractor: new FunctionExtractor(async () => { throw new Error("secret-extractor-detail"); }, "external", extractorIdentity("src/runtime/run-cancellation.test.ts:291")),
      },
    ];
    for (const entry of cases) {
      const dir = await tmp();
      const result = await runProgram({
        program: program(entry.extractor !== undefined),
        sources: entry.extractor ? { context: "represented evidence" } : {}, controller: entry.controller, model: unusedModel,
        backend: new FunctionBackend(async () => valueOutcome()), dir, signal: new AbortController().signal,
        ...(entry.extractor ? { extractor: entry.extractor, profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 } } : {}),
      });
      expect(result.error?.code).toBe(entry.expected);
      expect(JSON.stringify(result)).not.toContain("secret-");
      await expectSingleTerminal(dir, result);
    }
  });

  test("cancellation after an answer effect discards the provisional submission", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    const backend = new FunctionBackend(async (options) => {
      options.effect("answer", { value: { answer: "must-not-commit" } });
      owner.abort();
      return valueOutcome();
    });
    const result = await within(runProgram({
      program: program(), sources: {}, controller: new OneCellController(), model: unusedModel,
      backend, dir, signal: owner.signal,
    }));

    expect(result.status).toBe("cancelled");
    expect(result.ledger.usage.storedBytes).toBe(0);
    expect((await events(dir)).some((event) => event.type === "answer_committed")).toBe(false);
    await expectSingleTerminal(dir, result);
  });

  test("run deadline aborts pending work and rebuilds terminal status", async () => {
    const dir = await tmp();
    const controller: ControllerDriver = {
      identity: { id: "test/controller", version: "1", configuration: { fixture: "src/runtime/run-cancellation.test.ts:329" } },
      async next(): Promise<Cell> { await new Promise(() => {}); return { reasoning: "late", code: "1" }; },
      fork() { return this; },
    };
    const result = await within(runProgram({
      program: program(), sources: {}, controller, model: unusedModel,
      backend: new FunctionBackend(async () => valueOutcome()), dir, signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, wallMs: 20 },
    }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BUDGET_DEADLINE");
    await expectSingleTerminal(dir, result);
  });

  for (const [classification, fault] of (["completed", "failed", "cancelled"] as const).flatMap((classification) =>
    (["status write", "status sync", "status close", "status rename", "directory sync"] as const)
      .map((fault) => [classification, fault] as const))) {
    test(`${classification} terminal remains authoritative after ${fault} failure`, async () => {
      const dir = await tmp();
      const journal = new JournalStore(dir, terminalStatusFaultFileSystem(dir, fault));
      const owner = new AbortController();
      const controller: ControllerDriver = classification === "failed"
        ? {
            identity: { id: "test/throwing-controller", version: "1", configuration: { fixture: `terminal-${fault}` } },
            async next() { throw new Error("expected failure"); }, fork() { return this; },
          }
        : classification === "cancelled"
          ? {
              identity: { id: "test/cancelling-controller", version: "1", configuration: { fixture: `terminal-${fault}` } },
              async next(_state, signal) {
                owner.abort();
                await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
                return { reasoning: "unreachable", code: "1" };
              },
              fork() { return this; },
            }
          : new OneCellController();
      const backend = new FunctionBackend(async (options) => {
        options.effect("answer", { value: { answer: "done" } });
        return valueOutcome();
      });
      const result = await runProgram({
        program: program(), sources: {}, controller, model: unusedModel, backend, dir,
        signal: owner.signal, journal,
      });

      expect(result.status).toBe(classification);
      expect(result.warnings?.map((warning) => warning.code)).toContain("STATUS_CACHE_REFRESH_FAILED");
      const journalEvents = await events(dir);
      const terminals = journalEvents.filter((event) =>
        event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled");
      expect(terminals).toHaveLength(1);
      expect(reduceStatus(journalEvents).state).toBe(result.status);
      const rebuilt = await journal.status();
      expect(rebuilt.ok).toBe(true);
      if (rebuilt.ok) expect(rebuilt.value.state).toBe(result.status);
    });
  }

  test("filesystem journal failure returns a typed terminal result", async () => {
    const dir = await tmp();
    const file = join(dir, "not-a-directory");
    await writeFile(file, "x");
    const result = await within(runProgram({
      program: program(), sources: {}, controller: new OneCellController(), model: unusedModel,
      backend: new FunctionBackend(async () => valueOutcome()), dir: file, signal: new AbortController().signal,
    }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("JOURNAL_FAILED");
  });

  test("cancelled context producer commits no derived files", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    const backend = new FunctionBackend(async (options) => {
      owner.abort();
      const input = (options.globals.inputs as Record<string, { id: string }>)["context"]!;
      await options.dispatch("context.chunks", { id: input.id, options: { targetTokens: 1, maxChunks: 8 } }, options.signal!, options.deadlineMs);
      return valueOutcome();
    });
    const result = await runProgram({
      program: program(true), sources: { context: "abcdefgh" }, controller: new OneCellController(),
      model: unusedModel, backend, dir, signal: owner.signal,
    });
    expect(result.status).toBe("cancelled");
    expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
  });
});
