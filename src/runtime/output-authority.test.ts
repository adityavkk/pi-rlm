import { describe, expect, test } from "bun:test";
import type { RlmEvent } from "../core/journal.ts";
import { outputFromEvents } from "./run.ts";

const digest = "a".repeat(64);
const ref = `ctx_${digest}`;
const runId = `run_${"b".repeat(64)}`;
const rootFrameId = `${runId}:f0`;
const completed = { runId, status: "completed", completionMode: "answer", answer: { answer: "ok" } } as const;
const answer: Extract<RlmEvent, { type: "answer_committed" }> = {
  type: "answer_committed",
  frameId: rootFrameId,
  completionMode: "answer",
  outputRef: ref,
  outputSha256: digest,
  outputBytes: 15,
};
const terminal: Extract<RlmEvent, { type: "run_completed" }> = {
  type: "run_completed", runId, completionMode: "answer", outputRef: ref,
};

describe("current completion output authority", () => {
  test("correlates expected run, terminal ref, root frame, mode, hash, and bytes", () => {
    expect(outputFromEvents([answer, terminal], runId, rootFrameId, completed)).toEqual({
      ref, sha256: digest, bytes: 15,
    });
    const foreign: RlmEvent = {
      type: "run_completed", runId: "foreign", completionMode: "answer", outputRef: `ctx_${"c".repeat(64)}`,
    };
    expect(outputFromEvents([foreign, answer, terminal], runId, rootFrameId, completed)).toEqual({
      ref, sha256: digest, bytes: 15,
    });
  });

  test.each(([
    [{ ...terminal, runId: "foreign" }],
    [answer, { ...terminal, outputRef: `ctx_${"c".repeat(64)}` }],
    [{ ...answer, frameId: `${runId}:f1` }, terminal],
    [{ ...answer, completionMode: "fallback_extract" }, terminal],
    [{ ...answer, outputSha256: undefined }, terminal],
    [{ ...answer, outputBytes: undefined }, terminal],
    [answer, { ...answer }, terminal],
    [answer, terminal, { ...terminal }],
  ] as RlmEvent[][]).map((events) => ({ events })))("fails closed for adversarial journal events %#", ({ events }) => {
    expect(outputFromEvents(events, runId, rootFrameId, completed)).toBeUndefined();
  });
});
