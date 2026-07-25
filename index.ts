/**
 * pi-rlm extension entry.
 *
 * Launcher prompt guidance is intentionally separate from authorization. Every
 * run crosses a host-owned, session/turn/prompt/request/tool-call-bound,
 * single-use grant before the model runtime or QuickJS backend is initialized.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  canonicalStringify,
  compileShorthand,
  consumeGrant,
  emptyGrantStore,
  mintGrant,
  normalizeProgram,
  parseJsonValue,
  type GrantConsumeContext,
  type GrantDenial,
  type GrantMode,
  type LaunchGrant,
  type RlmProgram,
} from "./src/core/index.ts";
import {
  DEFAULT_PROFILE,
  ModelController,
  type LaunchAuthorizationMode,
  type Profile,
  runProgram,
  type RunResult,
} from "./src/runtime/index.ts";
import { throwIfAborted, waitForAbort, wasAborted } from "./src/runtime/abort.ts";
import type { ControllerDriver } from "./src/runtime/controller.ts";
import type { InterpreterBackend } from "./src/shell/interpreter/backend.ts";
import { QuickJsBackend } from "./src/shell/interpreter/quickjs.ts";
import { sha256 } from "./src/shell/hash.ts";
import type { ModelClient } from "./src/shell/model/client.ts";
import { PiModelClient } from "./src/shell/model/pi-model.ts";

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

interface LaunchRequest {
  readonly program: RlmProgram;
  readonly sources: Readonly<Record<string, string>>;
}

interface LaunchParams {
  readonly objective?: unknown;
  readonly context?: unknown;
  readonly program?: unknown;
  readonly sources?: unknown;
}

const normalizeSources = (
  raw: unknown,
): { ok: true; value: Readonly<Record<string, string>> } | { ok: false; message: string } => {
  if (raw === undefined) return { ok: true, value: Object.freeze(Object.create(null) as Record<string, string>) };
  const parsed = parseJsonValue(raw);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value))
    return { ok: false, message: "Invalid sources: must be an object whose values are strings." };
  const sources = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(parsed.value)) {
    if (typeof value !== "string") return { ok: false, message: `Invalid sources.${name}: must be a string.` };
    sources[name] = value;
  }
  return { ok: true, value: Object.freeze(sources) };
};

const buildRequest = (params: LaunchParams): { ok: true; value: LaunchRequest } | { ok: false; message: string } => {
  const sources = normalizeSources(params.sources);
  if (!sources.ok) return sources;
  if (params.program !== undefined) {
    const normalized = normalizeProgram(params.program);
    if (!normalized.ok)
      return { ok: false, message: `Invalid program: ${normalized.error.map((e) => `${e.path} ${e.message}`).join("; ")}` };
    return { ok: true, value: { program: normalized.value, sources: sources.value } };
  }
  if (typeof params.objective === "string" && params.objective.trim()) {
    if (params.context !== undefined && typeof params.context !== "string")
      return { ok: false, message: "Invalid context: must be a string." };
    const compiled = compileShorthand({ objective: params.objective });
    if (!compiled.ok) return { ok: false, message: `Invalid objective: ${compiled.error[0]?.message ?? "unknown"}` };
    return {
      ok: true,
      value: { program: compiled.value, sources: Object.freeze({ context: params.context ?? "" }) },
    };
  }
  return { ok: false, message: "Provide either { objective, context } or { program, sources }." };
};

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

const summarize = (result: RunResult): string => {
  if (result.status === "completed")
    return `pi-rlm ${result.completionMode === "fallback_extract" ? "completed via fallback extraction" : "completed"}.\n\nResult:\n${JSON.stringify(result.answer, null, 2)}\n\nUsage: ${result.ledger.usage.logicalCalls} calls, ${result.ledger.usage.attempts} attempts, ${result.ledger.usage.framesOpened} child frames.`;
  if (result.status === "cancelled") return "pi-rlm cancelled.";
  return `pi-rlm failed (${result.error?.code}): ${result.error?.message}`;
};

export interface RlmRuntimeDependencies {
  readonly resolveProfile?: () => Profile;
  readonly createBackend?: () => InterpreterBackend | Promise<InterpreterBackend>;
  readonly createModel?: (profile: Profile) => ModelClient | Promise<ModelClient>;
  readonly createController?: (model: ModelClient, profile: Profile) => ControllerDriver;
  readonly createRunDirectory?: () => Promise<string>;
  readonly createRunNonce?: () => string;
}

const executeRun = async (
  request: LaunchRequest,
  signal: AbortSignal,
  dependencies: RlmRuntimeDependencies = {},
  authorizationMode: LaunchAuthorizationMode = "direct",
): Promise<RunResult> => {
  throwIfAborted(signal);
  const profile = (dependencies.resolveProfile ?? resolveProfile)();
  const backendWork = Promise.resolve((dependencies.createBackend ?? getBackend)());
  const modelWork = dependencies.createModel
    ? Promise.resolve(dependencies.createModel(profile))
    : getRuntime().then((runtime) => new PiModelClient(runtime, profile.models.medium));
  const [backend, model] = await waitForAbort(Promise.all([backendWork, modelWork]), signal);
  throwIfAborted(signal);
  const controller = (dependencies.createController ??
    ((client, selectedProfile) => new ModelController(client, { model: selectedProfile.models.large })))(model, profile);
  const dirWork = (dependencies.createRunDirectory ?? (() => mkdtemp(join(tmpdir(), "pi-rlm-run-"))))();
  let dir: string;
  try {
    dir = await waitForAbort(dirWork, signal);
  } catch (error) {
    if (wasAborted(error, signal))
      void dirWork.then((lateDir) => rm(lateDir, { recursive: true, force: true })).catch(() => {});
    throw error;
  }
  throwIfAborted(signal);
  return runProgram({
    program: request.program,
    sources: request.sources,
    controller,
    model,
    backend,
    dir,
    profile,
    signal,
    authorizationMode,
    createRunNonce: dependencies.createRunNonce,
  });
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

const denialCode = (denial: GrantDenial): string => `RLM_GRANT_${denial}`;

const denied = (message: string): AgentToolResult<{ status: string }> => ({
  content: [{ type: "text", text: message }],
  details: { status: "denied" },
});

const RlmRunParams = Type.Object({
  objective: Type.Optional(Type.String({ description: "Objective for the shorthand form." })),
  context: Type.Optional(Type.String({ description: "Inline source text for the shorthand form." })),
  program: Type.Optional(Type.Unknown()),
  sources: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const createRlmExtension = (dependencies: RlmExtensionDependencies = {}) => (pi: ExtensionAPI): void => {
  const run = dependencies.executeRun ?? ((request, signal, mode) => executeRun(request, signal, dependencies.runtime, mode));
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
    description: "Start a host-authorized pi-rlm run from an objective.",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) {
        ctx.ui.notify("Usage: /rlm <objective>", "warning");
        return;
      }
      const built = buildRequest({ objective });
      if (!built.ok) {
        ctx.ui.notify(built.message, "error");
        return;
      }
      const hash = requestSha256(built.value);
      const grantId = createId();
      const binding = {
        sessionId: ctx.sessionManager.getSessionId(),
        turnNonce: `slash:${grantId}`,
        promptSha256: sha256(`/rlm ${objective}`),
      };
      const authorization = mintAndConsume(
        "slash_command",
        binding,
        binding,
        hash,
        hash,
        `command:${grantId}`,
      );
      if (!authorization.ok) {
        ctx.ui.notify(`${denialCode(authorization.denial)}: pi-rlm launch denied.`, "error");
        return;
      }
      audit(authorization.grant);
      const commandController = new AbortController();
      activeCommandRuns.add(commandController);
      ctx.ui.setStatus("pi-rlm", "running...");
      try {
        const result = await run(built.value, commandController.signal, "slash_command");
        ctx.ui.notify(summarize(result), result.status === "completed" ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(
          wasAborted(error, commandController.signal) ? "pi-rlm cancelled." : "pi-rlm failed before producing a result.",
          "error",
        );
      } finally {
        activeCommandRuns.delete(commandController);
        ctx.ui.setStatus("pi-rlm", "");
      }
    },
  });

  pi.registerTool({
    name: "rlm_run",
    label: "RLM Run",
    description: [
      "Run a long-context recursive model/agent workflow (pi-rlm).",
      "Use only when the user requests it; prompt wording is never launch authority.",
      "Provide { objective, context } for the shorthand, or { program, sources } for a typed program.",
      "Requires interactive host confirmation and a host-owned, exact-request, one-shot grant before spending.",
    ].join(" "),
    promptSnippet: "rlm_run: start an explicitly requested recursive long-context program",
    promptGuidelines: [
      "Use rlm_run only when the user explicitly requests pi-rlm or an RLM run.",
      "Use rlm_run for large-input, exhaustive, recursive, or structured fan-out tasks.",
      "Do not use rlm_run for routine tasks one agent can complete directly.",
    ],
    parameters: RlmRunParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<{ status: string }>> {
      const toolSignal = signal ?? new AbortController().signal;
      const callKey = `${ctx.sessionManager.getSessionId()}:${toolCallId}`;
      if (pendingToolCalls.has(callKey) || consumedToolCalls.has(callKey))
        return denied("RLM_GRANT_REPLAY: this tool call was already authorized or consumed.");
      pendingToolCalls.add(callKey);
      let reservedCorrelation: InputCorrelation | undefined;
      let consumedCorrelation = false;
      try {
        if (!ctx.hasUI)
          return denied("RLM_OPT_IN_REQUIRED: rlm_run requires interactive exact-request confirmation; use /rlm for a direct host launch.");
        const built = buildRequest(params as LaunchParams);
        if (!built.ok)
          return { content: [{ type: "text", text: built.message }], details: { status: "invalid" } };
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
          throw error;
        }
        if (!approved) return denied("RLM_OPT_IN_REQUIRED: pi-rlm launch was not approved.");
        if (toolSignal.aborted) return denied("RLM_CANCELLED: pi-rlm launch was cancelled before authorization.");
        if (confirmationGeneration !== authorizationGeneration)
          return denied("RLM_GRANT_GENERATION_MISMATCH: session changed before authorization consumption.");

        const current = buildRequest(params as LaunchParams);
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
        audit(authorization.grant);
        try {
          const result = await run(built.value, toolSignal, "confirmed");
          return { content: [{ type: "text", text: summarize(result) }], details: { status: result.status } };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: wasAborted(error, toolSignal) ? "pi-rlm cancelled." : "pi-rlm failed before producing a result.",
            }],
            details: { status: toolSignal.aborted ? "cancelled" : "error" },
          };
        }
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
