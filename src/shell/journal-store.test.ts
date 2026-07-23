import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import type { BudgetLimits } from "../core/budget.ts";
import type { RlmEvent } from "../core/journal.ts";
import { JournalStore } from "./journal-store.ts";

const limits: BudgetLimits = {
  maxDepth: 2, maxFrames: 4, maxLogicalCalls: 10, maxAttempts: 20,
  maxControllerTurns: 10, maxConcurrency: 2, storedByteLimit: 1000, deadlineMs: 1000,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-rlm-journal-"));
});

describe("JournalStore", () => {
  test("appends durably and projects authoritative status", async () => {
    const store = new JournalStore(dir);
    const events: RlmEvent[] = [
      { type: "run_started", runId: "r1", manifestHash: "m", limits },
      { type: "frame_opened", frameId: "f0", parentFrameId: null, depth: 0, objective: "root" },
      { type: "run_completed", runId: "r1", completionMode: "answer" },
    ];
    for (const e of events) await store.append(e);
    const status = await store.status();
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("completed");
    // status.json cache exists and matches
    const cached = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    expect(cached.state).toBe("completed");
  });

  test("recovers from a torn final append", async () => {
    const store = new JournalStore(dir);
    await store.append({ type: "run_started", runId: "r1", manifestHash: "m", limits });
    // simulate a crash mid-append: a partial line with no trailing newline
    await appendFile(join(dir, "events.jsonl"), '{"type":"frame_opened","frameId":"f0"');
    const events = await store.readEvents();
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.value).toHaveLength(1);
      expect(events.value[0]!.type).toBe("run_started");
    }
  });

  test("flags a corrupt interior line", async () => {
    await writeFile(join(dir, "events.jsonl"), 'not-json\n{"type":"run_started"}\n');
    const store = new JournalStore(dir);
    const events = await store.readEvents();
    expect(events.ok).toBe(false);
    if (!events.ok) expect(events.error.code).toBe("JOURNAL_CORRUPT");
  });
});
