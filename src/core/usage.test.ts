import { describe, expect, test } from "bun:test";
import { addUsage, ZERO_CALL_USAGE } from "./usage.ts";

describe("usage", () => {
  test("adds attempts and durations; sums optional tokens when present", () => {
    const a = { attempts: 1, durationMs: 10, totalTokens: 100, costUsd: 0.01 };
    const b = { attempts: 2, durationMs: 5, totalTokens: 50 };
    const sum = addUsage(a, b);
    expect(sum.ok).toBe(true);
    if (!sum.ok) return;
    expect(sum.value.attempts).toBe(3);
    expect(sum.value.durationMs).toBe(15);
    expect(sum.value.totalTokens).toBe(150);
    expect(sum.value.costUsd).toBe(0.01);
  });

  test("optional stays undefined when neither side reports it", () => {
    const sum = addUsage(ZERO_CALL_USAGE, ZERO_CALL_USAGE);
    expect(sum.ok).toBe(true);
    if (!sum.ok) return;
    expect(sum.value.totalTokens).toBeUndefined();
    expect(sum.value.costUsd).toBeUndefined();
  });

  test("rejects unsafe integers and repeated near-overflow values", () => {
    expect(addUsage(
      { attempts: Number.MAX_VALUE, durationMs: 0 },
      ZERO_CALL_USAGE,
    )).toMatchObject({ ok: false, error: { code: "INVALID_USAGE" } });
    expect(addUsage(
      { attempts: Number.MAX_SAFE_INTEGER, durationMs: Number.MAX_SAFE_INTEGER },
      { attempts: 1, durationMs: 1 },
    )).toMatchObject({ ok: false, error: { code: "INVALID_USAGE" } });
  });

  test("rejects huge repeated costs without producing Infinity", () => {
    const usage = { attempts: 1, durationMs: 1, costUsd: 10_000_000_000 };
    expect(addUsage(usage, usage)).toMatchObject({ ok: false, error: { code: "INVALID_USAGE" } });
  });
});
