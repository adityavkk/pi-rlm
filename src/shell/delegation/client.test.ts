import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
} from "pi-subagents/delegation";
import { DelegationV2Client } from "./client.ts";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT as LOCAL_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT as LOCAL_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT as LOCAL_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT as LOCAL_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT as LOCAL_UPDATE_EVENT,
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION as LOCAL_PROTOCOL_VERSION,
  type DelegationEventBus,
  type DelegationV2CallSpec,
} from "./protocol.ts";

class FakeEventBus implements DelegationEventBus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  throwOnSubscribe: string | undefined;
  throwOnEmit: string | undefined;

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    if (this.throwOnEmit === channel) throw new Error("fake emit failure");
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    if (this.throwOnSubscribe === channel) throw new Error("fake subscribe failure");
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }

  listenerCount(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0;
  }
}

const baseSpec = (overrides: Partial<DelegationV2CallSpec> = {}): DelegationV2CallSpec => ({
  requestId: "req_0123456789abcdef",
  ownerRunId: "run_0123456789abcdef",
  nodeId: "node_0123456789abcdef",
  agent: "reviewer",
  task: "Review the supplied material.",
  context: "fresh",
  cwd: "/tmp/project",
  timeoutMs: 200,
  result: { kind: "text" },
  ...overrides,
});

const identity = (spec: DelegationV2CallSpec) => ({
  version: 2 as const,
  requestId: spec.requestId,
  ownerRunId: spec.ownerRunId,
  nodeId: spec.nodeId,
});

const usage = {
  input: 10,
  output: 20,
  cacheRead: 1,
  cacheWrite: 2,
  cost: 0.03,
  turns: 2,
  toolCalls: 1,
  durationMs: 40,
};

const assertClientListenersRemoved = (bus: FakeEventBus): void => {
  expect(bus.listenerCount(SUBAGENT_DELEGATION_RESPONSE_EVENT)).toBe(0);
  expect(bus.listenerCount(SUBAGENT_DELEGATION_STARTED_EVENT)).toBe(0);
  expect(bus.listenerCount(SUBAGENT_DELEGATION_UPDATE_EVENT)).toBe(0);
};

