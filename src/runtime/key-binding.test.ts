import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLedger } from "../core/budget.ts";
import type { RlmEvent } from "../core/journal.ts";
import { normalizeProgram } from "../core/program.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import { systemClock } from "../shell/clock.ts";
import { ContextStore } from "../shell/context-store.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalAppendError, type JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import { bindKeys, dispatchCall } from "./broker.ts";
import type { GuestCallResult } from "./call-result.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import { Semaphore } from "./semaphore.ts";
import type { FrameRef, RunState } from "./state.ts";

const frame: FrameRef = { frameId: "frame", depth: 0, objective: "test", inputs: {}, outputs: [] };
const recurse = async (): Promise<GuestCallResult> => { throw new Error("unexpected recurse"); };

const makeState = async (append: (event: RlmEvent) => Promise<unknown>, model?: ModelClient): Promise<RunState> => {
  const normalized = normalizeProgram({
    objective: "bindings",
    profile: "default",
    inputs: [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid test program");
  const startMs = Date.now();
  return {
    runId: "run_bindings",
    startMs,
    profile: DEFAULT_PROFILE,
    clock: systemClock,
    hasher: sha256,
    program: normalized.value,
    ledger: { current: createLedger(resolveLimits(DEFAULT_PROFILE, startMs)) },
    store: new ContextStore(await mkdtemp(join(tmpdir(), "pi-rlm-bindings-"))),
    artifacts: new Map(),
    model: model ?? {
      id: "unused",
      identity: { id: "test/key-binding-model", version: "1", configuration: { fixture: "unused" } },
      complete: async () => ({ text: "ok", usage: ZERO_CALL_USAGE }) },
    journal: { append } as JournalStore,
    backend: {} as InterpreterBackend,
    callCache: new Map(),
    inflight: new Map(),
    keyIdentities: new Map(),
    scopeUsage: new Map(),
    semaphore: new Semaphore(DEFAULT_PROFILE.maxConcurrency),
    contextSemaphore: new Semaphore(1),
    agentAttempts: new Map(),
    frameSeq: { current: 1 },
  };
};

const claims = ["a", "b", "c"].map((key) => ({ frame, kind: "llm" as const, key, identity: { prompt: key } }));

describe("key binding journal transactions", () => {
  for (const eventDurable of [false, true]) {
    for (let boundary = 0; boundary < claims.length; boundary++) {
      test(`${eventDurable ? "durable" : "undurable"} failure at batch append ${boundary + 1}`, async () => {
        const events: RlmEvent[] = [];
        let calls = 0;
        let fail = true;
        const injected = new JournalAppendError("event", eventDurable, new Error("injected"));
        const state = await makeState(async (event) => {
          if (fail && calls++ === boundary) {
            if (eventDurable) events.push(event);
            throw injected;
          }
          events.push(event);
        });

        await expect(bindKeys(state, claims)).rejects.toBe(injected);
        expect(events.filter((event) => event.type === "key_bound")).toHaveLength(boundary + (eventDurable ? 1 : 0));
        expect(state.keyIdentities.size).toBe(boundary + (eventDurable ? 1 : 0));

        fail = false;
        const failed = claims[boundary]!;
        const changed = { ...failed, identity: { prompt: "changed" } };
        if (eventDurable) {
          await expect(bindKeys(state, [failed])).rejects.toBe(injected);
          await expect(bindKeys(state, [changed])).rejects.toMatchObject({ code: "KEY_IDENTITY_CHANGED" });
        } else {
          await bindKeys(state, [changed]);
          expect(state.keyIdentities.get(`llm\u0000${failed.key}`)?.state).toBe("durable");
        }
      });
    }
  }

  test("concurrent waiters share failure and an undurable key is reusable", async () => {
    let rejectAppend!: (error: unknown) => void;
    const append = new Promise<never>((_resolve, reject) => { rejectAppend = reject; });
    let firstAppend = true;
    const state = await makeState(async () => {
      if (firstAppend) {
        firstAppend = false;
        return append;
      }
    });
    const first = bindKeys(state, [claims[0]!]);
    const waiter = bindKeys(state, [claims[0]!]);
    const outcomes = Promise.allSettled([first, waiter]);
    const injected = new JournalAppendError("event", false, new Error("injected"));
    rejectAppend(injected);
    const [firstOutcome, waiterOutcome] = await outcomes;
    expect(firstOutcome).toEqual({ status: "rejected", reason: injected });
    expect(waiterOutcome).toEqual({ status: "rejected", reason: injected });
    expect(state.keyIdentities.size).toBe(0);
    await bindKeys(state, [{ ...claims[0]!, identity: { prompt: "reused" } }]);
  });

  test("failed batch binding launches no provider call or reservation", async () => {
    let providerCalls = 0;
    const state = await makeState(async (event) => {
      if (event.type === "key_bound" && event.key === "b")
        throw new JournalAppendError("event", false, new Error("injected"));
    }, {
      id: "counting",
      identity: { id: "test/key-binding-model", version: "1", configuration: { fixture: "counting" } },
      complete: async () => {
        providerCalls += 1;
        return { text: "unexpected", usage: ZERO_CALL_USAGE };
      },
    });
    await expect(dispatchCall(state, frame, "llm.batch", {
      key: "batch",
      items: [{ key: "a", prompt: "a" }, { key: "b", prompt: "b" }],
    }, recurse, new AbortController().signal, Date.now() + 5_000)).rejects.toBeInstanceOf(JournalAppendError);
    expect(providerCalls).toBe(0);
    expect(state.ledger.current.usage.logicalCalls).toBe(0);
    expect(state.ledger.current.usage.attempts).toBe(0);
    expect(state.ledger.current.usage.tokensReserved).toBe(0);
  });
});

describe("validate before key binding", () => {
  test("invalid llm and concat refs leave keys reusable and spend zero", async () => {
    const events: RlmEvent[] = [];
    let providerCalls = 0;
    const state = await makeState(async (event) => { events.push(event); }, {
      id: "counting",
      identity: { id: "test/key-binding-model", version: "1", configuration: { fixture: "validate" } },
      complete: async () => {
        providerCalls += 1;
        return { text: "ok", usage: ZERO_CALL_USAGE };
      },
    });
    const valid = await state.store.ingestText("valid", "context");
    const signal = new AbortController().signal;
    const deadline = Date.now() + 5_000;

    await expect(dispatchCall(state, frame, "llm", { key: "llm-ref", prompt: "p", context: { id: "missing" } }, recurse, signal, deadline))
      .rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(events).toHaveLength(0);
    expect(providerCalls).toBe(0);
    expect(state.ledger.current.usage.logicalCalls).toBe(0);
    const llm = await dispatchCall(state, frame, "llm", { key: "llm-ref", prompt: "p", context: { id: valid.id } }, recurse, signal, deadline) as GuestCallResult;
    expect(llm.ok).toBe(true);

    const beforeConcat = events.length;
    await expect(dispatchCall(state, frame, "contexts.concat", { key: "concat-ref", refs: [{ id: "missing" }] }, recurse, signal, deadline))
      .rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(events).toHaveLength(beforeConcat);
    const concat = await dispatchCall(state, frame, "contexts.concat", { key: "concat-ref", refs: [{ id: valid.id }] }, recurse, signal, deadline) as { id: string };
    expect(concat.id).toBe(valid.id);

    const beforeProducers = events.length;
    await expect(dispatchCall(state, frame, "contexts.derive", { key: "derive-input" }, recurse, signal, deadline))
      .rejects.toMatchObject({ code: "INVALID_SPEC" });
    await expect(dispatchCall(state, frame, "artifacts.write", { key: "artifact-input", name: "a" }, recurse, signal, deadline))
      .rejects.toMatchObject({ code: "INVALID_SPEC" });
    expect(events).toHaveLength(beforeProducers);
    await dispatchCall(state, frame, "contexts.derive", { key: "derive-input", value: "ok" }, recurse, signal, deadline);
    const artifact = await dispatchCall(state, frame, "artifacts.write", { key: "artifact-input", name: "a", value: "ok" }, recurse, signal, deadline) as { id: string };
    const beforeArtifactRef = events.length;
    await expect(dispatchCall(state, frame, "artifacts.asContext", { artifact: { id: "missing" } }, recurse, signal, deadline))
      .rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(events).toHaveLength(beforeArtifactRef);
    await dispatchCall(state, frame, "artifacts.asContext", { artifact }, recurse, signal, deadline);
  });
});
