import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { settledOperations } from "../runtime/testing/operation-events.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { canonicalStringify, parseJsonValue } from "../core/index.ts";
import { PROVIDER_REQUEST_IDENTITY_VERSION, type RlmEvent } from "../core/journal.ts";
import { buildInlineRequest } from "./source.ts";
import { sha256 } from "../shell/hash.ts";
import {
  createOfflineProviderRuntimeFixture,
  OFFLINE_CONTROLLER_MODEL,
  OFFLINE_HOST_MODEL,
  type OfflineHostResponse,
  type OfflineProviderMode,
  type OfflineProviderRuntimeFixture,
} from "./testing/offline-provider-runtime.ts";

const TOOL_CALL_ID = "call_pi_rlm_offline_replay_0001";
const REQUEST = {
  objective: "AgentSession grant replay acceptance",
  context: "fixed public AgentSession source",
};
const PROMPT = "Please use pi-rlm for this exact recursive long-context request.";
const TOOL_CALL: OfflineHostResponse = {
  type: "toolCall",
  id: TOOL_CALL_ID,
  name: "rlm_run",
  arguments: REQUEST,
};
const STOP: OfflineHostResponse = { type: "stop", text: "pi-rlm request finished" };
const ANSWER_SHA = "a1962b5a13bb394a10d97d3c6acadac0d02bc24ddebe0f80d05a96b9b4dddf90";
const CONTROLLER_REQUEST_SHA = "c38466d718fbe055e7ab66195ab5e593c3900ffc5bc63471c295947f4440405a";

interface Confirmation {
  readonly title: string;
  readonly message: string;
}

interface ToolResultLike {
  readonly role: "toolResult";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: Array<{ readonly type: string; readonly text?: string }>;
}

