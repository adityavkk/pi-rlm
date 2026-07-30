import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { settledOperations } from "../runtime/testing/operation-events.ts";
import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
  type SubagentDelegationV2Request,
  type SubagentDelegationV2TerminalResponse,
} from "pi-subagents/delegation";
import type { RlmEvent } from "../core/journal.ts";
import type { AgentApprovalRequest } from "../runtime/agent-delegation.ts";
import {
  AGENT_APPROVAL_DIALOG_MAX_BYTES,
  AGENT_APPROVAL_TIMEOUT_MS,
  agentApprovalConfirmationMessage,
  createExtensionAgentDelegation,
} from "./agent-delegation.ts";
import {
  createOfflineProviderRuntimeFixture,
  OFFLINE_COMMAND,
  type OfflineProviderRuntimeFixture,
} from "./testing/offline-provider-runtime.ts";

const ui = {
  setStatus() {},
  notify() {},
  confirm: async () => true,
} as unknown as ExtensionUIContext;

const withTimeout = async <T>(work: Promise<T>, label: string, ms = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const isV2Request = (value: unknown): value is SubagentDelegationV2Request => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<SubagentDelegationV2Request>;
  return request.version === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION
    && typeof request.requestId === "string"
    && typeof request.ownerRunId === "string"
    && typeof request.nodeId === "string";
};

