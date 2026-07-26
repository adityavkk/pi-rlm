import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
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
        profileOverrides: { maxLogicalCalls: 2, maxAttempts: 2 },
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
      const approvingUi = {
        ...ui,
        confirm: async (title: string) => {
          if (title.includes("delegated Pi agent")) approvalPrompts += 1;
          return true;
        },
      } as unknown as ExtensionUIContext;
      await fixture.runtime.session.bindExtensions({ mode: "print", uiContext: approvingUi });
      await withTimeout(fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }), "delegation prompt");

      expect(fixture.state.fetchCalls).toBe(0);
      expect(approvalPrompts).toBe(1);
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
          type: "agent_approval", agent: "reviewer", decision: "approved", policyId: "pi-ui.agent-confirm.v1",
        }),
      ]);
      expect(journal.filter((event) => event.type === "provider_attempted")).toEqual([
        expect.objectContaining({ type: "provider_attempted", kind: "controller", outcome: "ok" }),
        expect.objectContaining({
          type: "provider_attempted",
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
  });
});
