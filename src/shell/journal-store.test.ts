import { appendFile, mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import type { BudgetLimits } from "../core/budget.ts";
import type { RlmEvent } from "../core/journal.ts";
import {
  JournalAppendError,
  JournalStore,
  type JournalFileHandle,
  type JournalFileSystem,
} from "./journal-store.ts";

const limits: BudgetLimits = {
  maxDepth: 2, maxFrames: 4, maxLogicalCalls: 10, maxAttempts: 20,
  maxControllerTurns: 10, maxConcurrency: 2, storedByteLimit: 1000, deadlineMs: 1000,
};

const started: RlmEvent = { type: "run_started", runId: "r1", manifestHash: "m", limits };
const completed: RlmEvent = { type: "run_completed", runId: "r1", completionMode: "answer" };

const nodeFileSystem: JournalFileSystem = {
  open: async (path, flags) => open(path, flags),
  readFile: async (path) => readFile(path),
  rename,
};

type FaultOperation =
  | "events append"
  | "events sync"
  | "events close"
  | "status write"
  | "status sync"
  | "status close"
  | "status rename"
  | "directory sync"
  | "directory close";

const instrumentedFileSystem = (root: string, failAt?: FaultOperation): {
  readonly fileSystem: JournalFileSystem;
  readonly operations: string[];
} => {
  const operations: string[] = [];
  const eventsPath = join(root, "events.jsonl");
  const statusPath = join(root, "status.json.tmp");

  const operation = (path: string, name: string): string => {
    if (path === eventsPath) return `events ${name}`;
    if (path === statusPath) return `status ${name}`;
    if (path === root) return `directory ${name}`;
    return `other ${name}`;
  };
  const maybeFail = (name: string): void => {
    if (name === failAt) throw new Error(`injected ${name} failure`);
  };

  const wrap = (path: string, handle: JournalFileHandle): JournalFileHandle => ({
    appendFile: async (data, encoding) => {
      const name = operation(path, "append");
      operations.push(name);
      maybeFail(name);
      await handle.appendFile(data, encoding);
    },
    close: async () => {
      const name = operation(path, "close");
      operations.push(name);
      await handle.close();
      maybeFail(name);
    },
    readFile: async () => {
      operations.push(operation(path, "read"));
      return handle.readFile();
    },
    sync: async () => {
      const name = operation(path, "sync");
      operations.push(name);
      maybeFail(name);
      await handle.sync();
    },
    truncate: async (length) => {
      operations.push(operation(path, "truncate"));
      await handle.truncate(length);
    },
    writeFile: async (data, encoding) => {
      const name = operation(path, "write");
      operations.push(name);
      maybeFail(name);
      await handle.writeFile(data, encoding);
    },
  });

  return {
    operations,
    fileSystem: {
      open: async (path, flags) => {
        operations.push(operation(path, "open"));
        return wrap(path, await nodeFileSystem.open(path, flags));
      },
      readFile: nodeFileSystem.readFile,
      rename: async (oldPath, newPath) => {
        operations.push("status rename");
        maybeFail("status rename");
        await nodeFileSystem.rename(oldPath, newPath);
      },
    },
  };
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-rlm-journal-"));
});

