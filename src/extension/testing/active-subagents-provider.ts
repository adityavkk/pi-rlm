import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";

export const ACTIVE_SUBAGENTS_PROVIDER = "pi-rlm-active-subagents";
export const ACTIVE_SUBAGENTS_MODEL = `${ACTIVE_SUBAGENTS_PROVIDER}/child`;
export const ACTIVE_SUBAGENTS_TEXT = "active public delegation result";
export const ACTIVE_SUBAGENTS_STRUCTURED = { verdict: "active-public-pass", count: 2 } as const;

const usage = {
  input: 3,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const message = (
  model: Model<Api>,
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason,
  timestamp: Date.now(),
});

const record = (value: Record<string, unknown>): void => {
  const path = process.env["PI_RLM_ACTIVE_SUBAGENTS_OBSERVATIONS"];
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
};

/** Credential-free child provider loaded through Pi's documented extension API. */
export default function activeSubagentsProvider(pi: ExtensionAPI): void {
  globalThis.fetch = (async () => {
    record({ event: "network-attempt" });
    throw new Error("active subagents fixture blocked fetch");
  }) as unknown as typeof fetch;
  pi.registerProvider(ACTIVE_SUBAGENTS_PROVIDER, {
    name: "pi-rlm active subagents fixture",
    baseUrl: "https://offline.invalid",
    apiKey: "offline-fixture-not-a-secret",
    api: "pi-rlm-active-subagents-api",
    models: [{
      id: "child",
      name: "Active subagents child",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    }],
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
      const stream = createAssistantMessageEventStream();
      const structured = context.tools?.some((tool) => tool.name === "structured_output") === true;
      record({
        event: "started",
        pid: process.pid,
        model: `${model.provider}/${model.id}`,
        structured,
        envKeys: Object.keys(options?.env ?? {}).sort(),
        providerCredentialEnvKeys: Object.keys(process.env).filter((key) =>
          /(?:API_KEY|PASSWORD|CREDENTIAL)/.test(key) && !key.startsWith("PI_SUBAGENT_")).sort(),
        parentCapabilityPresent: typeof process.env["PI_SUBAGENT_PARENT_CAPABILITY_TOKEN"] === "string",
        tmpdir: process.env["TMPDIR"],
        taskSeen: context.messages.some((entry) => JSON.stringify(entry).includes("active package fixture")),
      });
      let settled = false;
      const finish = (final: AssistantMessage): void => {
        if (settled) return;
        settled = true;
        if (final.stopReason === "aborted" || final.stopReason === "error")
          stream.push({ type: "error", reason: final.stopReason, error: final });
        else {
          stream.push({ type: "start", partial: { ...final, content: [] } });
          stream.push({ type: "done", reason: final.stopReason, message: final });
        }
        stream.end(final);
      };
      const abort = (): void => {
        record({ event: "aborted" });
        finish(message(model, "aborted", []));
      };
      if (process.env["PI_RLM_ACTIVE_SUBAGENTS_PENDING"] === "1") {
        if (options?.signal?.aborted) queueMicrotask(abort);
        else options?.signal?.addEventListener("abort", abort, { once: true });
        return stream;
      }
      if (!structured) {
        queueMicrotask(() => finish(message(model, "stop", [{ type: "text", text: ACTIVE_SUBAGENTS_TEXT }])));
        return stream;
      }
      const toolCall: ToolCall = {
        type: "toolCall",
        id: "active-structured-output",
        name: "structured_output",
        arguments: { value: ACTIVE_SUBAGENTS_STRUCTURED },
      };
      queueMicrotask(() => {
        if (settled) return;
        settled = true;
        const final = message(model, "toolUse", [toolCall]);
        stream.push({ type: "start", partial: { ...final, content: [] } });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...final, content: [{ ...toolCall, arguments: {} }] } });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: final });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: final });
        stream.push({ type: "done", reason: "toolUse", message: final });
        stream.end(final);
      });
      return stream;
    },
  });
}
