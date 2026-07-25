import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { callError } from "../core/errors.ts";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify } from "../core/json.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { JournalAppendError, JournalStore, type JournalAppendOutcome } from "../shell/journal-store.ts";
import type { ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { tokenReservation } from "./broker.ts";
import { FunctionExtractor } from "./extractor.ts";
import { MockController } from "./mock-controller.ts";
import { ModelController } from "./model-controller.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { ModelInvocationError } from "./provider.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-accounting-"));

const program = (withEvidenceInput = false): RlmProgram => {
  const normalized = normalizeProgram({
    objective: "account every model effect",
    profile: "default",
    inputs: withEvidenceInput ? [{ name: "context", adapter: "text", description: "fallback evidence" }] : [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid test program");
  return normalized.value;
};

const events = async (dir: string): Promise<RlmEvent[]> =>
  (await readFile(join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RlmEvent);

const usageResponse = (
  text: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  durationMs: number,
): ModelResponse => ({
  text,
  usage: {
    attempts: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    durationMs,
  },
});

describe("tree-wide model accounting", () => {
  test("maxAttempts:0 blocks controller and provider invocation", async () => {
    const model = new MockModelClient(() => "must not run");
    const result = await runProgram({
      program: program(),
      sources: {},
      controller: new ModelController(model),
      model,
      backend,
      dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxAttempts: 0 },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "BUDGET_ATTEMPTS" },
      ledger: { usage: { controllerTurns: 0, logicalCalls: 0, attempts: 0, tokensReserved: 0 } },
    });
    expect(model.callCount).toBe(0);
  });

  test("controller primary and repair are one turn, one logical call, and two attempts", async () => {
    const outputs = [
      usageResponse("not-json", 5, 2, 0.1, 4),
      usageResponse(JSON.stringify({ reasoning: "fixed", code: "answer({ answer: 'ok' })" }), 7, 8, 0.2, 6),
    ];
    const model = new MockModelClient(() => outputs.shift()!);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: {}, controller: new ModelController(model), model, backend, dir,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(model.callCount).toBe(2);
    expect(result.ledger.usage).toMatchObject({
      controllerTurns: 1,
      logicalCalls: 1,
      attempts: 2,
      tokensUsed: 22,
      inputTokensUsed: 12,
      outputTokensUsed: 10,
      costUsd: 0.30000000000000004,
      providerDurationMs: 10,
      tokensReserved: 0,
      activeLeafCalls: 0,
    });
    const journal = await events(dir);
    const attempts = journal.filter((event) => event.type === "provider_attempted");
    expect(attempts).toHaveLength(2);
    expect(attempts.every((event) => event.type === "provider_attempted" && event.kind === "controller")).toBe(true);
    const cell = journal.find((event) => event.type === "cell_committed");
    expect(cell?.type === "cell_committed" && cell.usage).toMatchObject({ attempts: 2, totalTokens: 22, costUsd: 0.30000000000000004 });
  });

  test("recursive-frame controller usage is scoped to recurse without double settlement", async () => {
    const outputs = [
      JSON.stringify({
        reasoning: "delegate",
        code: "const r = await recurse({ key: 'child', objective: 'child' }); answer({ answer: r.value })",
      }),
      JSON.stringify({ reasoning: "child", code: "answer('nested')" }),
    ];
    const model = new MockModelClient(() => outputs.shift()!);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: {}, controller: new ModelController(model), model, backend, dir,
      signal: new AbortController().signal,
    });

    expect(result.answer).toEqual({ answer: "nested" });
    expect(model.callCount).toBe(2);
    expect(result.ledger.usage).toMatchObject({ framesOpened: 1, logicalCalls: 3, attempts: 2 });
    const journal = await events(dir);
    const recurse = journal.find((event) => event.type === "call_committed" && event.kind === "recurse");
    expect(recurse?.type === "call_committed" && recurse.usage.attempts).toBe(1);
    expect(journal.filter((event) => event.type === "provider_attempted")).toHaveLength(2);
  });

  test("leaf structured repair uses the same operation and counts both attempts", async () => {
    const outputs = ["not-json", JSON.stringify({ value: "fixed" })];
    const model = new MockModelClient(() => outputs.shift()!);
    const dir = await tmp();
    const controller = new MockController([{
      reasoning: "repair leaf",
      code: `
        const r = await llm({
          key: 'structured',
          prompt: 'return value',
          schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
        });
        answer({ answer: r.ok ? r.value.value : r.error.code });`,
    }]);
    const result = await runProgram({
      program: program(), sources: {}, controller, model, backend, dir,
      signal: new AbortController().signal,
    });

    expect(result.answer).toEqual({ answer: "fixed" });
    expect(model.callCount).toBe(2);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 2, tokensReserved: 0, activeLeafCalls: 0 });
    const call = (await events(dir)).find((event) => event.type === "call_committed" && event.kind === "llm");
    expect(call?.type === "call_committed" && call.usage.attempts).toBe(2);
  });

  test("external fallback has an explicit logical-operation and attempt contract", async () => {
    const dir = await tmp();
    const model = new MockModelClient(() => "unused");
    const result = await runProgram({
      program: program(true), sources: { context: "represented evidence" }, controller: new MockController([]), model, backend, dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
      extractor: new FunctionExtractor((evidence) => ({
        ok: true,
        value: { answer: "external" },
        evidenceRefs: [evidence.handles[0]!.evidenceId!],
      })),
    });

    expect(result.answer).toEqual({ answer: "external" });
    expect(model.callCount).toBe(0);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, tokensUsed: 0 });
    const attempt = (await events(dir)).find((event) => event.type === "provider_attempted");
    expect(attempt).toMatchObject({ type: "provider_attempted", kind: "extractor", outcome: "ok", usage: { attempts: 1 } });
  });

  test("provider fallback can call the model only through the shared boundary", async () => {
    let modelRequest: ModelRequest | undefined;
    const model = new MockModelClient((request) => {
      modelRequest = request;
      const evidenceId = request.prompt.match(/ev_[a-f0-9]{64}/)?.[0];
      if (!evidenceId) throw new Error("model prompt omitted evidence IDs");
      return usageResponse(JSON.stringify({
        value: { answer: "provider" }, evidenceRefs: [evidenceId],
      }), 3, 4, 0.05, 9);
    });
    const result = await runProgram({
      program: program(true), sources: { context: "represented evidence" }, controller: new MockController([]), model, backend, dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
      extractor: new FunctionExtractor(async (_evidence, _signal, operation) => {
        const response = await operation.complete({ prompt: "extract", system: "strict", maxOutputTokens: 32 });
        const envelope = JSON.parse(response.text) as { value: { answer: string }; evidenceRefs: string[] };
        return { ok: true, ...envelope };
      }, "provider"),
    });

    expect(result.answer).toEqual({ answer: "provider" });
    expect(model.callCount).toBe(1);
    expect(modelRequest?.prompt).toContain("evidenceRefs");
    expect(modelRequest?.prompt).toMatch(/ev_[a-f0-9]{64}/);
    expect(modelRequest?.schema).toMatchObject({
      required: ["value", "evidenceRefs"],
      properties: { evidenceRefs: { type: "array" } },
    });
    expect(result.ledger.usage).toMatchObject({
      logicalCalls: 1,
      attempts: 1,
      tokensUsed: 7,
      costUsd: 0.05,
      providerDurationMs: 9,
    });
  });

  test("provider extractor that skips its boundary fails instead of becoming free work", async () => {
    const model = new MockModelClient(() => "unused");
    const result = await runProgram({
      program: program(true), sources: { context: "represented evidence" }, controller: new MockController([]), model, backend, dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
      extractor: new FunctionExtractor((evidence) => ({
        ok: true,
        value: { answer: "hidden" },
        evidenceRefs: [evidence.handles[0]!.evidenceId!],
      }), "provider"),
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    expect(model.callCount).toBe(0);
  });

  test("invalid leaf token and batch concurrency values fail before provider spend", async () => {
    const model = new MockModelClient(() => "must not run");
    const controller = new MockController([{
      reasoning: "validate first",
      code: `
        const codes = [];
        for (const value of [-1, NaN, Infinity]) {
          try { await llm({ key: 'tokens:' + String(value), prompt: 'x', maxOutputTokens: value }); }
          catch (error) { codes.push(error.code); }
        }
        for (const value of [-1, NaN, Infinity]) {
          try { await llm.batch({ key: 'batch:' + String(value), concurrency: value, items: [{ key: 'item:' + String(value), prompt: 'x' }] }); }
          catch (error) { codes.push(error.code); }
        }
        answer({ answer: codes.join(',') });`,
    }]);
    const result = await runProgram({
      program: program(), sources: {}, controller, model, backend, dir: await tmp(),
      signal: new AbortController().signal,
    });

    expect(result.answer).toEqual({ answer: Array(6).fill("INVALID_SPEC").join(",") });
    expect(model.callCount).toBe(0);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 0, attempts: 0 });
  });

  test("invalid profile concurrency rejects before journal or controller effects", async () => {
    for (const maxConcurrency of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const dir = await tmp();
      let controllerCalls = 0;
      const controller = {
        async next() { controllerCalls += 1; return { reasoning: "bad", code: "1" }; },
        fork() { return this; },
      };
      const work = runProgram({
        program: program(), sources: {}, controller, model: new MockModelClient(() => "unused"), backend, dir,
        signal: new AbortController().signal,
        profile: { ...DEFAULT_PROFILE, maxConcurrency },
      });
      await expect(work).rejects.toThrow("maxConcurrency must be a positive safe integer");
      expect(controllerCalls).toBe(0);
      expect(await readdir(dir)).toEqual([]);
    }
  });
});