describe("JournalStore", () => {
  test("appends durably and projects authoritative status", async () => {
    const store = new JournalStore(dir);
    const events: RlmEvent[] = [
      started,
      { type: "frame_opened", frameId: "f0", parentFrameId: null, depth: 0, objective: "root" },
      completed,
    ];
    for (const event of events) await store.append(event);
    const status = await store.status();
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("completed");
    const cached = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    expect(cached.state).toBe("completed");
  });

  test("repairs a torn tail before append and continues the recovered fold", async () => {
    const { fileSystem, operations } = instrumentedFileSystem(dir);
    const store = new JournalStore(dir, fileSystem);
    await store.append(started);
    await appendFile(join(dir, "events.jsonl"), '{"type":"frame_opened","frameId":"torn"');

    operations.length = 0;
    await store.append({ type: "frame_opened", frameId: "f0", parentFrameId: null, depth: 0, objective: "root" });
    await store.append(completed);

    const raw = await readFile(join(dir, "events.jsonl"), "utf8");
    expect(raw).not.toContain('"frameId":"torn"');
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(3);
    expect(operations.slice(0, 6)).toEqual([
      "events open",
      "events read",
      "events truncate",
      "events sync",
      "events append",
      "events sync",
    ]);

    const events = await store.readEvents();
    expect(events.ok).toBe(true);
    if (events.ok) expect(events.value.map((event) => event.type)).toEqual(["run_started", "frame_opened", "run_completed"]);
    const status = await store.status();
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("completed");
  });

  test("does not treat an unterminated valid JSON object as a verified record", async () => {
    await writeFile(join(dir, "events.jsonl"), `${JSON.stringify(started)}\n${JSON.stringify(completed)}`);
    const store = new JournalStore(dir);
    await store.append({ type: "run_failed", runId: "r1", code: "FAILED", message: "replacement" });

    const events = await store.readEvents();
    expect(events.ok).toBe(true);
    if (events.ok) expect(events.value.map((event) => event.type)).toEqual(["run_started", "run_failed"]);
  });

  test("flags complete corruption and refuses to truncate or append", async () => {
    const original = `${JSON.stringify(started)}\nnot-json\npartial-tail`;
    await writeFile(join(dir, "events.jsonl"), original);
    const store = new JournalStore(dir);

    let failure: unknown;
    try {
      await store.append(completed);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(JournalAppendError);
    expect((failure as JournalAppendError).phase).toBe("event");
    expect((failure as JournalAppendError).cause).toEqual(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(original);
  });

  test("returns an empty journal only for ENOENT and propagates real read errors", async () => {
    const missing = await new JournalStore(dir).readEvents();
    expect(missing).toEqual({ ok: true, value: [] });

    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const fileSystem: JournalFileSystem = {
      ...nodeFileSystem,
      readFile: async () => { throw denied; },
    };
    await expect(new JournalStore(dir, fileSystem).readEvents()).rejects.toBe(denied);
  });

  test("appends a deduplicated batch contiguously and enforces its first terminal", async () => {
    const { fileSystem, operations } = instrumentedFileSystem(dir);
    const store = new JournalStore(dir, fileSystem);
    await store.append(started);
    operations.length = 0;

    const outcome = await store.appendBatch([
      { type: "phase", frameId: "f0", iteration: 1, ordinal: 0, name: "first" },
      { type: "emit", frameId: "f0", iteration: 1, ordinal: 0, message: "duplicate identity" },
      { type: "emit", frameId: "f0", iteration: 1, ordinal: 1, message: "second" },
      completed,
      { type: "frame_closed", frameId: "f0", state: "closed" },
    ]);

    expect(outcome.events).toEqual([
      "committed",
      "deduplicated",
      "committed",
      "committed",
      "ignored_after_terminal",
    ]);
    expect(operations.filter((operation) => operation === "events append")).toHaveLength(1);
    const journal = await store.readEvents();
    expect(journal.ok).toBe(true);
    if (journal.ok) expect(journal.value.map((event) => event.type))
      .toEqual(["run_started", "phase", "emit", "run_completed"]);
  });

  test("makes every rejected batch-write prefix non-authoritative except the exact checksummed line", async () => {
    const batch: RlmEvent[] = [
      { type: "phase", frameId: "f0", iteration: 1, ordinal: 0, name: "working" },
      {
        type: "cell_committed", frameId: "f0", iteration: 1, reasoning: "done", codeHash: "hash",
        hasResult: true, outputPreview: "done", outputRef: "ctx_answer",
      },
      { type: "answer_committed", frameId: "f0", completionMode: "answer", outputRef: "ctx_answer" },
    ];
    const completeDir = await mkdtemp(join(tmpdir(), "pi-rlm-journal-complete-"));
    const completeStore = new JournalStore(completeDir);
    await completeStore.append(started);
    await completeStore.appendBatch(batch);
    const completeRaw = await readFile(join(completeDir, "events.jsonl"), "utf8");
    const completeLine = `${completeRaw.trimEnd().split("\n").at(-1)}\n`;
    const completeRecord = JSON.parse(completeLine) as Record<string, unknown>;
    expect(completeRecord["type"]).toBe("journal_batch");
    expect(completeRecord["batchId"]).toMatch(/^batch_[a-f0-9]{64}$/);
    expect(completeRecord["checksum"]).toMatch(/^[a-f0-9]{64}$/);

    const replay = await completeStore.appendBatch(batch);
    expect(replay.events).toEqual(["deduplicated", "deduplicated", "deduplicated"]);
    expect(await readFile(join(completeDir, "events.jsonl"), "utf8")).toBe(completeRaw);

    const lineBytes = Buffer.byteLength(completeLine, "utf8");
    for (let prefixBytes = 0; prefixBytes <= lineBytes; prefixBytes++) {
      const faultDir = await mkdtemp(join(tmpdir(), "pi-rlm-journal-prefix-"));
      const eventsPath = join(faultDir, "events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify(started)}\n`);
      let rejected = false;
      const fileSystem: JournalFileSystem = {
        ...nodeFileSystem,
        open: async (path, flags) => {
          const handle = await nodeFileSystem.open(path, flags);
          if (path !== eventsPath) return handle;
          return {
            appendFile: async (data, encoding) => {
              if (rejected || !data.includes('"type":"journal_batch"')) {
                await handle.appendFile(data, encoding);
                return;
              }
              rejected = true;
              const prefix = Buffer.from(data, "utf8").subarray(0, prefixBytes).toString("utf8");
              if (prefix.length > 0) await handle.appendFile(prefix, encoding);
              throw new Error(`injected rejection after ${prefixBytes} bytes`);
            },
            close: () => handle.close(),
            readFile: () => handle.readFile(),
            sync: () => handle.sync(),
            truncate: (length) => handle.truncate(length),
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
          };
        },
      };
      const store = new JournalStore(faultDir, fileSystem);
      let failure: unknown;
      try {
        await store.appendBatch(batch);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(JournalAppendError);
      expect((failure as JournalAppendError).eventDurable).toBe(prefixBytes === lineBytes);

      const read = await store.readEvents();
      expect(read.ok).toBe(true);
      if (read.ok) {
        const committed = read.value.filter((event) =>
          event.type === "phase" || event.type === "cell_committed" || event.type === "answer_committed");
        expect(committed).toHaveLength(prefixBytes === lineBytes ? 3 : 0);
        expect(committed.filter((event) => "outputRef" in event)).toHaveLength(prefixBytes === lineBytes ? 2 : 0);
      }
      const records = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.filter((record) => record["type"] === "journal_batch"))
        .toHaveLength(prefixBytes === lineBytes ? 1 : 0);
    }
  }, 30_000);

  test("rejects a complete batch record whose checksum was changed", async () => {
    const store = new JournalStore(dir);
    await store.appendBatch([{ type: "emit", frameId: "f0", iteration: 1, ordinal: 0, message: "hello" }]);
    const path = join(dir, "events.jsonl");
    const record = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    record["checksum"] = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(record)}\n`);
    const read = await store.readEvents();
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("JOURNAL_CORRUPT");
  });

  test("syncs status content before rename and the containing directory after", async () => {
    const { fileSystem, operations } = instrumentedFileSystem(dir);
    await new JournalStore(dir, fileSystem).append(started);
    expect(operations).toEqual([
      "events open",
      "events read",
      "events append",
      "events sync",
      "events close",
      "status open",
      "status write",
      "status sync",
      "status close",
      "status rename",
      "directory open",
      "directory sync",
      "directory close",
    ]);
  });

  for (const fault of ["events append", "events sync", "events close"] as const) {
    test(`types ${fault} as an authoritative event-phase failure`, async () => {
      const { fileSystem } = instrumentedFileSystem(dir, fault);
      try {
        await new JournalStore(dir, fileSystem).append(started);
        throw new Error("expected append failure");
      } catch (error) {
        expect(error).toBeInstanceOf(JournalAppendError);
        expect((error as JournalAppendError).phase).toBe("event");
        expect((error as JournalAppendError).eventDurable).toBe(fault === "events close");
        expect(String((error as JournalAppendError).cause)).toContain(`injected ${fault} failure`);
      }
    });
  }

  for (const fault of [
    "status write",
    "status sync",
    "status close",
    "status rename",
    "directory sync",
    "directory close",
  ] as const) {
    test(`reports ${fault} without contradicting the durable event`, async () => {
      const { fileSystem } = instrumentedFileSystem(dir, fault);
      const store = new JournalStore(dir, fileSystem);
      const outcome = await store.append(started);
      expect(outcome.event).toBe("committed");
      expect(outcome.statusCache.state).toBe("failed");
      if (outcome.statusCache.state === "failed") {
        expect(outcome.statusCache.error.phase).toBe("status_cache");
        expect(outcome.statusCache.error.eventDurable).toBe(true);
        expect(String(outcome.statusCache.error.cause)).toContain(`injected ${fault} failure`);
      }
      expect(store.statusCacheFailures()).toHaveLength(1);
      const rebuilt = await store.status();
      expect(rebuilt.ok).toBe(true);
      if (rebuilt.ok) expect(rebuilt.value.runId).toBe("r1");
    });
  }
});
