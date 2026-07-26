import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent, ExtensionUIContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PROVIDER_REQUEST_IDENTITY_VERSION, type RlmEvent } from "../core/journal.ts";
import { buildBasePrompt } from "../runtime/controller-prompt.ts";
import {
  createOfflineProviderRuntimeFixture,
  OFFLINE_ANSWER,
  OFFLINE_COMMAND,
  OFFLINE_CONTROLLER_MODEL,
  OFFLINE_PROVIDER_ID,
  type OfflineProviderMode,
  type OfflineProviderRuntimeFixture,
} from "./testing/offline-provider-runtime.ts";

// Compile-time public-API guard: fixture registration uses the pinned exported method.
type PublicProviderRegistration = ModelRuntime["registerProvider"];
const publicProviderRegistration: PublicProviderRegistration | undefined = undefined;
void publicProviderRegistration;

const EXPECTED_REQUEST_SHA = "c0989fab00392eca206590ba5b1c301ffa4d4410f9f8b1547f344caaa4cba823";
const ANSWER_SHA = "a1962b5a13bb394a10d97d3c6acadac0d02bc24ddebe0f80d05a96b9b4dddf90";
const ANSWER_REF = `ctx_${ANSWER_SHA}`;

const ui = {
  setStatus() {},
  notify() {},
  confirm: async () => true,
} as unknown as ExtensionUIContext;

interface CustomMessage {
  readonly role: "custom";
  readonly customType: "pi-rlm-result";
  readonly content: string;
  readonly details: Record<string, unknown>;
}

const customMessage = (event: AgentSessionEvent): CustomMessage | undefined => {
  if (event.type !== "message_end") return undefined;
  const message = event.message as unknown as Partial<CustomMessage>;
  return message.role === "custom" && message.customType === "pi-rlm-result"
    ? message as CustomMessage
    : undefined;
};

