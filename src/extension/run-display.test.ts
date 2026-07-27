import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CoordinatedRun } from "./run-coordinator.ts";
import type { RunProgressSnapshot } from "../runtime/index.ts";
import {
  DISPLAY_TEXT_MAX_BYTES,
  projectRunDisplayItems,
  renderCoordinatedRuns,
  renderRunDisplay,
  sanitizeDisplayText,
  truncateDisplayLine,
  type RunDisplayItem,
} from "./run-display.ts";

const progress = (
  sequence: number,
  phase: RunProgressSnapshot["phase"] = "controller",
): RunProgressSnapshot => ({
  sequence,
  phase,
  status: "running",
  elapsedMs: 3_723_000,
  calls: { total: 123, active: 2, failed: 4, limit: 200 },
  frames: { total: 12, active: 3, limit: 20 },
  budgets: {
    tokensUsed: 1_234_567,
    inputTokensUsed: 1_000_000,
    outputTokensUsed: 234_567,
    tokensReserved: 5_000,
    tokenLimit: 2_000_000,
    costUsd: 1.25,
    providerDurationMs: 9_000,
    storedBytes: 100,
    storedByteLimit: 1_000,
    deadlineMs: 10_000,
  },
});

const items: readonly RunDisplayItem[] = [
  { localId: "rlm_local_old", runId: `run_${"1".repeat(64)}`, state: "running", progress: progress(4) },
  { localId: "rlm_local_cancel_old", state: "cancelling", progress: progress(2, "extractor") },
  { localId: "rlm_local_new", runId: `run_${"2".repeat(64)}`, state: "running", progress: progress(9, "journal") },
  { localId: "rlm_local_cancel_new", state: "cancelling", progress: progress(8, "finalizing") },
  { localId: "rlm_local_mid", state: "running", progress: progress(6, "context") },
];

const coordinated = (item: RunDisplayItem, extras: Partial<CoordinatedRun> = {}): CoordinatedRun => ({
  localId: item.localId,
  ...(item.runId ? { runId: item.runId } : {}),
  sessionId: "hidden-session",
  authorizationGeneration: 99,
  objectivePreview: "/private/path raw guest objective",
  state: item.state,
  ...(item.progress ? { progress: item.progress } : {}),
  ...extras,
});

describe("run display sanitizer", () => {
  test("strips terminal, C0/C1, and bidi controls and collapses lines", () => {
    const hostile = "A\u001b[31mred\u001b[0m\n\tB\u001b]0;secret\u0007C\u009b32mD\u009b0m\u0000\u0085\u202eE";
    expect(sanitizeDisplayText(hostile)).toBe("Ared BCDE");
    expect(sanitizeDisplayText("x\u001b]8;;https://evil.example\u001b\\link\u001b]8;;\u001b\\y"))
      .toBe("xlinky");
  });

  test("bounds UTF-8 at code-point boundaries and wide lines by columns", () => {
    const bounded = sanitizeDisplayText("😀".repeat(2_000));
    expect(Buffer.byteLength(bounded, "utf8")).toBe(DISPLAY_TEXT_MAX_BYTES);
    expect(bounded.endsWith("😀")).toBe(true);
    for (const width of [1, 2, 3, 4, 5, 12]) {
      const line = truncateDisplayLine("界😀e\u0301界", width);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toMatch(/[\u001b\u009b\u202e]/u);
    }
  });
});

