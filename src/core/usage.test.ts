import { describe, expect, test } from "bun:test";
import { addUsage, ZERO_CALL_USAGE } from "./usage.ts";

describe("usage", () => {
  test("adds attempts and durations; sums optional tokens when present", () => {
    const a = { attempts: 1, durationMs: 10, totalTokens: 100, costUsd: 0.01 };
    const b = { attempts: 2, durationMs: 5, totalTokens: 50 };
    const sum = addUsage(a, b);
    expect(sum.attempts).toBe(3);
    expect(sum.durationMs).toBe(15);
    expect(sum.totalTokens).toBe(150);
    expect(sum.costUsd).toBe(0.01);
  });

  test("optional stays undefined when neither side reports it", () => {
    const sum = addUsage(ZERO_CALL_USAGE, ZERO_CALL_USAGE);
    expect(sum.totalTokens).toBeUndefined();
    expect(sum.costUsd).toBeUndefined();
  });
});
