import { describe, expect, test } from "bun:test";
import { appendEntry, projectTrajectory, type ProjectionOptions, type TrajectoryEntry } from "./trajectory.ts";

const opts: ProjectionOptions = {
  headEntries: 1,
  tailEntries: 2,
  codeHeadBytes: 8,
  codeTailBytes: 4,
  reasoningMaxBytes: 10,
};

const entry = (i: number): TrajectoryEntry => ({
  iteration: i,
  reasoning: `reasoning number ${i} is quite long`,
  code: `// code cell ${i} `.repeat(4),
  hasResult: true,
  outputPreview: `out${i}`,
});

describe("trajectory projection", () => {
  test("returns all entries when within capacity", () => {
    const entries = [entry(1), entry(2), entry(3)];
    const p = projectTrajectory(entries, opts);
    expect(p.omittedCount).toBe(0);
    expect(p.entries).toHaveLength(3);
  });

  test("keeps head and tail, omits middle", () => {
    const entries = [entry(1), entry(2), entry(3), entry(4), entry(5)];
    const p = projectTrajectory(entries, opts);
    expect(p.total).toBe(5);
    expect(p.omittedCount).toBe(2);
    expect(p.entries.map((e) => e.iteration)).toEqual([1, 4, 5]);
  });

  test("bounds code and reasoning previews", () => {
    const p = projectTrajectory([entry(1)], opts);
    const only = p.entries[0]!;
    expect(only.reasoning.length).toBeLessThanOrEqual(10);
    expect(only.codePreview.truncated).toBe(true);
    expect(only.codePreview.omittedBytes).toBeGreaterThan(0);
  });

  test("appendEntry is immutable", () => {
    const a: readonly TrajectoryEntry[] = [entry(1)];
    const b = appendEntry(a, entry(2));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});
