import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import type { RlmEvent } from "../core/journal.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import type { ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { FunctionExtractor } from "./extractor.ts";
import { MockController } from "./mock-controller.ts";
import { ModelController } from "./model-controller.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => {
  backend = await QuickJsBackend.create();
});

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-accounting-"));

const program = (): RlmProgram => {
  const normalized = normalizeProgram({
    objective: "account every model effect",
    profile: "default",
    inputs: [],
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
      program: program(), sources: {}, controller: new MockController([]), model, backend, dir,
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
      extractor: new FunctionExtractor(() => ({ ok: true, value: { answer: "external" } })),
    });

    expect(result.answer).toEqual({ answer: "external" });
    expect(model.callCount).toBe(0);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, tokensUsed: 0 });
    const attempt = (await events(dir)).find((event) => event.type === "provider_attempted");
    expect(attempt).toMatchObject({ type: "provider_attempted", kind: "extractor", outcome: "ok", usage: { attempts: 1 } });
  });

  test("provider fallback can call the model only through the shared boundary", async () => {
    const model = new MockModelClient(() => usageResponse('{"answer":"provider"}', 3, 4, 0.05, 9));
    const result = await runProgram({
      program: program(), sources: {}, controller: new MockController([]), model, backend, dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
      extractor: new FunctionExtractor(async (_evidence, _signal, operation) => {
        const response = await operation.complete({ prompt: "extract", system: "strict", maxOutputTokens: 32 });
        return { ok: true, value: JSON.parse(response.text) };
      }, "provider"),
    });

    expect(result.answer).toEqual({ answer: "provider" });
    expect(model.callCount).toBe(1);
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
      program: program(), sources: {}, controller: new MockController([]), model, backend, dir: await tmp(),
      signal: new AbortController().signal,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 0 },
      extractor: new FunctionExtractor(() => ({ ok: true, value: { answer: "hidden" } }), "provider"),
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
