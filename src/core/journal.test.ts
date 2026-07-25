import { describe, expect, test } from "bun:test";
import type { BudgetLimits } from "./budget.ts";
import { reduceStatus, type RlmEvent } from "./journal.ts";
import { ZERO_CALL_USAGE } from "./usage.ts";

const limits: BudgetLimits = {
  maxDepth: 2,
  maxFrames: 4,
  maxLogicalCalls: 10,
  maxAttempts: 20,
  maxControllerTurns: 10,
  maxConcurrency: 2,
  storedByteLimit: 1000,
  deadlineMs: 1000,
};

describe("reduceStatus", () => {
  test("folds a completed run and dedupes replayed calls/cells", () => {
    const events: RlmEvent[] = [
      { type: "run_started", runId: "r1", manifestHash: "m", limits },
      { type: "frame_opened", frameId: "f0", parentFrameId: null, depth: 0, objective: "root" },
      { type: "phase", frameId: "f0", iteration: 1, ordinal: 0, name: "explore" },
      { type: "cell_committed", frameId: "f0", iteration: 1, reasoning: "r", codeHash: "h1", hasResult: true, outputPreview: "p1" },
      { type: "cell_committed", frameId: "f0", iteration: 1, reasoning: "r", codeHash: "h1", hasResult: true, outputPreview: "p1" }, // replay dup
      { type: "key_bound", frameId: "f0", kind: "llm", key: "k", identityHash: "identity-1" },
      { type: "key_bound", frameId: "f0", kind: "llm", key: "k", identityHash: "identity-1" }, // replay dup
      { type: "call_committed", frameId: "f0", callId: "c1", kind: "llm", key: "k", cached: false, ok: true, usage: ZERO_CALL_USAGE },
      { type: "call_committed", frameId: "f0", callId: "c1", kind: "llm", key: "k", cached: true, ok: true, usage: ZERO_CALL_USAGE }, // replay dup
      { type: "answer_committed", frameId: "f0", completionMode: "answer", outputRef: "out" },
      { type: "run_completed", runId: "r1", completionMode: "answer", outputRef: "out" },
    ];
    const status = reduceStatus(events);
    expect(status.state).toBe("completed");
    expect(status.completionMode).toBe("answer");
    expect(status.committedCallIds).toEqual(["c1"]);
    expect(status.keyBindings).toEqual([{ frameId: "f0", kind: "llm", key: "k", identityHash: "identity-1" }]);
    const f0 = status.frames["f0"]!;
    expect(f0.iterations).toBe(1);
    expect(f0.calls).toBe(1);
    expect(f0.phase).toBe("explore");
    expect(f0.state).toBe("answered");
  });

  test("captures failure", () => {
    const events: RlmEvent[] = [
      { type: "run_started", runId: "r2", manifestHash: "m", limits },
      { type: "run_failed", runId: "r2", code: "CPU_LIMIT", message: "boom" },
    ];
    const status = reduceStatus(events);
    expect(status.state).toBe("failed");
    expect(status.error?.code).toBe("CPU_LIMIT");
  });

  test("tracks nested frames and order", () => {
    const events: RlmEvent[] = [
      { type: "run_started", runId: "r3", manifestHash: "m", limits },
      { type: "frame_opened", frameId: "f0", parentFrameId: null, depth: 0, objective: "root" },
      { type: "frame_opened", frameId: "f1", parentFrameId: "f0", depth: 1, objective: "child" },
      { type: "frame_closed", frameId: "f1", state: "closed" },
    ];
    const status = reduceStatus(events);
    expect(status.frameOrder).toEqual(["f0", "f1"]);
    expect(status.frames["f1"]!.parentFrameId).toBe("f0");
    expect(status.frames["f1"]!.state).toBe("closed");
  });
});
