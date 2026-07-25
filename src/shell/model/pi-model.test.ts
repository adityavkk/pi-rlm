import { describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { StopReason } from "@earendil-works/pi-ai";
import { PiModelClient, PiModelError, type PiModelErrorCode } from "./pi-model.ts";

const REPORTED_USAGE = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 23,
  cost: { input: 0.11, output: 0.07, cacheRead: 0.03, cacheWrite: 0.02, total: 0.23 },
};

const EXPECTED_USAGE = {
  attempts: 1,
  inputTokens: 11,
  outputTokens: 7,
  totalTokens: 23,
  costUsd: 0.23,
  durationMs: 0,
};

interface MessageFixture {
  readonly stopReason: StopReason;
  readonly content: readonly Record<string, unknown>[];
  readonly errorMessage?: string;
}

const clientFor = (fixture: MessageFixture): PiModelClient => {
  const message = {
    role: "assistant",
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    timestamp: 1,
    usage: REPORTED_USAGE,
    ...fixture,
  };
  const runtime = {
    getModel: (provider: string, model: string) =>
      provider === "test-provider" && model === "test-model" ? { provider, id: model } : undefined,
    completeSimple: async () => message,
  } as unknown as ModelRuntime;
  return new PiModelClient(runtime, "test-provider/test-model");
};

type AdapterCase =
  | {
      readonly name: string;
      readonly fixture: MessageFixture;
      readonly text: string;
    }
  | {
      readonly name: string;
      readonly fixture: MessageFixture;
      readonly code: PiModelErrorCode;
      readonly message?: string;
    };

const cases: readonly AdapterCase[] = [
  {
    name: "returns normal text for stop",
    fixture: {
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    },
    text: "hello world",
  },
  {
    name: "rejects partial text for length",
    fixture: { stopReason: "length", content: [{ type: "text", text: "partial" }] },
    code: "OUTPUT_TRUNCATED",
  },
  {
    name: "maps provider error and its message",
    fixture: { stopReason: "error", content: [], errorMessage: "auth failed" },
    code: "PROVIDER_ERROR",
    message: "auth failed",
  },
  {
    name: "maps aborted completion",
    fixture: { stopReason: "aborted", content: [], errorMessage: "request aborted" },
    code: "CANCELLED",
    message: "request aborted",
  },
  {
    name: "rejects tool use without text",
    fixture: {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
    },
    code: "UNEXPECTED_TOOL_USE",
  },
  {
    name: "rejects stop without text",
    fixture: { stopReason: "stop", content: [{ type: "thinking", thinking: "no answer" }] },
    code: "MISSING_TEXT",
  },
];

describe("PiModelClient stop reasons", () => {
  for (const adapterCase of cases) {
    test(adapterCase.name, async () => {
      const completion = clientFor(adapterCase.fixture).complete({ prompt: "test" });

      if ("text" in adapterCase) {
        await expect(completion).resolves.toEqual({ text: adapterCase.text, usage: EXPECTED_USAGE });
        return;
      }

      try {
        await completion;
        throw new Error("expected PiModelError");
      } catch (error) {
        expect(error).toBeInstanceOf(PiModelError);
        const modelError = error as PiModelError;
        expect(modelError).toMatchObject({
          name: "PiModelError",
          code: adapterCase.code,
          stopReason: adapterCase.fixture.stopReason,
          provider: "test-provider",
          model: "test-model",
          usage: EXPECTED_USAGE,
        });
        if (adapterCase.message) expect(modelError.message).toBe(adapterCase.message);
      }
    });
  }
});
