import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLedger } from "../core/budget.ts";
import { normalizeProgram } from "../core/program.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import { type Clock, ManualClock, systemClock } from "../shell/clock.ts";
import { ContextStore } from "../shell/context-store.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalAppendError, JournalStore } from "../shell/journal-store.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelClient, ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { PiModelClient, PiModelError } from "../shell/model/pi-model.ts";
import { dispatchCall, retainCallResult, tokenReservation } from "./broker.ts";
import { type GuestCallResult, okResult } from "./call-result.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import { Semaphore } from "./semaphore.ts";
import type { FrameRef, RunState } from "./state.ts";
import { retainedJsonBytes } from "./stored-bytes.ts";

const modelIdentity = (fixture: string) => ({ id: "test/mock-model-handler", version: "1", configuration: { fixture } } as const);

const within = async <T>(promise: Promise<T>, timeoutMs = 250): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const brokerState = async (model: ModelClient, runId: string, clock: Clock = systemClock): Promise<RunState> => {
  const normalized = normalizeProgram({
    objective: "broker error boundary",
    profile: "default",
    inputs: [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid test program");
  const dir = await mkdtemp(join(tmpdir(), "pi-rlm-broker-"));
  const startMs = clock.now();
  return {
    runId,
    startMs,
    profile: DEFAULT_PROFILE,
    clock,
    hasher: sha256,
    program: normalized.value,
    ledger: { current: createLedger(resolveLimits(DEFAULT_PROFILE, startMs)) },
    store: new ContextStore(dir),
    artifacts: new Map(),
    model,
    journal: new JournalStore(dir),
    backend: {} as InterpreterBackend,
    callCache: new Map(),
    inflight: new Map(),
    keyIdentities: new Map(),
    scopeUsage: new Map(),
    semaphore: new Semaphore(1),
    contextSemaphore: new Semaphore(1),
    frameSeq: { current: 1 },
  };
};

const testFrame: FrameRef = { frameId: "frame", depth: 0, objective: "test", inputs: {}, outputs: [] };
const noRecurse = async (): Promise<GuestCallResult> => { throw new Error("unexpected recurse"); };

describe("tokenReservation", () => {
  test("counts system, prompt, every context, and output allowance", () => {
    const request: ModelRequest = {
      system: "s".repeat(400_002),
      prompt: "p".repeat(400_001),
      context: ["a".repeat(400_003), "b".repeat(400_004)],
      maxOutputTokens: 2_048,
    };

    expect(tokenReservation(request)).toBe(Math.ceil(1_600_010 / 4) + 2_048);
  });
});

describe("dispatchCall cancellation ownership", () => {
  test("releases a timed-out holder and aborted waiter, then admits an independent call", async () => {
    let rejectStuck!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const prompts: string[] = [];
    const model: ModelClient = {
      identity: { id: "test/model-client", version: "1", configuration: { fixture: "src/runtime/broker.test.ts:94" } },
      id: "abort-ignoring-model",
      complete(request: ModelRequest): Promise<ModelResponse> {
        prompts.push(request.prompt);
        if (request.prompt === "stuck") {
          markStarted();
          return new Promise((_resolve, reject) => { rejectStuck = reject; });
        }
        return Promise.resolve({ text: "next-ok", usage: ZERO_CALL_USAGE });
      },
    };

    const normalized = normalizeProgram({
      objective: "broker cancellation",
      profile: "default",
      inputs: [],
      outputs: [{ name: "answer", schema: { type: "string" } }],
    });
    if (!normalized.ok) throw new Error("invalid test program");
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-broker-"));
    const startMs = Date.now();
    const profile = { ...DEFAULT_PROFILE, maxConcurrency: 1 };
    const state: RunState = {
      runId: "run_broker_abort",
      startMs,
      profile,
      clock: systemClock,
      hasher: sha256,
      program: normalized.value,
      ledger: { current: createLedger(resolveLimits(profile, startMs)) },
      store: new ContextStore(dir),
      artifacts: new Map(),
      model,
      journal: new JournalStore(dir),
      backend: {} as InterpreterBackend,
      callCache: new Map(),
      inflight: new Map(),
      keyIdentities: new Map(),
      scopeUsage: new Map(),
      semaphore: new Semaphore(1),
      contextSemaphore: new Semaphore(1),
      frameSeq: { current: 1 },
    };
    const frame: FrameRef = { frameId: "frame", depth: 0, objective: "test", inputs: {}, outputs: [] };
    const recurse = async (): Promise<GuestCallResult> => { throw new Error("unexpected recurse"); };
    const deadlineMs = Date.now() + 5_000;

    const holderAbort = new AbortController();
    const holder = dispatchCall(
      state,
      frame,
      "llm",
      { key: "holder", prompt: "stuck" },
      recurse,
      holderAbort.signal,
      deadlineMs,
    ) as Promise<GuestCallResult>;
    await within(started);

    const waiterAbort = new AbortController();
    const waiter = dispatchCall(
      state,
      frame,
      "llm",
      { key: "waiter", prompt: "must-not-start" },
      recurse,
      waiterAbort.signal,
      deadlineMs,
    ) as Promise<GuestCallResult>;
    await within((async () => {
      while (state.inflight.size !== 2) await new Promise((resolve) => setTimeout(resolve, 1));
    })());
    expect(state.inflight.size).toBe(2);
    expect(state.ledger.current.usage.logicalCalls).toBe(1);

    waiterAbort.abort();
    const waiterResult = await within(waiter);
    expect(waiterResult.error?.code).toBe("CANCELLED");
    expect(state.inflight.size).toBe(1);
    expect(state.ledger.current.usage.logicalCalls).toBe(1);

    const holderDeadline = setTimeout(() => holderAbort.abort(), 20);
    const holderResult = await within(holder);
    clearTimeout(holderDeadline);
    expect(holderResult.error?.code).toBe("CANCELLED");
    expect(state.inflight.size).toBe(0);
    expect(state.ledger.current.usage.logicalCalls).toBe(1);
    expect(state.ledger.current.usage.attempts).toBe(1);
    expect(state.ledger.current.usage.activeLeafCalls).toBe(0);
    expect(state.ledger.current.usage.tokensReserved).toBe(0);
    expect(state.callCache.size).toBe(0);

    rejectStuck(new Error("late model rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.inflight.size).toBe(0);
    expect(state.callCache.size).toBe(0);

    const next = await within(dispatchCall(
      state,
      frame,
      "llm",
      { key: "next", prompt: "next" },
      recurse,
      new AbortController().signal,
      deadlineMs,
    ) as Promise<GuestCallResult>);
    expect(next.ok).toBe(true);
    expect(next.value).toBe("next-ok");
    expect(prompts).toEqual(["stuck", "next"]);
    expect(state.inflight.size).toBe(0);
    expect(state.callCache.size).toBe(1);
  });

  test("preserves bounded Pi failure metadata and reported usage", async () => {
    const usage = { attempts: 1, inputTokens: 8, outputTokens: 3, totalTokens: 11, costUsd: 0.04, durationMs: 75 };
    const model: ModelClient = {
      identity: { id: "test/model-client", version: "1", configuration: { fixture: "src/runtime/broker.test.ts:210" } },
      id: "typed-failure",
      async complete(): Promise<ModelResponse> {
        throw new PiModelError("PROVIDER_ERROR", "error", "test-provider", "test-model", usage, "sensitive provider message");
      },
    };
    const normalized = normalizeProgram({
      objective: "broker metadata",
      profile: "default",
      inputs: [],
      outputs: [{ name: "answer", schema: { type: "string" } }],
    });
    if (!normalized.ok) throw new Error("invalid test program");
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-broker-"));
    const startMs = Date.now();
    const state: RunState = {
      runId: "run_broker_metadata",
      startMs,
      profile: DEFAULT_PROFILE,
      clock: systemClock,
      hasher: sha256,
      program: normalized.value,
      ledger: { current: createLedger(resolveLimits(DEFAULT_PROFILE, startMs)) },
      store: new ContextStore(dir),
      artifacts: new Map(),
      model,
      journal: new JournalStore(dir),
      backend: {} as InterpreterBackend,
      callCache: new Map(),
      inflight: new Map(),
      keyIdentities: new Map(),
      scopeUsage: new Map(),
      semaphore: new Semaphore(1),
      contextSemaphore: new Semaphore(1),
      frameSeq: { current: 1 },
    };
    const result = await dispatchCall(
      state,
      { frameId: "frame", depth: 0, objective: "test", inputs: {}, outputs: [] },
      "llm",
      { key: "failure", prompt: "fail" },
      async () => { throw new Error("unexpected recurse"); },
      new AbortController().signal,
      Date.now() + 5_000,
    ) as GuestCallResult;

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "FAILED",
        message: "model provider failed",
        retryable: true,
        details: { stopReason: "error", provider: "test-provider", model: "test-model", usage },
      },
      usage,
    });
    expect(JSON.stringify(result)).not.toContain("sensitive provider message");
    expect(state.ledger.current.usage.tokensReserved).toBe(0);
  });

  test("passes sanitized runtime rejection metadata through to the guest", async () => {
    const clock = new ManualClock();
    const runtime = {
      getModel: () => ({ provider: "test-provider", id: "test-model" }),
      completeSimple: async () => {
        clock.advance(47);
        throw new Error("sensitive runtime failure");
      },
    } as unknown as ModelRuntime;
    const state = await brokerState(
      new PiModelClient(runtime, "test-provider/test-model", clock),
      "run_runtime_failure",
      clock,
    );
    const result = await dispatchCall(
      state,
      testFrame,
      "llm",
      { key: "runtime-failure", prompt: "fail", model: { model: "test-provider/test-model" } },
      noRecurse,
      new AbortController().signal,
      clock.now() + 5_000,
    ) as GuestCallResult;

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "FAILED",
        message: "model provider failed",
        details: {
          stopReason: "error",
          provider: "test-provider",
          model: "test-model",
          usage: { attempts: 1, durationMs: 47 },
        },
      },
      usage: { attempts: 1, durationMs: 47 },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(state.ledger.current.usage.tokensReserved).toBe(0);
    expect(state.ledger.current.usage.tokensUsed).toBe(0);
  });

  test("rejects hostile ModelClient usage without poisoning cumulative tokens", async () => {
    const usages = [
      { attempts: 1, totalTokens: 10_000_001, durationMs: 1 },
      { attempts: 1, totalTokens: Number.MAX_VALUE, durationMs: 1 },
      { attempts: 1, totalTokens: Number.MAX_SAFE_INTEGER, durationMs: 1 },
      { attempts: 1, totalTokens: 1, costUsd: 10_001, durationMs: 1 },
      { attempts: 1, totalTokens: 1, durationMs: 86_400_001 },
    ];
    const model: ModelClient = {
      identity: { id: "test/model-client", version: "1", configuration: { fixture: "src/runtime/broker.test.ts:317" } },
      id: "hostile-usage",
      async complete(): Promise<ModelResponse> {
        return { text: "unsafe", usage: usages.shift() as never };
      },
    };
    const state = await brokerState(model, "run_hostile_usage");
    for (let index = 0; index < 5; index++) {
      const result = await dispatchCall(
        state,
        testFrame,
        "llm",
        { key: `hostile-${index}`, prompt: "test" },
        noRecurse,
        new AbortController().signal,
        Date.now() + 5_000,
      ) as GuestCallResult;
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_RESULT" }, usage: { attempts: 1 } });
      expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
      expect(state.ledger.current.usage.tokensReserved).toBe(0);
      expect(state.ledger.current.usage.tokensUsed).toBe(0);
      expect(Object.values(state.ledger.current.usage).every(Number.isSafeInteger)).toBe(true);
    }
  });

  test("accounts token overshoot and blocks later calls while enforcing the output default", async () => {
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      identity: { id: "test/model-client", version: "1", configuration: { fixture: "src/runtime/broker.test.ts:344" } },
      id: "overshoot",
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        return { text: "ok", usage: { attempts: 1, totalTokens: 600, durationMs: 1 } };
      },
    };
    const state = await brokerState(model, "run_token_overshoot");
    state.ledger.current = createLedger({ ...state.ledger.current.limits, tokenLimit: 520 });

    const first = await dispatchCall(
      state,
      testFrame,
      "llm",
      { key: "first", prompt: "x" },
      noRecurse,
      new AbortController().signal,
      Date.now() + 5_000,
    ) as GuestCallResult;
    expect(first).toMatchObject({ ok: true, usage: { totalTokens: 600 } });
    expect(requests[0]?.maxOutputTokens).toBe(512);
    expect(state.ledger.current.usage).toMatchObject({ tokensReserved: 0, tokensUsed: 600 });

    const second = await dispatchCall(
      state,
      testFrame,
      "llm",
      { key: "second", prompt: "x" },
      noRecurse,
      new AbortController().signal,
      Date.now() + 5_000,
    ) as GuestCallResult;
    expect(second).toMatchObject({ ok: false, error: { code: "BUDGET_TOKENS" } });
    expect(requests).toHaveLength(1);
  });

  test("does not invoke accessors or trust malformed Pi error accounting", async () => {
    let getterCalls = 0;
    const topAccessor = new PiModelError(
      "PROVIDER_ERROR",
      "error",
      "provider",
      "model",
      { attempts: 1, totalTokens: 999, durationMs: 1 },
      "hidden",
    );
    Object.defineProperty(topAccessor, "usage", {
      get: () => {
        getterCalls++;
        return { attempts: 1, totalTokens: 999, durationMs: 1 };
      },
    });

    const nestedUsage = Object.create(null) as Record<string, unknown>;
    nestedUsage["attempts"] = 1;
    nestedUsage["durationMs"] = 1;
    Object.defineProperty(nestedUsage, "totalTokens", {
      get: () => {
        getterCalls++;
        return 999;
      },
    });
    const nestedAccessor = new PiModelError("PROVIDER_ERROR", "error", "provider", "model", nestedUsage as never, "hidden");

    const cyclicUsage = Object.create(null) as Record<string, unknown>;
    cyclicUsage["attempts"] = 1;
    cyclicUsage["durationMs"] = 2;
    cyclicUsage["cycle"] = cyclicUsage;
    const cyclic = new PiModelError("PROVIDER_ERROR", "error", "provider", "model", cyclicUsage as never, "hidden");
    const oversized = new PiModelError(
      "PROVIDER_ERROR",
      "error",
      "p".repeat(257),
      "model",
      { attempts: 1, totalTokens: Number.NaN, durationMs: 1 },
      "hidden",
    );
    const failures = [topAccessor, nestedAccessor, cyclic, oversized];
    const clock = new ManualClock();
    const fallbackDurationMs = 37;
    const model = new MockModelClient(() => {
      clock.advance(fallbackDurationMs);
      throw failures.shift();
    }, modelIdentity("src/runtime/broker.test.ts:422"));
    const state = await brokerState(model, "run_hostile_errors", clock);
    const results: GuestCallResult[] = [];
    for (let index = 0; index < 4; index++) {
      results.push(await dispatchCall(
        state,
        testFrame,
        "llm",
        { key: `failure-${index}`, prompt: "fail" },
        noRecurse,
        new AbortController().signal,
        Date.now() + 5_000,
      ) as GuestCallResult);
    }

    expect(getterCalls).toBe(0);
    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: "FAILED" },
      usage: { attempts: 1, durationMs: fallbackDurationMs },
    });
    expect(results[0]?.error?.details).toBeUndefined();
    expect(results[1]?.error?.details).toBeUndefined();
    expect(results[1]?.usage).toEqual({ attempts: 1, durationMs: fallbackDurationMs });
    expect(results[2]).toMatchObject({
      error: { details: { usage: { attempts: 1, durationMs: 2 } } },
      usage: { attempts: 1, durationMs: 2 },
    });
    expect(JSON.stringify(results[2])).not.toContain("cycle");
    expect(results[3]?.error?.details).toBeUndefined();
    expect(results[3]?.usage).toEqual({ attempts: 1, durationMs: fallbackDurationMs });
    expect(JSON.stringify(results)).not.toContain("pppppppp");
    expect(state.ledger.current.usage.tokensReserved).toBe(0);
    expect(state.ledger.current.usage.tokensUsed).toBe(0);
  });

  test("denied call-cache snapshots never insert and remain denied on retry", async () => {
    const model = new MockModelClient(() => "oversized model result", modelIdentity("src/runtime/broker.test.ts:458"));
    const state = await brokerState(model, "run_cache_bytes");
    state.ledger.current = createLedger({ ...state.ledger.current.limits, storedByteLimit: 1 });
    const results: GuestCallResult[] = [];
    for (let index = 0; index < 2; index++) {
      results.push(await dispatchCall(
        state,
        testFrame,
        "llm",
        { key: "same", prompt: "same" },
        noRecurse,
        new AbortController().signal,
        Date.now() + 5_000,
      ) as GuestCallResult);
    }
    expect(results.map((result) => result.error?.code)).toEqual(["BUDGET_BYTES", "BUDGET_BYTES"]);
    expect(model.callCount).toBe(2);
    expect(state.callCache.size).toBe(0);
    expect(state.ledger.current.usage.storedBytes).toBe(0);
    const events = await state.journal.readEvents();
    expect(events.ok && events.value.filter((event) => event.type === "call_committed")).toHaveLength(0);
  });

  test("cancellation while waiting for retention ownership leaves no cache reservation", async () => {
    const state = await brokerState(new MockModelClient(() => "unused", modelIdentity("src/runtime/broker.test.ts:482")), "run_retention_wait_abort");
    const held = await state.contextSemaphore.acquire();
    if (!held) throw new Error("expected held semaphore");
    const abort = new AbortController();
    const result = okResult("call_wait_abort", "value", ZERO_CALL_USAGE, false);
    const pending = retainCallResult(state, result, {
      type: "call_committed",
      frameId: testFrame.frameId,
      callId: result.callId,
      kind: "llm",
      key: "wait-abort",
      cached: false,
      ok: true,
      usage: ZERO_CALL_USAGE,
    }, abort.signal);

    abort.abort();
    await expect(within(pending)).rejects.toMatchObject({ name: "OperationAbortedError" });
    held();
    expect(state.callCache.size).toBe(0);
    expect(state.ledger.current.usage.storedBytes).toBe(0);
  });

  test("cancellation during journal append cannot commit late cache bytes", async () => {
    const base = await brokerState(new MockModelClient(() => "unused", modelIdentity("src/runtime/broker.test.ts:506")), "run_retention_append_abort");
    let started!: () => void;
    let resolveAppend!: (outcome: Awaited<ReturnType<JournalStore["append"]>>) => void;
    const appendStarted = new Promise<void>((resolve) => { started = resolve; });
    const appendPending = new Promise<Awaited<ReturnType<JournalStore["append"]>>>((resolve) => { resolveAppend = resolve; });
    const state: RunState = {
      ...base,
      journal: { append: () => { started(); return appendPending; } } as unknown as JournalStore,
    };
    const abort = new AbortController();
    const result = okResult("call_append_abort", "value", ZERO_CALL_USAGE, false);
    const pending = retainCallResult(state, result, {
      type: "call_committed",
      frameId: testFrame.frameId,
      callId: result.callId,
      kind: "llm",
      key: "append-abort",
      cached: false,
      ok: true,
      usage: ZERO_CALL_USAGE,
    }, abort.signal);

    await within(appendStarted);
    abort.abort();
    await expect(within(pending)).rejects.toMatchObject({ name: "OperationAbortedError" });
    expect(state.callCache.size).toBe(0);
    expect(state.ledger.current.usage.storedBytes).toBe(retainedJsonBytes(result as never));
    resolveAppend({ event: "committed", statusCache: { state: "refreshed" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.callCache.size).toBe(0);
    expect(state.ledger.current.usage.storedBytes).toBe(retainedJsonBytes(result as never));
  });

  test("durable status refresh failure retains one cache charge and propagates once", async () => {
    const base = await brokerState(new MockModelClient(() => "unused", modelIdentity("src/runtime/broker.test.ts:539")), "run_retention_durable_failure");
    const injected = new JournalAppendError("status_cache", true, new Error("injected refresh failure"));
    let appends = 0;
    const state: RunState = {
      ...base,
      journal: {
        append: async () => {
          appends++;
          return { event: "committed", statusCache: { state: "failed", error: injected } } as const;
        },
      } as unknown as JournalStore,
    };
    const result = okResult("call_durable_failure", "durable", ZERO_CALL_USAGE, false);
    const event = {
      type: "call_committed",
      frameId: testFrame.frameId,
      callId: result.callId,
      kind: "llm",
      key: "durable-failure",
      cached: false,
      ok: true,
      usage: ZERO_CALL_USAGE,
    } as const;

    await expect(retainCallResult(state, result, event, new AbortController().signal)).rejects.toBe(injected);
    const charged = retainedJsonBytes(result as never);
    expect(state.callCache.get(result.callId)).toEqual({ ...result, outputRef: expect.stringMatching(/^ctx_[0-9a-f]{64}$/) });
    expect(state.ledger.current.usage.storedBytes).toBe(charged);
    expect(appends).toBe(1);

    const duplicate = await retainCallResult(state, result, event, new AbortController().signal);
    expect(duplicate).toBe(state.callCache.get(result.callId)!);
    expect(state.ledger.current.usage.storedBytes).toBe(charged);
    expect(appends).toBe(1);
  });
});
