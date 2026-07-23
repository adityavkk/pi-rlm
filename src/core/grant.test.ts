import { describe, expect, test } from "bun:test";
import { consumeGrant, detectExplicitOptIn, emptyGrantStore, expireOtherTurns, mintGrant } from "./grant.ts";

const grant = {
  grantId: "g1",
  sessionId: "s1",
  turnNonce: "t1",
  promptSha256: "p1",
  mode: "slash_command" as const,
};

describe("launch grants", () => {
  test("mint then consume once", () => {
    const { store } = mintGrant(emptyGrantStore(), grant);
    const ctx = { grantId: "g1", sessionId: "s1", turnNonce: "t1", promptSha256: "p1" };
    const first = consumeGrant(store, ctx);
    expect(first.ok).toBe(true);
    if (first.ok) expect(consumeGrant(first.value.store, ctx).ok).toBe(false); // single-use
  });

  test.each([
    [{ sessionId: "other" }, "SESSION_MISMATCH"],
    [{ turnNonce: "other" }, "TURN_MISMATCH"],
    [{ promptSha256: "other" }, "PROMPT_MISMATCH"],
  ])("rejects on binding mismatch %o", (override, denial) => {
    const { store } = mintGrant(emptyGrantStore(), grant);
    const ctx = { grantId: "g1", sessionId: "s1", turnNonce: "t1", promptSha256: "p1", ...override };
    const r = consumeGrant(store, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(denial as never);
  });

  test("unknown grant id is NOT_FOUND", () => {
    const r = consumeGrant(emptyGrantStore(), { grantId: "x", sessionId: "s1", turnNonce: "t1", promptSha256: "p1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NOT_FOUND");
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
