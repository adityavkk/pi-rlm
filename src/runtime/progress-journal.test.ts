import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { reduceStatus, type RlmEvent } from "../core/journal.ts";
import { normalizeProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import {
  JournalAppendError,
  type JournalAppendOutcome,
  JournalStore,
} from "../shell/journal-store.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { MockController } from "./mock-controller.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-progress-"));
const events = async (dir: string): Promise<RlmEvent[]> =>
  (await readFile(join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RlmEvent);

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
  model: options.model ?? new MockModelClient(() => "unused"),
  backend,
  dir,
  signal: options.signal ?? new AbortController().signal,
  ...(options.journal ? { journal: options.journal } : {}),
});

class FailingProgressJournal extends JournalStore {
  private failed = false;

  constructor(dir: string, private readonly failedOrdinal: number) {
    super(dir);
  }

  override append(event: RlmEvent): Promise<JournalAppendOutcome> {
    if (!this.failed && (event.type === "phase" || event.type === "emit") && event.ordinal === this.failedOrdinal) {
      this.failed = true;
      return Promise.reject(new JournalAppendError("event", false, new Error("injected progress disk failure")));
    }
    return super.append(event);
  }
}

class RefreshFailureJournal extends JournalStore {
  private readonly failures: JournalAppendError[] = [];

  override async append(event: RlmEvent): Promise<JournalAppendOutcome> {
    const outcome = await super.append(event);
    if (this.failures.length === 0 && (event.type === "phase" || event.type === "emit")) {
      const error = new JournalAppendError("status_cache", true, new Error("injected progress cache refresh failure"));
      this.failures.push(error);
      return { event: outcome.event, statusCache: { state: "failed", error } };
    }
    return outcome;
  }

  override statusCacheFailures(): readonly JournalAppendError[] {
    return this.failures;
  }
}

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
    });
    const result = await run(dir, new MockController([{
      reasoning: "cancel after progress",
      code: "phase('not-committed'); await llm({ key: 'cancel', prompt: 'cancel' }); 'late'",
    }]), { signal: owner.signal, model });

    expect(result.status).toBe("cancelled");
    expect((await events(dir)).filter((event) => event.type === "phase" || event.type === "emit")).toHaveLength(0);
  });

  for (const ordinal of [0, 1]) {
    test(`fails closed when authoritative progress append ${ordinal + 1} fails`, async () => {
      const dir = await tmp();
      const journal = new FailingProgressJournal(dir, ordinal);
      const result = await run(dir, new MockController([{
        reasoning: "two effects",
        code: "phase('one'); emit({ message: 'two' }); answer({ answer: 'must-not-complete' }); 'ok'",
      }]), { journal });

      expect(result).toMatchObject({ status: "failed", error: { code: "JOURNAL_FAILED" } });
      const journalEvents = await events(dir);
      expect(journalEvents.some((event) => event.type === "cell_committed" || event.type === "answer_committed")).toBe(false);
      expect(journalEvents.filter((event) =>
        event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled")).toHaveLength(1);
      expect(reduceStatus(journalEvents).state).toBe("failed");
      expect(Object.values(reduceStatus(journalEvents).frames).some((frame) => frame.phase !== undefined)).toBe(false);
    });
  }

  test("continues after a durable event with rebuildable cache refresh failure", async () => {
    const dir = await tmp();
    const journal = new RefreshFailureJournal(dir);
    const result = await run(dir, new MockController([{
      reasoning: "cache warning",
      code: "phase('durable'); answer({ answer: 'done' }); 'ok'",
    }]), { journal });

    expect(result.status).toBe("completed");
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

  test("keeps child and parent progress identities independent", async () => {
    const dir = await tmp();
    const controller = new MockController(
      [{
        reasoning: "parent",
        code: "const child = await recurse({ key: 'child', objective: 'child' }); phase('parent'); answer({ answer: child.value }); 'ok'",
      }],
      () => new MockController([{
        reasoning: "child",
        code: "phase('child'); emit({ message: 'child emit' }); answer('done'); 'ok'",
      }]),
    );
    const result = await run(dir, controller);

    expect(result.status).toBe("completed");
    const progress = (await events(dir)).filter((event) => event.type === "phase" || event.type === "emit");
    expect(progress.map((event) => [event.frameId.endsWith(":f0") ? "parent" : "child", event.iteration, event.ordinal]))
      .toEqual([["child", 1, 0], ["child", 1, 1], ["parent", 1, 0]]);
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
