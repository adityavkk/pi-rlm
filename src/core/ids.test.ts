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
    expect(a).toMatch(/^call_llm_[0-9a-f]{64}$/);
  });

  test("callId changes with identity, kind, key, or run", () => {
    const base = { runId: "r1", kind: "llm" as const, key: "k", identity: { p: 1 } };
    const id = deriveCallId(sha256, base);
    expect(deriveCallId(sha256, { ...base, identity: { p: 2 } })).not.toBe(id);
    expect(deriveCallId(sha256, { ...base, kind: "agent" })).not.toBe(id);
    expect(deriveCallId(sha256, { ...base, key: "k2" })).not.toBe(id);
    expect(deriveCallId(sha256, { ...base, runId: "r2" })).not.toBe(id);
  });

  test("callId does not alias equal prefixes and rejects non-SHA digests", () => {
    const base = { runId: "r1", kind: "llm" as const, key: "k", identity: { p: 1 } };
    const prefix = "a".repeat(24);
    const first = deriveCallId(() => `${prefix}${"1".repeat(40)}`, base);
    const second = deriveCallId(() => `${prefix}${"2".repeat(40)}`, base);
    expect(first).not.toBe(second);
    expect(() => deriveCallId(() => "a".repeat(63), base)).toThrow(/64 lowercase hexadecimal/);
    expect(() => identityHash(() => "A".repeat(64), {})).toThrow(/64 lowercase hexadecimal/);
  });

  test("shortHash length", () => {
    expect(shortHash(sha256, "x", 8)).toHaveLength(8);
  });
});
