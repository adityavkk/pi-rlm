import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createRlmExtension } from "../../../index.ts";
import { createExtensionAgentDelegation } from "../agent-delegation.ts";
import { createRunCoordinator } from "../run-coordinator.ts";
import type { RunInspectionPage, RunInspectionRequest } from "../../runtime/run-inspection-types.ts";

const RUN_NAME = `run-${"a".repeat(32)}`;
const RUN_ID = `run_${"b".repeat(64)}`;
const ACTIVE_RUN_ID = `run_${"9".repeat(64)}`;
const FRAME_ID = `${RUN_ID}:f0`;
const HASH = "c".repeat(64);
const CURSOR_PREFIX = "visual_next_";
const INITIAL_COMMAND =
  '/rlm {"objective":"Interactive visual fixture","context":"offline deterministic visual context"}';
const ACTIVE_DELAY_MS = 30_000;
const SHORT_DELAY_MS = 800;

const limits = {
  maxDepth: 2,
  maxFrames: 8,
  maxLogicalCalls: 16,
  maxAttempts: 16,
  maxControllerTurns: 4,
  maxConcurrency: 2,
  tokenLimit: 4_096,
  storedByteLimit: 1_048_576,
  deadlineMs: 4_102_444_800_000,
};
const usage = {
  framesOpened: 1,
  logicalCalls: 1,
  attempts: 1,
  controllerTurns: 1,
  activeLeafCalls: 0,
  tokensReserved: 0,
  tokensUsed: 12,
  inputTokensUsed: 8,
  outputTokensUsed: 4,
  costUsd: 0,
  providerDurationMs: 25,
  storedBytes: 128,
};
const ledger = { limits, usage };

const wait = (durationMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(done, durationMs);
  function done(): void {
    signal.removeEventListener("abort", cancelled);
    resolve();
  }
  function cancelled(): void {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancelled);
    reject(signal.reason ?? new Error("cancelled"));
  }
  signal.addEventListener("abort", cancelled, { once: true });
});

const itemsFor = (view: RunInspectionRequest["view"], secondPage: boolean): RunInspectionPage["items"] => {
  const pageOffset = secondPage ? 1 : 0;
  switch (view) {
    case "summary": return [{
      kind: "summary", status: "completed", rootFrameId: FRAME_ID, eventCount: 12,
      frames: 1, cells: 2, committedCalls: 1, observedProviderAttempts: 1,
      completionMode: "fallback_extract",
    }];
    case "frames": return [{
      kind: "frame", frameId: FRAME_ID, parentFrameId: null, depth: 0, state: "answered",
      cells: 2 + pageOffset, committedCalls: 1, phase: { sha256: HASH, bytes: 12 },
    }];
    case "cells": return [{
      kind: "cell", frameId: FRAME_ID, iteration: pageOffset + 1, codeHash: HASH,
      hasResult: true, outputBytes: 64, committedOutputBytes: 64,
      usage: { attempts: 1, inputTokens: 8, outputTokens: 4, totalTokens: 12, costUsd: 0, durationMs: 25 },
    }];
    case "calls": return [{
      kind: "call", frameId: FRAME_ID, callId: `call_llm_${pageOffset === 0 ? HASH : "d".repeat(64)}`,
      callKind: "llm", key: { sha256: HASH, bytes: 16 }, executions: 1, ok: true,
      usage: { attempts: 1, inputTokens: 8, outputTokens: 4, totalTokens: 12, costUsd: 0, durationMs: 25 },
      outputSha256: HASH, outputBytes: 64, observedProviderAttempts: 1, lastOutcome: "ok",
    }];
    case "budget": return [{
      kind: "budget", limits, observedLowerBounds: {
        frames: 1, cells: 2, committedCalls: 1, observedProviderAttempts: 1,
        observedControllerProviderAttempts: 1, reportedInputTokens: 8,
        reportedOutputTokens: 4, reportedTotalTokens: 12, reportedCostUsd: 0,
        providerDurationMs: 25, committedContentBytes: 128,
      },
    }];
    case "errors": return [{
      kind: "error", source: "run", frameId: FRAME_ID,
      error: { trustedCode: "CPU_LIMIT", code: { sha256: HASH, bytes: 9 }, message: { sha256: HASH, bytes: 24 } },
    }];
  }
};

const inspectManagedRunPage = async (request: RunInspectionRequest): Promise<RunInspectionPage> => {
  if (request.runName !== RUN_NAME) throw new Error("unknown visual fixture run");
  const secondPage = request.cursor === `${CURSOR_PREFIX}${request.view}`;
  if (request.cursor !== undefined && !secondPage) throw new Error("invalid visual fixture cursor");
  return {
    version: 1,
    runName: RUN_NAME,
    runId: RUN_ID,
    manifestHash: HASH,
    journalPrefixSha256: HASH,
    eventCount: 12,
    view: request.view,
    items: itemsFor(request.view, secondPage),
    serializedBytes: 512,
    ...(!secondPage ? { nextCursor: `${CURSOR_PREFIX}${request.view}` } : {}),
  };
};