const terminalEvents = (events: readonly RlmEvent[]) => events.filter((event) =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled");

const customResults = (events: readonly AgentSessionEvent[]) => events.filter((event) => {
  if (event.type !== "message_end") return false;
  const message = event.message as unknown as { role?: unknown; customType?: unknown };
  return message.role === "custom" && message.customType === "pi-rlm-result";
});

describe("public Pi agent delegation E2E", () => {
  test("runs QuickJS agent() through the shared public pi-subagents v2 event bus", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-public-delegation-"));
    const requests: SubagentDelegationV2Request[] = [];
    const contextReads: Array<{ path: string; text: string }> = [];
    let fixture: OfflineProviderRuntimeFixture | undefined;
    let unsubscribe: (() => void) | undefined;
    let approvalPrompts = 0;
    try {
      fixture = await createOfflineProviderRuntimeFixture(root, "success", {
        controllerCode: `
          const delegated = await agent({
            key: 'public-review',
            agent: 'reviewer',
            task: 'Read the supplied context and return the exact delegated result.',
            context: input,
          });
          answer({ answer: delegated.ok ? delegated.value : delegated.error.code });`,
        profileOverrides: { maxLogicalCalls: 2, maxAttempts: 2, wallMs: 15_000, cellWallMs: 15_000 },
        extensionSetup(pi) {
          pi.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
            if (!isV2Request(data)) return;
            requests.push(data);
            const identity = {
              version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
              requestId: data.requestId,
              ownerRunId: data.ownerRunId,
              nodeId: data.nodeId,
            } as const;
            pi.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, identity);
            void (async () => {
              const manifest = JSON.parse(data.task.split("\n").at(-1) ?? "") as {
                contexts: Array<{ path: string; sha256: string }>;
              };
              const path = manifest.contexts[0]!.path;
              contextReads.push({ path, text: await readFile(path, "utf8") });
              const response: SubagentDelegationV2TerminalResponse = {
                ...identity,
                status: "completed",
                agent: "reviewer",
                model: "offline/reviewer",
                result: { kind: "text", text: "delegated public result" },
                usage: {
                  input: 3,
                  output: 2,
                  cacheRead: 1,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 1,
                  toolCalls: 1,
                  durationMs: 12,
                },
              };
              pi.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response);
            })();
          });
        },
      });
      const observed: AgentSessionEvent[] = [];
      unsubscribe = fixture.runtime.session.subscribe((event) => observed.push(event));
      let confirmationOptions: { signal?: AbortSignal; timeout?: number } | undefined;
      const approvingUi = {
        ...ui,
        confirm: async (title: string, _message: string, options?: { signal?: AbortSignal; timeout?: number }) => {
          if (title.includes("delegated Pi agent")) approvalPrompts += 1;
          confirmationOptions = options;
          return true;
        },
      } as unknown as ExtensionUIContext;
      await fixture.runtime.session.bindExtensions({ mode: "tui", uiContext: approvingUi });
      await withTimeout(
        fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }),
        "delegation prompt",
        15_000,
      );

      expect(fixture.state.fetchCalls).toBe(0);
      expect(approvalPrompts).toBe(1);
      expect(confirmationOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(confirmationOptions?.timeout).toBe(AGENT_APPROVAL_TIMEOUT_MS);
      expect(confirmationOptions?.timeout).toBeLessThanOrEqual(120_000);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        version: 2,
        agent: "reviewer",
        context: "fresh",
        cwd: root,
        result: { kind: "text" },
        artifacts: true,
        turnBudget: { maxTurns: 40, graceTurns: 4 },
        toolBudget: { soft: 80, hard: 100 },
      });
      expect(requests[0]!.requestId).toMatch(/^req_[0-9a-f]{64}$/);
      expect(requests[0]!.ownerRunId).toMatch(/^run_[0-9a-f]{64}$/);
      expect(requests[0]!.nodeId).toMatch(/^call_agent_[0-9a-f]{64}$/);
      expect(contextReads).toHaveLength(1);
      expect(contextReads[0]!.text).toBe("exact offline source");

      const journal = await fixture.readEvents();
      expect(terminalEvents(journal)).toEqual([
        expect.objectContaining({ type: "run_completed", completionMode: "answer" }),
      ]);
      expect(journal.filter((event) => event.type === "agent_approval")).toEqual([
        expect.objectContaining({
          type: "agent_approval", agent: "reviewer", decision: "approved", policyId: "pi-ui.agent-confirm.v2.timeout-60000",
        }),
      ]);
      expect(settledOperations(journal)).toEqual([
        expect.objectContaining({ type: "operation_settled", kind: "controller", outcome: "ok" }),
        expect.objectContaining({
          type: "operation_settled",
          kind: "agent",
          outcome: "ok",
          usage: { attempts: 1, inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0, durationMs: 12 },
          requestIdentityVersion: "pi-rlm.agent-request.v1",
          requestSha256:expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]);
      expect(journal.filter((event) => event.type === "call_committed" && event.kind === "agent")).toHaveLength(1);
      expect(customResults(observed)).toHaveLength(1);
      const resultMessage = customResults(observed)[0]!;
      const message = resultMessage.type === "message_end"
        ? resultMessage.message as unknown as { content: string }
        : undefined;
      expect(JSON.parse(message!.content)).toMatchObject({
        status: "completed",
        answer: { answer: "delegated public result" },
        usage: { attempts: 2, logicalCalls: 2, tokensUsed: 24, activeLeafCalls: 0 },
      });
    } finally {
      unsubscribe?.();
      await fixture?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test.each(["rpc", "print", "json"] as const)("%s denies opaque agents without dialog or delegation", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), `pi-rlm-${mode}-opaque-`));
    let fixture: OfflineProviderRuntimeFixture | undefined;
    let requests = 0;
    let prompts = 0;
    try {
      fixture = await createOfflineProviderRuntimeFixture(root, "success", {
        controllerCode: `
          const delegated = await agent({ key: 'opaque', agent: 'reviewer', task: 'exact task' });
          answer({ answer: delegated.ok ? delegated.value : delegated.error.code });`,
        profileOverrides: { maxLogicalCalls: 2, maxAttempts: 2 },
        extensionSetup(pi) {
          pi.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => { requests += 1; });
        },
      });
      const rejectingUi = {
        ...ui,
        confirm: async () => { prompts += 1; return true; },
      } as unknown as ExtensionUIContext;
      await fixture.runtime.session.bindExtensions({ mode, uiContext: rejectingUi });
      await withTimeout(fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }), `${mode} denial`);
      expect(prompts).toBe(0);
      expect(requests).toBe(0);
      const journal = await fixture.readEvents();
      expect(journal.filter((event) => event.type === "agent_approval")).toEqual([
        expect.objectContaining({ agent: "reviewer", decision: "denied", policyId: "allowlist-only" }),
      ]);
      expect(settledOperations(journal).filter((event) => event.kind === "agent")).toHaveLength(0);
    } finally {
      await fixture?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

const exactApprovalRequest: AgentApprovalRequest = {
  runId: "run_test",
  frameId: "frame_test",
  callId: "call_agent_test",
  agent: "reviewer",
  taskSha256: "a".repeat(64),
  taskPreview: "review exact task",
  context: "fresh",
  model: "safe/model",
  thinking: "high",
};

const approvalPolicyFixture = (
  confirm: (title: string, message: string, options?: { signal?: AbortSignal; timeout?: number }) => Promise<boolean>,
  approvalTimeoutMs?: number,
) => {
  let current = true;
  let begins = 0;
  let settlements = 0;
  const ctx = {
    mode: "tui",
    cwd: "/tmp/project",
    ui: { confirm },
    sessionManager: { getSessionId: () => "session" },
  };
  const config = createExtensionAgentDelegation({ events: {} } as never)(
    ctx as never,
    "session",
    1,
    (_sessionId, _generation, signal) => current && !signal.aborted,
    {
      begin: () => {
        begins += 1;
        let settled = false;
        return {
          settle: () => {
            if (settled) return;
            settled = true;
            settlements += 1;
          },
        };
      },
    },
    approvalTimeoutMs === undefined ? undefined : { approvalTimeoutMs },
  );
  return {
    approve: config.approval!.approve,
    stale: () => { current = false; },
    counts: () => ({ begins, settlements }),
  };
};

describe("opaque-agent confirmation policy", () => {
  test.each([
    ["denial", async (): Promise<boolean> => false],
    ["exception", async (): Promise<boolean> => { throw new Error("host UI failed"); }],
  ] as const)("%s settles once and denies", async (_label, confirm) => {
    const fixture = approvalPolicyFixture(confirm as never);
    await expect(fixture.approve(exactApprovalRequest, new AbortController().signal)).resolves.toBe(false);
    expect(fixture.counts()).toEqual({ begins: 1, settlements: 1 });
  });

  test("passes a bounded timeout that dismisses and settles the dialog", async () => {
    let captured: { signal?: AbortSignal; timeout?: number } | undefined;
    const fixture = approvalPolicyFixture(async (_title, _message, options) => {
      captured = options;
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(false), options?.timeout));
    }, 1);
    const owner = new AbortController();
    await expect(fixture.approve(exactApprovalRequest, owner.signal)).resolves.toBe(false);
    expect(captured).toEqual({ signal: owner.signal, timeout: 1 });
    expect(fixture.counts()).toEqual({ begins: 1, settlements: 1 });
  });

  test("passes public signal and timeout options and rechecks stale sessions", async () => {
    let options: { signal?: AbortSignal; timeout?: number } | undefined;
    const fixture = approvalPolicyFixture(async (_title, _message, captured) => {
      options = captured;
      fixture.stale();
      return true;
    });
    const owner = new AbortController();
    await expect(fixture.approve(exactApprovalRequest, owner.signal)).resolves.toBe(false);
    expect(options).toEqual({ signal: owner.signal, timeout: AGENT_APPROVAL_TIMEOUT_MS });
    expect(fixture.counts()).toEqual({ begins: 1, settlements: 1 });
  });

  test("abort settles promptly and suppresses a late true", async () => {
    let release!: (value: boolean) => void;
    const late = new Promise<boolean>((resolve) => { release = resolve; });
    const fixture = approvalPolicyFixture(async () => late);
    const owner = new AbortController();
    const pending = fixture.approve(exactApprovalRequest, owner.signal);
    await Promise.resolve();
    owner.abort();
    await expect(pending).resolves.toBe(false);
    expect(fixture.counts()).toEqual({ begins: 1, settlements: 1 });
    release(true);
    await Promise.resolve();
    expect(fixture.counts()).toEqual({ begins: 1, settlements: 1 });
  });

  test("dialog sanitizes hostile fields and remains byte bounded", () => {
    const message = agentApprovalConfirmationMessage({
      ...exactApprovalRequest,
      taskPreview: `safe\nInjected:\u001b]0;hostile\u0007\u202eevil${"😀".repeat(2_000)}`,
      model: "model\nHostile",
    }, "b".repeat(64));
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(AGENT_APPROVAL_DIALOG_MAX_BYTES);
    expect(message).not.toMatch(/[\u001b\u0007\u202e]/u);
    expect(message).not.toContain("model\nHostile");
    expect(message).not.toContain("safe\nInjected");
    expect(message.split("\n")).toHaveLength(15);
    expect(message.endsWith("\n")).toBe(true);
    expect(message).toContain("Delegated agent\n");
    expect(message).toContain("Exact request\n");
    expect(message).toContain("Task preview\n");
    expect(message).toContain("Capability\n");
  });
});
