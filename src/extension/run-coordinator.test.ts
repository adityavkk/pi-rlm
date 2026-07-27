import { describe, expect, test } from "bun:test";
import { createLedger } from "../core/budget.ts";
import type { RunProgressSnapshot } from "../runtime/run-progress.ts";
import type { RunResult } from "../runtime/run.ts";
import {
  createRunCoordinator,
  objectivePreview,
  RUN_COORDINATOR_MAX_ACTIVE,
  RUN_COORDINATOR_MAX_RECENT,
  RUN_COORDINATOR_MAX_SUBSCRIBERS,
} from "./run-coordinator.ts";

const runId = (value: string): string => `run_${value.repeat(64).slice(0, 64)}`;
const runName = (value: string): string => `run-${value.repeat(32).slice(0, 32)}`;
const indexedRunId = (value: number): string => `run_${value.toString(16).padStart(64, "0")}`;
const limits = {
  maxDepth: 2, maxFrames: 4, maxLogicalCalls: 8, maxAttempts: 8,
  maxControllerTurns: 4, maxConcurrency: 2, storedByteLimit: 1_000, deadlineMs: 5_000,
};
const terminal = (id: string, status: RunResult["status"] = "completed"): RunResult => ({
  runId: id,
  status,
  ...(status === "completed" ? { completionMode: "answer" as const, answer: { answer: "not projected" } } : {}),
  ...(status === "failed" ? { error: { code: "TEST_FAILED", message: "not projected" } } : {}),
  ...(status === "cancelled" ? { error: { code: "CANCELLED", message: "not projected" } } : {}),
  ledger: createLedger(limits),
});

const progress = (id: string, sequence = 1): RunProgressSnapshot => Object.freeze({
  sequence,
  runId: id,
  phase: "controller" as const,
  status: "running" as const,
  elapsedMs: 10,
  calls: Object.freeze({ total: 2, active: 1, failed: 0, limit: 8 }),
  frames: Object.freeze({ total: 1, active: 1, limit: 4 }),
  budgets: Object.freeze({
    tokensUsed: 3, inputTokensUsed: 2, outputTokensUsed: 1, tokensReserved: 5,
    costUsd: 0.01, providerDurationMs: 4, storedBytes: 6, storedByteLimit: 1_000, deadlineMs: 5_000,
  }),
});

const fixture = () => {
  let local = 0;
  let token = 0;
  const coordinator = createRunCoordinator({
    createLocalId: () => `rlm_local_${++local}`,
    createControlToken: () => `control_${String(++token).padStart(40, "0")}`,
  });
  coordinator.setSession("session", 1);
  return coordinator;
};

