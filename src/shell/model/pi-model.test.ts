import { describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { StopReason } from "@earendil-works/pi-ai";
import { MAX_CALL_DURATION_MS } from "../../core/usage.ts";
import { ManualClock } from "../clock.ts";
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

const clientFor = (fixture: MessageFixture, durationMs = 0): PiModelClient => {
  const clock = new ManualClock();
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
    completeSimple: async () => {
      clock.advance(durationMs);
      return message;
    },
  } as unknown as ModelRuntime;
  return new PiModelClient(runtime, "test-provider/test-model", clock);
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
  test("measures completion duration for success and typed provider failure", async () => {
    const success = await clientFor({ stopReason: "stop", content: [{ type: "text", text: "ok" }] }, 125)
      .complete({ prompt: "test" });
    expect(success.usage.durationMs).toBe(125);

    try {
      await clientFor({ stopReason: "error", content: [] }, 275).complete({ prompt: "test" });
      throw new Error("expected PiModelError");
    } catch (error) {
      expect(error).toBeInstanceOf(PiModelError);
      expect((error as PiModelError).usage.durationMs).toBe(275);
    }
  });

  test("sanitizes ordinary runtime rejection and includes elapsed duration", async () => {
    const clock = new ManualClock();
    const runtime = {
      getModel: () => ({ provider: "test-provider", id: "test-model" }),
      completeSimple: async () => {
        clock.advance(90);
        const providerError = new Error("sensitive provider failure");
        providerError.stack = "sensitive provider stack";
        throw providerError;
      },
    } as unknown as ModelRuntime;

    try {
      await new PiModelClient(runtime, "test-provider/test-model", clock).complete({ prompt: "test" });
      throw new Error("expected PiModelError");
    } catch (error) {
      expect(error).toBeInstanceOf(PiModelError);
      expect(error).toMatchObject({
        code: "PROVIDER_ERROR",
        stopReason: "error",
        provider: "test-provider",
        model: "test-model",
        usage: { attempts: 1, durationMs: 90 },
      });
      expect((error as Error).message).not.toContain("sensitive");
      expect((error as Error).stack).not.toContain("provider stack");
    }
  });

  test("bounds invalid and non-monotonic clock readings", async () => {
    const cases = [
      { readings: [0, 1.9], expected: 1 },
      { readings: [100, 50], expected: 0 },
      { readings: [Number.NaN, 100], expected: 0 },
      { readings: [0, Number.POSITIVE_INFINITY], expected: 0 },
      { readings: [-Number.MAX_VALUE, Number.MAX_VALUE], expected: MAX_CALL_DURATION_MS },
    ];
    for (const { readings, expected } of cases) {
      let index = 0;
      const clock = { now: () => readings[index++]! };
      const runtime = {
        getModel: () => ({ provider: "test-provider", id: "test-model" }),
        completeSimple: async () => { throw new Error("runtime failure"); },
      } as unknown as ModelRuntime;
      try {
        await new PiModelClient(runtime, "test-provider/test-model", clock).complete({ prompt: "test" });
        throw new Error("expected PiModelError");
      } catch (error) {
        expect(error).toBeInstanceOf(PiModelError);
        expect((error as PiModelError).usage.durationMs).toBe(expected);
      }
    }
  });

  test("types runtime rejection after cancellation and includes elapsed duration", async () => {
    const clock = new ManualClock();
    const runtime = {
      getModel: () => ({ provider: "test-provider", id: "test-model" }),
      completeSimple: async () => {
        clock.advance(40);
        throw new Error("sensitive abort reason");
      },
    } as unknown as ModelRuntime;
    const owner = new AbortController();
    owner.abort();
    const completion = new PiModelClient(runtime, "test-provider/test-model", clock)
      .complete({ prompt: "test", signal: owner.signal });
    try {
      await completion;
      throw new Error("expected PiModelError");
    } catch (error) {
      expect(error).toBeInstanceOf(PiModelError);
      expect(error).toMatchObject({ code: "CANCELLED", stopReason: "aborted", usage: { attempts: 1, durationMs: 40 } });
      expect((error as Error).message).not.toContain("sensitive");
    }
  });

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

describe("PiModelClient retry policy", () => {
  test("sets the pinned public maxRetries option to zero", async () => {
    let observedOptions: unknown;
    const runtime = {
      getModel: () => ({ provider: "test-provider", id: "test-model" }),
      completeSimple: async (_model: unknown, _context: unknown, options: unknown) => {
        observedOptions = options;
        return {
          role: "assistant",
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          timestamp: 1,
          usage: REPORTED_USAGE,
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        };
      },
    } as unknown as ModelRuntime;

    await new PiModelClient(runtime, "test-provider/test-model").complete({ prompt: "test" });
    expect(observedOptions).toMatchObject({ maxRetries: 0 });
  });
});
