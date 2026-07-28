import { describe, expect, test } from "bun:test";
import { JournalAppendError } from "../shell/journal-store.ts";
import { classifyCheckpointJournalFailure } from "./checkpoint-persistence.ts";

describe("optional checkpoint journal publication", () => {
  test.each([
    ["append", false, false],
    ["sync-before-durable", false, false],
    ["sync-after-durable", true, true],
    ["close", true, true],
  ] as const)("classifies %s storage failure by exact durability", (_seam, durable, expected) => {
    const storage = Object.assign(new Error("storage fault"), { code: "EIO" });
    expect(classifyCheckpointJournalFailure(new JournalAppendError("event", durable, storage))).toBe(expected);
  });

  test.each(["append", "sync", "close"] as const)("propagates writer authority loss at %s", (seam) => {
    const fenced = Object.assign(new Error(`writer fenced at ${seam}`), { code: "WRITER_ARBITER_FENCED" });
    const wrapped = new JournalAppendError("event", seam === "close", fenced);
    expect(() => classifyCheckpointJournalFailure(wrapped)).toThrow(fenced);
  });

  test("does not decline unclassified corruption", () => {
    const corruption = new JournalAppendError("event", false, new TypeError("invalid journal"));
    expect(() => classifyCheckpointJournalFailure(corruption)).toThrow(corruption);
  });
});