describe("reviewed accounting boundaries", () => {
  test("token reservation grows with canonical structured-schema bytes", () => {
    const small = { type: "object", properties: { value: { type: "string" } } };
    const large = { ...small, description: "schema-content".repeat(400) };
    const request = { prompt: "p", maxOutputTokens: 32 };
    const expected = (schema: typeof small | typeof large) =>
      Math.ceil(Buffer.byteLength(`p${canonicalStringify(schema)}`, "utf8") / 4) + 32;

    expect(tokenReservation({ ...request, schema: small })).toBe(expected(small));
    expect(tokenReservation({ ...request, schema: large })).toBe(expected(large));
    expect(tokenReservation({ ...request, schema: large })).toBeGreaterThan(tokenReservation({ ...request, schema: small })!);
  });

  test("external extractor settles once when provider-attempt journal cache refresh fails", async () => {
    const dir = await tmp();
    class CacheFailJournal extends JournalStore {
      private injected = false;
      override async append(event: RlmEvent): Promise<JournalAppendOutcome> {
        const outcome = await super.append(event);
        if (!this.injected && event.type === "provider_attempted") {
          this.injected = true;
          return {
            ...outcome,
            statusCache: {
              state: "failed",
              error: new JournalAppendError("status_cache", true, new Error("injected")),
            },
          };
        }
        return outcome;
      }
    }
    const result = await runProgram({
      program: program(true), sources: { context: "represented evidence" }, controller: new MockController([]), model: new MockModelClient(() => "unused"), backend, dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
      extractor: new FunctionExtractor((evidence) => ({
        ok: true,
        value: { answer: "external" },
        evidenceRefs: [evidence.handles[0]!.evidenceId!],
      })),
      journal: new CacheFailJournal(dir),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "JOURNAL_FAILED", cause: { name: "JournalAppendError" } },
      ledger: { usage: { logicalCalls: 1, attempts: 1, activeLeafCalls: 0 } },
    });
    expect((await events(dir)).filter((event) => event.type === "provider_attempted")).toHaveLength(1);
  });

  test("external extractor receives no nested completion capability at maxConcurrency one", async () => {
    let argumentCount = 0;
    const model = new MockModelClient(() => "must not run");
    const extractor = new FunctionExtractor((...args) => {
      argumentCount = args.length;
      return {
        ok: true,
        value: { answer: "external" },
        evidenceRefs: [args[0].handles[0]!.evidenceId!],
      };
    });
    const result = await runProgram({
      program: program(true), sources: { context: "represented evidence" }, controller: new MockController([]), model, backend, dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0, maxConcurrency: 1 },
      extractor,
    });

    expect(result).toMatchObject({ status: "completed", answer: { answer: "external" } });
    expect(argumentCount).toBe(2);
    expect(model.callCount).toBe(0);
    expect(result.ledger.usage.activeLeafCalls).toBe(0);
  });

  test("same recurse key under two parent lineages runs isolated child frames", async () => {
    const controller = {
      async next(state: { objective: string }) {
        if (state.objective === "account every model effect") return {
          reasoning: "open siblings",
          code: `
            const [left, right] = await Promise.all([
              recurse({ key: 'left', objective: 'left-parent' }),
              recurse({ key: 'right', objective: 'right-parent' }),
            ]);
            answer({ answer: left.ok && right.ok ? left.value + right.value : 'failed' });`,
        };
        if (state.objective === "leaf") return { reasoning: "leaf", code: "answer('leaf')" };
        return {
          reasoning: "same nested key",
          code: `const child = await recurse({ key: 'shared-child', objective: 'leaf' }); answer(child.value);`,
        };
      },
      fork() { return this; },
    };
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: {}, controller, model: new MockModelClient(() => "unused"), backend, dir,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "completed", answer: { answer: "leafleaf" } });
    expect(result.ledger.usage.framesOpened).toBe(4);
    const shared = (await events(dir)).filter((event) =>
      event.type === "call_committed" && event.kind === "recurse" && event.key === "shared-child");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((event) => event.type === "call_committed" ? event.callId : "")).size).toBe(2);
  });

  test("failed recurse result is not cached and identical retry keeps its binding", async () => {
    let childRuns = 0;
    const controller = {
      async next(state: { objective: string }) {
        if (state.objective === "account every model effect") return {
          reasoning: "retry child",
          code: `
            const first = await recurse({ key: 'retry-child', objective: 'transient-child' });
            const second = await recurse({ key: 'retry-child', objective: 'transient-child' });
            answer({ answer: !first.ok && second.ok ? second.value : 'failed' });`,
        };
        childRuns += 1;
        if (childRuns === 1)
          throw new ModelInvocationError(callError("FAILED", "transient provider failure"), ZERO_CALL_USAGE);
        return { reasoning: "retry succeeds", code: "answer('retried')" };
      },
      fork() { return this; },
    };
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: {}, controller, model: new MockModelClient(() => "unused"), backend, dir,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "completed", answer: { answer: "retried" } });
    expect(childRuns).toBe(2);
    expect(result.ledger.usage.framesOpened).toBe(2);
    const retried = (await events(dir)).filter((event) =>
      event.type === "call_committed" && event.kind === "recurse" && event.key === "retry-child");
    expect(retried.map((event) => event.type === "call_committed" && event.ok)).toEqual([false, true]);
    expect(new Set(retried.map((event) => event.type === "call_committed" ? event.callId : "")).size).toBe(1);
  });

  test("every trajectory numeric field rejects negative, nonfinite, fractional, and unsafe values before effects", async () => {
    const fields = ["headEntries", "tailEntries", "codeHeadBytes", "codeTailBytes", "reasoningMaxBytes"] as const;
    const invalid = [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, Number.MAX_SAFE_INTEGER + 1];
    for (const field of fields) {
      for (const value of invalid) {
        const dir = await tmp();
        const work = runProgram({
          program: program(), sources: {}, controller: new MockController([]), model: new MockModelClient(() => "unused"), backend, dir,
          signal: new AbortController().signal,
          profile: { ...DEFAULT_PROFILE, trajectory: { ...DEFAULT_PROFILE.trajectory, [field]: value } },
        });
        await expect(work).rejects.toThrow(`trajectory.${field} must be a nonnegative safe integer`);
        expect(await readdir(dir)).toEqual([]);
      }
    }
  });

  test("trajectory projection capacity sums must remain safe integers", async () => {
    for (const trajectory of [
      { ...DEFAULT_PROFILE.trajectory, headEntries: Number.MAX_SAFE_INTEGER, tailEntries: 1 },
      { ...DEFAULT_PROFILE.trajectory, codeHeadBytes: Number.MAX_SAFE_INTEGER, codeTailBytes: 1 },
    ]) {
      const dir = await tmp();
      const work = runProgram({
        program: program(), sources: {}, controller: new MockController([]), model: new MockModelClient(() => "unused"), backend, dir,
        signal: new AbortController().signal,
        profile: { ...DEFAULT_PROFILE, trajectory },
      });
      await expect(work).rejects.toThrow("capacity");
      expect(await readdir(dir)).toEqual([]);
    }
  });
});
