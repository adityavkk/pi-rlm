import { describe, expect, test } from "bun:test";
import { cloneBoundedJson } from "./bounded-json.ts";

describe("delegation bounded JSON", () => {
  test("rejects a wide object at the node cap without cloning the remainder", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 10_000; index += 1) wide[`key-${index}`] = index;
    expect(cloneBoundedJson(wide, { maxBytes: 10 * 1024 * 1024, maxNodes: 16, maxDepth: 10 }))
      .toEqual({ ok: false });
  });

  test("rejects array extras, cycles, accessors, and proxies without invoking code", () => {
    const extra = [1, 2] as number[] & { extra?: number };
    extra.extra = 3;
    expect(cloneBoundedJson(extra, { maxBytes: 1024, maxNodes: 16, maxDepth: 10 })).toEqual({ ok: false });

    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(cloneBoundedJson(cycle, { maxBytes: 1024, maxNodes: 16, maxDepth: 10 })).toEqual({ ok: false });

    let getterCalls = 0;
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { getterCalls += 1; return "bad"; } });
    expect(cloneBoundedJson(accessor, { maxBytes: 1024, maxNodes: 16, maxDepth: 10 })).toEqual({ ok: false });
    expect(getterCalls).toBe(0);

    let traps = 0;
    const proxy = new Proxy({}, { ownKeys() { traps += 1; return []; } });
    expect(cloneBoundedJson(proxy, { maxBytes: 1024, maxNodes: 16, maxDepth: 10 })).toEqual({ ok: false });
    expect(traps).toBe(0);
  });
});
