import { mkdtemp, open, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { reduceStatus, type RlmEvent } from "../core/journal.ts";
import { normalizeProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import {
  JournalAppendError,
  type JournalBatchAppendOutcome,
  type JournalFileHandle,
  type JournalFileSystem,
  JournalStore,
} from "../shell/journal-store.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { MockController } from "./mock-controller.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const modelIdentity = (fixture: string) => ({
  id: "test/progress-model", version: "1", configuration: { fixture },
} as const);

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-progress-"));
const events = async (dir: string): Promise<RlmEvent[]> => {
  const result = await new JournalStore(dir).readEvents();
  if (!result.ok) throw result.error;
  return result.value;
};

const journalRecords = async (dir: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const program = () => {
  const normalized = normalizeProgram({
    objective: "test progress",
    profile: "default",
    inputs: [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid test program");
  return normalized.value;
};

const run = (dir: string, controller: MockController, options: {
  signal?: AbortSignal;
  journal?: JournalStore;
  model?: MockModelClient;
} = {}) => runProgram({
  program: program(),
  sources: {},
  controller,
  model: options.model ?? new MockModelClient(() => "unused", modelIdentity("default")),
  backend,
  dir,
  signal: options.signal ?? new AbortController().signal,
  ...(options.journal ? { journal: options.journal } : {}),
});

class FailingCellBatchJournal extends JournalStore {
  private failed = false;

  constructor(dir: string, private readonly failedPosition: number) {
    super(dir);
  }

  override appendBatch(events: readonly RlmEvent[]): Promise<JournalBatchAppendOutcome> {
    if (!this.failed && events.some((event) => event.type === "cell_committed") && events[this.failedPosition]) {
      this.failed = true;
      return Promise.reject(new JournalAppendError("event", false, new Error("injected cell batch disk failure")));
    }
    return super.appendBatch(events);
  }
}

class RefreshFailureJournal extends JournalStore {
  private readonly failures: JournalAppendError[] = [];

  override async appendBatch(events: readonly RlmEvent[]): Promise<JournalBatchAppendOutcome> {
    const outcome = await super.appendBatch(events);
    if (this.failures.length === 0 && events.some((event) => event.type === "phase" || event.type === "emit")) {
      const error = new JournalAppendError("status_cache", true, new Error("injected progress cache refresh failure"));
      this.failures.push(error);
      return { events: outcome.events, statusCache: { state: "failed", error } };
    }
    return outcome;
  }

  override statusCacheFailures(): readonly JournalAppendError[] {
    return this.failures;
  }
}

const rejectCompleteCellBatchFileSystem = (dir: string): JournalFileSystem => {
  const eventsPath = join(dir, "events.jsonl");
  let rejected = false;
  const wrap = (path: string, handle: JournalFileHandle): JournalFileHandle => ({
    appendFile: async (data, encoding) => {
      if (path === eventsPath && !rejected && data.includes('"type":"cell_committed"')) {
        rejected = true;
        await handle.appendFile(data, encoding);
        throw new Error("injected rejection after complete batch line");
      }
      await handle.appendFile(data, encoding);
    },
    close: () => handle.close(),
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    readFile: () => handle.readFile(),
    stat: () => handle.stat(),
    sync: () => handle.sync(),
    truncate: (length) => handle.truncate(length),
    writeFile: (data, encoding) => handle.writeFile(data, encoding),
  });
  return {
    open: async (path, flags) => wrap(path, await open(path, flags)),
    readFile: async (path) => readFile(path),
    rename,
  };
};

const delayedFirstCellBatchFileSystem = (dir: string): {
  readonly fileSystem: JournalFileSystem;
  readonly delayed: () => boolean;
} => {
  const eventsPath = join(dir, "events.jsonl");
  let delayed = false;
  const wrap = (path: string, handle: JournalFileHandle): JournalFileHandle => ({
    appendFile: async (data, encoding) => {
      if (path === eventsPath && !delayed && data.includes('"type":"cell_committed"')) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await handle.appendFile(data, encoding);
    },
    close: () => handle.close(),
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    readFile: () => handle.readFile(),
    stat: () => handle.stat(),
    sync: () => handle.sync(),
    truncate: (length) => handle.truncate(length),
    writeFile: (data, encoding) => handle.writeFile(data, encoding),
  });
  return {
    delayed: () => delayed,
    fileSystem: {
      open: async (path, flags) => wrap(path, await open(path, flags)),
      readFile: async (path) => readFile(path),
      rename,
    },
  };
};

describe("authoritative progress journal effects", () => {
  test("awaits phase and emit in within-cell order before answer commit", async () => {
    const dir = await tmp();
    const result = await run(dir, new MockController([{
      reasoning: "report and answer",
      code: "phase('inspect'); emit({ message: 'halfway' }); answer({ answer: 'done' }); 'ok'",
    }]));

    expect(result.status).toBe("completed");
    const ordered = (await events(dir)).filter((event) =>
      event.type === "phase" || event.type === "emit" || event.type === "cell_committed" || event.type === "answer_committed");
    expect(ordered.map((event) => event.type)).toEqual(["phase", "emit", "cell_committed", "answer_committed"]);
    const batches = (await journalRecords(dir)).filter((record) => record["type"] === "journal_batch");
    expect(batches).toHaveLength(1);
    expect((batches[0]?.["events"] as RlmEvent[]).map((event) => event.type))
      .toEqual(["phase", "emit", "cell_committed", "answer_committed"]);
    expect(ordered.slice(0, 2)).toMatchObject([
      { type: "phase", iteration: 1, ordinal: 0, name: "inspect" },
      { type: "emit", iteration: 1, ordinal: 1, message: "halfway" },
    ]);
  });

  test("does not journal provisional progress from a failed cell", async () => {
    const dir = await tmp();
    const result = await run(dir, new MockController([
      { reasoning: "fails", code: "phase('not-committed'); emit({ message: 'discard' }); throw new Error('boom')" },
      { reasoning: "recover", code: "answer({ answer: 'done' }); 'ok'" },
    ]));

    expect(result.status).toBe("completed");
    expect((await events(dir)).filter((event) => event.type === "phase" || event.type === "emit")).toHaveLength(0);
  });

  test("cancellation discards buffered progress", async () => {
    const dir = await tmp();
    const owner = new AbortController();
    const model = new MockModelClient(() => {
      owner.abort();
      return "late";
    }, modelIdentity("cancellation"));
    const result = await run(dir, new MockController([{
      reasoning: "cancel after progress",
      code: "phase('not-committed'); await llm({ key: 'cancel', prompt: 'cancel' }); 'late'",
    }]), { signal: owner.signal, model });

    expect(result.status).toBe("cancelled");
    expect((await events(dir)).filter((event) => event.type === "phase" || event.type === "emit")).toHaveLength(0);
  });

  for (const position of [0, 1, 2, 3]) {
    test(`keeps safely published answer bytes unreferenced when cell batch position ${position + 1} faults`, async () => {
      const dir = await tmp();
      const journal = new FailingCellBatchJournal(dir, position);
      const result = await run(dir, new MockController([{
        reasoning: "two effects",
        code: "phase('one'); emit({ message: 'two' }); answer({ answer: 'must-not-complete' }); 'ok'",
      }]), { journal });

      expect(result).toMatchObject({ status: "failed", error: { code: "JOURNAL_FAILED" } });
      // Content-addressed publication from #45 is immediately shareable and cannot be unlinked safely on rollback.
      expect(result.ledger.usage.storedBytes).toBeGreaterThan(0);
      const journalEvents = await events(dir);
      expect(journalEvents.some((event) =>
        event.type === "phase" || event.type === "emit" || event.type === "cell_committed" ||
        event.type === "answer_committed")).toBe(false);
      expect((await journalRecords(dir)).filter((record) => record["type"] === "journal_batch")).toHaveLength(0);
      expect(journalEvents.filter((event) =>
        event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled")).toHaveLength(1);
      expect(reduceStatus(journalEvents).state).toBe("failed");
      expect(Object.values(reduceStatus(journalEvents).frames).some((frame) => frame.phase !== undefined)).toBe(false);
    });
  }

  test("keeps answer bytes when a complete checksummed batch line is written then rejected", async () => {
    const dir = await tmp();
    const journal = new JournalStore(dir, rejectCompleteCellBatchFileSystem(dir));
    const result = await run(dir, new MockController([{
      reasoning: "durable ambiguous write",
      code: "phase('durable'); answer({ answer: 'kept' }); 'ok'",
    }]), { journal });

    expect(result).toMatchObject({ status: "failed", error: { code: "JOURNAL_FAILED" } });
    expect(result.ledger.usage.storedBytes).toBeGreaterThan(0);
    const journalEvents = await events(dir);
    expect(journalEvents.filter((event) => event.type === "cell_committed")).toHaveLength(1);
    expect(journalEvents.filter((event) => event.type === "answer_committed")).toHaveLength(1);
    const answer = journalEvents.find((event): event is Extract<RlmEvent, { type: "answer_committed" }> =>
      event.type === "answer_committed");
    expect(answer).toBeDefined();
    expect(answer?.outputRef).toMatch(/^ctx_[a-f0-9]+$/);
    expect((await journalRecords(dir)).filter((record) => record["type"] === "journal_batch")).toHaveLength(1);
  });

  test("continues after a durable event with rebuildable cache refresh failure", async () => {
    const dir = await tmp();
    const journal = new RefreshFailureJournal(dir);
    const result = await run(dir, new MockController([{
      reasoning: "cache warning",
      code: "phase('durable'); answer({ answer: 'done' }); 'ok'",
    }]), { journal });

    expect(result.status).toBe("completed");
    expect(result.ledger.usage.storedBytes).toBeGreaterThan(0);
    expect(result.warnings?.map((warning) => warning.code)).toContain("STATUS_CACHE_REFRESH_FAILED");
    expect((await events(dir)).filter((event) => event.type === "phase")).toHaveLength(1);
  });

  test("deduplicates replay by frame, cell iteration, and ordinal", async () => {
    const dir = await tmp();
    const journal = new JournalStore(dir);
    const first = { type: "phase", frameId: "f0", iteration: 2, ordinal: 0, name: "first" } as const;
    await journal.append(first);
    const duplicate = await journal.append({ type: "emit", frameId: "f0", iteration: 2, ordinal: 0, message: "replayed" });

    expect(duplicate.event).toBe("deduplicated");
    expect((await events(dir)).filter((event) => event.type === "phase" || event.type === "emit")).toEqual([first]);
  });

  test("keeps overlapping child cell batches contiguous under append delay", async () => {
    const dir = await tmp();
    const delayed = delayedFirstCellBatchFileSystem(dir);
    const journal = new JournalStore(dir, delayed.fileSystem);
    const controller = new MockController(
      [{
        reasoning: "parent",
        code: "await Promise.all([recurse({ key: 'a', objective: 'A' }), recurse({ key: 'b', objective: 'B' })]); answer({ answer: 'done' }); 'ok'",
      }],
      (objective) => new MockController([{
        reasoning: objective,
        code: `phase('${objective}'); emit({ message: '${objective}-emit' }); answer('${objective}-answer'); 'ok'`,
      }]),
      { id: "test/progress-fork-factory", version: "1", configuration: { fixture: "overlapping-child-batches" } },
    );
    const result = await run(dir, controller, { journal });

    expect(result.status).toBe("completed");
    expect(delayed.delayed()).toBe(true);
    const journalEvents = await events(dir);
    const childFrames = new Map(journalEvents
      .filter((event): event is Extract<RlmEvent, { type: "phase" }> => event.type === "phase" && (event.name === "A" || event.name === "B"))
      .map((event) => [event.frameId, event.name]));
    expect([...childFrames.values()].sort()).toEqual(["A", "B"]);
    const childBatchEvents = journalEvents.filter((event) =>
      "frameId" in event && childFrames.has(event.frameId) &&
      (event.type === "phase" || event.type === "emit" || event.type === "cell_committed" || event.type === "answer_committed"));
    for (const [frameId] of childFrames) {
      const positions = childBatchEvents
        .map((event, index) => "frameId" in event && event.frameId === frameId ? index : -1)
        .filter((index) => index >= 0);
      expect(positions).toHaveLength(4);
      expect(positions.at(-1)! - positions[0]!).toBe(3);
      expect(positions.map((index) => childBatchEvents[index]?.type))
        .toEqual(["phase", "emit", "cell_committed", "answer_committed"]);
    }
  });

  test("terminal fold applies only committed progress and keeps the first replay identity", () => {
    const journalEvents: RlmEvent[] = [
      { type: "frame_opened", frameId: "f0", parentFrameId: null, depth: 0, objective: "test" },
      { type: "phase", frameId: "f0", iteration: 1, ordinal: 0, name: "orphan" },
      { type: "phase", frameId: "f0", iteration: 2, ordinal: 0, name: "committed" },
      { type: "phase", frameId: "f0", iteration: 2, ordinal: 0, name: "duplicate" },
      { type: "cell_committed", frameId: "f0", iteration: 2, reasoning: "ok", codeHash: "hash", hasResult: true, outputPreview: "ok" },
      { type: "run_failed", runId: "r", code: "JOURNAL_FAILED", message: "failed" },
    ];

    expect(reduceStatus(journalEvents).frames["f0"]?.phase).toBe("committed");
  });
});