describe("DelegationV2Client", () => {
  test("pins the exact public pi-subagents v2 channel contract", () => {
    expect([
      LOCAL_PROTOCOL_VERSION,
      LOCAL_REQUEST_EVENT,
      LOCAL_STARTED_EVENT,
      LOCAL_UPDATE_EVENT,
      LOCAL_RESPONSE_EVENT,
      LOCAL_CANCEL_EVENT,
    ]).toEqual([
      SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
      SUBAGENT_DELEGATION_REQUEST_EVENT,
      SUBAGENT_DELEGATION_STARTED_EVENT,
      SUBAGENT_DELEGATION_UPDATE_EVENT,
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      SUBAGENT_DELEGATION_CANCEL_EVENT,
    ]);
  });
  test("subscribes before request emit and accepts synchronous text response", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity(spec));
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec),
        status: "completed",
        result: { kind: "text", text: "checked" },
        usage,
        runId: "child-run",
        agent: "reviewer",
        model: "provider/model",
      });
    });

    await expect(new DelegationV2Client(bus).run(spec)).resolves.toEqual({
      ok: true,
      status: "completed",
      value: "checked",
      usage,
      runId: "child-run",
      agent: "reviewer",
      model: "provider/model",
    });
    expect((bus.emitted[0]?.data as { version: number }).version).toBe(2);
    assertClientListenersRemoved(bus);
  });

  test("accepts bounded strict structured JSON", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec({ result: { kind: "structured", schema: { type: "object" } } });
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec),
        status: "completed",
        result: { kind: "structured", value: { verdict: "pass", count: 2 } },
      });
    });
    const result = await new DelegationV2Client(bus).run(spec);
    expect(result).toEqual({ ok: true, status: "completed", value: { verdict: "pass", count: 2 } });
    if (result.ok && typeof result.value === "object" && result.value !== null && !Array.isArray(result.value))
      expect(Object.getPrototypeOf(result.value)).toBeNull();
  });

  test("maps terminal child failures without exposing provider error text", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec),
        status: "failed",
        error: "SECRET provider path and payload",
        usage,
      });
    });
    await expect(new DelegationV2Client(bus).run(spec)).resolves.toEqual({
      ok: false,
      code: "FAILED",
      status: "failed",
      usage,
    });
  });

  test("ignores unrelated responses and suppresses duplicate and late terminals", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec), requestId: "other", status: "completed", result: { kind: "text", text: "wrong" },
      });
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec), status: "completed", result: { kind: "text", text: "first" },
      });
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec), status: "completed", result: { kind: "text", text: "late" },
      });
    });
    await expect(new DelegationV2Client(bus).run(spec)).resolves.toMatchObject({ ok: true, value: "first" });
    expect(bus.emitted.filter((event) => event.channel === SUBAGENT_DELEGATION_CANCEL_EVENT)).toHaveLength(0);
  });

  test("partial invalid_request cannot collide across owner and node identities", async () => {
    const bus = new FakeEventBus();
    const first = baseSpec({ ownerRunId: "owner-one", nodeId: "node-one" });
    const second = baseSpec({ ownerRunId: "owner-two", nodeId: "node-two" });
    let requests = 0;
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      requests += 1;
      if (requests !== 2) return;
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 2, requestId: first.requestId, status: "invalid_request", error: "partial",
      });
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(first), status: "completed", result: { kind: "text", text: "first" },
      });
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(second), status: "completed", result: { kind: "text", text: "second" },
      });
    });
    const client = new DelegationV2Client(bus);
    const [a, b] = await Promise.all([client.run(first), client.run(second)]);
    expect(a).toMatchObject({ ok: true, value: "first" });
    expect(b).toMatchObject({ ok: true, value: "second" });
  });

  test("matching malformed or oversized terminal fails closed and cancels once", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec),
        status: "completed",
        result: { kind: "text", text: "x".repeat(2 * 1024 * 1024 + 1) },
      });
    });
    await expect(new DelegationV2Client(bus).run(spec)).resolves.toEqual({
      ok: false, code: "INVALID_RESULT", status: "invalid_result",
    });
    const cancellations = bus.emitted.filter((event) => event.channel === SUBAGENT_DELEGATION_CANCEL_EVENT);
    expect(cancellations).toEqual([{ channel: SUBAGENT_DELEGATION_CANCEL_EVENT, data: identity(spec) }]);
    assertClientListenersRemoved(bus);
  });

  test("abort after start emits one exact v2 cancellation and cleans listeners", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec({ timeoutMs: 5_000 });
    const controller = new AbortController();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity(spec));
      controller.abort();
    });
    await expect(new DelegationV2Client(bus).run(spec, { signal: controller.signal })).resolves.toEqual({
      ok: false, code: "CANCELLED", status: "cancelled",
    });
    expect(bus.emitted.filter((event) => event.channel === SUBAGENT_DELEGATION_CANCEL_EVENT))
      .toEqual([{ channel: SUBAGENT_DELEGATION_CANCEL_EVENT, data: identity(spec) }]);
    assertClientListenersRemoved(bus);
  });

  test("pre-aborted signal launches nothing", async () => {
    const bus = new FakeEventBus();
    const controller = new AbortController();
    controller.abort();
    await expect(new DelegationV2Client(bus).run(baseSpec(), { signal: controller.signal })).resolves.toEqual({
      ok: false, code: "CANCELLED", status: "cancelled",
    });
    expect(bus.emitted).toHaveLength(0);
    assertClientListenersRemoved(bus);
  });

  test("missing bridge fails on bounded start timeout and cancels the attempt", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec({ timeoutMs: 1_000 });
    await expect(new DelegationV2Client(bus).run(spec, { startTimeoutMs: 5 })).resolves.toEqual({
      ok: false, code: "UNAVAILABLE_CONTEXT", status: "unavailable_context",
    });
    expect(bus.emitted.map((event) => event.channel)).toEqual([
      SUBAGENT_DELEGATION_REQUEST_EVENT,
      SUBAGENT_DELEGATION_CANCEL_EVENT,
    ]);
    assertClientListenersRemoved(bus);
  });

  test("started attempt reaches total timeout and emits one cancellation", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec({ timeoutMs: 10 });
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity(spec)));
    await expect(new DelegationV2Client(bus).run(spec)).resolves.toEqual({
      ok: false, code: "TIMEOUT", status: "timed_out",
    });
    expect(bus.emitted.filter((event) => event.channel === SUBAGENT_DELEGATION_CANCEL_EVENT)).toHaveLength(1);
  });

  test("subscribe and request emit failures are bounded and leak no listeners", async () => {
    const subscribeBus = new FakeEventBus();
    subscribeBus.throwOnSubscribe = SUBAGENT_DELEGATION_STARTED_EVENT;
    await expect(new DelegationV2Client(subscribeBus).run(baseSpec())).resolves.toEqual({
      ok: false, code: "UNAVAILABLE_CONTEXT", status: "unavailable_context",
    });
    assertClientListenersRemoved(subscribeBus);

    const emitBus = new FakeEventBus();
    emitBus.throwOnEmit = SUBAGENT_DELEGATION_REQUEST_EVENT;
    await expect(new DelegationV2Client(emitBus).run(baseSpec())).resolves.toEqual({
      ok: false, code: "UNAVAILABLE_CONTEXT", status: "unavailable_context",
    });
    expect(emitBus.emitted.map((event) => event.channel)).toEqual([
      SUBAGENT_DELEGATION_REQUEST_EVENT,
      SUBAGENT_DELEGATION_CANCEL_EVENT,
    ]);
    assertClientListenersRemoved(emitBus);
  });

  test("proxy and accessor events invoke no traps and do not block a valid terminal", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec();
    let traps = 0;
    const proxy = new Proxy({}, {
      get() { traps += 1; throw new Error("trap"); },
      ownKeys() { traps += 1; throw new Error("trap"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("trap"); },
    });
    let getters = 0;
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "version", { enumerable: true, get() { getters += 1; return 2; } });
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, proxy);
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, accessor);
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec), status: "completed", result: { kind: "text", text: "safe" },
      });
    });
    await expect(new DelegationV2Client(bus).run(spec)).resolves.toMatchObject({ ok: true, value: "safe" });
    expect(traps).toBe(0);
    expect(getters).toBe(0);
  });

  test("accepts bounded public v2 update fields while projecting the stable subset", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec();
    const updates: unknown[] = [];
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity(spec));
      bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        ...identity(spec),
        currentTool: "read",
        currentToolArgs: "{\"path\":\"source\"}",
        recentOutput: "working",
        recentOutputLines: ["one", "two"],
        recentTools: [{ tool: "read", args: "source" }],
        model: "provider/model",
        toolCount: 1,
        durationMs: 2,
        tokens: 3,
      });
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec), status: "completed", result: { kind: "text", text: "done" },
      });
    });
    await new DelegationV2Client(bus).run(spec, { onUpdate: (update) => { updates.push(update); } });
    expect(updates).toEqual([{
      currentTool: "read", recentOutput: "working", model: "provider/model", toolCount: 1, durationMs: 2, tokens: 3,
    }]);
  });

  test("bounds updates and ignores hostile update payloads", async () => {
    const bus = new FakeEventBus();
    const spec = baseSpec();
    const updates: unknown[] = [];
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps += 1; return 2; }, ownKeys() { traps += 1; return []; } });
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity(spec));
      bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, proxy);
      bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, { ...identity(spec), recentOutput: "x".repeat(16 * 1024 + 1) });
      for (let index = 0; index < 300; index += 1)
        bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, { ...identity(spec), currentTool: `tool-${index}`, toolCount: index });
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        ...identity(spec), status: "completed", result: { kind: "text", text: "done" },
      });
    });
    await new DelegationV2Client(bus).run(spec, { onUpdate: (update) => { updates.push(update); } });
    expect(updates).toHaveLength(256);
    expect(updates[0]).toEqual({ currentTool: "tool-0", toolCount: 0 });
    expect(traps).toBe(0);
  });

  test("rejects invalid requests before event subscription or emission", async () => {
    const bus = new FakeEventBus();
    await expect(new DelegationV2Client(bus).run(baseSpec({ requestId: "bad\nid" }))).resolves.toEqual({
      ok: false, code: "INVALID_REQUEST", status: "invalid_request",
    });
    await expect(new DelegationV2Client(bus).run(baseSpec({
      result: { kind: "structured", schema: { huge: "x".repeat(32 * 1024) } },
    }))).resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    let getterCalls = 0;
    const hostileSkills: string[] = [];
    Object.defineProperty(hostileSkills, "0", {
      enumerable: true,
      configurable: true,
      get() { getterCalls += 1; return "secret"; },
    });
    hostileSkills.length = 1;
    await expect(new DelegationV2Client(bus).run(baseSpec({ skill: hostileSkills })))
      .resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(getterCalls).toBe(0);
    expect(bus.emitted).toHaveLength(0);
    assertClientListenersRemoved(bus);
  });
});
