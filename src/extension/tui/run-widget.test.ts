import { describe, expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import type { CoordinatedRun } from "../run-coordinator.ts";
import { createRunWidget, RunWidget } from "./run-widget.ts";

const active = (localId: string, state: "running" | "cancelling", sequence: number): CoordinatedRun => ({
  localId,
  sessionId: "session-must-not-render",
  authorizationGeneration: 42,
  objectivePreview: "/hidden/path and raw provider text",
  state,
  progress: {
    sequence,
    phase: "controller",
    status: "running",
    elapsedMs: 2_000,
    calls: { total: 3, active: 1, failed: 0, limit: 8 },
    frames: { total: 2, active: 1, limit: 4 },
    budgets: {
      tokensUsed: 900, inputTokensUsed: 600, outputTokensUsed: 300, tokensReserved: 0,
      costUsd: 0, providerDurationMs: 1_000, storedBytes: 0, storedByteLimit: 1_000,
      deadlineMs: 5_000,
    },
  },
});

describe("RunWidget", () => {
  test("is a public-root Component with explicit update and idempotent dispose", () => {
    let renders = 0;
    const widget: Component & { update(runs: readonly CoordinatedRun[]): void; dispose(): void } =
      new RunWidget(() => { renders += 1; });
    expect(widget.render(80)).toEqual([]);
    widget.update([active("rlm_first", "running", 1)]);
    expect(renders).toBe(1);
    expect(widget.render(80).join("\n")).toContain("lm_first");
    widget.invalidate();
    expect(renders).toBe(1);
    widget.dispose();
    widget.dispose();
    expect(renders).toBe(2);
    expect(widget.render(80)).toEqual([]);
    widget.update([active("rlm_late", "running", 2)]);
    expect(renders).toBe(2);
    expect(widget.render(80)).toEqual([]);
  });

  test("updates synchronously without timers and retains no hidden display fields", () => {
    const originalTimeout = globalThis.setTimeout;
    const originalInterval = globalThis.setInterval;
    let timerCalls = 0;
    globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
      timerCalls += 1;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.setInterval = ((..._args: Parameters<typeof setInterval>) => {
      timerCalls += 1;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      const widget = createRunWidget(undefined, [
        active("rlm_running", "running", 1),
        active("rlm_cancelling", "cancelling", 2),
      ]);
      const lines = widget.render(120);
      expect(timerCalls).toBe(0);
      expect(lines[0]).toContain("cancelling");
      expect(lines.join("\n")).not.toMatch(/session-must-not-render|hidden|provider/u);
      widget.dispose();
      expect(timerCalls).toBe(0);
    } finally {
      globalThis.setTimeout = originalTimeout;
      globalThis.setInterval = originalInterval;
    }
  });

  test("renders one compact summary below width 60", () => {
    const widget = new RunWidget([
      active("rlm_one", "running", 1),
      active("rlm_two", "cancelling", 2),
    ]);
    expect(widget.render(59)).toEqual(["RLM: 2 active, 1 cancelling · /rlm runs"]);
    expect(widget.render(60)).toHaveLength(3);
  });
});