const withTimeout = async <T>(work: Promise<T>, label: string, ms = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const createUi = (confirmations: Confirmation[]): ExtensionUIContext => ({
  setStatus() {},
  notify() {},
  confirm: async (title: string, message: string) => {
    confirmations.push({ title, message });
    return true;
  },
}) as unknown as ExtensionUIContext;

const setup = async (mode: OfflineProviderMode, hostScript: readonly OfflineHostResponse[]) => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-agent-session-${mode}-`));
  let fixture: OfflineProviderRuntimeFixture | undefined;
  try {
    fixture = await createOfflineProviderRuntimeFixture(root, mode, {
      hostScript,
      persistSession: true,
    });
    const confirmations: Confirmation[] = [];
    await withTimeout(
      fixture.runtime.session.bindExtensions({ mode: "tui", uiContext: createUi(confirmations) }),
      "public ExtensionRunner bind",
    );
    return { root, fixture, confirmations };
  } catch (error) {
    if (fixture) {
      try { await fixture.dispose(); }
      finally { fixture.restoreFetchTripwire(); }
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

const cleanup = async (
  root: string,
  fixture: OfflineProviderRuntimeFixture,
): Promise<void> => {
  try { await fixture.dispose(); }
  finally {
    fixture.restoreFetchTripwire();
    await rm(root, { recursive: true, force: true });
  }
};

const toolResults = (messages: readonly unknown[]): ToolResultLike[] => messages.filter((message): message is ToolResultLike => {
  const candidate = message as Partial<ToolResultLike>;
  return candidate.role === "toolResult" && candidate.toolName === "rlm_run";
});

const durableToolResults = (entries: readonly unknown[]): ToolResultLike[] => entries.flatMap((entry) => {
  const candidate = entry as { type?: string; message?: unknown };
  return candidate.type === "message" ? toolResults([candidate.message]) : [];
});

const projection = (result: ToolResultLike): Record<string, any> => {
  const text = result.content.find((content) => content.type === "text")?.text;
  if (text === undefined) throw new Error("rlm_run tool result has no text content");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThan(64 * 1024);
  return JSON.parse(text) as Record<string, any>;
};

const grantEntries = (entries: readonly unknown[]): Array<Record<string, any>> => entries.filter((entry) => {
  const candidate = entry as Record<string, unknown>;
  return candidate["type"] === "custom" && candidate["customType"] === "pi-rlm-launch-grant";
}) as Array<Record<string, any>>;

const requestSha = (): string => {
  const built = buildInlineRequest(REQUEST);
  if (!built.ok) throw new Error(`fixed AgentSession request is invalid: ${built.error.code}`);
  const parsed = parseJsonValue({ program: built.value.program, sources: built.value.sources });
  if (!parsed.ok) throw new Error(`fixed AgentSession request is not JSON: ${parsed.reason}`);
  return sha256(canonicalStringify(parsed.value));
};

const terminalEvents = (events: readonly RlmEvent[]) => events.filter((event) =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled");

const runDirectories = async (fixture: OfflineProviderRuntimeFixture): Promise<string[]> =>
  (await readdir(fixture.runRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .map((entry) => join(fixture.runRoot, entry.name));

const snapshotTree = async (root: string): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isFile()) snapshot[relative] = (await readFile(path)).toString("base64");
    }
  };
  await visit(root, "");
  return snapshot;
};

const assertSelectedHostAndToolBoundary = (fixture: OfflineProviderRuntimeFixture): void => {
  expect(`${fixture.runtime.session.model?.provider}/${fixture.runtime.session.model?.id}`).toBe(OFFLINE_HOST_MODEL);
  expect(fixture.runtime.session.getActiveToolNames()).toEqual(["rlm_run"]);
};

const assertGrant = (
  fixture: OfflineProviderRuntimeFixture,
  confirmations: readonly Confirmation[],
): Record<string, any> => {
  const grants = grantEntries(fixture.sessionManager.getEntries());
  const reopenedGrants = grantEntries(fixture.reopenSession().getEntries());
  expect(grants).toHaveLength(1);
  expect(reopenedGrants).toEqual(grants);
  const data = grants[0]?.["data"] as Record<string, any>;
  const matchingTurns = fixture.state.extensionTurnStarts.filter((event) =>
    event.sessionId === data["sessionId"]
      && `${event.turnIndex}:${event.timestamp}` === data["turnNonce"]);
  expect(matchingTurns).toHaveLength(1);
  expect(data["turnNonce"]).toBe(`${matchingTurns[0]!.turnIndex}:${matchingTurns[0]!.timestamp}`);
  expect(data).toEqual({
    grantId: "offline-fixture-1",
    sessionId: fixture.runtime.session.sessionId,
    turnNonce: data["turnNonce"],
    promptSha256: sha256(PROMPT),
    requestSha256: requestSha(),
    toolCallId: TOOL_CALL_ID,
    mode: "confirmed",
    issuedAtMs: data["issuedAtMs"],
    expiresAtMs: data["expiresAtMs"],
    consumedAtMs: data["consumedAtMs"],
  });
  expect(Number.isSafeInteger(data["issuedAtMs"])).toBe(true);
  expect(data["expiresAtMs"] - data["issuedAtMs"]).toBe(120_000);
  expect(data["consumedAtMs"]).toBeGreaterThanOrEqual(data["issuedAtMs"]);
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]?.title).toBe("Approve exact pi-rlm request?");
  expect(confirmations[0]?.message).toContain("Objective: AgentSession grant replay acceptance");
  expect(confirmations[0]?.message).toContain("Profile: default");
  expect(confirmations[0]?.message).toContain("Inputs: context");
  expect(confirmations[0]?.message).toContain("Outputs: answer");
  expect(confirmations[0]?.message).toContain(`Sources: context (${Buffer.byteLength(REQUEST.context, "utf8")} bytes)`);
  expect(confirmations[0]?.message).toContain(`Exact normalized request SHA-256: ${requestSha()}`);
  return data;
};

/** Public AgentSession + ExtensionRunner tool loop. No constructed ExtensionContext or private Pi API. */
describe("public AgentSession rlm_run grant lifecycle", () => {
  test("one exact grant completes once and rejects a repeated host tool-call ID", async () => {
    const { root, fixture, confirmations } = await setup("success", [TOOL_CALL, TOOL_CALL, STOP]);
    try {
      assertSelectedHostAndToolBoundary(fixture);
      await withTimeout(
        fixture.runtime.session.prompt(PROMPT, { source: "interactive" }),
        "AgentSession replay turn",
      );
      await withTimeout(fixture.runtime.session.waitForIdle(), "AgentSession replay idle");
      expect(fixture.runtime.session.isIdle).toBe(true);

      const hostCalls = fixture.state.calls.filter((call) => `${call.model.provider}/${call.model.id}` === OFFLINE_HOST_MODEL);
      const controllerCalls = fixture.state.calls.filter((call) =>
        `${call.model.provider}/${call.model.id}` === OFFLINE_CONTROLLER_MODEL);
      expect(fixture.state.calls.map((call) => `${call.model.provider}/${call.model.id}`)).toEqual([
        OFFLINE_HOST_MODEL, OFFLINE_CONTROLLER_MODEL, OFFLINE_HOST_MODEL, OFFLINE_HOST_MODEL,
      ]);
      expect(hostCalls).toHaveLength(3);
      expect(controllerCalls).toHaveLength(1);
      expect(hostCalls.every((call) => call.context.tools?.map((tool) => tool.name).join(",") === "rlm_run")).toBe(true);
      expect(hostCalls.map((call) => call.options)).toEqual([
        { hasSignal: true, envKeys: [] },
        { hasSignal: true, envKeys: [] },
        { hasSignal: true, envKeys: [] },
      ]);
      expect(fixture.runtime.session.getLastAssistantText()).toBe(STOP.text);
      expect(controllerCalls[0]?.options).toEqual({ maxRetries: 0, maxTokens: 512, hasSignal: true, envKeys: [] });

      const currentResults = toolResults(fixture.runtime.session.messages);
      const durableResults = durableToolResults(fixture.reopenSession().getEntries());
      expect(currentResults).toHaveLength(2);
      expect(durableResults).toHaveLength(2);
      expect(currentResults.map((result) => result.toolCallId)).toEqual([TOOL_CALL_ID, TOOL_CALL_ID]);
      expect(durableResults.map((result) => result.content)).toEqual(currentResults.map((result) => result.content));
      const completedProjection = projection(currentResults[0]!);
      const completedDuration = completedProjection["usage"]?.providerDurationMs;
      expect(Number.isSafeInteger(completedDuration)).toBe(true);
      expect(completedProjection).toEqual({
        answer: { answer: "offline provider answer" },
        mode: "answer",
        output: { bytes: 36, ref: `ctx_${ANSWER_SHA}`, sha256: ANSWER_SHA },
        runId: completedProjection["runId"],
        status: "completed",
        truncation: { omittedBytes: 0, originalBytes: 36, truncated: false },
        usage: {
          activeLeafCalls: 0, attempts: 1, controllerTurns: 1, costUsd: 0, framesOpened: 0,
          inputTokensUsed: 11, logicalCalls: 1, outputTokensUsed: 7,
          providerDurationMs: completedDuration, storedBytes: 70, tokensReserved: 0, tokensUsed: 18,
        },
        warningCodes: [],
      });
      expect(completedProjection["runId"]).toMatch(/^run_[a-f0-9]{64}$/);
      expect(projection(currentResults[1]!)).toEqual({
        error: {
          code: "RLM_GRANT_REPLAY",
          message: "RLM_GRANT_REPLAY: this tool call was already authorized or consumed.",
        },
        errorCode: "RLM_GRANT_REPLAY",
        mode: null,
        output: null,
        runId: null,
        status: "failed",
        truncation: { omittedBytes: 0, originalBytes: 0, truncated: false },
        usage: null,
        warningCodes: [],
      });

      assertGrant(fixture, confirmations);
      const journal = await fixture.readEvents();
      expect(terminalEvents(journal)).toHaveLength(1);
      expect(terminalEvents(journal)[0]).toEqual({
        type: "run_completed",
        runId: completedProjection["runId"],
        completionMode: "answer",
        outputRef: `ctx_${ANSWER_SHA}`,
      });
      expect(await runDirectories(fixture)).toHaveLength(1);
      expect(fixture.state.calls.every((call) => call.options.envKeys.length === 0)).toBe(true);
      expect(fixture.state.fetchCalls).toBe(0);
    } finally {
      await cleanup(root, fixture);
    }
  }, 15_000);

  test("public AgentSession.abort cancels one consumed run and rejects late provider mutation", async () => {
    const { root, fixture, confirmations } = await setup("pending", [TOOL_CALL, STOP]);
    try {
      assertSelectedHostAndToolBoundary(fixture);
      const prompt = fixture.runtime.session.prompt(PROMPT, { source: "interactive" });
      await withTimeout(fixture.state.started, "controller provider start");
      const controllerCalls = fixture.state.calls.filter((call) =>
        `${call.model.provider}/${call.model.id}` === OFFLINE_CONTROLLER_MODEL);
      expect(controllerCalls).toHaveLength(1);
      const controllerSignal = controllerCalls[0]?.signal;
      expect(controllerSignal?.aborted).toBe(false);
      let observedSignalAborts = 0;
      controllerSignal?.addEventListener("abort", () => { observedSignalAborts += 1; }, { once: true });

      await withTimeout(fixture.runtime.session.abort(), "public AgentSession.abort");
      await withTimeout(prompt, "cancelled AgentSession turn");
      await withTimeout(fixture.runtime.session.waitForIdle(), "cancelled AgentSession idle");
      expect(fixture.runtime.session.isIdle).toBe(true);
      expect(observedSignalAborts).toBe(1);
      expect(controllerSignal?.aborted).toBe(true);
      expect(fixture.state.aborts).toBe(1);
      const hostCalls = fixture.state.calls.filter((call) =>
        `${call.model.provider}/${call.model.id}` === OFFLINE_HOST_MODEL);
      // Pi 0.80.10 durably records the cancelled tool result, then asks the host
      // model for the terminal assistant response. The script emits no second tool call.
      expect(fixture.state.calls.map((call) => `${call.model.provider}/${call.model.id}`)).toEqual([
        OFFLINE_HOST_MODEL, OFFLINE_CONTROLLER_MODEL, OFFLINE_HOST_MODEL,
      ]);
      expect(hostCalls).toHaveLength(2);
      expect(hostCalls.map((call) => call.options)).toEqual([
        { hasSignal: true, envKeys: [] },
        { hasSignal: true, envKeys: [] },
      ]);
      expect(hostCalls[1]?.context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
      expect(fixture.runtime.session.getLastAssistantText()).toBe(STOP.text);
      expect(fixture.state.calls.filter((call) => `${call.model.provider}/${call.model.id}` === OFFLINE_CONTROLLER_MODEL))
        .toHaveLength(1);

      assertGrant(fixture, confirmations);
      const journal = await fixture.readEvents();
      expect(journal.map((event) => event.type)).toEqual([
        "run_started", "frame_opened", "operation_intended", "operation_settled", "frame_closed", "run_cancelled",
      ]);
      const attempts = settledOperations(journal);
      expect(attempts).toHaveLength(1);
      const runStarted = journal[0];
      if (runStarted?.type !== "run_started") throw new Error("cancelled journal does not start with run_started");
      const frameId = `${runStarted.runId}:f0`;
      expect(attempts[0]).toMatchObject({
        type: "operation_settled",
        frameId,
        operationId: `${frameId}:controller:1`,
        kind: "controller",
        attempt: 1,
        outcome: "cancelled",
        usage: { attempts: 1, durationMs: attempts[0]!.usage.durationMs },
        requestIdentityVersion: PROVIDER_REQUEST_IDENTITY_VERSION,
        requestSha256: CONTROLLER_REQUEST_SHA,
        errorCode: "CANCELLED",
      });
      expect(Object.keys(attempts[0]!.usage).sort()).toEqual(["attempts", "durationMs"]);
      expect(Number.isSafeInteger(attempts[0]!.usage.durationMs)).toBe(true);
      const terminals = terminalEvents(journal);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toEqual({
        type: "run_cancelled",
        runId: terminals[0]!.runId,
        code: "CANCELLED",
        message: "run cancelled by owner",
      });
      expect(await runDirectories(fixture)).toHaveLength(1);

      const currentResults = toolResults(fixture.runtime.session.messages);
      const durableResults = durableToolResults(fixture.reopenSession().getEntries());
      expect(currentResults).toHaveLength(1);
      expect(durableResults).toHaveLength(1);
      expect(durableResults[0]?.content).toEqual(currentResults[0]?.content);
      const cancelledProjection = projection(currentResults[0]!);
      expect(cancelledProjection).toEqual({
        error: { code: "CANCELLED", message: "run cancelled by owner" },
        errorCode: "CANCELLED",
        mode: null,
        output: null,
        runId: terminals[0]!.runId,
        status: "cancelled",
        truncation: { omittedBytes: 0, originalBytes: 0, truncated: false },
        usage: {
          activeLeafCalls: 0, attempts: 1, controllerTurns: 1, costUsd: 0, framesOpened: 0,
          inputTokensUsed: 0, logicalCalls: 1, outputTokensUsed: 0,
          providerDurationMs: attempts[0]!.usage.durationMs, storedBytes: 32,
          tokensReserved: 0, tokensUsed: 0,
        },
        warningCodes: [],
      });

      const treeBefore = await snapshotTree(fixture.runRoot);
      const eventsBefore = structuredClone(journal);
      const accountingBefore = structuredClone(attempts[0]?.usage);
      if (!fixture.sessionFile) throw new Error("persistent AgentSession fixture has no session file");
      const sessionFileBefore = await readFile(fixture.sessionFile);
      const sessionBefore = JSON.stringify({
        messages: fixture.runtime.session.messages,
        entries: fixture.reopenSession().getEntries(),
      });
      fixture.state.emitLate();
      await withTimeout(new Promise<void>((resolve) => setTimeout(resolve, 25)), "late provider observation");
      expect(fixture.state.lateEmissionAttempts).toBe(1);
      expect(fixture.state.lateEmissionDispatchAttempts).toBe(1);
      expect(fixture.state.lateEmissionAccepted).toBe(1);
      expect(fixture.state.aborts).toBe(1);
      expect(await snapshotTree(fixture.runRoot)).toEqual(treeBefore);
      expect(await fixture.readEvents()).toEqual(eventsBefore);
      expect(attempts[0]?.usage).toEqual(accountingBefore);
      expect(await readFile(fixture.sessionFile)).toEqual(sessionFileBefore);
      expect(JSON.stringify({
        messages: fixture.runtime.session.messages,
        entries: fixture.reopenSession().getEntries(),
      })).toBe(sessionBefore);
      expect(fixture.state.calls).toHaveLength(3);
      const emittedToolCalls = fixture.runtime.session.messages.flatMap((message) =>
        message.role === "assistant" ? message.content.filter((content) => content.type === "toolCall") : []);
      expect(emittedToolCalls).toHaveLength(1);
      expect(emittedToolCalls[0]?.id).toBe(TOOL_CALL_ID);
      expect(fixture.state.calls.every((call) => call.options.envKeys.length === 0)).toBe(true);
      expect(fixture.state.fetchCalls).toBe(0);
    } finally {
      await cleanup(root, fixture);
    }
  }, 15_000);
});
