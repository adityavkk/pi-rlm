import { describe, expect, test } from "bun:test";
import { parseRlmEvent } from "./journal-event.ts";

const usage = { attempts: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: 0, durationMs: 4 };

describe("agent journal event parsing", () => {
  test("accepts bounded agent approval decisions", () => {
    expect(parseRlmEvent({
      type: "agent_approval",
      frameId: "frame",
      callId: "call_agent_abc",
      agent: "reviewer",
      policyId: "policy-v1",
      decision: "approved",
    }).ok).toBe(true);
    expect(parseRlmEvent({
      type: "agent_approval",
      frameId: "frame",
      callId: "call_agent_abc",
      agent: "reviewer",
      policyId: "policy-v1",
      decision: "forged",
    }).ok).toBe(false);
  });

  test("requires the agent request identity version only for agent attempts", () => {
    const event = {
      type: "provider_attempted",
      frameId: "frame",
      operationId: "call_agent_abc",
      kind: "agent",
      key: "review",
      attempt: 1,
      outcome: "ok",
      usage,
      requestIdentityVersion: "pi-rlm.agent-request.v1",
      requestSha256: "a".repeat(64),
    };
    expect(parseRlmEvent(event).ok).toBe(true);
    expect(parseRlmEvent({ ...event, requestIdentityVersion: "pi-rlm.provider-request.v1" }).ok).toBe(false);
    expect(parseRlmEvent({ ...event, kind: "llm" }).ok).toBe(false);
  });
});
