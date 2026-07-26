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
} from "./src/runtime/index.ts";
import {
  ManagedRunStore,
  RunRetentionError,
  type ManagedRunStoreOptions,
} from "./src/runtime/run-retention.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./src/runtime/abort.ts";
import type { ControllerDriver } from "./src/runtime/controller.ts";
import type { InterpreterBackend } from "./src/shell/interpreter/backend.ts";
import { QuickJsBackend } from "./src/shell/interpreter/quickjs.ts";
import { createExtensionAgentDelegation } from "./src/extension/agent-delegation.ts";
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
  };
  readonly runRetention?: ManagedRunStoreOptions;
  /** Observer for detached cleanup after cancellation wins a directory-allocation race. */
  readonly onRetentionError?: (error: RunRetentionError) => void;
}

const executeRun = async (
  request: LaunchRequest,
  signal: AbortSignal,
  dependencies: RlmRuntimeDependencies = {},
  authorizationMode: LaunchAuthorizationMode = "direct",
  agentDelegation?: AgentDelegationConfig,
): Promise<RunResult> => {
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
    throwIfAborted(signal);
    result = await runProgram({
      program: request.program, sources: request.sources, controller, model, backend, dir: lease.dir, profile, signal,
      authorizationMode, createRunNonce: dependencies.createRunNonce, runLifecycle: lease.lifecycle,
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
  readonly controller: AbortController;
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
  let inputCorrelation: InputCorrelation | undefined;
  let grantStore = emptyGrantStore();
  let authorizationGeneration = 0;
  const pendingToolCalls = new Set<string>();
  const consumedToolCalls = new Set<string>();
  const activeCommandRuns = new Set<AbortController>();

  const invalidateAuthorization = (): void => {
    authorizationGeneration += 1;
    for (const controller of activeCommandRuns) controller.abort(new Error("command lifecycle ended"));
    activeCommandRuns.clear();
    inputCorrelation = undefined;
    grantStore = emptyGrantStore();
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

  const run = (
    request: LaunchRequest,
    signal: AbortSignal,
    mode: LaunchAuthorizationMode,
    ctx: ExtensionContext,
    sessionId: string,
    generation: number,
  ): Promise<RunResult> => dependencies.executeRun
    ? dependencies.executeRun(request, signal, mode)
    : executeRun(
        request,
        signal,
        dependencies.runtime,
        mode,
        extensionAgentDelegation(ctx, sessionId, generation, (id, gen, ownedSignal, ownedCtx) =>
          sessionMatches(id, gen, ownedSignal, ownedCtx), dependencies.runtime?.agentPolicy),
      );

  const deliverCommandResult = (
    projection: RlmResultProjection,
    lifecycle: CommandLifecycle,
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
    if (!sessionMatches(lifecycle.sessionId, lifecycle.authorizationGeneration, lifecycle.controller.signal, ctx)) return;
    try { pi.appendEntry("pi-rlm-result", metadata); } catch { /* Message delivery remains independently useful. */ }
    if (!sessionMatches(lifecycle.sessionId, lifecycle.authorizationGeneration, lifecycle.controller.signal, ctx)) return;
    try {
      pi.sendMessage({
        customType: "pi-rlm-result",
        content,
        details: metadata,
        display: true,
      }, { triggerTurn: false });
    } catch {
      // One bounded, non-recursive diagnostic attempt. Never retry delivery.
      if (!sessionMatches(lifecycle.sessionId, lifecycle.authorizationGeneration, lifecycle.controller.signal, ctx)) return;
      try {
        pi.appendEntry("pi-rlm-result-delivery-failed", {
          runId: metadata.runId,
          status: metadata.status,
          code: "RLM_RESULT_DELIVERY_FAILED",
        });
      } catch { /* No further audit attempt: audit failures cannot recurse. */ }
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
  pi.on("session_before_switch", invalidateAuthorization);
  pi.on("session_before_fork", invalidateAuthorization);
  pi.on("session_start", (event) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") invalidateAuthorization();
  });
  pi.on("session_shutdown", invalidateAuthorization);

  pi.registerCommand("rlm", {
    description: "Start a host-authorized pi-rlm run with an explicit source.",
    handler: async (args, ctx) => {
      // Bind ownership before the first asynchronous source-capture checkpoint.
      const commandController = new AbortController();
      let sessionId: string;
      try { sessionId = ctx.sessionManager.getSessionId(); }
      catch { return; }
      const lifecycle: CommandLifecycle = {
        controller: commandController,
        sessionId,
        authorizationGeneration,
      };
      activeCommandRuns.add(commandController);

      try {
        let built: Awaited<ReturnType<typeof captureCommandRequest>>;
        try {
          built = await captureCommandRequest(args, ctx, commandController.signal);
        } catch (error) {
          if (wasAborted(error, commandController.signal)
            || !sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
          deliverCommandResult(
            failureProjection("RLM_SOURCE_FAILED", "pi-rlm source capture failed."),
            lifecycle,
            ctx,
          );
          return;
        }
        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        if (!built.ok) {
          deliverCommandResult(failureProjection(built.error.code, built.error.message), lifecycle, ctx);
          return;
        }

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
          deliverCommandResult(
            failureProjection("RLM_GRANT_FAILED", "pi-rlm launch authorization failed."),
            lifecycle,
            ctx,
          );
          return;
        }
        if (!authorization.ok) {
          const code = denialCode(authorization.denial);
          deliverCommandResult(failureProjection(code, "pi-rlm launch was denied."), lifecycle, ctx);
          return;
        }

        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        try { audit(authorization.grant); }
        catch {
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
            commandController.signal,
            "slash_command",
            ctx,
            sessionId,
            lifecycle.authorizationGeneration,
          );
        } catch (error) {
          if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
          const cancelled = wasAborted(error, commandController.signal);
          deliverCommandResult(failureProjection(
            cancelled ? "CANCELLED" : "RLM_RUN_FAILED",
            cancelled ? "pi-rlm was cancelled." : "pi-rlm failed before producing a result.",
            null,
            cancelled ? "cancelled" : "failed",
          ), lifecycle, ctx);
          return;
        }
        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        auditWarnings(result);
        if (!sessionMatches(sessionId, lifecycle.authorizationGeneration, commandController.signal, ctx)) return;
        deliverCommandResult(projectRunResult(result), lifecycle, ctx);
      } finally {
        activeCommandRuns.delete(commandController);
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
        try {
          if (confirmationGeneration !== authorizationGeneration
            || ctx.sessionManager.getSessionId() !== initialBinding.sessionId)
            return denied("RLM_GRANT_GENERATION_MISMATCH: session changed before launch.");
          const result = await run(
            built.value,
            toolSignal,
            "confirmed",
            ctx,
            initialBinding.sessionId,
            confirmationGeneration,
          );
          if (confirmationGeneration !== authorizationGeneration
            || ctx.sessionManager.getSessionId() !== initialBinding.sessionId)
            return denied("RLM_GRANT_GENERATION_MISMATCH: session changed while pi-rlm was running.");
          auditWarnings(result);
          return projectedToolResult(projectRunResult(result));
        } catch (error) {
          const cancelled = wasAborted(error, toolSignal);
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
