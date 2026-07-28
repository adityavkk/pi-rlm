/**
 * pi-rlm extension entry.
 *
 * Launcher prompt guidance is intentionally separate from authorization. Every
 * run crosses a host-owned, session/turn/prompt/request/tool-call-bound,
 * single-use grant before the model runtime or QuickJS backend is initialized.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  canonicalStringify,
  consumeGrant,
  emptyGrantStore,
  mintGrant,
  parseJsonValue,
  type GrantConsumeContext,
  type GrantDenial,
  type GrantMode,
  type LaunchGrant,
} from "./src/core/index.ts";
import {
  DEFAULT_PROFILE,
  ModelController,
  type LaunchAuthorizationMode,
  type Profile,
  preflightRunComponents,
  prepareAgentDelegation,
  type AgentDelegationConfig,
  runProgram,
  type RunResult,
  type RunWarning,
  type ManagedResumeCandidateInspection,
  inspectManagedResumeCandidate as inspectManagedResumeCandidateDefault,
} from "./src/runtime/index.ts";
import { MANAGED_RUN_PERSISTENCE } from "./src/runtime/run-managed-lifecycle.ts";
import {
  ManagedRunStore,
  RunRetentionError,
  type ManagedRunListing,
  type ManagedRunStoreOptions,
  type RunCleanupOptions,
  type RunCleanupResult,
} from "./src/runtime/run-retention.ts";
import {
  inspectManagedRunPage as inspectManagedRunPageDefault,
} from "./src/runtime/run-inspection.ts";
import type {
  RunInspectionPage,
  RunInspectionRequest,
} from "./src/runtime/run-inspection-types.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./src/runtime/abort.ts";
import type { ControllerDriver } from "./src/runtime/controller.ts";
import type { InterpreterBackend } from "./src/shell/interpreter/backend.ts";
import { QuickJsBackend } from "./src/shell/interpreter/quickjs.ts";
import { createExtensionAgentDelegation } from "./src/extension/agent-delegation.ts";
import {
  createRunCoordinator,
  type OwnedRunHandle,
  type RunCoordinator,
} from "./src/extension/run-coordinator.ts";
import { sha256 } from "./src/shell/hash.ts";
import type { ModelClient } from "./src/shell/model/client.ts";
import { PiModelClient } from "./src/shell/model/pi-model.ts";
import {
  buildInlineRequest,
  captureCommandRequest,
  type LaunchRequest,
} from "./src/extension/source.ts";
import {
  failureProjection,
  projectRunResult,
  resultContent,
  resultMetadata,
  type RlmResultMetadata,
  type RlmResultProjection,
} from "./src/extension/result.ts";
import { RunWidget } from "./src/extension/tui/run-widget.ts";
import { openRunNavigator } from "./src/extension/tui/run-navigator.ts";
import { openRunInspector } from "./src/extension/tui/run-inspector.ts";
import {
  cancelLocalRun,
  resolveInspectionRunName,
  routeRlmCommand,
} from "./src/extension/run-command.ts";
import {
  acquireManagedResumeLease as acquireManagedResumeLeaseDefault,
  type ManagedResumeLease,
} from "./src/extension/managed-resume-lease.ts";
import {
  consumeResumeGrant,
  emptyResumeGrantStore,
  mintResumeGrant,
  revokeResumeGrant,
  type ManagedResumeGrant,
  type ResumeAuthorizationBinding,
} from "./src/extension/resume-grant.ts";
import {
  managementContent,
  managementFailure,
  projectCleanupManagement,
  projectInspectManagement,
  projectResumeManagement,
  projectRunsManagement,
  type RlmManagementMetadata,
} from "./src/extension/management-result.ts";
import { truncateDisplayLine } from "./src/extension/run-display.ts";
import {
  renderRlmRunCallComponent,
  renderRlmToolResultComponent,
} from "./src/extension/tui/result-renderer.ts";

export const LAUNCH_SNIPPET =
  "pi-rlm runs long-context recursive model/agent workflows in a sandboxed JS controller. " +
  "Use /rlm for a direct host launch; rlm_run always requires exact-request host confirmation. " +
  "Do not propose it for ordinary tasks.";

const envModel = (key: string, fallback: string): string => process.env[key] ?? fallback;

const resolveProfile = (): Profile => {
  const base = envModel("PI_RLM_MODEL", "anthropic/claude-sonnet-4-5");
  return {
    ...DEFAULT_PROFILE,
    models: {
      small: envModel("PI_RLM_MODEL_SMALL", base),
      medium: envModel("PI_RLM_MODEL_MEDIUM", base),
      large: envModel("PI_RLM_MODEL_LARGE", base),
    },
  };
};

let backendPromise: Promise<QuickJsBackend> | undefined;
const getBackend = (): Promise<QuickJsBackend> => (backendPromise ??= QuickJsBackend.create());

let runtimePromise: Promise<ModelRuntime> | undefined;
const getRuntime = (): Promise<ModelRuntime> => (runtimePromise ??= ModelRuntime.create());


const requestSha256 = (request: LaunchRequest): string => {
  const parsed = parseJsonValue({ program: request.program, sources: request.sources });
  if (!parsed.ok) throw new TypeError(`Normalized launch request is not JSON at ${parsed.path}: ${parsed.reason}`);
  return sha256(canonicalStringify(parsed.value));
};

const preview = (value: string, limit = 240): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length} characters)`;

const confirmationMessage = (request: LaunchRequest, hash: string): string => {
  const sources = Object.entries(request.sources)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name} (${Buffer.byteLength(value, "utf8")} bytes)`)
    .join(", ");
  return [
    `Objective: ${preview(request.program.objective)}`,
    `Profile: ${request.program.profile}`,
    `Inputs: ${request.program.inputs.map((input) => input.name).join(", ") || "none"}`,
    `Outputs: ${request.program.outputs.map((output) => output.name).join(", ")}`,
    `Sources: ${sources || "none"}`,
    `Exact normalized request SHA-256: ${hash}`,
    "This run may make many model calls and spend tokens.",
  ].join("\n");
};

const resumeConfirmationMessage = (request: RlmResumeAuthorizationRequest): string => [
  `Managed name: ${request.managedName}`,
  `Run ID: ${request.runId}`,
  `Manifest SHA-256: ${request.manifestHash}`,
  `Checkpoint: ${request.checkpointSequence}`,
  `Checkpoint SHA-256: ${request.checkpointSha256}`,
  `Checkpoint prefix SHA-256: ${request.checkpointPrefixSha256}`,
  `Writer generation: ${request.writerOrdinal}`,
  `Writer token SHA-256: ${request.writerTokenSha256}`,
  `Session authorization generation: ${request.authorizationGeneration}`,
  `Command nonce: ${request.commandNonce}`,
  `Turn origin SHA-256: ${request.turnOriginSha256}`,
  `Mode: ${request.mode}`,
  `Authorization expires at: ${request.expiresAtMs}`,
  "Continuation may make model or delegated-agent calls and spend tokens.",
].join("\n");

const sameResumeCandidate = (
  left: ManagedResumeCandidateInspection,
  right: ManagedResumeCandidateInspection,
): boolean => left.managedName === right.managedName
  && left.runId === right.runId
  && left.manifestHash === right.manifestHash
  && left.checkpointSequence === right.checkpointSequence
  && left.checkpointSha256 === right.checkpointSha256
  && left.checkpointPrefixSha256 === right.checkpointPrefixSha256
  && left.journalPrefixSha256 === right.journalPrefixSha256
  && left.nextIteration === right.nextIteration
  && left.nextControllerTurn === right.nextControllerTurn
  && left.deadlineMs === right.deadlineMs
  && left.agentDelegationRequired === right.agentDelegationRequired;

const resumeErrorProjection = (error: unknown, managedName: string): RlmManagementMetadata => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
  const classified = code === "RECOVERY_TERMINAL"
    ? ["RLM_RESUME_TERMINAL", "Terminal managed runs are inspect-only.", true] as const
    : code === "RECOVERY_AMBIGUOUS"
      ? ["RLM_RESUME_AMBIGUOUS", "Managed continuation is ambiguous and inspect-only.", true] as const
      : code === "RECOVERY_CHECKPOINT_MISSING"
        ? ["RLM_RESUME_CHECKPOINT_MISSING", "Managed run has no resumable checkpoint.", true] as const
        : code === "RECOVERY_INCOMPATIBLE" || code === "RECOVERY_COMPONENT_MISMATCH"
          || code === "RECOVERY_CONTROLLER_UNSUPPORTED" || code === "RECOVERY_UNSUPPORTED_STATE"
          ? ["RLM_RESUME_INCOMPATIBLE", "Managed continuation is incompatible and inspect-only.", true] as const
          : code === "RECOVERY_UNSAFE_TAIL" || code === "RECOVERY_CHECKPOINT_INVALID"
            || code === "RECOVERY_SEMANTIC_CORRUPTION" || code === "RECOVERY_JOURNAL_CORRUPT"
            ? ["RLM_RESUME_INVALID", "Managed continuation authority is invalid and inspect-only.", true] as const
            : code === "RECOVERY_DIRECTORY_INVALID"
              ? ["RLM_RESUME_NOT_FOUND", "Exact managed resume target was not found.", false] as const
              : code === "RUN_RETENTION_RESUME_FAILED"
                ? ["RLM_RESUME_CONTENDED", "Managed continuation writer authority is unavailable.", false] as const
                : code === "BUDGET_DEADLINE"
                  ? ["RLM_RESUME_DEADLINE", "Managed run absolute deadline has elapsed.", true] as const
                  : ["RLM_RESUME_FAILED", "Managed continuation failed before completion.", false] as const;
  return managementFailure("resume", classified[0], classified[1], {
    managedName,
    ...(classified[2] ? { inspectOnly: true } : {}),
  });
};

const retentionWarning = (
  result: RunResult,
  code: Extract<RunWarning["code"], "RETENTION_METADATA_FAILED" | "RETENTION_CLEANUP_FAILED">,
  error: unknown,
): RunResult => {
  const candidate = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : undefined;
  const name = typeof candidate?.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate.name)
    ? candidate.name
    : "Error";
  const causeCode = typeof candidate?.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(candidate.code)
    ? candidate.code
    : undefined;
  const warning: RunWarning = {
    code,
    message: code === "RETENTION_METADATA_FAILED"
      ? "authoritative run result retained, but lifecycle metadata finalization failed"
      : "authoritative run result retained, but the post-run retention sweep failed",
    cause: { name, ...(causeCode ? { code: causeCode } : {}) },
  };
  const warnings = [...(result.warnings ?? []), warning].slice(-8);
  return { ...result, warnings };
};

export interface RlmRuntimeDependencies {
  readonly resolveProfile?: () => Profile;
  readonly createBackend?: () => InterpreterBackend | Promise<InterpreterBackend>;
  readonly createModel?: (profile: Profile) => ModelClient | Promise<ModelClient>;
  readonly createController?: (model: ModelClient, profile: Profile) => ControllerDriver;
  /** Custom directories retain the legacy caller-owned lifecycle and are never swept. */
  readonly createRunDirectory?: () => Promise<string>;
  readonly createRunNonce?: () => string;
  readonly agentPolicy?: {
    readonly allowedAgents?: readonly string[];
    readonly allowForkContext?: boolean;
    readonly approvalTimeoutMs?: number;
  };
  readonly runRetention?: ManagedRunStoreOptions;
  /** Observer for detached cleanup after cancellation wins a directory-allocation race. */
  readonly onRetentionError?: (error: RunRetentionError) => void;
}

