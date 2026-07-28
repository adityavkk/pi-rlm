import { describe, expect, test } from "bun:test";
import {
  AGENT_REQUEST_IDENTITY_VERSION,
  deriveOperationIntentId,
  OPERATION_JOURNAL_SCHEMA_VERSION,
  PROVIDER_REQUEST_IDENTITY_VERSION,
  type OperationIntentIdentity,
} from "../core/operation.ts";
import { sha256 } from "./hash.ts";
import { parseRlmEvent } from "./journal-event.ts";

const usage = { attempts: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: 0, durationMs: 4 };

const intent = (kind: OperationIntentIdentity["kind"] = "agent") => {
  const identity: OperationIntentIdentity = {
    schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
    runId: "run",
    frameId: "frame",
    operationId: "call_agent_abc",
    kind,
    key: "fixture",
    attempt: 1,
    requestIdentityVersion: kind === "agent" ? AGENT_REQUEST_IDENTITY_VERSION : PROVIDER_REQUEST_IDENTITY_VERSION,
    requestSha256: "a".repeat(64),
    reservation: { logicalCalls: 1, attempts: 1, tokens: 0 },
  };
  return { type: "operation_intended" as const, ...identity, intentId: deriveOperationIntentId(sha256, identity) };
};

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

  test("requires exact request versions and a recomputed intent identity", () => {
    const event = intent();
    expect(parseRlmEvent(event).ok).toBe(true);
    expect(parseRlmEvent({ ...event, requestIdentityVersion: PROVIDER_REQUEST_IDENTITY_VERSION }).ok).toBe(false);
    expect(parseRlmEvent({ ...event, kind: "llm" }).ok).toBe(false);
    expect(parseRlmEvent({ ...event, reservation: { ...event.reservation, tokens: 1 } }).ok).toBe(false);
    expect(parseRlmEvent({ ...event, task: "must-not-persist" }).ok).toBe(false);
  });

  test("requires one strict settlement with typed outcome metadata", () => {
    const intended = intent("llm");
    const settled = {
      type: "operation_settled",
      schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
      runId: intended.runId,
      frameId: intended.frameId,
      intentId: intended.intentId,
      outcome: "ok",
      usage,
    } as const;
    expect(parseRlmEvent(settled).ok).toBe(true);
    expect(parseRlmEvent({ ...settled, errorCode: "FAILED" }).ok).toBe(false);
    expect(parseRlmEvent({ ...settled, outcome: "error", errorCode: "FAILED" }).ok).toBe(true);
    expect(parseRlmEvent({ ...settled, outcome: "error" }).ok).toBe(false);
    expect(parseRlmEvent({ ...settled, usage: { ...usage, attempts: 2 } }).ok).toBe(false);
  });
});
