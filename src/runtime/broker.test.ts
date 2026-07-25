import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLedger } from "../core/budget.ts";
import { normalizeProgram } from "../core/program.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import { systemClock } from "../shell/clock.ts";
import { ContextStore } from "../shell/context-store.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalStore } from "../shell/journal-store.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelClient, ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { ManualClock } from "../shell/clock.ts";
import { PiModelClient, PiModelError } from "../shell/model/pi-model.ts";
import { dispatchCall } from "./broker.ts";
import type { GuestCallResult } from "./call-result.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import { Semaphore } from "./semaphore.ts";
import type { FrameRef, RunState } from "./state.ts";

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

const brokerState = async (model: ModelClient, runId: string): Promise<RunState> => {
  const normalized = normalizeProgram({
    objective: "broker error boundary",
    profile: "default",
    inputs: [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid test program");
  const dir = await mkdtemp(join(tmpdir(), "pi-rlm-broker-"));
  const startMs = Date.now();
  return {
    runId,
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
    semaphore: new Semaphore(1),
    contextSemaphore: new Semaphore(1),
    frameSeq: { current: 1 },
  };
};

const testFrame: FrameRef = { frameId: "frame", depth: 0, objective: "test", inputs: {}, outputs: [] };
const noRecurse = async (): Promise<GuestCallResult> => { throw new Error("unexpected recurse"); };

describe("dispatchCall cancellation ownership", () => {
  test("releases a timed-out holder and aborted waiter, then admits an independent call", async () => {
    let rejectStuck!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const prompts: string[] = [];
    const model: ModelClient = {
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
    expect(state.ledger.current.usage.logicalCalls).toBe(2);

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
    expect(state.ledger.current.usage.logicalCalls).toBe(0);
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
    const state = await brokerState(new PiModelClient(runtime, "test-provider/test-model", clock), "run_runtime_failure");
    const result = await dispatchCall(
      state,
      testFrame,
      "llm",
      { key: "runtime-failure", prompt: "fail", model: { model: "test-provider/test-model" } },
      noRecurse,
      new AbortController().signal,
      Date.now() + 5_000,
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
    const model: ModelClient = {
      id: "hostile-errors",
      async complete(): Promise<ModelResponse> { throw failures.shift(); },
    };
    const state = await brokerState(model, "run_hostile_errors");
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
    expect(results[0]).toMatchObject({ ok: false, error: { code: "FAILED" }, usage: ZERO_CALL_USAGE });
    expect(results[0]?.error?.details).toBeUndefined();
    expect(results[1]?.error?.details).toBeUndefined();
    expect(results[1]?.usage).toEqual(ZERO_CALL_USAGE);
    expect(results[2]).toMatchObject({
      error: { details: { usage: { attempts: 1, durationMs: 2 } } },
      usage: { attempts: 1, durationMs: 2 },
    });
    expect(JSON.stringify(results[2])).not.toContain("cycle");
    expect(results[3]?.error?.details).toBeUndefined();
    expect(results[3]?.usage).toEqual(ZERO_CALL_USAGE);
    expect(JSON.stringify(results)).not.toContain("pppppppp");
    expect(state.ledger.current.usage.tokensReserved).toBe(0);
    expect(state.ledger.current.usage.tokensUsed).toBe(0);
  });
});
