/**
 * Pi-backed ModelClient (imperative shell).
 *
 * Adapts a Pi `ModelRuntime` completion to the broker's minimal ModelClient
 * contract. Model ids are "provider/model". Structured-output enforcement stays
 * in the broker; this adapter only performs one completion and maps usage.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { CallUsage } from "../../core/usage.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "./client.ts";

const splitModel = (id: string): { provider: string; model: string } => {
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error(`model id must be "provider/model": ${id}`);
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
};

export class PiModelClient implements ModelClient {
  readonly id = "pi-model-runtime";

  constructor(
    private readonly runtime: ModelRuntime,
    private readonly defaultModel: string,
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
    const message = await this.runtime.completeSimple(resolved, context, {
      ...(reasoning ? { reasoning } : {}),
      ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    const usage: CallUsage = {
      attempts: 1,
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      totalTokens: message.usage.totalTokens,
      costUsd: message.usage.cost.total,
      durationMs: 0,
    };
    return { text, usage };
  }
}
