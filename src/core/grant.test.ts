import { describe, expect, test } from "bun:test";
import { consumeGrant, detectExplicitOptIn, emptyGrantStore, expireOtherTurns, mintGrant } from "./grant.ts";

const grant = {
  grantId: "g1",
  sessionId: "s1",
  turnNonce: "t1",
  promptSha256: "p1",
  requestSha256: "r1",
  toolCallId: "call1",
  mode: "slash_command" as const,
  issuedAtMs: 100,
  expiresAtMs: 200,
  expiresAfterToolCall: true as const,
};

const context = {
  grantId: "g1",
  sessionId: "s1",
  turnNonce: "t1",
  promptSha256: "p1",
  requestSha256: "r1",
  toolCallId: "call1",
  nowMs: 150,
};

describe("launch grants", () => {
  test("mint then consume once", () => {
    const { store } = mintGrant(emptyGrantStore(), grant);
    const first = consumeGrant(store, context);
    expect(first.ok).toBe(true);
    if (first.ok) {
      const replay = consumeGrant(first.value.store, context);
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error).toBe("NOT_FOUND");
    }
  });

  test.each([
    [{ sessionId: "other" }, "SESSION_MISMATCH"],
    [{ turnNonce: "other" }, "TURN_MISMATCH"],
    [{ promptSha256: "other" }, "PROMPT_MISMATCH"],
    [{ requestSha256: "other" }, "REQUEST_MISMATCH"],
    [{ toolCallId: "other" }, "TOOL_CALL_MISMATCH"],
  ])("rejects on binding mismatch %o", (override, denial) => {
    const { store } = mintGrant(emptyGrantStore(), grant);
    const result = consumeGrant(store, { ...context, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(denial as never);
  });

  test("rejects an expired grant", () => {
    const { store } = mintGrant(emptyGrantStore(), grant);
    const result = consumeGrant(store, { ...context, nowMs: grant.expiresAtMs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("EXPIRED");
  });

  test("unknown grant id is NOT_FOUND", () => {
    const result = consumeGrant(emptyGrantStore(), context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("NOT_FOUND");
  });

  test("expireOtherTurns keeps only the current turn", () => {
    let { store } = mintGrant(emptyGrantStore(), grant);
    ({ store } = mintGrant(store, { ...grant, grantId: "g2", turnNonce: "t2" }));
    const kept = expireOtherTurns(store, "t2");
    expect(Object.keys(kept.grants)).toEqual(["g2"]);
  });

  test("detectExplicitOptIn recognizes explicit phrases only", () => {
    expect(detectExplicitOptIn("please /rlm summarize")).toBe(true);
    expect(detectExplicitOptIn("use pi-rlm on this repo")).toBe(true);
    expect(detectExplicitOptIn("run an RLM over the logs")).toBe(true);
    expect(detectExplicitOptIn("just summarize this file")).toBe(false);
  });
});
