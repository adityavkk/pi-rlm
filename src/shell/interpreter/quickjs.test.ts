import { beforeAll, describe, expect, test } from "bun:test";
import { transformCell } from "../../core/cell.ts";
import type { JsonValue } from "../../core/json.ts";
import type { CellGlobals, HostDispatch, HostEffect } from "./backend.ts";
import { QuickJsBackend } from "./quickjs.ts";

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const baseGlobals = (workspace: JsonValue = {}): CellGlobals => ({
  objective: "test objective",
  inputs: { context: { id: "ctx_1" } },
  variables: {},
  budget: { depth: 0 },
  workspace,
});

interface RunOpts {
  workspace?: JsonValue;
  dispatch?: HostDispatch;
  effect?: HostEffect;
  deadlineMs?: number;
  signal?: AbortSignal;
}

const run = async (code: string, opts: RunOpts = {}) => {
  const t = transformCell(code);
  if (!t.ok) throw new Error(`transform failed: ${t.error.message}`);
  return backend.evalCell({
    source: t.value.source,
    deadlineMs: opts.deadlineMs ?? Date.now() + 5000,
    memoryBytes: 64 * 1024 * 1024,
    globals: baseGlobals(opts.workspace ?? {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    dispatch: opts.dispatch ?? (async () => null),
    effect: opts.effect ?? (() => {}),
  });
};

describe("QuickJsBackend", () => {
  test("returns implicit last-expression value", async () => {
    const out = await run("const x = 40;\nx + 2");
    expect(out.kind).toBe("value");
    if (out.kind === "value") {
      expect(out.result).toBe(42);
      expect(out.hasResult).toBe(true);
    }
  });

  test("round-trips and mutates workspace", async () => {
    const out = await run("workspace.n = (workspace.n ?? 0) + 1;\nworkspace.n", { workspace: { n: 4 } });
    expect(out.kind).toBe("value");
    if (out.kind === "value") {
      expect(out.result).toBe(5);
      expect((out.workspace as { n: number }).n).toBe(5);
      expect(out.workspaceInvalidPaths).toHaveLength(0);
    }
  });

  test("awaits async host dispatch and passes args", async () => {
    const calls: Array<{ name: string; args: JsonValue }> = [];
    const dispatch: HostDispatch = async (name, args) => {
      calls.push({ name, args });
      await new Promise((r) => setTimeout(r, 3));
      return { ok: true, value: `echo:${(args as { prompt: string }).prompt}` };
    };
    const out = await run(
      "const a = await llm({ key: 'k1', prompt: 'one' });\nconst b = await llm({ key: 'k2', prompt: 'two' });\n[a, b]",
      { dispatch },
    );
    expect(out.kind).toBe("value");
    if (out.kind === "value") expect(out.result).toEqual([{ ok: true, value: "echo:one" }, { ok: true, value: "echo:two" }]);
    expect(calls.map((c) => c.name)).toEqual(["llm", "llm"]);
  });

  test("guest throw becomes a recoverable guest_error", async () => {
    const out = await run("throw new Error('boom')");
    expect(out.kind).toBe("guest_error");
    if (out.kind === "guest_error") expect(out.message).toContain("boom");
  });

  test("infinite loop is interrupted as CPU_LIMIT", async () => {
    const out = await run("while (true) {}", { deadlineMs: Date.now() + 50 });
    expect(out.kind).toBe("terminal");
    if (out.kind === "terminal") expect(out.error.code).toBe("CPU_LIMIT");
  });

  test("owner cancellation aborts dispatch and nested evaluation", async () => {
    const owner = new AbortController();
    let dispatchAborted = false;
    const started = Date.now();
    const timer = setTimeout(() => owner.abort(), 20);
    const out = await run("await llm({ key: 'k', prompt: 'p' })", {
      signal: owner.signal,
      deadlineMs: started + 250,
      dispatch: async (_name, _args, signal) => {
        signal.addEventListener("abort", () => { dispatchAborted = true; }, { once: true });
        return new Promise<never>(() => {});
      },
    });
    clearTimeout(timer);
    expect(Date.now() - started).toBeLessThan(200);
    expect(out.kind).toBe("terminal");
    if (out.kind === "terminal") expect(out.error.code).toBe("DISPOSED");
    expect(dispatchAborted).toBe(true);
  });

  test("unawaited host work fails the cell", async () => {
    const dispatch: HostDispatch = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return null;
    };
    // fire without await, then return synchronously
    const out = await run("llm({ key: 'k', prompt: 'p' });\n1", { dispatch });
    expect(out.kind).toBe("guest_error");
    if (out.kind === "guest_error") expect(out.message).toContain("UNAWAITED_WORK");
  });

  test("synchronous effects are delivered (phase, emit, answer, console)", async () => {
    const effects: Array<{ name: string; args: JsonValue }> = [];
    const effect: HostEffect = (name, args) => effects.push({ name, args });
    const out = await run(
      "phase('classify');\nconsole.log('hi', 2);\nemit({ message: 'progress', current: 1 });\nanswer({ done: true });\n'ok'",
      { effect },
    );
    expect(out.kind).toBe("value");
    expect(effects.map((e) => e.name)).toEqual(["phase", "console", "emit", "answer"]);
    expect(effects[3]!.args).toEqual({ value: { done: true } });
  });

  test("snapshots effects with captured intrinsics and rejects unsafe payload traversal", async () => {
    const effects: Array<{ name: string; args: JsonValue }> = [];
    const out = await run(`
      const nativeStringify = JSON.stringify;
      JSON.stringify = () => '{"value":{"forged":true}}';
      JSON.parse = () => ({ value: { forged: true } });
      answer(undefined);
      answer({ actual: true });
      const cycle = {}; cycle.self = cycle; answer(cycle);
      const accessor = {};
      Object.defineProperty(accessor, "secret", { enumerable: true, get() { while (true) {} } });
      answer(accessor);
      let proxyTrapRan = false;
      const proxy = new Proxy({}, { ownKeys() { proxyTrapRan = true; while (true) {} } });
      answer(proxy);
      workspace.proxyTrapRan = proxyTrapRan;
      nativeStringify(proxyTrapRan);
    `, { effect: (name, args) => effects.push({ name, args }) });

    expect(out.kind).toBe("value");
    expect(effects).toEqual([
      { name: "answer", args: null },
      { name: "answer", args: { value: { actual: true } } },
      { name: "answer", args: null },
      { name: "answer", args: null },
      { name: "answer", args: null },
    ]);
    if (out.kind === "value") expect(out.workspace).toEqual({ proxyTrapRan: false });
  });

  test("flags non-serializable workspace values", async () => {
    const out = await run("workspace.fn = () => 1;\n1");
    expect(out.kind).toBe("value");
    if (out.kind === "value") expect(out.workspaceInvalidPaths).toContain("fn");
  });

  test("fresh context per cell: no lexical leakage across cells", async () => {
    await run("const leaked = 123; leaked");
    const out = await run("typeof leaked");
    expect(out.kind).toBe("value");
    if (out.kind === "value") expect(out.result).toBe("undefined");
  });

  test("Math.random and Date are withheld", async () => {
    const rnd = await run("Math.random()");
    expect(rnd.kind).toBe("guest_error");
    const date = await run("typeof Date");
    if (date.kind === "value") expect(date.result).toBe("undefined");
  });
});
