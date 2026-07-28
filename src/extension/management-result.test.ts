import { describe, expect, test } from "bun:test";
import type { RunResult } from "../runtime/run.ts";
import { createLedger } from "../core/budget.ts";
import { DEFAULT_PROFILE, resolveLimits } from "../runtime/profile.ts";
import {
  managementContent,
  managementFailure,
  projectCleanupManagement,
  projectInspectManagement,
  projectResumeManagement,
  projectRunsManagement,
} from "./management-result.ts";

const name = `run-${"a".repeat(32)}`;
const runId = `run_${"b".repeat(64)}`;
const listing = {
  root: "/private/secret/root",
  runs: [{
    name, path: "/private/secret/run", bytes: 10, activity: "inactive",
    metadata: { schemaVersion: 1, status: "completed", owner: "SECRET_OWNER_TOKEN", createdAtMs: 1,
      updatedAtMs: 2, terminalAtMs: 2, runId },
  }],
  issues: [{ code: "SCAN_FAILED", message: "RAW ERROR /private/path", cause: new Error("SECRET") }],
  scannedBytes: 10,
  scannedEntries: 2,
} as never;

describe("management result projection", () => {
  test("list, inspect, and cleanup omit paths, owners, raw errors, and checkpoint content", () => {
    const listed = managementContent(projectRunsManagement(listing));
    expect(listed).toContain(name);
    expect(listed).not.toContain("/private");
    expect(listed).not.toContain("OWNER");
    expect(listed).not.toContain("RAW ERROR");

    const inspected = managementContent(projectInspectManagement({
      version: 1, runName: name, runId, manifestHash: "c".repeat(64), journalPrefixSha256: "d".repeat(64),
      eventCount: 1, view: "summary", serializedBytes: 1, items: [{
        kind: "summary", status: "failed", rootFrameId: `${runId}:f0`, eventCount: 1, frames: 1, cells: 0,
        committedCalls: 0, observedProviderAttempts: 0,
        error: { code: { sha256: "e".repeat(64), bytes: 999 }, message: { sha256: "f".repeat(64), bytes: 999 } },
      }],
    }, name));
    expect(inspected).not.toContain("checkpoint content");
    expect(inspected).not.toContain("RAW");

    const cleaned = managementContent(projectCleanupManagement({
      ...(listing as unknown as Record<string, unknown>), deleted: [name], wouldDelete: [], retained: [], skipped: [],
    } as never, "apply"));
    expect(cleaned).toContain(name);
    expect(cleaned).not.toContain("/private");
  });

  test("resume output contains only terminal accounting metadata, never the answer or raw error", () => {
    const result: RunResult = {
      runId,
      status: "failed",
      answer: { secret: "RAW CHECKPOINT ANSWER" },
      error: { code: "FAILED", message: "RAW PROVIDER ERROR /private/path" },
      ledger: createLedger(resolveLimits(DEFAULT_PROFILE, 0)),
    };
    const encoded = managementContent(projectResumeManagement(result, name));
    expect(encoded).toContain("FAILED");
    expect(encoded).not.toContain("RAW");
    expect(encoded).not.toContain("/private");
  });

  test("fixed failures remain bounded canonical metadata", () => {
    const encoded = managementContent(managementFailure("resume", "RLM_RESUME_TERMINAL", "Run is inspect-only.", {
      managedName: name, inspectOnly: true,
    }));
    expect(JSON.parse(encoded)).toMatchObject({ operation: "resume", code: "RLM_RESUME_TERMINAL", inspectOnly: true });
    expect(Buffer.byteLength(encoded)).toBeLessThan(64 * 1024);
  });
});
