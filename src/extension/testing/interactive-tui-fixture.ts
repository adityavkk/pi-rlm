import { join } from "node:path";
import {
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createRlmExtension } from "../../../index.ts";
import { agentApprovalConfirmationMessage } from "../agent-delegation.ts";
import { createRunCoordinator } from "../run-coordinator.ts";
import type { RunInspectionPage, RunInspectionRequest } from "../../runtime/run-inspection-types.ts";

const USAGE = `Usage: bun src/extension/testing/interactive-tui-fixture.ts

Offline InteractiveMode visual acceptance fixture.
Starts /rlm automatically; exit with Ctrl+D after completing the checklist.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (process.argv.length > 2) throw new Error(USAGE);

const RUN_NAME = `run-${"a".repeat(32)}`;
const RUN_ID = `run_${"b".repeat(64)}`;
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
const APPROVAL_HASH = "e".repeat(64);

let fixtureActiveId = 0;
const approvalFixture: ExtensionFactory = (pi) => {
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
      handle.setPhase("allocating");
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
    description: "Open the production exact delegated-agent approval dialog.",
    handler: async (_args, ctx) => {
      const controller = new AbortController();
      const approved = await ctx.ui.confirm(
        "Approve exact delegated Pi agent request?",
        agentApprovalConfirmationMessage(APPROVAL_REQUEST, APPROVAL_HASH),
        { signal: controller.signal, timeout: 60_000 },
      );
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
    runs: [{
      name: RUN_NAME,
      path: join(process.cwd(), "managed-fixture", RUN_NAME),
      metadata: {
        schemaVersion: 1, status: "completed", owner: "f".repeat(32),
        createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_001_000,
        terminalAtMs: 1_700_000_001_000, runId: RUN_ID,
      },
      bytes: 4_096,
      activity: "inactive",
    }],
    issues: [],
    scannedBytes: 4_096,
    scannedEntries: 8,
  }),
  inspectManagedRunPage,
});

const root = process.cwd();
const agentDir = join(root, ".pi-rlm-visual-agent");
const settingsManager = SettingsManager.inMemory();
const sessionManager = SessionManager.inMemory(root);
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsStore: new InMemoryModelsStore(),
  modelsPath: null,
  allowModelNetwork: false,
});
const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      extensionFactories: [
        { name: "pi-rlm-production-visual", factory: rlmFixture },
        { name: "pi-rlm-approval-visual", factory: approvalFixture },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: options.sessionManager,
    sessionStartEvent: options.sessionStartEvent,
    noTools: "all",
  });
  return { ...created, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd: root, agentDir, sessionManager });
try {
  await new InteractiveMode(runtime, { initialMessage: INITIAL_COMMAND, verbose: true }).run();
} finally {
  await runtime.dispose();
}
