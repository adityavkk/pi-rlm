/**
 * pi-rlm extension entry.
 *
 * Registers the explicit launch surfaces: the `/rlm` slash command (host
 * initiated, always allowed) and the `rlm_run` tool (model initiated, gated by
 * a host confirmation so prompt guidance alone cannot start a run). Runs execute
 * on the QuickJS backend with a one-response controller over the Pi model
 * runtime. Large inputs stay in the host-backed context store; only the final
 * result returns to the conversation.
 *
 * Offline correctness (engine, interpreter, broker, budgets, journal) is
 * covered by the test suite. The live provider path requires configured model
 * auth and is intended for interactive use.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compileShorthand, normalizeProgram, type RlmProgram } from "./src/core/index.ts";
import { QuickJsBackend } from "./src/shell/interpreter/quickjs.ts";
import type { InterpreterBackend } from "./src/shell/interpreter/backend.ts";
import { PiModelClient } from "./src/shell/model/pi-model.ts";
import { DEFAULT_PROFILE, ModelController, type Profile, runProgram, type RunResult } from "./src/runtime/index.ts";

export const LAUNCH_SNIPPET =
  "pi-rlm runs long-context recursive model/agent workflows in a sandboxed JS controller. " +
  "Start one explicitly with the /rlm command or by asking to 'use pi-rlm'. Do not start runs for ordinary tasks.";

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
  readonly sources: Record<string, string>;
}

const buildRequest = (params: {
  objective?: string;
  context?: string;
  program?: unknown;
  sources?: Record<string, string>;
}): { ok: true; value: LaunchRequest } | { ok: false; message: string } => {
  if (params.program !== undefined) {
    const normalized = normalizeProgram(params.program);
    if (!normalized.ok) return { ok: false, message: `Invalid program: ${normalized.error.map((e) => `${e.path} ${e.message}`).join("; ")}` };
    return { ok: true, value: { program: normalized.value, sources: params.sources ?? {} } };
  }
  if (params.objective) {
    const compiled = compileShorthand({ objective: params.objective });
    if (!compiled.ok) return { ok: false, message: `Invalid objective: ${compiled.error[0]?.message ?? "unknown"}` };
    return { ok: true, value: { program: compiled.value, sources: { context: params.context ?? "" } } };
  }
  return { ok: false, message: "Provide either { objective, context } or { program, sources }." };
};

const summarize = (result: RunResult): string => {
  if (result.status === "completed")
    return `pi-rlm ${result.completionMode === "fallback_extract" ? "completed via fallback extraction" : "completed"}.\n\nResult:\n${JSON.stringify(result.answer, null, 2)}\n\nUsage: ${result.ledger.usage.logicalCalls} calls, ${result.ledger.usage.attempts} attempts, ${result.ledger.usage.framesOpened} child frames.`;
  return `pi-rlm failed (${result.error?.code}): ${result.error?.message}`;
};

const executeRun = async (request: LaunchRequest): Promise<RunResult> => {
  const profile = resolveProfile();
  const [backend, runtime] = await Promise.all([getBackend(), getRuntime()]);
  const model = new PiModelClient(runtime, profile.models.medium);
  const controller = new ModelController(model, { model: profile.models.large });
  const dir = await mkdtemp(join(tmpdir(), "pi-rlm-run-"));
  return runProgram({ program: request.program, sources: request.sources, controller, model, backend: backend as InterpreterBackend, dir, profile });
};

const gate = async (ctx: ExtensionContext): Promise<{ ok: true } | { ok: false; message: string }> => {
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm("Start a pi-rlm run?", "This may make many model calls and spend tokens.");
    return ok ? { ok: true } : { ok: false, message: "Canceled: pi-rlm run not approved." };
  }
  if (process.env["PI_RLM_ALLOW_UNSOLICITED"] === "1") return { ok: true };
  return { ok: false, message: "RLM_OPT_IN_REQUIRED: start pi-rlm with the /rlm command or run interactively to approve." };
};

const RlmRunParams = Type.Object({
  objective: Type.Optional(Type.String({ description: "Objective for the shorthand form." })),
  context: Type.Optional(Type.String({ description: "Inline source text for the shorthand form." })),
  program: Type.Optional(Type.Unknown()),
  sources: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("rlm", {
    description: "Start a pi-rlm run from an objective (host-initiated; bypasses the model).",
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
      ctx.ui.setStatus("pi-rlm", "running...");
      try {
        const result = await executeRun(built.value);
        ctx.ui.notify(summarize(result), result.status === "completed" ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(`pi-rlm error: ${(error as Error).message}`, "error");
      } finally {
        ctx.ui.setStatus("pi-rlm", "");
      }
    },
  });

  pi.registerTool({
    name: "rlm_run",
    label: "RLM Run",
    description: [
      "Run a long-context recursive model/agent workflow (pi-rlm).",
      "Use only after explicit user opt-in ('use pi-rlm' / '/rlm'); not for ordinary tasks.",
      "Provide { objective, context } for the shorthand, or { program, sources } for a typed program.",
      "Requires host approval before spending; the model cannot start a run on its own.",
    ].join(" "),
    parameters: RlmRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<{ status: string }>> {
      const allowed = await gate(ctx);
      if (!allowed.ok) return { content: [{ type: "text", text: allowed.message }], details: { status: "denied" } };
      const built = buildRequest(params as Parameters<typeof buildRequest>[0]);
      if (!built.ok) return { content: [{ type: "text", text: built.message }], details: { status: "invalid" } };
      try {
        const result = await executeRun(built.value);
        return { content: [{ type: "text", text: summarize(result) }], details: { status: result.status } };
      } catch (error) {
        return { content: [{ type: "text", text: `pi-rlm error: ${(error as Error).message}` }], details: { status: "error" } };
      }
    },
  });
}