const APPROVAL_REQUEST = {
  runId: RUN_ID,
  frameId: FRAME_ID,
  callId: `${FRAME_ID}:approval`,
  agent: "worker",
  taskSha256: "d".repeat(64),
  taskPreview: "Review the exact offline fixture request.",
  context: "fresh" as const,
  model: "fixture/offline",
  thinking: "medium",
};
let fixtureActiveId = 0;
const approvalFixture: ExtensionFactory = (pi) => {
  const createDelegation = createExtensionAgentDelegation(pi);
  pi.registerCommand("rlm-active-fixture", {
    description: "Create a detached local active run for visual cancellation acceptance.",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      coordinator.setSession(sessionId, 0);
      const handle = coordinator.create({
        sessionId,
        authorizationGeneration: 0,
        objective: `Detached cancellation fixture ${++fixtureActiveId}`,
      });
      handle.bindRunId(ACTIVE_RUN_ID);
      handle.observe({
        sequence: 7,
        phase: "controller",
        status: "running",
        elapsedMs: 94_000,
        calls: { total: 14, active: 3, failed: 0, limit: 16 },
        frames: { total: 6, active: 2, limit: 8 },
        budgets: {
          tokensUsed: 184_200, inputTokensUsed: 160_000, outputTokensUsed: 24_200,
          tokensReserved: 8_000, tokenLimit: 409_600, costUsd: 0,
          providerDurationMs: 81_000, storedBytes: 24_000, storedByteLimit: 1_048_576,
          deadlineMs: 4_102_444_800_000,
        },
      });
      const timer = setTimeout(() => handle.fail("failed", "VISUAL_TIMEOUT"), ACTIVE_DELAY_MS);
      timer.unref();
      handle.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        handle.fail("cancelled", "CANCELLED");
      }, { once: true });
      ctx.ui.notify(`Detached run alias: ${handle.control.localId}`, "info");
    },
  });
  pi.registerCommand("rlm-approval-fixture", {
    description: "Open the production exact delegated-agent approval path.",
    handler: async (_args, ctx) => {
      const controller = new AbortController();
      const sessionId = ctx.sessionManager.getSessionId();
      coordinator.setSession(sessionId, 0);
      const ownership = coordinator.create({
        sessionId,
        authorizationGeneration: 0,
        objective: "Exact delegated-agent approval fixture",
      });
      const delegation = createDelegation(
        ctx,
        sessionId,
        0,
        (expectedId, generation, signal, guardedCtx) =>
          !signal.aborted && generation === 0 && expectedId === sessionId
          && guardedCtx.sessionManager.getSessionId() === sessionId,
        {
          begin: (request, requestSha256) => ownership.beginAgentApproval({
            requestSha256,
            agent: request.agent,
            taskSha256: request.taskSha256,
            context: request.context,
            ...(request.model ? { model: request.model } : {}),
            ...(request.thinking ? { thinking: request.thinking } : {}),
          }),
        },
      );
      const approved = await delegation.approval?.approve(APPROVAL_REQUEST, controller.signal) === true;
      ownership.fail("cancelled", approved ? "FIXTURE_APPROVED" : "FIXTURE_DECLINED");
      ctx.ui.notify(approved ? "Fixture approval accepted." : "Fixture approval declined.", "info");
    },
  });
};

let localId = 0;
let controlToken = 0;
let grantId = 0;
let runNumber = 0;
const coordinator = createRunCoordinator({
  createLocalId: () => `rlm_visual_${++localId}`,
  createControlToken: () => (++controlToken).toString(16).padStart(64, "0"),
});
const rlmFixture = createRlmExtension({
  runCoordinator: coordinator,
  createId: () => `visual_grant_${++grantId}`,
  executeRun: async (_request, signal) => {
    const ordinal = ++runNumber;
    await wait(ordinal === 1 ? ACTIVE_DELAY_MS : SHORT_DELAY_MS, signal);
    if (ordinal > 1 && ordinal % 2 === 1) return {
      runId: `run_${ordinal.toString(16).padStart(64, "0")}`,
      status: "failed",
      error: { code: "VISUAL_FAILURE", message: "deterministic offline visual failure" },
      ledger,
    };
    return {
      runId: `run_${ordinal.toString(16).padStart(64, "0")}`,
      status: "completed",
      completionMode: "fallback_extract",
      answer: { answer: `offline fallback fixture ${ordinal}` },
      ledger,
    };
  },
  listManagedRuns: async () => ({
    root: join(process.cwd(), "managed-fixture"),
    runs: [
      {
        name: RUN_NAME,
        path: join(process.cwd(), "managed-fixture", RUN_NAME),
        metadata: {
          schemaVersion: 1, status: "completed", owner: "f".repeat(32),
          createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_003_000,
          terminalAtMs: 1_700_000_003_000, runId: RUN_ID,
        },
        bytes: 196_608,
        activity: "inactive",
      },
      {
        name: `run-${"c".repeat(32)}`,
        path: join(process.cwd(), "managed-fixture", `run-${"c".repeat(32)}`),
        metadata: {
          schemaVersion: 1, status: "failed", owner: "f".repeat(32),
          createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_002_000,
          terminalAtMs: 1_700_000_002_000, runId: `run_${"d".repeat(64)}`,
        },
        bytes: 86_016,
        activity: "inactive",
      },
      {
        name: `run-${"e".repeat(32)}`,
        path: join(process.cwd(), "managed-fixture", `run-${"e".repeat(32)}`),
        metadata: {
          schemaVersion: 1, status: "completed", owner: "f".repeat(32),
          createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_001_000,
          terminalAtMs: 1_700_000_001_000, runId: `run_${"f".repeat(64)}`,
        },
        bytes: 48_128,
        activity: "inactive",
      },
    ],
    issues: [],
    scannedBytes: 4_096,
    scannedEntries: 8,
  }),
  inspectManagedRunPage,
});


export const VISUAL_FIXTURE_EXTENSIONS = Object.freeze([
  { name: "pi-rlm-production-visual", factory: rlmFixture },
  { name: "pi-rlm-approval-visual", factory: approvalFixture },
]);

export const fullPiVisualExtension: ExtensionFactory = (pi) => {
  rlmFixture(pi);
  approvalFixture(pi);
};
