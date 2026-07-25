import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";
import { MockController } from "./mock-controller.ts";
import { FunctionExtractor } from "./extractor.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-e2e-"));

const program = (overrides: Partial<RlmProgram> = {}): RlmProgram => {
  const base = normalizeProgram({
    objective: overrides.objective ?? "test",
    profile: "default",
    inputs: [{ name: "context", adapter: "text", description: "corpus" }],
    outputs: overrides.outputs ?? [{ name: "answer", schema: { type: "string" } }],
  });
  if (!base.ok) throw new Error("bad program");
  return base.value;
};

describe("runProgram e2e", () => {
  test("map/reduce with llm.batch, workspace, and typed answer", async () => {
    const model = new MockModelClient((req) => (req.prompt.includes("count") ? JSON.stringify({ n: 1 }) : "ok"));
    const controller = new MockController([
      {
        reasoning: "chunk, classify, reduce",
        code: `
          phase('classify');
          const chunks = await input.chunks({ targetTokens: 50, maxChunks: 10 });
          const mapped = await llm.batch({
            key: 'classify',
            items: chunks.map((c) => ({
              key: 'c:' + c.sha256,
              prompt: 'count categories',
              context: c,
              schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
            })),
          });
          let total = 0;
          for (const r of mapped) if (r.ok) total += r.value.n;
          workspace.total = total;
          answer({ total });
          'done'`,
      },
    ]);
    const result = await runProgram({
      program: program({ objective: "count", outputs: [{ name: "total", schema: { type: "integer" } }] }),
      sources: { context: "0".repeat(200) + "1".repeat(200) + "2".repeat(100) },
      controller,
      model,
      backend,
      dir: await tmp(),
    });
    expect(result.status).toBe("completed");
    expect(result.completionMode).toBe("answer");
    expect(result.answer).toEqual({ total: 3 });
    expect(model.callCount).toBe(3);
    expect(result.ledger.usage.logicalCalls).toBe(3);
  });

  test("recurse opens a child frame whose answer flows back to the parent", async () => {
    const model = new MockModelClient(() => "unused");
    const controller = new MockController(
      [
        {
          reasoning: "delegate then answer",
          code: `
            const r = await recurse({ key: 'k', objective: 'sub-objective', context: input });
            answer({ answer: r.ok ? r.value : 'child-failed' });
            'root-done'`,
        },
      ],
      () => new MockController([{ reasoning: "child", code: "answer('child-result'); 'child-done'" }]),
    );
    const result = await runProgram({
      program: program({ objective: "parent" }),
      sources: { context: "hello" },
      controller,
      model,
      backend,
      dir: await tmp(),
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "child-result" });
    expect(result.ledger.usage.framesOpened).toBe(1);
  });

  test("parent cell cancellation detaches a delayed child controller without late mutations", async () => {
    class DelayedChildController implements ControllerDriver {
      calls = 0;
      aborted = false;

      async next(_state: FrameState, signal?: AbortSignal): Promise<Cell> {
        this.calls += 1;
        signal?.addEventListener("abort", () => { this.aborted = true; }, { once: true });
        if (this.calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { reasoning: "late child cell", code: "1" };
        }
        return { reasoning: "must not run", code: "answer('late'); 'done'" };
      }

      fork(): ControllerDriver {
        return new DelayedChildController();
      }
    }

    const child = new DelayedChildController();
    const controller = new MockController(
      [{
        reasoning: "delegate",
        code: "await recurse({ key: 'slow', objective: 'slow child', context: input }); 'done'",
      }],
      () => child,
    );
    const dir = await tmp();
    const started = Date.now();
    const result = await runProgram({
      program: program({ objective: "cancel child" }),
      sources: { context: "hello" },
      controller,
      model: new MockModelClient(() => "unused"),
      backend,
      dir,
      profile: { ...DEFAULT_PROFILE, cellWallMs: 50 },
    });

    expect(Date.now() - started).toBeLessThan(250);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CPU_LIMIT");
    expect(child.aborted).toBe(true);
    expect(child.calls).toBe(1);
    const eventsAtFinalization = await readFile(join(dir, "events.jsonl"), "utf8");
    expect(result.ledger.usage.controllerTurns).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(eventsAtFinalization);
    // A late continuation would reserve another controller turn before this
    // second next() call, so one call proves both scheduling and ledger stopped.
    expect(child.calls).toBe(1);
  }, 2_000);

  test("duplicate llm keys coalesce to one model call (cache)", async () => {
    let n = 0;
    const model = new MockModelClient(() => `r${++n}`);
    const controller = new MockController([
      {
        reasoning: "call twice same key",
        code: `
          const a = await llm({ key: 'k', prompt: 'p' });
          const b = await llm({ key: 'k', prompt: 'p' });
          answer({ answer: a.value === b.value ? 'same' : 'diff' });
          'x'`,
      },
    ]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
    });
    expect(result.answer).toEqual({ answer: "same" });
    expect(model.callCount).toBe(1);
  });

  test("turn exhaustion triggers fallback extraction", async () => {
    const model = new MockModelClient(() => "ok");
    const controller = new MockController([
      { reasoning: "noop 1", code: "workspace.a = (workspace.a ?? 0) + 1; workspace.a" },
      { reasoning: "noop 2", code: "workspace.a = (workspace.a ?? 0) + 1; workspace.a" },
    ]);
    const extractor = new FunctionExtractor((evidence) => ({
      ok: true,
      value: { answer: `fallback:${JSON.stringify(evidence.workspace)}` },
    }));
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 2 },
      extractor,
    });
    expect(result.status).toBe("completed");
    expect(result.completionMode).toBe("fallback_extract");
    expect((result.answer as { answer: string }).answer).toContain("fallback");
  });

  test("exhaustion without an extractor fails with NO_ANSWER", async () => {
    const model = new MockModelClient(() => "ok");
    const controller = new MockController([{ reasoning: "noop", code: "1 + 1" }]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 1 },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("NO_ANSWER");
  });

  test("budget exhaustion returns a catchable CallResult, not a throw", async () => {
    const model = new MockModelClient(() => "ok");
    const controller = new MockController([
      {
        reasoning: "two distinct calls under a 1-call budget",
        code: `
          const a = await llm({ key: 'k1', prompt: 'one' });
          const b = await llm({ key: 'k2', prompt: 'two' });
          answer({ answer: (a.ok ? 'ok' : 'a?') + ':' + (b.ok ? 'ok' : b.error.code) });
          'x'`,
      },
    ]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
      profile: { ...DEFAULT_PROFILE, maxLogicalCalls: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "ok:BUDGET_CALLS" });
    expect(model.callCount).toBe(1);
  });

  test("invalid answer is recoverable; the controller corrects on the next turn", async () => {
    const model = new MockModelClient(() => "ok");
    const controller = new MockController([
      { reasoning: "wrong shape", code: "answer({ wrong: 1 }); 'first'" },
      { reasoning: "corrected", code: "answer({ answer: 'fixed' }); 'second'" },
    ]);
    const result = await runProgram({
      program: program(),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "fixed" });
  });

  test("inherited output values do not satisfy the answer contract", async () => {
    const model = new MockModelClient(() => "ok");
    const controller = new MockController([
      { reasoning: "missing own value", code: "answer({}); 'first'" },
      { reasoning: "own value", code: "answer({ toString: 'fixed' }); 'second'" },
    ]);
    const result = await runProgram({
      program: program({ outputs: [{ name: "toString", schema: { type: "string" } }] }),
      sources: { context: "c" },
      controller,
      model,
      backend,
      dir: await tmp(),
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ toString: "fixed" });
  });

  test("context limit and unsupported syntax errors are typed and guest-catchable", async () => {
    const model = new MockModelClient(() => "ok");
    const controller = new MockController([{
      reasoning: "recover from invalid context options",
      code: `
        const codes = [];
        try { await input.grep({ pattern: '(a+)+$', syntax: 're2', maxMatches: 1 }); }
        catch (error) { codes.push(error.code); }
        try { await input.grep({ pattern: 'a', maxMatches: Infinity }); }
        catch (error) { codes.push(error.code); }
        answer({ answer: codes.join(',') });`,
    }]);
    const result = await runProgram({
      program: program(),
      sources: { context: `${"a".repeat(100_000)}!` },
      controller,
      model,
      backend,
      dir: await tmp(),
    });
    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "INVALID_SPEC,INVALID_SPEC" });
  });
});