const terminalEvents = (events: readonly RlmEvent[]) => events.filter((event) =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled");

const withTimeout = async <T>(work: Promise<T>, label: string, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const runCommand = async (mode: OfflineProviderMode) => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-offline-${mode}-`));
  let fixture: OfflineProviderRuntimeFixture | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    fixture = await createOfflineProviderRuntimeFixture(root, mode);
    const observed: AgentSessionEvent[] = [];
    unsubscribe = fixture.runtime.session.subscribe((event) => observed.push(event));
    await fixture.runtime.session.bindExtensions({ mode: "print", uiContext: ui });
    return { root, fixture, observed, unsubscribe };
  } catch (error) {
    unsubscribe?.();
    await fixture?.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

const runIdentity = (events: readonly RlmEvent[]) => {
  const starts = events.filter((event) => event.type === "run_started");
  expect(starts).toHaveLength(1);
  const runId = starts[0]!.runId;
  const frameId = `${runId}:f0`;
  expect(runId).toMatch(/^run_[a-f0-9]{64}$/);
  expect(events.filter((event) => "runId" in event && event.runId === runId)).toHaveLength(2);
  expect(events.filter((event) => "frameId" in event && event.frameId !== frameId)).toHaveLength(0);
  const terminals = terminalEvents(events);
  expect(terminals).toHaveLength(1);
  expect(terminals[0]!.runId).toBe(runId);
  return { runId, frameId, terminal: terminals[0]! };
};

const exactAttempt = (
  event: Extract<RlmEvent, { type: "provider_attempted" }>,
  frameId: string,
  outcome: "ok" | "error" | "cancelled",
) => {
  const errorCode = outcome === "ok" ? undefined : outcome === "error" ? "FAILED" : "CANCELLED";
  const tokens = outcome === "ok"
    ? { inputTokens: 11, outputTokens: 7, totalTokens: 18, costUsd: 0 }
    : outcome === "error" ? { inputTokens: 11, outputTokens: 0, totalTokens: 11, costUsd: 0 } : {};
  expect(event).toEqual({
    type: "provider_attempted",
    frameId,
    operationId: `${frameId}:controller:1`,
    kind: "controller",
    key: "1",
    attempt: 1,
    outcome,
    usage: { attempts: 1, ...tokens, durationMs: event.usage.durationMs },
    requestIdentityVersion: PROVIDER_REQUEST_IDENTITY_VERSION,
    requestSha256: EXPECTED_REQUEST_SHA,
    ...(errorCode ? { errorCode } : {}),
  });
  expect(Number.isSafeInteger(event.usage.durationMs)).toBe(true);
  expect(event.usage.durationMs).toBeGreaterThanOrEqual(0);
};

/** Real extension -> PiModelClient -> ModelRuntime -> controller -> QuickJS -> journal -> session. */
describe("credential-free offline Pi provider E2E", () => {
  test("success commits one exact request/cell/answer sequence and completed session result", async () => {
    const { root, fixture, observed, unsubscribe } = await runCommand("success");
    try {
      await withTimeout(fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }), "success prompt");
      expect(fixture.state.fetchCalls).toBe(0);
      expect(fixture.state.calls).toHaveLength(1);
      const call = fixture.state.calls[0]!;
      expect(call.model).toEqual({ provider: OFFLINE_PROVIDER_ID, id: "controller", api: "pi-rlm-offline-api" });
      expect(`${call.model.provider}/${call.model.id}`).toBe(OFFLINE_CONTROLLER_MODEL);
      expect(call.options).toEqual({ maxRetries: 0, maxTokens: 512, hasSignal: true, envKeys: [] });
      expect(call.signal?.aborted).toBe(false);
      expect(call.context.systemPrompt).toBe(buildBasePrompt());
      expect(call.context.messages).toHaveLength(1);
      expect(call.context.messages[0]?.role).toBe("user");
      expect(call.context.messages[0]?.content).toEqual(expect.stringContaining("Offline provider E2E"));
      expect(call.context.messages[0]?.content).toEqual(expect.stringContaining("context (20 bytes, ~5 tokens, sha b9fa0ae0)"));

      const events = await fixture.readEvents();
      const { runId, frameId, terminal } = runIdentity(events);
      expect(events.map((event) => event.type)).toEqual([
        "run_started", "frame_opened", "provider_attempted", "workspace_committed",
        "cell_committed", "answer_committed", "frame_closed", "run_completed",
      ]);
      const attempts = events.filter((event): event is Extract<RlmEvent, { type: "provider_attempted" }> =>
        event.type === "provider_attempted");
      expect(attempts).toHaveLength(1);
      exactAttempt(attempts[0]!, frameId, "ok");
      const cell = events.find((event): event is Extract<RlmEvent, { type: "cell_committed" }> => event.type === "cell_committed")!;
      expect(cell).toEqual({
        type: "cell_committed", frameId, iteration: 1, reasoning: "deterministic offline controller",
        codeHash: "b581cdccc04050ebd7286c9c59d58b9d6b97c3892936c6ab94b3d57bba823181",
        hasResult: false, outputPreview: "null", outputBytes: 4, outputOmittedBytes: 0,
        usage: attempts[0]!.usage, outputRef: ANSWER_REF, outputRefSha256: ANSWER_SHA, outputRefBytes: 36,
      });
      expect(events.find((event) => event.type === "answer_committed")).toEqual({
        type: "answer_committed", frameId, completionMode: "answer",
        outputRef: ANSWER_REF, outputSha256: ANSWER_SHA, outputBytes: 36,
      });
      expect(terminal).toEqual({ type: "run_completed", runId, completionMode: "answer", outputRef: ANSWER_REF });

      const messages = observed.map(customMessage).filter((value): value is CustomMessage => value !== undefined);
      expect(messages).toHaveLength(1);
      expect(Buffer.byteLength(messages[0]!.content, "utf8")).toBeLessThan(64 * 1024);
      const projection = JSON.parse(messages[0]!.content) as Record<string, any>;
      expect(projection).toEqual({
        answer: { answer: OFFLINE_ANSWER }, mode: "answer",
        output: { bytes: 36, ref: ANSWER_REF, sha256: ANSWER_SHA }, runId, status: "completed",
        truncation: { omittedBytes: 0, originalBytes: 36, truncated: false },
        usage: {
          activeLeafCalls: 0, attempts: 1, controllerTurns: 1, costUsd: 0, framesOpened: 0,
          inputTokensUsed: 11, logicalCalls: 1, outputTokensUsed: 7,
          providerDurationMs: attempts[0]!.usage.durationMs, storedBytes: 58,
          tokensReserved: 0, tokensUsed: 18,
        },
        warningCodes: [],
      });
      const entries = fixture.sessionManager.getEntries().filter((entry) =>
        entry.type === "custom_message" && entry.customType === "pi-rlm-result");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.type === "custom_message" && entries[0].content).toBe(messages[0]!.content);
    } finally {
      unsubscribe();
      await fixture.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("typed provider error commits exact failed attempt/terminal and failed session result", async () => {
    const { root, fixture, observed, unsubscribe } = await runCommand("error");
    try {
      await withTimeout(fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }), "failure prompt");
      expect(fixture.state.fetchCalls).toBe(0);
      expect(fixture.state.calls).toHaveLength(1);
      expect(fixture.state.calls[0]?.options).toEqual({ maxRetries: 0, maxTokens: 512, hasSignal: true, envKeys: [] });
      const events = await fixture.readEvents();
      const { runId, frameId, terminal } = runIdentity(events);
      expect(events.map((event) => event.type)).toEqual([
        "run_started", "frame_opened", "provider_attempted", "frame_closed", "run_failed",
      ]);
      const attempt = events.find((event): event is Extract<RlmEvent, { type: "provider_attempted" }> =>
        event.type === "provider_attempted")!;
      exactAttempt(attempt, frameId, "error");
      expect(terminal).toEqual({ type: "run_failed", runId, code: "FAILED", message: "model provider failed" });
      expect(events.find((event) => event.type === "frame_closed")).toEqual({ type: "frame_closed", frameId, state: "failed" });

      const messages = observed.map(customMessage).filter((value): value is CustomMessage => value !== undefined);
      expect(messages).toHaveLength(1);
      const projection = JSON.parse(messages[0]!.content) as Record<string, any>;
      expect(projection).toEqual({
        error: { code: "FAILED", message: "model provider failed" }, errorCode: "FAILED", mode: null,
        output: null, runId, status: "failed",
        truncation: { omittedBytes: 0, originalBytes: 0, truncated: false },
        usage: {
          activeLeafCalls: 0, attempts: 1, controllerTurns: 1, costUsd: 0, framesOpened: 0,
          inputTokensUsed: 11, logicalCalls: 1, outputTokensUsed: 0,
          providerDurationMs: attempt.usage.durationMs, storedBytes: 20, tokensReserved: 0, tokensUsed: 11,
        },
        warningCodes: [],
      });
    } finally {
      unsubscribe();
      await fixture.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("session replacement aborts once, retains cancellation, and rejects late mutation", async () => {
    const { root, fixture, observed, unsubscribe } = await runCommand("pending");
    const replacementObserved: AgentSessionEvent[] = [];
    let unsubscribeReplacement: (() => void) | undefined;
    try {
      const originalSession = fixture.runtime.session;
      const prompt = originalSession.prompt(OFFLINE_COMMAND, { source: "interactive" });
      await withTimeout(fixture.state.started, "provider start");
      expect(fixture.state.calls).toHaveLength(1);
      expect(fixture.state.calls[0]?.options).toEqual({ maxRetries: 0, maxTokens: 512, hasSignal: true, envKeys: [] });
      await withTimeout(fixture.runtime.newSession(), "session replacement");
      const replacementSession = fixture.runtime.session;
      expect(replacementSession).not.toBe(originalSession);
      unsubscribeReplacement = replacementSession.subscribe((event) => replacementObserved.push(event));
      await withTimeout(prompt, "cancelled prompt");
      expect(fixture.state.aborts).toBe(1);
      expect(fixture.state.calls[0]?.signal?.aborted).toBe(true);
      const events = await fixture.readEvents();
      const { runId, frameId, terminal } = runIdentity(events);
      expect(events.map((event) => event.type)).toEqual([
        "run_started", "frame_opened", "provider_attempted", "frame_closed", "run_cancelled",
      ]);
      const attempt = events.find((event): event is Extract<RlmEvent, { type: "provider_attempted" }> =>
        event.type === "provider_attempted")!;
      exactAttempt(attempt, frameId, "cancelled");
      expect(Object.keys(attempt.usage).sort()).toEqual(["attempts", "durationMs"]);
      expect(terminal).toEqual({ type: "run_cancelled", runId, code: "CANCELLED", message: "run cancelled by owner" });
      expect(events.find((event) => event.type === "frame_closed")).toEqual({ type: "frame_closed", frameId, state: "cancelled" });
      expect(observed.map(customMessage).filter(Boolean)).toHaveLength(0);

      const journalBefore = await fixture.readJournalBytes();
      const eventsBefore = structuredClone(events);
      const accountingBefore = structuredClone(attempt.usage);
      fixture.state.emitLate();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fixture.state.lateEmissionAttempts).toBe(1);
      expect(fixture.state.lateEmissionDispatchAttempts).toBe(1);
      expect(fixture.state.lateEmissionAccepted).toBe(1);
      expect(fixture.state.aborts).toBe(1);
      expect(await fixture.readJournalBytes()).toEqual(journalBefore);
      expect(await fixture.readEvents()).toEqual(eventsBefore);
      expect(attempt.usage).toEqual(accountingBefore);
      expect(fixture.state.calls).toHaveLength(1);
      expect(fixture.state.fetchCalls).toBe(0);
      expect(observed.map(customMessage).filter(Boolean)).toHaveLength(0);
      expect(replacementObserved.map(customMessage).filter(Boolean)).toHaveLength(0);
      expect(fixture.sessionManager.getEntries().filter((entry) =>
        entry.type === "custom_message" && entry.customType === "pi-rlm-result")).toHaveLength(0);
    } finally {
      unsubscribeReplacement?.();
      unsubscribe();
      await fixture.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("setup fault disposes partial runtime and restores the fetch tripwire", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-offline-setup-fault-"));
    const fetchBefore = globalThis.fetch;
    try {
      await expect(createOfflineProviderRuntimeFixture(root, "success", { setupFault: "after-agent-runtime" }))
        .rejects.toThrow("injected offline fixture setup fault");
      expect(globalThis.fetch).toBe(fetchBefore);
    } finally {
      if (globalThis.fetch !== fetchBefore) globalThis.fetch = fetchBefore;
      await rm(root, { recursive: true, force: true });
    }
  });
});