const requireCoordinatorMutation = (
  result: ReturnType<OwnedRunHandle["bindRunId"]>,
  operation: string,
): void => {
  if (result.ok) return;
  throw Object.assign(new Error(`local run ${operation} failed`), {
    name: "RunCoordinatorBindingError",
    code: result.code ?? "RLM_RUN_IDENTITY_FAILED",
  });
};

const executeRun = async (
  request: LaunchRequest,
  ownership: OwnedRunHandle,
  dependencies: RlmRuntimeDependencies = {},
  authorizationMode: LaunchAuthorizationMode = "direct",
  agentDelegation?: AgentDelegationConfig,
): Promise<RunResult> => {
  const signal = ownership.signal;
  requireCoordinatorMutation(ownership.setPhase("initializing"), "initialization");
  throwIfAborted(signal);
  const preparedAgentDelegation = prepareAgentDelegation(agentDelegation);
  const profile = (dependencies.resolveProfile ?? resolveProfile)();
  const backendWork = Promise.resolve((dependencies.createBackend ?? getBackend)());
  const modelWork = dependencies.createModel
    ? Promise.resolve(dependencies.createModel(profile))
    : getRuntime().then((runtime) => new PiModelClient(runtime, profile.models.medium));
  const [backend, model] = await waitForAbort(Promise.all([backendWork, modelWork]), signal);
  throwIfAborted(signal);
  const controller = (dependencies.createController ??
    ((client, selectedProfile) => new ModelController(client, { model: selectedProfile.models.large })))(model, profile);
  preflightRunComponents({
    backend,
    model,
    controller,
    ...(preparedAgentDelegation ? { agentDelegation: preparedAgentDelegation } : {}),
  });
  requireCoordinatorMutation(ownership.setPhase("allocating"), "allocation");
  if (dependencies.createRunDirectory) {
    const dirWork = dependencies.createRunDirectory();
    let dir: string;
    try {
      dir = await waitForAbort(dirWork, signal);
    } catch (error) {
      if (wasAborted(error, signal))
        void dirWork.then((lateDir) => rm(lateDir, { recursive: true, force: true })).catch(() => {});
      throw error;
    }
    try {
      throwIfAborted(signal);
      const result = await runProgram({
        program: request.program, sources: request.sources, controller, model, backend, dir, profile, signal,
        authorizationMode, createRunNonce: dependencies.createRunNonce,
        onProgress: ownership.observe,
        onProgressSource: ownership.attachProgress,
        ...(agentDelegation ? { agentDelegation } : {}),
      });
      if (result.status !== "completed") await rm(dir, { recursive: true, force: true });
      return result;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  const store = new ManagedRunStore(dependencies.runRetention);
  const allocationWork = store.create();
  let lease: Awaited<typeof allocationWork>;
  try {
    lease = await waitForAbort(allocationWork, signal);
  } catch (error) {
    if (wasAborted(error, signal)) {
      void allocationWork.then((lateLease) => lateLease.discard()).catch((cause: unknown) => {
        const observed = cause instanceof RunRetentionError
          ? cause
          : new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "late managed allocation cleanup failed", cause);
        (dependencies.onRetentionError ?? ((failure) => console.error(failure.code, failure.message)))(observed);
      });
    }
    throw error;
  }

  let result: RunResult;
  try {
    requireCoordinatorMutation(ownership.bindRunName(lease.name), "run-name binding");
    throwIfAborted(signal);
    result = await runProgram({
      program: request.program, sources: request.sources, controller, model, backend, dir: lease.dir, profile, signal,
      authorizationMode,
      createRunNonce: dependencies.createRunNonce,
      onProgress: ownership.observe,
      onProgressSource: ownership.attachProgress,
      runLifecycle: {
        claimEntries: lease.lifecycle.claimEntries,
        [MANAGED_RUN_PERSISTENCE]: lease.lifecycle[MANAGED_RUN_PERSISTENCE],
        onManifest: async (runId) => {
          requireCoordinatorMutation(ownership.bindRunId(runId), "run-id binding");
          await lease.lifecycle.onManifest(runId);
        },
        onRunStarted: lease.lifecycle.onRunStarted,
      },
      ...(agentDelegation ? { agentDelegation } : {}),
    });
  } catch (primary) {
    const cleanupFailures: unknown[] = [];
    try { await lease.abandon(); } catch (error) { cleanupFailures.push(error); }
    try { await store.cleanup(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length > 0)
      throw new RunRetentionError(
        "RUN_RETENTION_CLEANUP_FAILED",
        "run failure and managed lifecycle cleanup both failed",
        new AggregateError([primary, ...cleanupFailures]),
      );
    throw primary;
  }
  try { await lease.finish(result.status, result.runId); }
  catch (error) { result = retentionWarning(result, "RETENTION_METADATA_FAILED", error); }
  try { await store.cleanup(); }
  catch (error) { result = retentionWarning(result, "RETENTION_CLEANUP_FAILED", error); }
  return result;
};

export interface RlmUiIntervalHandle { unref?(): void }

export interface RlmResumeAuthorizationRequest extends ResumeAuthorizationBinding {
  readonly expiresAtMs: number;
}

export interface RlmExtensionDependencies {
  readonly executeRun?: (
    request: LaunchRequest,
    signal: AbortSignal,
    authorizationMode: LaunchAuthorizationMode,
  ) => Promise<RunResult>;
  readonly runtime?: RlmRuntimeDependencies;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly grantTtlMs?: number;
  /** Deterministic TUI refresh seams. Production uses one unref'ed interval. */
  readonly setUiInterval?: (callback: () => void, intervalMs: number) => RlmUiIntervalHandle;
  readonly clearUiInterval?: (handle: RlmUiIntervalHandle) => void;
  /** Host-managed listing seam, already bound to its retention options. */
  readonly listManagedRuns?: () => Promise<ManagedRunListing>;
  /** Host-managed inspection seam, already bound to the same retention options. */
  readonly inspectManagedRunPage?: (request: RunInspectionRequest) => Promise<RunInspectionPage>;
  /** Metadata-only resume preflight seam. */
  readonly inspectManagedResumeCandidate?: (managedName: string) => Promise<ManagedResumeCandidateInspection>;
  /** Opaque exact writer-lease acquisition seam. */
  readonly acquireManagedResumeLease?: (managedName: string) => Promise<ManagedResumeLease>;
  /** Shared retention cleanup seam. */
  readonly cleanupManagedRuns?: (options: RunCleanupOptions) => Promise<RunCleanupResult>;
  /** Trusted exact host mechanism for non-TUI resume. Absence means fail closed. */
  readonly authorizeResume?: (
    request: RlmResumeAuthorizationRequest,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  /** Pi-neutral ownership registry injection for deterministic tests/hosts. */
  readonly runCoordinator?: RunCoordinator;
}

interface LaunchReservation {
  readonly toolCallId: string;
  readonly requestSha256: string;
}

interface InputCorrelation {
  readonly sessionId: string;
  readonly promptSha256: string;
  readonly expiresAtMs: number;
  currentTurnNonce?: string;
  reservation?: LaunchReservation;
}

interface LaunchBinding {
  readonly sessionId: string;
  readonly turnNonce: string;
  readonly promptSha256: string;
}

interface CommandLifecycle {
  readonly ownership: OwnedRunHandle;
  readonly sessionId: string;
  readonly authorizationGeneration: number;
}

const denialCode = (denial: GrantDenial): string => `RLM_GRANT_${denial}`;

const projectedToolResult = (projection: RlmResultProjection): AgentToolResult<RlmResultMetadata> => ({
  content: [{ type: "text", text: resultContent(projection) }],
  details: resultMetadata(projection),
});

const denied = (codeOrMessage: string, message?: string): AgentToolResult<RlmResultMetadata> => {
  const code = message === undefined
    ? (/^([A-Z][A-Z0-9_-]{0,63}):/.exec(codeOrMessage)?.[1] ?? "RLM_LAUNCH_DENIED")
    : codeOrMessage;
  return projectedToolResult(failureProjection(code, message ?? codeOrMessage));
};

const RlmRunParams = Type.Object({
  objective: Type.Optional(Type.String({ description: "Objective for the shorthand form." })),
  context: Type.Optional(Type.String({ description: "Inline source text for the shorthand form." })),
  program: Type.Optional(Type.Unknown()),
  sources: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const createRlmExtension = (dependencies: RlmExtensionDependencies = {}) => (pi: ExtensionAPI): void => {
  const extensionAgentDelegation = createExtensionAgentDelegation(pi);
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  const grantTtlMs = dependencies.grantTtlMs ?? 120_000;
  const runCoordinator = dependencies.runCoordinator ?? createRunCoordinator();
  const listManagedRuns = dependencies.listManagedRuns
    ?? (() => new ManagedRunStore(dependencies.runtime?.runRetention).list());
  const inspectManagedRunPage = dependencies.inspectManagedRunPage
    ?? ((request: RunInspectionRequest) => inspectManagedRunPageDefault(request, dependencies.runtime?.runRetention));
  const inspectManagedResumeCandidate = dependencies.inspectManagedResumeCandidate
    ?? ((managedName: string) => inspectManagedResumeCandidateDefault(managedName, dependencies.runtime?.runRetention));
  const acquireManagedResumeLease = dependencies.acquireManagedResumeLease
    ?? ((managedName: string) => acquireManagedResumeLeaseDefault(managedName, dependencies.runtime?.runRetention));
  const cleanupManagedRuns = dependencies.cleanupManagedRuns
    ?? ((options: RunCleanupOptions) => new ManagedRunStore(dependencies.runtime?.runRetention).cleanup(options));
  const notifyCommand = (ctx: ExtensionContext, message: string, level: "info" | "error" = "info"): void => {
    try { ctx.ui.notify(truncateDisplayLine(message, 160), level); } catch { /* Non-TUI hosts may expose a no-op UI. */ }
  };
  let inputCorrelation: InputCorrelation | undefined;
  let grantStore = emptyGrantStore();
  let resumeGrantStore = emptyResumeGrantStore();
  let authorizationGeneration = 0;
  const pendingToolCalls = new Set<string>();
  const consumedToolCalls = new Set<string>();
  const activeCommandRuns = new Set<OwnedRunHandle>();
  const managementControllers = new Set<AbortController>();

  const invalidateManagement = (): void => {
    for (const controller of managementControllers) controller.abort(new Error("management session invalidated"));
    managementControllers.clear();
  };

  const invalidateAuthorization = (): void => {
    authorizationGeneration += 1;
    runCoordinator.invalidateSession();
    inputCorrelation = undefined;
    grantStore = emptyGrantStore();
    resumeGrantStore = emptyResumeGrantStore();
    pendingToolCalls.clear();
    consumedToolCalls.clear();
  };

  const bindingFor = (ctx: ExtensionContext): LaunchBinding | undefined => {
    if (!inputCorrelation) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    if (inputCorrelation.sessionId !== sessionId || now() >= inputCorrelation.expiresAtMs) {
      inputCorrelation = undefined;
      return undefined;
    }
    if (inputCorrelation.currentTurnNonce === undefined) return undefined;
    return {
      sessionId,
      turnNonce: inputCorrelation.currentTurnNonce,
      promptSha256: inputCorrelation.promptSha256,
    };
  };

  const mintAndConsume = (
    mode: GrantMode,
    expected: LaunchBinding,
    actual: LaunchBinding,
    expectedRequestSha256: string,
    actualRequestSha256: string,
    toolCallId: string,
  ): { ok: true; grant: LaunchGrant } | { ok: false; denial: GrantDenial } => {
    const issuedAtMs = now();
    const grant: LaunchGrant = {
      grantId: createId(),
      ...expected,
      requestSha256: expectedRequestSha256,
      toolCallId,
      mode,
      issuedAtMs,
      expiresAtMs: issuedAtMs + grantTtlMs,
      expiresAfterToolCall: true,
    };
    ({ store: grantStore } = mintGrant(grantStore, grant));
    const context: GrantConsumeContext = {
      grantId: grant.grantId,
      ...actual,
      requestSha256: actualRequestSha256,
      toolCallId,
      nowMs: now(),
    };
    const consumed = consumeGrant(grantStore, context);
    if (!consumed.ok) {
      const remaining = { ...grantStore.grants };
      delete remaining[grant.grantId];
      grantStore = { grants: remaining };
      return { ok: false, denial: consumed.error };
    }
    grantStore = consumed.value.store;
    return { ok: true, grant: consumed.value.grant };
  };

  const audit = (grant: LaunchGrant): void => {
    pi.appendEntry("pi-rlm-launch-grant", {
      grantId: grant.grantId,
      sessionId: grant.sessionId,
      turnNonce: grant.turnNonce,
      promptSha256: grant.promptSha256,
      requestSha256: grant.requestSha256,
      toolCallId: grant.toolCallId,
      mode: grant.mode,
      issuedAtMs: grant.issuedAtMs,
      expiresAtMs: grant.expiresAtMs,
      consumedAtMs: now(),
    });
  };

  const auditWarnings = (result: RunResult): void => {
    if (!result.warnings?.length) return;
    try {
      pi.appendEntry("pi-rlm-run-warnings", {
        runId: result.runId,
        status: result.status,
        codes: result.warnings.map((warning) => warning.code).slice(-8),
      });
    } catch {
      // Warning audit is best-effort and cannot replace the authoritative result.
    }
  };

  const sessionMatches = (
    sessionId: string,
    generation: number,
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ): boolean => {
    if (signal?.aborted || generation !== authorizationGeneration || !ctx) return false;
    try { return ctx.sessionManager.getSessionId() === sessionId; }
    catch { return false; }
  };

  const run = async (
    request: LaunchRequest,
    ownership: OwnedRunHandle,
    mode: LaunchAuthorizationMode,
    ctx: ExtensionContext,
    sessionId: string,
    generation: number,
  ): Promise<RunResult> => {
    if (!dependencies.executeRun)
      return executeRun(
        request,
        ownership,
        dependencies.runtime,
        mode,
        extensionAgentDelegation(
          ctx,
          sessionId,
          generation,
          (id, gen, ownedSignal, ownedCtx) => sessionMatches(id, gen, ownedSignal, ownedCtx),
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
          dependencies.runtime?.agentPolicy,
        ),
      );
    requireCoordinatorMutation(ownership.setPhase("initializing"), "initialization");
    const work = Promise.resolve(dependencies.executeRun(request, ownership.signal, mode));
    void work.then(() => {}, () => {});
    try {
      return await waitForAbort(work, ownership.signal);
    } catch (error) {
      if (wasAborted(error, ownership.signal)) ownership.fail("cancelled", "CANCELLED");
      throw error;
    }
  };

  const deliverBoundCommandResult = (
    projection: RlmResultProjection,
    sessionId: string,
    generation: number,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): void => {
    let metadata: RlmResultMetadata;
    let content: string;
    try {
      metadata = resultMetadata(projection);
      content = resultContent(projection);
    } catch {
      const bounded = failureProjection("RLM_RESULT_DELIVERY_FAILED", "pi-rlm result delivery failed.");
      metadata = resultMetadata(bounded);
      content = resultContent(bounded);
    }

    // Each effect has its own boundary. Re-check immediately before each one.
    if (!sessionMatches(sessionId, generation, signal, ctx)) return;
    try { pi.appendEntry("pi-rlm-result", metadata); } catch { /* Message delivery remains independently useful. */ }
    if (!sessionMatches(sessionId, generation, signal, ctx)) return;
    try {
      pi.sendMessage({
        customType: "pi-rlm-result",
        content,
        details: metadata,
        display: true,
      }, { triggerTurn: false });
    } catch {
      if (!sessionMatches(sessionId, generation, signal, ctx)) return;
      try {
        pi.appendEntry("pi-rlm-result-delivery-failed", {
          runId: metadata.runId,
          status: metadata.status,
          code: "RLM_RESULT_DELIVERY_FAILED",
        });
      } catch { /* No further audit attempt: audit failures cannot recurse. */ }
    }
  };

  const deliverManagementResult = (
    supplied: RlmManagementMetadata,
    sessionId: string,
    generation: number,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): void => {
    let metadata = supplied;
    let content: string;
    try { content = managementContent(metadata); }
    catch {
      metadata = managementFailure("invalid", "RLM_MANAGEMENT_DELIVERY_FAILED", "Management result delivery failed.");
      content = managementContent(metadata);
    }
    if (!sessionMatches(sessionId, generation, signal, ctx)) return;
    try { pi.appendEntry("pi-rlm-management-result", metadata as unknown as Record<string, unknown>); }
    catch { /* Visible completion remains independently useful. */ }
    if (!sessionMatches(sessionId, generation, signal, ctx)) return;
    try {
      pi.sendMessage({
        customType: "pi-rlm-management-result",
        content,
        details: metadata,
        display: true,
      }, { triggerTurn: false });
    } catch { /* A management command is never rerun to repair delivery. */ }
  };

  const deliverCommandResult = (
    projection: RlmResultProjection,
    lifecycle: CommandLifecycle,
    ctx: ExtensionContext,
  ): void => deliverBoundCommandResult(
    projection,
    lifecycle.sessionId,
    lifecycle.authorizationGeneration,
    lifecycle.ownership.signal,
    ctx,
  );

  const resumeManagedCommand = async (
    managedName: string,
    sessionId: string,
    generation: number,
    commandSignal: AbortSignal,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const deliver = (value: RlmManagementMetadata): void =>
      deliverManagementResult(value, sessionId, generation, commandSignal, ctx);
    const current = (): boolean => sessionMatches(sessionId, generation, commandSignal, ctx);
    if (dependencies.runtime?.createRunDirectory) {
      deliver(managementFailure(
        "resume", "RLM_RESUME_CUSTOM_DIRECTORY", "Caller-owned custom run directories are inspect-only.",
        { managedName, inspectOnly: true },
      ));
      return;
    }
    let candidate: ManagedResumeCandidateInspection;
    try { candidate = await waitForAbort(inspectManagedResumeCandidate(managedName), commandSignal); }
    catch (error) { if (current()) deliver(resumeErrorProjection(error, managedName)); return; }
    if (!current()) return;
    if (now() >= candidate.deadlineMs) {
      deliver(managementFailure("resume", "RLM_RESUME_DEADLINE", "Managed run absolute deadline has elapsed.", {
        managedName, inspectOnly: true,
      }));
      return;
    }
    const hasTuiAuthorization = ctx.mode === "tui" && ctx.hasUI;
    if (!hasTuiAuthorization && !dependencies.authorizeResume) {
      deliver(managementFailure(
        "resume", "RLM_RESUME_AUTHORIZATION_REQUIRED",
        "Managed continuation requires an exact host authorization mechanism.", { managedName },
      ));
      return;
    }

    let lease: ManagedResumeLease | undefined;
    let grantId: string | undefined;
    let ownership: OwnedRunHandle | undefined;
    let authoritativeResult = false;
    try {
      lease = await waitForAbort(acquireManagedResumeLease(managedName), commandSignal);
      if (!current()) return;
      const afterLease = await waitForAbort(inspectManagedResumeCandidate(managedName), commandSignal);
      if (!sameResumeCandidate(candidate, afterLease)) {
        deliver(managementFailure("resume", "RLM_RESUME_STALE", "Managed continuation identity changed before authorization.", {
          managedName, inspectOnly: true,
        }));
        return;
      }
      candidate = afterLease;
      const writer = lease.writerIdentity();
      if (writer.managedName !== managedName || writer.runId !== candidate.runId) {
        deliver(managementFailure("resume", "RLM_RESUME_STALE", "Managed writer identity does not match the inspected run.", {
          managedName, inspectOnly: true,
        }));
        return;
      }
      const commandNonce = createId();
      const turnOriginSha256 = sha256(`/rlm resume ${managedName}`);
      const binding: ResumeAuthorizationBinding = {
        sessionId,
        authorizationGeneration: generation,
        commandNonce,
        turnOriginSha256,
        managedName,
        runId: candidate.runId,
        manifestHash: candidate.manifestHash,
        checkpointSequence: candidate.checkpointSequence,
        checkpointSha256: candidate.checkpointSha256,
        checkpointPrefixSha256: candidate.checkpointPrefixSha256,
        writerOrdinal: writer.writerOrdinal,
        writerTokenSha256: writer.writerTokenSha256,
        mode: ctx.mode,
      };
      const authorizationRequest: RlmResumeAuthorizationRequest = {
        ...binding,
        expiresAtMs: now() + grantTtlMs,
      };
      let approved: boolean;
      try {
        approved = hasTuiAuthorization
          ? await waitForAbort(ctx.ui.confirm(
              "Approve exact managed pi-rlm continuation?",
              resumeConfirmationMessage(authorizationRequest),
            ), commandSignal)
          : await waitForAbort(Promise.resolve(dependencies.authorizeResume!(authorizationRequest, commandSignal)), commandSignal);
      } catch (error) {
        if (current()) deliver(managementFailure(
          "resume",
          wasAborted(error, commandSignal) ? "CANCELLED" : "RLM_RESUME_AUTHORIZATION_FAILED",
          wasAborted(error, commandSignal) ? "Managed continuation authorization was cancelled."
            : "Managed continuation authorization failed.",
          { managedName },
        ));
        return;
      }
      if (!current()) return;
      if (!approved) {
        deliver(managementFailure("resume", "RLM_RESUME_DENIED", "Managed continuation was not approved.", { managedName }));
        return;
      }
      const approvedCandidate = await waitForAbort(inspectManagedResumeCandidate(managedName), commandSignal);
      const approvedWriter = lease.writerIdentity();
      if (!sameResumeCandidate(candidate, approvedCandidate)
        || approvedWriter.writerOrdinal !== writer.writerOrdinal
        || approvedWriter.writerTokenSha256 !== writer.writerTokenSha256) {
        deliver(managementFailure("resume", "RLM_RESUME_STALE", "Managed continuation identity changed during approval.", {
          managedName, inspectOnly: true,
        }));
        return;
      }

      grantId = createId();
      const issuedAtMs = now();
      const grant: ManagedResumeGrant = Object.freeze({
        grantId,
        ...binding,
        issuedAtMs,
        expiresAtMs: authorizationRequest.expiresAtMs,
        oneShot: true,
      });
      resumeGrantStore = mintResumeGrant(resumeGrantStore, grant);
      if (!current()) return;
      try {
        pi.appendEntry("pi-rlm-resume-grant", {
          grantId: grant.grantId,
          sessionId: grant.sessionId,
          authorizationGeneration: grant.authorizationGeneration,
          commandNonce: grant.commandNonce,
          turnOriginSha256: grant.turnOriginSha256,
          managedName: grant.managedName,
          runId: grant.runId,
          manifestHash: grant.manifestHash,
          checkpointSequence: grant.checkpointSequence,
          checkpointSha256: grant.checkpointSha256,
          checkpointPrefixSha256: grant.checkpointPrefixSha256,
          writerOrdinal: grant.writerOrdinal,
          writerTokenSha256: grant.writerTokenSha256,
          mode: grant.mode,
          issuedAtMs: grant.issuedAtMs,
          expiresAtMs: grant.expiresAtMs,
          oneShot: true,
        });
      } catch {
        resumeGrantStore = revokeResumeGrant(resumeGrantStore, grantId);
        deliver(managementFailure(
          "resume", "RLM_RESUME_AUDIT_FAILED", "Managed continuation audit failed; no runtime was constructed.",
          { managedName },
        ));
        return;
      }
      if (!current()) return;

      runCoordinator.setSession(sessionId, generation);
      ownership = runCoordinator.create({
        sessionId,
        authorizationGeneration: generation,
        objective: "",
        ownerSignal: commandSignal,
      });
      activeCommandRuns.add(ownership);
      requireCoordinatorMutation(ownership.bindRunName(managedName), "resume run-name binding");
      requireCoordinatorMutation(ownership.bindRunId(candidate.runId), "resume run-id binding");
      requireCoordinatorMutation(ownership.setPhase("initializing"), "resume initialization");

      const profile = (dependencies.runtime?.resolveProfile ?? resolveProfile)();
      const backendWork = Promise.resolve((dependencies.runtime?.createBackend ?? getBackend)());
      const modelWork = dependencies.runtime?.createModel
        ? Promise.resolve(dependencies.runtime.createModel(profile))
        : getRuntime().then((runtime) => new PiModelClient(runtime, profile.models.medium));
      const [backend, model] = await waitForAbort(Promise.all([backendWork, modelWork]), ownership.signal);
      if (!current()) return;
      const controller = (dependencies.runtime?.createController
        ?? ((client: ModelClient, selectedProfile: Profile) =>
          new ModelController(client, { model: selectedProfile.models.large })))(model, profile);
      const agentDelegation = candidate.agentDelegationRequired ? extensionAgentDelegation(
        ctx,
        sessionId,
        generation,
        (id, gen, ownedSignal, ownedCtx) => sessionMatches(id, gen, ownedSignal, ownedCtx),
        {
          begin: (request, requestSha256) => ownership!.beginAgentApproval({
            requestSha256,
            agent: request.agent,
            taskSha256: request.taskSha256,
            context: request.context,
            ...(request.model ? { model: request.model } : {}),
            ...(request.thinking ? { thinking: request.thinking } : {}),
          }),
        },
        dependencies.runtime?.agentPolicy,
      ) : undefined;
      preflightRunComponents({ backend, model, controller, ...(agentDelegation ? {
        agentDelegation: prepareAgentDelegation(agentDelegation)!,
      } : {}) });
      const resumeInput = {
        controller,
        model,
        backend,
        signal: ownership.signal,
        onProgress: ownership.observe,
        onProgressSource: ownership.attachProgress,
        ...(agentDelegation ? { agentDelegation } : {}),
      };
      const compatible = await lease.inspect(resumeInput);
      if (compatible.runId !== candidate.runId || compatible.manifestHash !== candidate.manifestHash
        || compatible.checkpointSequence !== candidate.checkpointSequence
        || compatible.checkpointSha256 !== candidate.checkpointSha256
        || compatible.checkpointPrefixSha256 !== candidate.checkpointPrefixSha256) {
        deliver(managementFailure("resume", "RLM_RESUME_STALE", "Managed checkpoint identity changed after compatibility preflight.", {
          managedName, inspectOnly: true,
        }));
        ownership.fail("failed", "RLM_RESUME_STALE");
        return;
      }
      if (!current()) return;
      const finalCandidate = await inspectManagedResumeCandidate(managedName);
      const finalWriter = lease.writerIdentity();
      const actualBinding: ResumeAuthorizationBinding = {
        sessionId: ctx.sessionManager.getSessionId(),
        authorizationGeneration,
        commandNonce,
        turnOriginSha256,
        managedName: finalCandidate.managedName,
        runId: finalCandidate.runId,
        manifestHash: finalCandidate.manifestHash,
        checkpointSequence: finalCandidate.checkpointSequence,
        checkpointSha256: finalCandidate.checkpointSha256,
        checkpointPrefixSha256: finalCandidate.checkpointPrefixSha256,
        writerOrdinal: finalWriter.writerOrdinal,
        writerTokenSha256: finalWriter.writerTokenSha256,
        mode: ctx.mode,
      };
      const consumed = consumeResumeGrant(resumeGrantStore, {
        grantId,
        ...actualBinding,
        nowMs: now(),
      });
      resumeGrantStore = consumed.store;
      if (!consumed.ok) {
        ownership.fail("failed", `RLM_RESUME_GRANT_${consumed.denial}`);
        deliver(managementFailure(
          "resume", `RLM_RESUME_GRANT_${consumed.denial}`,
          "Managed continuation authorization became stale before consumption.", { managedName },
        ));
        return;
      }

      // No await or host effect may appear between one-shot consumption and continuation entry.
      let result = await lease.resume(resumeInput);
      authoritativeResult = true;
      try { await lease.finish(result); }
      catch (error) { result = retentionWarning(result, "RETENTION_METADATA_FAILED", error); }
      try { await cleanupManagedRuns({}); }
      catch (error) { result = retentionWarning(result, "RETENTION_CLEANUP_FAILED", error); }
      const finished = ownership.finish(result);
      if (!finished.ok) {
        ownership.fail("failed", "RLM_RUN_IDENTITY_FAILED");
        if (current()) deliver(managementFailure(
          "resume", "RLM_RUN_IDENTITY_FAILED", "Managed continuation returned an invalid run identity.", { managedName },
        ));
        return;
      }
      if (!current()) return;
      auditWarnings(result);
      if (current()) deliver(projectResumeManagement(result, managedName));
    } catch (error) {
      if (!current()) return;
      const cancelled = wasAborted(error, ownership?.signal ?? commandSignal);
      ownership?.fail(cancelled ? "cancelled" : "failed", cancelled ? "CANCELLED" : "RLM_RESUME_FAILED");
      deliver(cancelled
        ? managementFailure("resume", "CANCELLED", "Managed continuation was cancelled.", { managedName })
        : resumeErrorProjection(error, managedName));
    } finally {
      if (grantId) resumeGrantStore = revokeResumeGrant(resumeGrantStore, grantId);
      if (ownership) {
        activeCommandRuns.delete(ownership);
        const coordinated = runCoordinator.resolve(ownership.control.localId);
        if (coordinated?.state === "running" || coordinated?.state === "cancelling")
          ownership.fail(commandSignal.aborted ? "cancelled" : "failed",
            commandSignal.aborted ? "CANCELLED" : "RLM_RESUME_FAILED");
      }
      if (lease && !authoritativeResult) {
        try { await lease.abandon(); }
        catch { /* Exact authority remains retained by ManagedRunStore for retry. */ }
      }
    }
  };

  pi.on("input", (event, ctx) => {
    inputCorrelation = {
      sessionId: ctx.sessionManager.getSessionId(),
      promptSha256: sha256(event.text),
      expiresAtMs: now() + grantTtlMs,
    };
  });

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!inputCorrelation || inputCorrelation.sessionId !== sessionId || now() >= inputCorrelation.expiresAtMs) {
      inputCorrelation = undefined;
      return;
    }
    inputCorrelation.currentTurnNonce = `${event.turnIndex}:${event.timestamp}`;
  });

  pi.on("turn_end", () => {
    if (inputCorrelation) delete inputCorrelation.currentTurnNonce;
  });
  pi.on("agent_end", () => {
    inputCorrelation = undefined;
  });
  let runWidget: RunWidget | undefined;
  let widgetContext: ExtensionContext | undefined;
  let widgetRefresh: RlmUiIntervalHandle | undefined;
  let widgetRefreshStarting = false;
  let widgetRefreshGeneration = 0;
  let widgetInstallation = 0;
  const clearRefresh = dependencies.clearUiInterval
    ?? ((handle: RlmUiIntervalHandle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const stopWidgetRefresh = (): void => {
    widgetRefreshGeneration += 1;
    const handle = widgetRefresh;
    widgetRefresh = undefined;
    if (!handle) return;
    try { clearRefresh(handle); } catch { /* Best-effort timer cleanup. */ }
  };
  const hasActiveRuns = (runs: ReturnType<RunCoordinator["list"]>): boolean =>
    runs.some((run) => run.state === "running" || run.state === "cancelling");
  const syncWidgetRefresh = (runs: ReturnType<RunCoordinator["list"]>): void => {
    if (!runWidget || widgetContext?.mode !== "tui" || !hasActiveRuns(runs)) { stopWidgetRefresh(); return; }
    if (widgetRefresh !== undefined || widgetRefreshStarting) return;
    widgetRefreshStarting = true;
    const generation = ++widgetRefreshGeneration;
    const schedule = dependencies.setUiInterval
      ?? ((callback: () => void, intervalMs: number): RlmUiIntervalHandle => setInterval(callback, intervalMs));
    let handle: RlmUiIntervalHandle | undefined;
    try {
      handle = schedule(() => {
        if (!runWidget || widgetContext?.mode !== "tui") { stopWidgetRefresh(); return; }
        const current = runCoordinator.list();
        if (!hasActiveRuns(current)) { stopWidgetRefresh(); return; }
        try { runWidget.update(current); } catch { /* Rendering cannot own timer cleanup. */ }
      }, 1_000);
    } catch { widgetRefreshGeneration += 1; }
    finally { widgetRefreshStarting = false; }
    if (!handle) return;
    if (generation !== widgetRefreshGeneration || !runWidget
      || widgetContext?.mode !== "tui" || !hasActiveRuns(runCoordinator.list())) {
      try { clearRefresh(handle); } catch { /* Best-effort unpublished timer cleanup. */ }
      return;
    }
    widgetRefresh = handle;
    try { handle.unref?.(); }
    catch { stopWidgetRefresh(); }
  };
  const unsubscribeWidget = runCoordinator.subscribe((runs) => {
    try { runWidget?.update(runs); }
    finally { syncWidgetRefresh(runs); }
  });
  const clearWidget = (): void => {
    widgetInstallation += 1;
    const current = widgetContext;
    const widget = runWidget;
    widgetContext = undefined;
    runWidget = undefined;
    stopWidgetRefresh();
    try { widget?.dispose(); } catch { /* Component disposal is best-effort and idempotent. */ }
    if (current?.mode === "tui") {
      try { current.ui.setWidget("pi-rlm-runs", undefined); } catch { /* Best-effort UI cleanup. */ }
    }
  };
  const installWidget = (ctx: ExtensionContext): void => {
    clearWidget();
    if (ctx.mode !== "tui") return;
    const installation = widgetInstallation;
    widgetContext = ctx;
    let factoryConsumed = false;
    try {
      ctx.ui.setWidget("pi-rlm-runs", (tui) => {
        if (factoryConsumed || installation !== widgetInstallation || widgetContext !== ctx || ctx.mode !== "tui") {
          const stale = new RunWidget();
          stale.dispose();
          return stale;
        }
        factoryConsumed = true;
        if (runWidget) return runWidget;
        let widget!: RunWidget;
        widget = new RunWidget(runCoordinator.list(), () => tui.requestRender(), () => {
          if (runWidget !== widget) return;
          runWidget = undefined;
          stopWidgetRefresh();
        });
        runWidget = widget;
        syncWidgetRefresh(runCoordinator.list());
        return widget;
      }, { placement: "aboveEditor" });
    } catch {
      const widget = runWidget;
      widgetContext = undefined;
      runWidget = undefined;
      stopWidgetRefresh();
      try { widget?.dispose(); } catch { /* Best-effort failed-install cleanup. */ }
    }
  };

  pi.on("session_before_switch", () => { invalidateManagement(); invalidateAuthorization(); clearWidget(); });
  pi.on("session_before_fork", () => { invalidateManagement(); invalidateAuthorization(); clearWidget(); });
  pi.on("session_start", (event, ctx) => {
    invalidateManagement();
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") invalidateAuthorization();
    installWidget(ctx);
  });
  pi.on("session_shutdown", () => {
    invalidateManagement();
    invalidateAuthorization();
    clearWidget();
    unsubscribeWidget();
  });

  pi.registerCommand("rlm", {
    description: "Launch, list, inspect, resume, clean up, or cancel host-managed pi-rlm runs.",
    handler: async (args, ctx) => {
      // Every command route is bound before its first host or UI effect.
      let sessionId: string;
      try { sessionId = ctx.sessionManager.getSessionId(); }
      catch { return; }
      const entryGeneration = authorizationGeneration;
      const authority = { sessionId, authorizationGeneration: entryGeneration };
      const route = routeRlmCommand(args);
      if (route.kind !== "launch") {
        if (route.kind === "invalid-management") {
          deliverManagementResult(
            managementFailure("invalid", "RLM_MANAGEMENT_INVALID", "Invalid RLM management command."),
            sessionId, entryGeneration, undefined, ctx,
          );
          return;
        }
        if (route.kind === "cancel") {
          const cancelled = cancelLocalRun(route.target, runCoordinator, authority);
          const message = cancelled.ok
            ? (cancelled.alreadyRequested ? "RLM cancellation was already requested." : "RLM cancellation requested.")
            : "RLM local run alias was not found.";
          notifyCommand(ctx, message, cancelled.ok ? "info" : "error");
          deliverManagementResult(cancelled.ok
            ? {
                ...managementFailure("cancel", "RLM_CANCEL_REQUESTED", message),
                status: "completed",
              }
            : managementFailure("cancel", "RLM_CANCEL_NOT_FOUND", message),
          sessionId, entryGeneration, undefined, ctx);
          return;
        }
        const managementController = new AbortController();
        managementControllers.add(managementController);
        const isCurrent = (): boolean => sessionMatches(
          sessionId, entryGeneration, managementController.signal, ctx,
        );
        const isTuiCurrent = (): boolean => isCurrent() && ctx.mode === "tui";
        const deliver = (result: RlmManagementMetadata): void =>
          deliverManagementResult(result, sessionId, entryGeneration, managementController.signal, ctx);
        try {
          if (route.kind === "resume") {
            resumeGrantStore = emptyResumeGrantStore();
            await resumeManagedCommand(route.target, sessionId, entryGeneration, managementController.signal, ctx);
            return;
          }
          if (route.kind === "cleanup") {
            if (route.mode !== "dry-run") {
              const commandNonce = createId();
              if (!isCurrent()) return;
              try {
                pi.appendEntry("pi-rlm-cleanup-audit", {
                  sessionId,
                  authorizationGeneration: entryGeneration,
                  commandNonce,
                  turnOriginSha256: sha256(`/rlm cleanup${route.mode === "force" ? " --force" : ""}`),
                  mode: route.mode,
                  auditedAtMs: now(),
                });
              } catch {
                deliver(managementFailure(
                  "cleanup", "RLM_CLEANUP_AUDIT_FAILED", "Cleanup audit failed; no retention mutation was attempted.",
                ));
                return;
              }
            }
            const cleaned = await cleanupManagedRuns({
              ...(route.mode === "dry-run" ? { dryRun: true } : {}),
              ...(route.mode === "force" ? { force: true } : {}),
            });
            if (isCurrent()) deliver(projectCleanupManagement(cleaned, route.mode));
            return;
          }
          const localRuns = (): readonly ReturnType<RunCoordinator["list"]>[number][] =>
            runCoordinator.list().filter((run) =>
              run.sessionId === sessionId && run.authorizationGeneration === entryGeneration);
          if (route.kind === "inspect") {
            const runName = resolveInspectionRunName(route.target, runCoordinator, authority);
            if (!runName) {
              deliver(managementFailure(
                "inspect", "RLM_INSPECTION_TARGET_INVALID",
                "Inspection target must be an exact managed name or current bound local alias.",
              ));
              return;
            }
            const page = await inspectManagedRunPage({
              version: 1, runName, view: "summary", pageSize: 50,
            });
            if (!isCurrent()) return;
            deliver(projectInspectManagement(page, runName));
            if (ctx.mode === "tui")
              await openRunInspector(ctx, runName, inspectManagedRunPage, managementController.signal, isTuiCurrent);
            return;
          }
          const listing = await listManagedRuns();
          if (!isCurrent()) return;
          deliver(projectRunsManagement(listing, localRuns()));
          if (ctx.mode === "tui") await openRunNavigator(ctx, {
            listLocalRuns: localRuns,
            listManagedRuns,
            inspect: (runName) => openRunInspector(
              ctx, runName, inspectManagedRunPage, managementController.signal, isTuiCurrent,
            ),
          }, managementController.signal, isTuiCurrent);
          return;
        } catch (error) {
          if (!isCurrent()) return;
          const operation = route.kind === "inspect" ? "inspect"
            : route.kind === "cleanup" ? "cleanup" : route.kind === "runs" ? "runs" : "invalid";
          deliver(managementFailure(
            operation,
            operation === "cleanup" ? "RLM_CLEANUP_FAILED"
              : operation === "inspect" ? "RLM_INSPECTION_FAILED" : "RLM_RUNS_FAILED",
            operation === "cleanup" ? "Managed cleanup failed safely."
              : operation === "inspect" ? "Managed inspection is unavailable." : "Managed listing is unavailable.",
          ));
          return;
        } finally {
          managementControllers.delete(managementController);
          managementController.abort(new Error("management command completed"));
        }
      }

      // Bind ownership before the first asynchronous source-capture checkpoint.
      let commandController: OwnedRunHandle;
      try {
        runCoordinator.setSession(sessionId, entryGeneration);
        commandController = runCoordinator.create({
          sessionId,
          authorizationGeneration: entryGeneration,
          objective: "",
        });
      } catch {
        deliverBoundCommandResult(
          failureProjection("RLM_RUN_LIMIT", "pi-rlm could not allocate a local run handle."),
          sessionId,
          entryGeneration,
          undefined,
          ctx,
        );
        return;
      }
      const lifecycle: CommandLifecycle = {
        ownership: commandController,
        sessionId,
        authorizationGeneration: entryGeneration,
      };
      activeCommandRuns.add(commandController);
      requireCoordinatorMutation(commandController.setPhase("source_capture"), "source capture");
      const failCommand = (code: string, status: "failed" | "cancelled" = "failed"): void => {
        commandController.fail(status, code);
      };

      try {
        let built: Awaited<ReturnType<typeof captureCommandRequest>>;
        try {
          built = await captureCommandRequest(args, ctx, commandController.signal);
        } catch (error) {
          if (wasAborted(error, commandController.signal)
            || !sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
          failCommand("RLM_SOURCE_FAILED");
          deliverCommandResult(
            failureProjection("RLM_SOURCE_FAILED", "pi-rlm source capture failed."),
            lifecycle,
            ctx,
          );
          return;
        }
        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        if (!built.ok) {
          failCommand(built.error.code);
          deliverCommandResult(failureProjection(built.error.code, built.error.message), lifecycle, ctx);
          return;
        }
        commandController.setObjective(built.value.program.objective);

        let authorization: ReturnType<typeof mintAndConsume>;
        try {
          const hash = requestSha256(built.value);
          const grantId = createId();
          const binding = {
            sessionId,
            turnNonce: `slash:${grantId}`,
            promptSha256: sha256(`/rlm ${args}`),
          };
          if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
          authorization = mintAndConsume(
            "slash_command",
            binding,
            binding,
            hash,
            hash,
            `command:${grantId}`,
          );
        } catch {
          failCommand("RLM_GRANT_FAILED");
          deliverCommandResult(
            failureProjection("RLM_GRANT_FAILED", "pi-rlm launch authorization failed."),
            lifecycle,
            ctx,
          );
          return;
        }
        if (!authorization.ok) {
          const code = denialCode(authorization.denial);
          failCommand(code);
          deliverCommandResult(failureProjection(code, "pi-rlm launch was denied."), lifecycle, ctx);
          return;
        }

        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        try { audit(authorization.grant); }
        catch {
          failCommand("RLM_AUDIT_FAILED");
          deliverCommandResult(
            failureProjection("RLM_AUDIT_FAILED", "pi-rlm launch audit failed; no run was started."),
            lifecycle,
            ctx,
          );
          return;
        }

        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        try { ctx.ui.setStatus("pi-rlm", "running..."); } catch { /* Best-effort transient status. */ }
        let result: RunResult;
        try {
          if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
          result = await run(
            built.value,
            commandController,
            "slash_command",
            ctx,
            sessionId,
            lifecycle.authorizationGeneration,
          );
        } catch (error) {
          if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
          const cancelled = wasAborted(error, commandController.signal);
          commandController.fail(cancelled ? "cancelled" : "failed", cancelled ? "CANCELLED" : "RLM_RUN_FAILED");
          deliverCommandResult(failureProjection(
            cancelled ? "CANCELLED" : "RLM_RUN_FAILED",
            cancelled ? "pi-rlm was cancelled." : "pi-rlm failed before producing a result.",
            null,
            cancelled ? "cancelled" : "failed",
          ), lifecycle, ctx);
          return;
        }
        const finished = commandController.finish(result);
        if (!finished.ok) {
          failCommand("RLM_RUN_IDENTITY_FAILED");
          if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
          deliverCommandResult(
            failureProjection("RLM_RUN_IDENTITY_FAILED", "pi-rlm returned an invalid run identity."),
            lifecycle,
            ctx,
          );
          return;
        }
        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        auditWarnings(result);
        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        deliverCommandResult(projectRunResult(result), lifecycle, ctx);
      } finally {
        activeCommandRuns.delete(commandController);
        const current = runCoordinator.resolve(commandController.control.localId);
        if (current?.state === "running" || current?.state === "cancelling")
          commandController.fail(
            commandController.signal.aborted ? "cancelled" : "failed",
            commandController.signal.aborted ? "CANCELLED" : "RLM_RUN_FAILED",
          );
        if (sessionMatches(sessionId, lifecycle.authorizationGeneration, undefined, ctx)) {
          try { ctx.ui.setStatus("pi-rlm", ""); } catch { /* Best-effort transient status. */ }
        }
      }
    },
  });

  pi.registerTool({
    name: "rlm_run",
    label: "RLM Run",
    description: [
      "Run a long-context recursive model/agent workflow (pi-rlm).",
      "Use only when the user requests it; prompt wording is never launch authority.",
      "Provide { objective, context } with non-empty context, or a complete { program, sources } typed program.",
      "Requires interactive host confirmation and a host-owned, exact-request, one-shot grant before spending.",
    ].join(" "),
    promptSnippet: "rlm_run: start an explicitly requested recursive long-context program",
    promptGuidelines: [
      "Use rlm_run only when the user explicitly requests pi-rlm or an RLM run.",
      "Use rlm_run for large-input, exhaustive, recursive, or structured fan-out tasks.",
      "Do not use rlm_run for routine tasks one agent can complete directly.",
    ],
    parameters: RlmRunParams,
    renderCall: () => renderRlmRunCallComponent(),
    renderResult: (result) => renderRlmToolResultComponent(result),
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<RlmResultMetadata>> {
      const toolSignal = signal ?? new AbortController().signal;
      const callKey = `${ctx.sessionManager.getSessionId()}:${toolCallId}`;
      if (pendingToolCalls.has(callKey) || consumedToolCalls.has(callKey))
        return denied("RLM_GRANT_REPLAY: this tool call was already authorized or consumed.");
      pendingToolCalls.add(callKey);
      let reservedCorrelation: InputCorrelation | undefined;
      let consumedCorrelation = false;
      try {
        const built = buildInlineRequest(params);
        if (!built.ok) return projectedToolResult(failureProjection(built.error.code, built.error.message));
        if (!ctx.hasUI)
          return denied("RLM_OPT_IN_REQUIRED: rlm_run requires interactive exact-request confirmation; use /rlm for a direct host launch.");
        const initialBinding = bindingFor(ctx);
        if (!initialBinding || !inputCorrelation)
          return denied("RLM_OPT_IN_REQUIRED: no current Pi user-turn correlation is available for confirmation.");
        const expectedHash = requestSha256(built.value);
        if (inputCorrelation.reservation)
          return denied("RLM_GRANT_REPLAY: this user input is already reserved by another rlm_run call.");
        inputCorrelation.reservation = { toolCallId, requestSha256: expectedHash };
        reservedCorrelation = inputCorrelation;
        const confirmationGeneration = authorizationGeneration;

        let approved: boolean;
        try {
          approved = await waitForAbort(ctx.ui.confirm(
            "Approve exact pi-rlm request?",
            confirmationMessage(built.value, expectedHash),
          ), toolSignal);
        } catch (error) {
          if (wasAborted(error, toolSignal)) return denied("RLM_CANCELLED: pi-rlm launch was cancelled before authorization.");
          return projectedToolResult(failureProjection(
            "RLM_CONFIRMATION_FAILED",
            "pi-rlm confirmation failed; no run was started.",
          ));
        }
        if (!approved) return denied("RLM_OPT_IN_REQUIRED: pi-rlm launch was not approved.");
        if (toolSignal.aborted) return denied("RLM_CANCELLED: pi-rlm launch was cancelled before authorization.");
        if (confirmationGeneration !== authorizationGeneration)
          return denied("RLM_GRANT_GENERATION_MISMATCH: session changed before authorization consumption.");
        if (ctx.sessionManager.getSessionId() !== initialBinding.sessionId)
          return denied("RLM_GRANT_SESSION_MISMATCH: session changed before authorization consumption.");

        const current = buildInlineRequest(params);
        const actualHash = current.ok ? requestSha256(current.value) : "invalid-after-approval";
        const actualBinding = bindingFor(ctx) ?? {
          sessionId: ctx.sessionManager.getSessionId(),
          turnNonce: "missing",
          promptSha256: "missing",
        };
        const authorization = mintAndConsume(
          "confirmed",
          initialBinding,
          actualBinding,
          expectedHash,
          actualHash,
          toolCallId,
        );
        if (!authorization.ok)
          return denied(`${denialCode(authorization.denial)}: pi-rlm launch binding changed before consumption.`);

        consumedCorrelation = true;
        if (inputCorrelation === reservedCorrelation) inputCorrelation = undefined;
        consumedToolCalls.add(callKey);
        if (confirmationGeneration !== authorizationGeneration
          || ctx.sessionManager.getSessionId() !== initialBinding.sessionId)
          return denied("RLM_GRANT_GENERATION_MISMATCH: session changed before launch audit.");
        try { audit(authorization.grant); }
        catch {
          return projectedToolResult(failureProjection(
            "RLM_AUDIT_FAILED",
            "pi-rlm launch audit failed; no run was started.",
          ));
        }
        let ownership: OwnedRunHandle;
        try {
          if (confirmationGeneration !== authorizationGeneration
            || ctx.sessionManager.getSessionId() !== initialBinding.sessionId)
            return denied("RLM_GRANT_GENERATION_MISMATCH: session changed before launch.");
          runCoordinator.setSession(initialBinding.sessionId, confirmationGeneration);
          ownership = runCoordinator.create({
            sessionId: initialBinding.sessionId,
            authorizationGeneration: confirmationGeneration,
            objective: built.value.program.objective,
            ownerSignal: toolSignal,
          });
        } catch {
          return projectedToolResult(failureProjection(
            "RLM_RUN_LIMIT",
            "pi-rlm could not allocate a local run handle.",
          ));
        }
        try {
          const result = await run(
            built.value,
            ownership,
            "confirmed",
            ctx,
            initialBinding.sessionId,
            confirmationGeneration,
          );
          const finished = ownership.finish(result);
          if (!finished.ok) {
            ownership.fail("failed", "RLM_RUN_IDENTITY_FAILED");
            return projectedToolResult(failureProjection(
              "RLM_RUN_IDENTITY_FAILED",
              "pi-rlm returned an invalid run identity.",
            ));
          }
          if (confirmationGeneration !== authorizationGeneration
            || ctx.sessionManager.getSessionId() !== initialBinding.sessionId)
            return denied("RLM_GRANT_GENERATION_MISMATCH: session changed while pi-rlm was running.");
          auditWarnings(result);
          return projectedToolResult(projectRunResult(result));
        } catch (error) {
          const cancelled = wasAborted(error, ownership.signal);
          ownership.fail(cancelled ? "cancelled" : "failed", cancelled ? "CANCELLED" : "RLM_RUN_FAILED");
          return projectedToolResult(failureProjection(
            cancelled ? "CANCELLED" : "RLM_RUN_FAILED",
            cancelled ? "pi-rlm was cancelled." : "pi-rlm failed before producing a result.",
            null,
            cancelled ? "cancelled" : "failed",
          ));
        }
      } catch (error) {
        if (wasAborted(error, toolSignal))
          return denied("RLM_CANCELLED: pi-rlm launch was cancelled before authorization.");
        return projectedToolResult(failureProjection(
          "RLM_TOOL_FAILED",
          "pi-rlm tool authorization failed; no run was started.",
        ));
      } finally {
        if (
          !consumedCorrelation &&
          reservedCorrelation !== undefined &&
          inputCorrelation === reservedCorrelation &&
          reservedCorrelation.reservation?.toolCallId === toolCallId
        )
          delete reservedCorrelation.reservation;
        pendingToolCalls.delete(callKey);
      }
    },
  });
};

export default createRlmExtension();
