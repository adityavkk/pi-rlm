import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { normalizeProgram } from "../core/program.ts";
import type { RlmEvent } from "../core/journal.ts";
import type {
  DelegationV2CallSpec,
  DelegationV2Outcome,
  DelegationV2RunOptions,
} from "../shell/delegation/index.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import type { AgentDelegator, AgentApprovalRequest } from "./agent-delegation.ts";
import { MockController } from "./mock-controller.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => { backend = await QuickJsBackend.create(); });

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-agent-e2e-"));
const model = () => new MockModelClient(() => "unused", {
  id: "test/agent-model",
  version: "1",
  configuration: { fixture: "agent-call-e2e" },
});
const program = () => {
  const normalized = normalizeProgram({
    objective: "delegate review",
    profile: "default",
    inputs: [{ name: "context", adapter: "text", description: "source" }],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid fixture program");
  return normalized.value;
};
const events = async (dir: string): Promise<RlmEvent[]> => {
  const { JournalStore } = await import("../shell/journal-store.ts");
  const scanned = await new JournalStore(dir).readEvents();
  if (!scanned.ok) throw scanned.error;
  return scanned.value;
};

class FakeDelegator implements AgentDelegator {
  readonly identity = {
    id: "test/delegation-v2",
    version: "2",
    configuration: { fixture: "agent-call-e2e" },
  } as const;
  readonly requests: DelegationV2CallSpec[] = [];

  constructor(private readonly respond: (
    spec: DelegationV2CallSpec,
    options: DelegationV2RunOptions,
    attempt: number,
  ) => Promise<DelegationV2Outcome> | DelegationV2Outcome) {}

  async run(spec: DelegationV2CallSpec, options: DelegationV2RunOptions = {}): Promise<DelegationV2Outcome> {
    this.requests.push(spec);
    return this.respond(spec, options, this.requests.length);
  }
}

const successfulUsage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 3,
  cost: 0.02,
  turns: 2,
  toolCalls: 1,
  durationMs: 40,
};

describe("agent() delegation E2E", () => {
  test("coalesces, accounts, journals, retains, and passes verified context files", async () => {
    const client = new FakeDelegator(async (spec) => {
      expect(spec.requestId).toMatch(/^req_[0-9a-f]{64}$/);
      expect(spec.ownerRunId).toMatch(/^run_[0-9a-f]{64}$/);
      expect(spec.nodeId).toMatch(/^call_agent_[0-9a-f]{64}$/);
      expect(spec.cwd).toBe("/tmp/project");
      expect(spec.context).toBe("fresh");
      expect(spec.result).toEqual({ kind: "text" });
      const manifest = JSON.parse(spec.task.split("\n").at(-1) ?? "") as {
        version: string;
        contexts: Array<{ path: string; sha256: string; bytes: number }>;
      };
      expect(manifest.version).toBe("pi-rlm.agent-context.v1");
      expect(manifest.contexts).toHaveLength(1);
      expect(await readFile(manifest.contexts[0]!.path, "utf8")).toBe("source text");
      expect(manifest.contexts[0]!.bytes).toBe(11);
      return { ok: true, status: "completed", value: "checked", usage: successfulUsage };
    });
    const controller = new MockController([{
      reasoning: "delegate twice",
      code: `
        const [a, b] = await Promise.all([
          agent({ key: 'review', agent: 'reviewer', task: 'Check the source.', context: input }),
          agent({ key: 'review', agent: 'reviewer', task: 'Check the source.', context: input }),
        ]);
        answer({ answer: a.ok && b.ok && b.cached ? a.value : 'failed' });`,
    }]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(),
      sources: { context: "source text" },
      controller,
      model: model(),
      backend,
      dir,
      signal: new AbortController().signal,
      agentDelegation: {
        client,
        cwd: "/tmp/project",
        allowedAgents: ["reviewer"],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.answer).toEqual({ answer: "checked" });
    expect(client.requests).toHaveLength(1);
    expect(result.ledger.usage).toMatchObject({
      logicalCalls: 1,
      attempts: 1,
      tokensUsed: 20,
      inputTokensUsed: 15,
      outputTokensUsed: 5,
      costUsd: 0.02,
      providerDurationMs: 40,
      activeLeafCalls: 0,
    });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "agent_approval")).toEqual([
      expect.objectContaining({ type: "agent_approval", agent: "reviewer", decision: "allowlisted", policyId: "allowlist-only" }),
    ]);
    expect(journal.filter((event) => event.type === "provider_attempted")).toEqual([
      expect.objectContaining({
        type: "provider_attempted",
        kind: "agent",
        outcome: "ok",
        requestIdentityVersion: "pi-rlm.agent-request.v1",
        requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        usage: { attempts: 1, inputTokens: 15, outputTokens: 5, totalTokens: 20, costUsd: 0.02, durationMs: 40 },
      }),
    ]);
    expect(journal.filter((event) => event.type === "call_committed")).toEqual([
      expect.objectContaining({ type: "call_committed", kind: "agent", ok: true, outputRef: expect.stringMatching(/^ctx_/) }),
    ]);
  });

  test("validates structured results before committing the call", async () => {
    const client = new FakeDelegator(() => ({
      ok: true,
      status: "completed",
      value: { verdict: 7 },
      usage: successfulUsage,
    }));
    const controller = new MockController([{
      reasoning: "require a string verdict",
      code: `
        const r = await agent({
          key: 'structured', agent: 'reviewer', task: 'Return a verdict.',
          schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } },
        });
        answer({ answer: r.ok ? 'unexpected' : r.error.code });`,
    }]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, controller, model: model(), backend, dir,
      signal: new AbortController().signal,
      agentDelegation: { client, cwd: "/tmp/project", allowedAgents: ["reviewer"] },
    });
    expect(result.answer).toEqual({ answer: "INVALID_RESULT" });
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, tokensUsed: 20 });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "provider_attempted")).toEqual([
      expect.objectContaining({ type: "provider_attempted", kind: "agent", outcome: "invalid_result", errorCode: "INVALID_RESULT" }),
    ]);
    expect(journal.filter((event) => event.type === "call_committed")).toHaveLength(0);
  });

  test("owner cancellation while opaque approval is pending returns a cancelled run", async () => {
    let markApprovalStarted!: () => void;
    const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
    const never = new Promise<boolean>(() => {});
    const client = new FakeDelegator(() => { throw new Error("must not launch"); });
    const controller = new MockController([{
      reasoning: "wait for approval",
      code: `const r = await agent({ key: 'pending-approval', agent: 'unknown-agent', task: 'Wait.' }); answer({ answer: r.error.code });`,
    }]);
    const owner = new AbortController();
    const dir = await tmp();
    const running = runProgram({
      program: program(), sources: { context: "source" }, controller, model: model(), backend, dir,
      signal: owner.signal,
      agentDelegation: {
        client,
        cwd: "/tmp/project",
        approval: {
          id: "test-pending-v1",
          approve: async () => { markApprovalStarted(); return never; },
        },
      },
    });
    await approvalStarted;
    owner.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("CANCELLED");
    expect(client.requests).toHaveLength(0);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 0, attempts: 0, activeLeafCalls: 0 });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "provider_attempted")).toHaveLength(0);
    expect(journal.filter((event) => event.type === "run_cancelled")).toHaveLength(1);
  });

  test("denies an opaque agent before delegation spend", async () => {
    let approvals = 0;
    let approvalRequest: AgentApprovalRequest | undefined;
    const client = new FakeDelegator(() => { throw new Error("must not launch"); });
    const controller = new MockController([{
      reasoning: "request opaque agent",
      code: `const r = await agent({ key: 'opaque', agent: 'unknown-agent', task: 'Do work.' }); answer({ answer: r.error.code });`,
    }]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, controller, model: model(), backend, dir,
      signal: new AbortController().signal,
      agentDelegation: {
        client,
        cwd: "/tmp/project",
        approval: {
          id: "test-deny-v1",
          approve: async (request) => { approvals += 1; approvalRequest = request; return false; },
        },
      },
    });
    expect(result.answer).toEqual({ answer: "DENIED" });
    expect(approvals).toBe(1);
    expect(approvalRequest).toMatchObject({ agent: "unknown-agent", context: "fresh" });
    expect(client.requests).toHaveLength(0);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 0, attempts: 0, tokensUsed: 0 });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "agent_approval")).toEqual([
      expect.objectContaining({ decision: "denied", policyId: "test-deny-v1" }),
    ]);
    expect(journal.filter((event) => event.type === "provider_attempted")).toHaveLength(0);
  });

  test("rejects an accessor-bearing custom delegator outcome without invoking it", async () => {
    let traps = 0;
    const hostile = Object.create(null);
    Object.defineProperty(hostile, "ok", { enumerable: true, get() { traps += 1; return true; } });
    const client = new FakeDelegator(() => hostile as never);
    const controller = new MockController([{
      reasoning: "observe hostile outcome",
      code: `const r = await agent({ key: 'hostile', agent: 'reviewer', task: 'Return text.' }); answer({ answer: r.error.code });`,
    }]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, controller, model: model(), backend, dir,
      signal: new AbortController().signal,
      agentDelegation: { client, cwd: "/tmp/project", allowedAgents: ["reviewer"] },
    });
    expect(result.answer).toEqual({ answer: "INVALID_RESULT" });
    expect(traps).toBe(0);
    expect((await events(dir)).filter((event) => event.type === "provider_attempted")).toEqual([
      expect.objectContaining({ type: "provider_attempted", kind: "agent", outcome: "invalid_result" }),
    ]);
  });

  test("rejects hostile reported usage without poisoning the ledger", async () => {
    const client = new FakeDelegator(() => ({
      ok: true,
      status: "completed",
      value: "must not commit",
      usage: { ...successfulUsage, input: 10_000_001 },
    }));
    const controller = new MockController([{
      reasoning: "observe accounting rejection",
      code: `const r = await agent({ key: 'usage', agent: 'reviewer', task: 'Return text.' }); answer({ answer: r.error.code });`,
    }]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, controller, model: model(), backend, dir,
      signal: new AbortController().signal,
      agentDelegation: { client, cwd: "/tmp/project", allowedAgents: ["reviewer"] },
    });
    expect(result.answer).toEqual({ answer: "INVALID_RESULT" });
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, tokensUsed: 0, activeLeafCalls: 0 });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "provider_attempted")).toEqual([
      expect.objectContaining({
        type: "provider_attempted", kind: "agent", outcome: "invalid_result", errorCode: "INVALID_RESULT",
        usage: { attempts: 1, durationMs: expect.any(Number) },
      }),
    ]);
    expect(journal.filter((event) => event.type === "call_committed")).toHaveLength(0);
  });

  test("maps delegated cancellation as a settled accounted call failure", async () => {
    const client = new FakeDelegator(() => ({
      ok: false,
      code: "CANCELLED",
      status: "cancelled",
      usage: successfulUsage,
    }));
    const controller = new MockController([{
      reasoning: "observe child cancellation",
      code: `const r = await agent({ key: 'cancel', agent: 'reviewer', task: 'Stop.' }); answer({ answer: r.error.code });`,
    }]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, controller, model: model(), backend, dir,
      signal: new AbortController().signal,
      agentDelegation: { client, cwd: "/tmp/project", allowedAgents: ["reviewer"] },
    });
    expect(result.answer).toEqual({ answer: "CANCELLED" });
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, tokensUsed: 20, activeLeafCalls: 0 });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "provider_attempted")).toEqual([
      expect.objectContaining({ type: "provider_attempted", kind: "agent", outcome: "cancelled", errorCode: "CANCELLED" }),
    ]);
  });

  test("retries failed identities with distinct request attempts and one durable key", async () => {
    const client = new FakeDelegator((_spec, _options, attempt) => attempt === 1
      ? { ok: false, code: "FAILED", status: "failed", usage: successfulUsage }
      : { ok: true, status: "completed", value: "recovered", usage: successfulUsage });
    const controller = new MockController([{
      reasoning: "retry once",
      code: `
        const first = await agent({ key: 'retry', agent: 'reviewer', task: 'Retryable.' });
        const second = await agent({ key: 'retry', agent: 'reviewer', task: 'Retryable.' });
        answer({ answer: second.ok ? second.value : first.error.code });`,
    }]);
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, controller, model: model(), backend, dir,
      signal: new AbortController().signal,
      agentDelegation: { client, cwd: "/tmp/project", allowedAgents: ["reviewer"] },
    });
    expect(result.answer).toEqual({ answer: "recovered" });
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]!.requestId).not.toBe(client.requests[1]!.requestId);
    expect(client.requests[0]!.nodeId).toBe(client.requests[1]!.nodeId);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 2, attempts: 2, tokensUsed: 40 });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "key_bound" && event.kind === "agent")).toHaveLength(1);
    expect(journal.filter((event) => event.type === "provider_attempted" && event.kind === "agent")).toHaveLength(2);
    expect(journal.filter((event) => event.type === "call_committed" && event.kind === "agent")).toHaveLength(1);
  });
});
