import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { deriveCallId, identityHash, shortHash } from "./ids.ts";

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

describe("deterministic ids", () => {
  test("identityHash is order-independent", () => {
    expect(identityHash(sha256, { a: 1, b: 2 })).toBe(identityHash(sha256, { b: 2, a: 1 }));
  });

  test("callId is stable for equal identity and kind", () => {
    const a = deriveCallId(sha256, { runId: "r1", kind: "llm", key: "k", identity: { p: 1 } });
    const b = deriveCallId(sha256, { runId: "r1", kind: "llm", key: "k", identity: { p: 1 } });
    expect(a).toBe(b);
    expect(a.startsWith("call_llm_")).toBe(true);
  });

  test("callId changes with identity, kind, key, or run", () => {
    const base = { runId: "r1", kind: "llm" as const, key: "k", identity: { p: 1 } };
    const id = deriveCallId(sha256, base);
    expect(deriveCallId(sha256, { ...base, identity: { p: 2 } })).not.toBe(id);
    expect(deriveCallId(sha256, { ...base, kind: "agent" })).not.toBe(id);
    expect(deriveCallId(sha256, { ...base, key: "k2" })).not.toBe(id);
    expect(deriveCallId(sha256, { ...base, runId: "r2" })).not.toBe(id);
  });

  test("shortHash length", () => {
    expect(shortHash(sha256, "x", 8)).toHaveLength(8);
  });
});