describe("run coordinator", () => {
  test("binds exact aliases and never renders local control authority", () => {
    const coordinator = fixture();
    const handle = coordinator.create({
      sessionId: "session", authorizationGeneration: 1,
      objective: `review\u001b[31m\n${"é".repeat(200)}`,
    });
    expect(handle.bindRunName(runName("a"))).toEqual({ ok: true });
    expect(handle.bindRunId(runId("b"))).toEqual({ ok: true });
    handle.observe(progress(runId("b")));
    for (const alias of [handle.control.localId, runName("a"), runId("b")])
      expect(coordinator.resolve(alias)?.localId).toBe(handle.control.localId);
    const projected = coordinator.resolve(handle.control.localId)!;
    expect(Buffer.byteLength(projected.objectivePreview, "utf8")).toBeLessThanOrEqual(240);
    expect(projected.objectivePreview).not.toContain("\u001b");
    expect(JSON.stringify(projected)).not.toContain(handle.control.token);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected.progress).toEqual(progress(runId("b")));
  });

  test("only the exact capability cancels and cancellation is idempotent", () => {
    const coordinator = fixture();
    const handle = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "x" });
    handle.bindRunId(runId("c"));
    expect(coordinator.cancel({ localId: handle.control.localId, token: "x".repeat(32) }))
      .toMatchObject({ ok: false, code: "RUN_NOT_OWNED" });
    expect(coordinator.cancel({ localId: runId("c"), token: handle.control.token }))
      .toMatchObject({ ok: false, code: "RUN_NOT_OWNED" });
    expect(handle.cancel()).toEqual({ ok: true, requested: true });
    expect(handle.signal.aborted).toBe(true);
    expect(handle.cancel()).toEqual({ ok: true, alreadyRequested: true });
    handle.finish(terminal(runId("c"), "cancelled"));
    expect(handle.cancel()).toMatchObject({ ok: false, code: "RUN_TERMINAL" });
  });

  test("external signals and session invalidation share owned abort paths", () => {
    const coordinator = fixture();
    const toolOwner = new AbortController();
    const tool = coordinator.create({
      sessionId: "session", authorizationGeneration: 1, objective: "tool", ownerSignal: toolOwner.signal,
    });
    const command = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "command" });
    toolOwner.abort();
    expect(tool.signal.aborted).toBe(true);
    expect(command.signal.aborted).toBe(false);
    coordinator.invalidateSession();
    expect(command.signal.aborted).toBe(true);
    expect(coordinator.resolve(tool.control.localId)?.state).toBe("cancelling");
    expect(coordinator.resolve(command.control.localId)?.state).toBe("cancelling");
  });

  test("terminal completion wins once and late results cannot mutate it", () => {
    const coordinator = fixture();
    const handle = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "x" });
    const id = runId("d");
    handle.finish(terminal(id));
    const before = coordinator.resolve(handle.control.localId);
    expect(handle.finish(terminal(id, "failed"))).toMatchObject({ ok: false, code: "RUN_TERMINAL" });
    handle.observe(progress(id, 99));
    expect(coordinator.resolve(handle.control.localId)).toEqual(before);
    expect(handle.cancel()).toMatchObject({ ok: false, code: "RUN_TERMINAL" });
  });

  test("alias collision never overwrites an existing record", () => {
    const firstId = runId("e");
    let ids = [firstId, "rlm_second"];
    const coordinator = createRunCoordinator({
      createLocalId: () => ids.shift()!,
      createControlToken: () => `control_${"x".repeat(40)}`,
    });
    coordinator.setSession("session", 1);
    const first = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "first" });
    const second = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "second" });
    expect(second.bindRunId(firstId)).toMatchObject({ ok: false, code: "ALIAS_COLLISION" });
    expect(coordinator.resolve(firstId)?.localId).toBe(first.control.localId);
  });

  test("active, recent, and subscriber caps are exact", () => {
    const coordinator = fixture();
    const active = Array.from({ length: RUN_COORDINATOR_MAX_ACTIVE }, (_, index) =>
      coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: String(index) }));
    expect(() => coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "overflow" }))
      .toThrow(expect.objectContaining({ code: "COORDINATOR_ACTIVE_LIMIT" }));
    active.forEach((handle, index) => expect(handle.finish(terminal(indexedRunId(index)))).toEqual({ ok: true }));
    const oldest = active[0]!;
    for (let index = RUN_COORDINATOR_MAX_ACTIVE; index < RUN_COORDINATOR_MAX_RECENT + 5; index++) {
      const handle = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: String(index) });
      expect(handle.finish(terminal(indexedRunId(index)))).toEqual({ ok: true });
    }
    expect(coordinator.list()).toHaveLength(RUN_COORDINATOR_MAX_RECENT);
    expect(coordinator.resolve(oldest.control.localId)).toBeUndefined();
    expect(coordinator.resolve(indexedRunId(0))).toBeUndefined();
    expect(oldest.fail()).toMatchObject({ ok: false, code: "RUN_NOT_OWNED" });
    const disposers = Array.from({ length: RUN_COORDINATOR_MAX_SUBSCRIBERS }, () =>
      coordinator.subscribe(() => { throw new Error("ignored"); }));
    const activeSubscriberRun = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "notify" });
    activeSubscriberRun.setPhase("initializing");
    activeSubscriberRun.fail();
    expect(() => coordinator.subscribe(() => {}))
      .toThrow(expect.objectContaining({ code: "COORDINATOR_SUBSCRIBER_LIMIT" }));
    disposers.forEach((dispose) => dispose());
  });

  test("stale generations cannot allocate or replace current ownership", () => {
    const coordinator = fixture();
    coordinator.setSession("session", 2);
    expect(() => coordinator.setSession("session", 1))
      .toThrow(expect.objectContaining({ code: "COORDINATOR_STALE_GENERATION" }));
    expect(() => coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "stale" }))
      .toThrow(expect.objectContaining({ code: "COORDINATOR_STALE_GENERATION" }));
  });

  test("finish validates identity atomically before terminalization", () => {
    const coordinator = fixture();
    const first = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "first" });
    const second = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "second" });
    expect(first.bindRunId(runId("a"))).toEqual({ ok: true });
    expect(second.finish(terminal(runId("a")))).toMatchObject({ ok: false, code: "ALIAS_COLLISION" });
    expect(coordinator.resolve(second.control.localId)?.state).toBe("running");
    expect(second.bindRunId(runId("b"))).toEqual({ ok: true });
    expect(second.finish(terminal(runId("c")))).toMatchObject({ ok: false, code: "IDENTITY_MISMATCH" });
    expect(second.fail("failed", "RLM_RUN_IDENTITY_FAILED")).toEqual({ ok: true });
    expect(coordinator.resolve(second.control.localId)?.terminal?.errorCode).toBe("RLM_RUN_IDENTITY_FAILED");
  });

  test("early phases hand off, terminal refreshes once, and cancel defeats late completion", () => {
    const coordinator = fixture();
    const phases: string[] = [];
    coordinator.subscribe((runs) => {
      const phase = runs[0]?.progress?.phase;
      if (phase) phases.push(phase);
      throw new Error("active subscriber failure");
    });
    const handle = coordinator.create({ sessionId: "session", authorizationGeneration: 1, objective: "x" });
    handle.setPhase("source_capture");
    handle.setPhase("initializing");
    handle.setPhase("allocating");
    let reads = 0;
    const runtime = progress(runId("d"), 1);
    handle.attachProgress({ getSnapshot: () => { reads += 1; return runtime; } });
    expect(phases).toEqual(expect.arrayContaining(["source_capture", "initializing", "allocating", "controller"]));
    expect(handle.cancel()).toEqual({ ok: true, requested: true });
    expect(handle.fail("cancelled", "CANCELLED")).toEqual({ ok: true });
    const terminalRun = coordinator.resolve(handle.control.localId);
    const terminalReads = reads;
    coordinator.list();
    coordinator.resolve(handle.control.localId);
    expect(reads).toBe(terminalReads);
    expect(handle.finish(terminal(runId("d")))).toMatchObject({ ok: false, code: "RUN_TERMINAL" });
    expect(coordinator.resolve(handle.control.localId)).toEqual(terminalRun);
  });

  test("objective preview is scalar, sanitized, and byte bounded", () => {
    const preview = objectivePreview(`a\u009b31m\u202e${"😀".repeat(100)}`);
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(240);
    expect(preview).not.toContain("\u009b");
    expect(preview).not.toContain("\u202e");
  });
});
