import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RlmEvent } from "../core/journal.ts";
import { normalizeProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import {
  JournalAppendError,
  JournalStore,
  nodeJournalFileSystem,
  type JournalAppendOutcome,
  type JournalFileSystem,
} from "../shell/journal-store.ts";
import type { ModelClient, ModelResponse } from "../shell/model/client.ts";
import type { ControllerDriver } from "./controller.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { inspectRecoveredRun } from "./run-recovery.ts";
import { runProgram, type RunInput } from "./run.ts";

const SECRET_PROMPT = "SECRET operation prompt";
const SECRET_OUTPUT = "SECRET provider output";
const roots: string[] = [];
let backend: QuickJsBackend;

beforeAll(async () => { backend = await QuickJsBackend.create(); });
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

const temp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rlm-operation-fault-"));
  roots.push(dir);
  return dir;
};

const program = (() => {
  const value = normalizeProgram({
    objective: "exercise one external request",
    profile: "default",
    inputs: [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!value.ok) throw new Error("invalid operation fault fixture");
  return value.value;
})();

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const fixture = (dir: string, model: ModelClient, journal?: JournalStore): RunInput => {
  const controller: ControllerDriver = {
    identity: { id: "test/operation-fault-controller", version: "1", configuration: {} },
    async next(_state, _signal, operation) {
      await operation.complete(model, { prompt: SECRET_PROMPT, maxOutputTokens: 8 });
      throw new Error("stop after one accounted request");
    },
    fork() { return this; },
  };
  return {
    program,
    sources: {},
    controller,
    model,
    backend,
    dir,
    signal: new AbortController().signal,
    ...(journal ? { journal } : {}),
  };
};

const model = (effect: () => Promise<ModelResponse> | ModelResponse, calls: { count: number }): ModelClient => ({
  id: "fault-model",
  identity: { id: "test/operation-fault-model", version: "1", configuration: {} },
  async complete() { calls.count += 1; return effect(); },
});

const events = async (dir: string): Promise<RlmEvent[]> => {
  const read = await new JournalStore(dir).readEvents();
  if (!read.ok) throw read.error;
  return read.value;
};

type EventKind = "operation_intended" | "operation_settled";
type FaultSeam = "append" | "sync" | "close";

const operationFaultFileSystem = (target: EventKind, seam: FaultSeam): JournalFileSystem => {
  let fired = false;
  return {
    readFile: (path) => nodeJournalFileSystem.readFile(path),
    rename: (from, to) => nodeJournalFileSystem.rename(from, to),
    open: async (path, flags, mode) => {
      const handle = await nodeJournalFileSystem.open(path, flags, mode);
      let targetAppend = false;
      return {
        readFile: () => handle.readFile(),
        truncate: (length) => handle.truncate(length),
        writeFile: (data, encoding) => handle.writeFile(data, encoding),
        appendFile: async (data, encoding) => {
          targetAppend = data.includes(`\"type\":\"${target}\"`);
          if (targetAppend && seam === "append" && !fired) {
            fired = true;
            throw new Error(`injected ${target} append fault`);
          }
          await handle.appendFile(data, encoding);
        },
        sync: async () => {
          if (targetAppend && seam === "sync" && !fired) {
            fired = true;
            throw new Error(`injected ${target} sync fault`);
          }
          await handle.sync();
        },
        close: async () => {
          if (targetAppend && seam === "close" && !fired) {
            fired = true;
            await handle.close();
            throw new Error(`injected ${target} close fault`);
          }
          await handle.close();
        },
      };
    },
  };
};

class OperationFaultJournal extends JournalStore {
  injected?: JournalAppendError;

  constructor(dir: string, private readonly target: EventKind, seam: FaultSeam) {
    super(dir, operationFaultFileSystem(target, seam));
  }

  override async append(event: RlmEvent): Promise<JournalAppendOutcome> {
    try { return await super.append(event); }
    catch (error) {
      if (event.type === this.target && error instanceof JournalAppendError) this.injected = error;
      throw error;
    }
  }
}

class SettlementGateJournal extends JournalStore {
  readonly reached = deferred<void>();
  readonly release = deferred<void>();

  constructor(dir: string, private readonly afterDurable: boolean) { super(dir); }

  override async append(event: RlmEvent): Promise<JournalAppendOutcome> {
    if (event.type !== "operation_settled") return super.append(event);
    if (!this.afterDurable) {
      this.reached.resolve();
      await this.release.promise;
      return super.append(event);
    }
    const outcome = await super.append(event);
    this.reached.resolve();
    await this.release.promise;
    return outcome;
  }
}

describe("write-ahead operation fault matrix", () => {
  test("pre-intent budget denial invokes neither controller model nor journal operation", async () => {
    const dir = await temp();
    const calls = { count: 0 };
    const result = await runProgram({
      ...fixture(dir, model(() => ({ text: SECRET_OUTPUT, usage: { attempts: 1, durationMs: 1 } }), calls)),
      profile: { ...DEFAULT_PROFILE, maxAttempts: 0 },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "BUDGET_ATTEMPTS" }, ledger: { usage: { attempts: 0 } } });
    expect(calls.count).toBe(0);
    expect((await events(dir)).filter((event) => event.type.startsWith("operation_"))).toEqual([]);
  });

  test.each([
    ["operation_intended", "append", false, 0, false],
    ["operation_intended", "sync", true, 0, true],
    ["operation_intended", "close", true, 0, true],
    ["operation_settled", "append", false, 1, true],
    ["operation_settled", "sync", true, 1, false],
    ["operation_settled", "close", true, 1, false],
  ] as const)("%s %s fault preserves durability, spend, recovery, and budgets", async (target, seam, durable, expectedCalls, ambiguous) => {
    const dir = await temp();
    const calls = { count: 0 };
    const journal = new OperationFaultJournal(dir, target, seam);
    const result = await runProgram(fixture(dir, model(() => ({
      text: SECRET_OUTPUT,
      usage: { attempts: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: 0, durationMs: 1 },
    }), calls), journal));
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "JOURNAL_FAILED" },
      ledger: { usage: { attempts: 1, logicalCalls: 1, tokensReserved: 0, activeLeafCalls: 0 } },
    });
    expect(journal.injected?.eventDurable).toBe(durable);
    expect(calls.count).toBe(expectedCalls);
    const journalEvents = await events(dir);
    expect(journalEvents.filter((event) => event.type === target)).toHaveLength(durable ? 1 : 0);
    if (ambiguous) await expect(inspectRecoveredRun(dir)).rejects.toMatchObject({ code: "RECOVERY_AMBIGUOUS" });
    else await expect(inspectRecoveredRun(dir)).resolves.toMatchObject({ status: "failed" });
  });

  test("durable intent is visible before provider return and contains hashes only", async () => {
    const dir = await temp();
    const calls = { count: 0 };
    const provider = deferred<ModelResponse>();
    const running = runProgram(fixture(dir, model(() => provider.promise, calls)));
    while (calls.count === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const prefix = await events(dir);
    expect(prefix.filter((event) => event.type === "operation_intended")).toHaveLength(1);
    expect(prefix.filter((event) => event.type === "operation_settled")).toHaveLength(0);
    await expect(inspectRecoveredRun(dir)).rejects.toMatchObject({ code: "RECOVERY_AMBIGUOUS" });
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).not.toContain(SECRET_PROMPT);
    provider.resolve({ text: SECRET_OUTPUT, usage: { attempts: 1, durationMs: 1 } });
    await running;
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).not.toContain(SECRET_OUTPUT);
  });

  test.each([false, true] as const)("provider result pauses %s durable settlement before caller observation", async (afterDurable) => {
    const dir = await temp();
    const calls = { count: 0 };
    const journal = new SettlementGateJournal(dir, afterDurable);
    const running = runProgram(fixture(dir, model(() => ({ text: SECRET_OUTPUT, usage: { attempts: 1, durationMs: 1 } }), calls), journal));
    await journal.reached.promise;
    const prefix = await events(dir);
    expect(prefix.filter((event) => event.type === "operation_intended")).toHaveLength(1);
    expect(prefix.filter((event) => event.type === "operation_settled")).toHaveLength(afterDurable ? 1 : 0);
    if (afterDurable) await expect(inspectRecoveredRun(dir)).resolves.toMatchObject({ status: "nonterminal" });
    else await expect(inspectRecoveredRun(dir)).rejects.toMatchObject({ code: "RECOVERY_AMBIGUOUS" });
    journal.release.resolve();
    await running;
    expect(calls.count).toBe(1);
  });
});
