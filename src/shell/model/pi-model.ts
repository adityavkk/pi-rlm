/**
 * Pi-backed ModelClient (imperative shell).
 *
 * Adapts a Pi `ModelRuntime` completion to the broker's minimal ModelClient
 * contract. Model ids are "provider/model". Structured-output enforcement stays
 * in the broker; this adapter only performs one completion and maps usage.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, StopReason } from "@earendil-works/pi-ai";
import { MAX_CALL_DURATION_MS, type CallUsage } from "../../core/usage.ts";
import { monotonicClock, type Clock } from "../clock.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "./client.ts";

export type PiModelErrorCode =
  | "CANCELLED"
  | "PROVIDER_ERROR"
  | "OUTPUT_TRUNCATED"
  | "UNEXPECTED_TOOL_USE"
  | "MISSING_TEXT";

/** Typed failure from a completed Pi request, including any reported usage. */
export class PiModelError extends Error {
  override readonly name = "PiModelError";

  constructor(
    readonly code: PiModelErrorCode,
    readonly stopReason: StopReason,
    readonly provider: string,
    readonly model: string,
    readonly usage: CallUsage,
    message: string,
  ) {
    super(message);
  }
}

const splitModel = (id: string): { provider: string; model: string } => {
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error(`model id must be "provider/model": ${id}`);
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
};

const elapsedMs = (startedMs: number, completedMs: number): number => {
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs <= startedMs) return 0;
  const elapsed = completedMs - startedMs;
  return Number.isFinite(elapsed) ? Math.min(Math.floor(elapsed), MAX_CALL_DURATION_MS) : MAX_CALL_DURATION_MS;
};

const mapUsage = (message: AssistantMessage, durationMs: number): CallUsage => ({
  attempts: 1,
  inputTokens: message.usage.input,
  outputTokens: message.usage.output,
  totalTokens: message.usage.totalTokens,
  costUsd: message.usage.cost.total,
  durationMs,
});

const mapMessage = (message: AssistantMessage, provider: string, model: string, durationMs: number): ModelResponse => {
  const usage = mapUsage(message, durationMs);
  const fail = (code: PiModelErrorCode, fallback: string): never => {
    throw new PiModelError(code, message.stopReason, provider, model, usage, message.errorMessage ?? fallback);
  };

  switch (message.stopReason) {
    case "error":
      return fail("PROVIDER_ERROR", `provider ${provider} failed to complete model ${model}`);
    case "aborted":
      return fail("CANCELLED", `completion aborted for ${provider}/${model}`);
    case "length":
      return fail("OUTPUT_TRUNCATED", `output truncated for ${provider}/${model}`);
    case "toolUse":
      return fail("UNEXPECTED_TOOL_USE", `unexpected tool use from ${provider}/${model}`);
    case "stop": {
      const textParts = message.content.filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      );
      if (textParts.length === 0) return fail("MISSING_TEXT", `no text returned by ${provider}/${model}`);
      return { text: textParts.map((part) => part.text).join(""), usage };
    }
  }
};

export class PiModelClient implements ModelClient {
  readonly id = "pi-model-runtime";

  constructor(
    private readonly runtime: ModelRuntime,
    private readonly defaultModel: string,
    private readonly clock: Clock = monotonicClock,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { provider, model } = splitModel(request.model ?? this.defaultModel);
    const resolved = this.runtime.getModel(provider, model);
    if (!resolved) throw new Error(`unknown model ${provider}/${model}`);

    const contextText = (request.context ?? [])
      .map((text, i) => `<context index="${i}">\n${text}\n</context>`)
      .join("\n\n");
    const userText = contextText ? `${contextText}\n\n${request.prompt}` : request.prompt;

    const context: Context = {
      messages: [{ role: "user", content: userText, timestamp: Date.now() }],
      ...(request.system ? { systemPrompt: request.system } : {}),
    };
    const reasoning = request.thinking && request.thinking !== "off" ? request.thinking : undefined;
    const startedMs = this.clock.now();
    let message: AssistantMessage;
    try {
      message = await this.runtime.completeSimple(resolved, context, {
        // Pi 0.80.10 exposes maxRetries on the public simple-completion options.
        // One accounting attempt therefore maps to one transport request.
        maxRetries: 0,
        ...(reasoning ? { reasoning } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch {
      const durationMs = elapsedMs(startedMs, this.clock.now());
      const cancelled = request.signal?.aborted === true;
      throw new PiModelError(
        cancelled ? "CANCELLED" : "PROVIDER_ERROR",
        cancelled ? "aborted" : "error",
        provider,
        model,
        { attempts: 1, durationMs },
        cancelled
          ? `completion aborted for ${provider}/${model}`
          : `provider ${provider} failed to complete model ${model}`,
      );
    }

    return mapMessage(message, provider, model, elapsedMs(startedMs, this.clock.now()));
  }
}
