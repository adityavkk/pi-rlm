import { describe, expect, test } from "bun:test";
import type { RlmEvent } from "../core/journal.ts";
import { recoveryCallRetryFrameCompatible } from "./run-recovery-journal.ts";

type Call = Extract<RlmEvent, { type: "call_committed" }>;
const call = (kind: Call["kind"], frameId: string): Call => ({
  type: "call_committed",
  frameId,
  callId: `call_${kind}_${"a".repeat(64)}`,
  kind,
  key: "global-retry",
  cached: false,
  ok: false,
  usage: { attempts: 1, durationMs: 0 },
  outputRef: `ctx_${"b".repeat(64)}`,
  outputSha256: "b".repeat(64),
  outputBytes: 1,
});

describe("recovery call execution scope", () => {
  test.each(["llm", "agent"] as const)("permits a failed global %s call to retry across frames", (kind) => {
    expect(recoveryCallRetryFrameCompatible(call(kind, "child"), call(kind, "root"))).toBe(true);
  });

  test("keeps recurse retries in their lineage frame and rejects kind drift", () => {
    expect(recoveryCallRetryFrameCompatible(call("recurse", "child"), call("recurse", "root"))).toBe(false);
    expect(recoveryCallRetryFrameCompatible(call("llm", "child"), call("agent", "root"))).toBe(false);
  });
});
