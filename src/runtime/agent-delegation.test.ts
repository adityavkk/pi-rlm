import { describe, expect, test } from "bun:test";
import type { DelegationV2CallSpec, DelegationV2Outcome } from "../shell/delegation/index.ts";
import {
  authorizeAgent,
  bindAgentDelegationRuntime,
  prepareAgentDelegation,
  type AgentApprovalRequest,
  type AgentDelegator,
} from "./agent-delegation.ts";

class TestDelegator implements AgentDelegator {
  readonly identity = {
    id: "test/delegator",
    version: "2",
    configuration: { protocol: 2 },
  } as const;
  async run(_spec: DelegationV2CallSpec): Promise<DelegationV2Outcome> {
    return { ok: true, status: "completed", value: "ok" };
  }
}

const approvalRequest = (agent: string): AgentApprovalRequest => ({
  runId: "run_test",
  frameId: "frame_test",
  callId: "call_test",
  agent,
  taskSha256: "a".repeat(64),
  taskPreview: "task",
  context: "fresh",
});

describe("agent delegation policy", () => {
  test("normalizes allowlist and binds only non-secret policy identity", () => {
    const prepared = prepareAgentDelegation({
      client: new TestDelegator(),
      cwd: "/private/project/path",
      allowedAgents: ["worker", "reviewer", "worker"],
      allowForkContext: true,
      approval: { id: "test-approval-v1", approve: async () => true },
    })!;
    expect(prepared.allowedAgents).toEqual(["reviewer", "worker"]);
    expect(prepared.identity).toMatchObject({
      id: "pi-rlm/agent-delegation",
      version: "pi-rlm.agent-policy.v1",
      configuration: {
        allowedAgents: ["reviewer", "worker"],
        allowForkContext: true,
        approvalPolicy: "test-approval-v1",
        cwdSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(prepared.identity)).not.toContain("/private/project/path");
  });

  test("coalesces one opaque-agent approval for the run", async () => {
    let calls = 0;
    let release!: (value: boolean) => void;
    const decision = new Promise<boolean>((resolve) => { release = resolve; });
    const prepared = prepareAgentDelegation({
      client: new TestDelegator(),
      cwd: "/tmp/project",
      approval: { id: "test-approval-v1", approve: async () => { calls += 1; return decision; } },
    })!;
    const runtime = bindAgentDelegationRuntime(prepared, new AbortController().signal)!;
    const signal = new AbortController().signal;
    const first = authorizeAgent(runtime, approvalRequest("reviewer"), signal);
    const second = authorizeAgent(runtime, { ...approvalRequest("reviewer"), callId: "call_2" }, signal);
    expect(calls).toBe(1);
    release(true);
    await expect(Promise.all([first, second])).resolves.toEqual(["approved", "approved"]);
    await expect(authorizeAgent(runtime, { ...approvalRequest("reviewer"), callId: "call_3" }, signal))
      .resolves.toBe("approved");
    expect(calls).toBe(1);
  });

  test("allowlist bypasses approval and absent policy denies", async () => {
    let calls = 0;
    const allowlisted = bindAgentDelegationRuntime(prepareAgentDelegation({
      client: new TestDelegator(), cwd: "/tmp/project", allowedAgents: ["reviewer"],
      approval: { id: "unused", approve: async () => { calls += 1; return false; } },
    })!, new AbortController().signal)!;
    await expect(authorizeAgent(allowlisted, approvalRequest("reviewer"), new AbortController().signal))
      .resolves.toBe("allowlisted");
    expect(calls).toBe(0);

    const denied = bindAgentDelegationRuntime(prepareAgentDelegation({
      client: new TestDelegator(), cwd: "/tmp/project",
    })!, new AbortController().signal)!;
    await expect(authorizeAgent(denied, approvalRequest("unknown"), new AbortController().signal))
      .resolves.toBe("denied");
  });

  test("rejects accessors and proxies without invoking them", () => {
    let getterCalls = 0;
    const config = {
      client: new TestDelegator(),
      cwd: "/tmp/project",
    } as Record<string, unknown>;
    Object.defineProperty(config, "allowedAgents", {
      enumerable: true,
      get() { getterCalls += 1; return ["reviewer"]; },
    });
    expect(() => prepareAgentDelegation(config as never)).toThrow("own data property");
    expect(getterCalls).toBe(0);

    let traps = 0;
    const configuration = new Proxy({}, { ownKeys() { traps += 1; return []; } });
    const client = new TestDelegator() as TestDelegator & { identity: unknown };
    Object.defineProperty(client, "identity", {
      enumerable: true,
      value: { id: "test", version: "1", configuration },
    });
    expect(() => prepareAgentDelegation({ client: client as AgentDelegator, cwd: "/tmp/project" }))
      .toThrow("bounded strict JSON");
    expect(traps).toBe(0);

    const accessorClient = { identity: new TestDelegator().identity } as Record<string, unknown>;
    Object.defineProperty(accessorClient, "run", { get() { getterCalls += 1; return () => {}; } });
    expect(() => prepareAgentDelegation({ client: accessorClient as unknown as AgentDelegator, cwd: "/tmp/project" }))
      .toThrow("data method");
    expect(getterCalls).toBe(0);
  });
});
