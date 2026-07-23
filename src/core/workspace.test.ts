import { describe, expect, test } from "bun:test";
import { isArtifactHandle, isContextHandle, validateWorkspace } from "./workspace.ts";

describe("validateWorkspace", () => {
  test("accepts JSON and tagged handles", () => {
    const r = validateWorkspace({
      count: 3,
      items: [1, 2, { nested: true }],
      ctx: { contextId: "ctx_1" },
      art: { artifactId: "art_1" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(isContextHandle(r.value["ctx"]!)).toBe(true);
      expect(isArtifactHandle(r.value["art"]!)).toBe(true);
    }
  });

  test("rejects functions and non-finite numbers with keyed errors", () => {
    const r = validateWorkspace({ good: 1, bad: () => 1, worse: Number.NaN });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const keys = r.error.map((e) => e.key).sort();
      expect(keys).toEqual(["bad", "worse"]);
    }
  });

  test("a two-key object with contextId is treated as plain JSON", () => {
    const r = validateWorkspace({ x: { contextId: "c", extra: 1 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(isContextHandle(r.value["x"]!)).toBe(false);
  });
});