describe("responsive run rendering", () => {
  test("has deterministic snapshots at acceptance widths", () => {
    const rendered = Object.fromEntries([50, 60, 80, 100, 120, 180]
      .map((width) => [width, renderRunDisplay(items, width)]));
    expect(rendered).toMatchInlineSnapshot(`
      {
        "100": [
          "RLM cancelling #ncel_new · finalizing · calls 2a/123t/4f · frames 3a/12t · elapsed 1h02m",
          "RLM cancelling #ncel_old · extractor · calls 2a/123t/4f · frames 3a/12t · elapsed 1h02m",
          "RLM running #22222222 · journal · calls 2a/123t/4f · frames 3a/12t · tokens 1.2m · elapsed 1h02m",
          "+2 more · /rlm runs · /rlm cancel <id>",
        ],
        "120": [
          "RLM cancelling #ncel_new · finalizing · calls 2a/123t/4f · frames 3a/12t · tokens 1.2m · elapsed 1h02m",
          "RLM cancelling #ncel_old · extractor · calls 2a/123t/4f · frames 3a/12t · tokens 1.2m · elapsed 1h02m",
          "RLM running #22222222 · journal · calls 2a/123t/4f · frames 3a/12t · tokens 1.2m · elapsed 1h02m",
          "+2 more · /rlm runs · /rlm cancel <id>",
        ],
        "180": [
          "RLM cancelling #ncel_new · finalizing · calls 2a/123t/4f · frames 3a/12t · tokens 1.2m · elapsed 1h02m",
          "RLM cancelling #ncel_old · extractor · calls 2a/123t/4f · frames 3a/12t · tokens 1.2m · elapsed 1h02m",
          "RLM running #22222222 · journal · calls 2a/123t/4f · frames 3a/12t · tokens 1.2m · elapsed 1h02m",
          "+2 more · /rlm runs · /rlm cancel <id>",
        ],
        "50": [
          "RLM: 5 active, 2 cancelling · /rlm runs",
        ],
        "60": [
          "RLM cancelling #ncel_new · finalizing · elapsed 1h02m",
          "RLM cancelling #ncel_old · extractor · elapsed 1h02m",
          "RLM running #22222222 · journal · elapsed 1h02m",
          "+2 more · /rlm runs · /rlm cancel <id>",
        ],
        "80": [
          "RLM cancelling #ncel_new · finalizing · calls 2a/123t/4f · elapsed 1h02m",
          "RLM cancelling #ncel_old · extractor · calls 2a/123t/4f · elapsed 1h02m",
          "RLM running #22222222 · journal · calls 2a/123t/4f · elapsed 1h02m",
          "+2 more · /rlm runs · /rlm cancel <id>",
        ],
      }
    `);
    for (const [width, lines] of Object.entries(rendered))
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Number(width));
  });

  test("filters, prioritizes cancellation/sequence, and strictly bounds rows", () => {
    const withTerminal = [...items, {
      localId: "rlm_terminal", state: "completed", progress: progress(100),
    } as unknown as RunDisplayItem];
    expect(renderRunDisplay(withTerminal, 59)).toHaveLength(1);
    const lines = renderRunDisplay(withTerminal, 120);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("ncel_new");
    expect(lines[1]).toContain("ncel_old");
    expect(lines[2]).toContain("22222222");
    expect(lines[3]).toContain("+2 more");

    const many: RunDisplayItem[] = Array.from({ length: 31 }, (_, index) => ({
      localId: `rlm_many_${String(index).padStart(2, "0")}`,
      state: "running" as const,
      progress: progress(index),
    }));
    many.push({ localId: "rlm_priority_cancel", state: "cancelling", progress: progress(999) });
    const prioritized = renderRunDisplay(many, 120);
    expect(prioritized[0]).toContain("y_cancel");
    expect(prioritized[3]).toContain("+29 more");
    expect(renderRunDisplay(many, 50)).toEqual(["RLM: 32 active, 1 cancelling · /rlm runs"]);
  });

  test("projection and output omit hidden coordinator and guest fields", () => {
    const runs = items.map((item) => coordinated(item));
    const projection = projectRunDisplayItems(runs);
    const output = renderCoordinatedRuns(runs, 180).join("\n");
    expect(JSON.stringify(projection)).not.toMatch(/hidden-session|authorization|private|objective/u);
    expect(output).not.toMatch(/hidden-session|private|guest|secret/u);
    expect(output).toContain("calls 2a/123t/4f");
    expect(output).toContain("frames 3a/12t");
    expect(output).toContain("tokens 1.2m");
    expect(output).toContain("elapsed 1h02m");
  });
});
