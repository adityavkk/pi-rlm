import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { canonicalStringify, parseJsonValue } from "../core/index.ts";
import type { RlmEvent } from "../core/journal.ts";
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
  let unsubscribe: (() => void) | undefined;
  try {
    fixture = await withTimeout(
      createOfflineProviderRuntimeFixture(root, mode, { hostScript }),
      "offline AgentSession fixture setup",
    );
    const events: AgentSessionEvent[] = [];
    unsubscribe = fixture.runtime.session.subscribe((event) => events.push(event));
    const confirmations: Confirmation[] = [];
    await withTimeout(
      fixture.runtime.session.bindExtensions({ mode: "tui", uiContext: createUi(confirmations) }),
      "public ExtensionRunner bind",
    );
    return { root, fixture, events, confirmations, unsubscribe };
  } catch (error) {
    unsubscribe?.();
    if (fixture) {
      try { await withTimeout(fixture.dispose(), "failed fixture disposal"); }
      finally { fixture.restoreFetchTripwire(); }
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

const cleanup = async (
  root: string,
  fixture: OfflineProviderRuntimeFixture,
  unsubscribe: () => void,
): Promise<void> => {
  unsubscribe();
  try { await withTimeout(fixture.dispose(), "AgentSession fixture disposal"); }
  finally {
    fixture.restoreFetchTripwire();
    await withTimeout(rm(root, { recursive: true, force: true }), "AgentSession fixture cleanup");
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
  observed: readonly AgentSessionEvent[],
  confirmations: readonly Confirmation[],
): Record<string, any> => {
  const grants = grantEntries(fixture.sessionManager.getEntries());
  expect(grants).toHaveLength(1);
  const data = grants[0]?.["data"] as Record<string, any>;
  expect(observed.filter((event) => event.type === "turn_start").length).toBeGreaterThanOrEqual(1);
  expect(data["turnNonce"]).toMatch(/^0:\d+$/);
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
  expect(confirmations[0]?.message).toContain(`Exact normalized request SHA-256: ${requestSha()}`);
  return data;
};

/** Public AgentSession + ExtensionRunner tool loop. No constructed ExtensionContext or private Pi API. */
describe("public AgentSession rlm_run grant lifecycle", () => {
  test("one exact grant completes once and rejects a repeated host tool-call ID", async () => {
    const { root, fixture, events, confirmations, unsubscribe } = await setup("success", [TOOL_CALL, TOOL_CALL, STOP]);
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
      expect(hostCalls).toHaveLength(3);
      expect(controllerCalls).toHaveLength(1);
      expect(hostCalls[0]?.context.tools?.map((tool) => tool.name)).toEqual(["rlm_run"]);
      expect(hostCalls.every((call) => call.options.hasSignal)).toBe(true);
      expect(controllerCalls[0]?.options).toEqual({ maxRetries: 0, maxTokens: 512, hasSignal: true, envKeys: [] });

      const currentResults = toolResults(fixture.runtime.session.messages);
      const durableResults = durableToolResults(fixture.sessionManager.getEntries());
      expect(currentResults).toHaveLength(2);
      expect(durableResults).toHaveLength(2);
      expect(currentResults.map((result) => result.toolCallId)).toEqual([TOOL_CALL_ID, TOOL_CALL_ID]);
      expect(durableResults.map((result) => result.content)).toEqual(currentResults.map((result) => result.content));
      expect(projection(currentResults[0]!)["status"]).toBe("completed");
      expect(projection(currentResults[1]!)).toMatchObject({
        status: "failed",
        runId: null,
        errorCode: "RLM_GRANT_REPLAY",
        error: { code: "RLM_GRANT_REPLAY" },
        usage: null,
      });

      assertGrant(fixture, events, confirmations);
      const journal = await fixture.readEvents();
      expect(terminalEvents(journal)).toHaveLength(1);
      expect(terminalEvents(journal)[0]?.type).toBe("run_completed");
      expect(await runDirectories(fixture)).toHaveLength(1);
      expect(fixture.state.fetchCalls).toBe(0);
    } finally {
      await cleanup(root, fixture, unsubscribe);
    }
  }, 15_000);

  test("public AgentSession.abort cancels one consumed run and rejects late provider mutation", async () => {
    const { root, fixture, events, confirmations, unsubscribe } = await setup("pending", [TOOL_CALL, STOP]);
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
      expect(hostCalls).toHaveLength(2);
      expect(hostCalls[1]?.context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
      expect(fixture.state.calls.filter((call) => `${call.model.provider}/${call.model.id}` === OFFLINE_CONTROLLER_MODEL))
        .toHaveLength(1);

      assertGrant(fixture, events, confirmations);
      const journal = await fixture.readEvents();
      expect(journal.map((event) => event.type)).toEqual([
        "run_started", "frame_opened", "provider_attempted", "frame_closed", "run_cancelled",
      ]);
      const attempts = journal.filter((event): event is Extract<RlmEvent, { type: "provider_attempted" }> =>
        event.type === "provider_attempted");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ kind: "controller", attempt: 1, outcome: "cancelled", errorCode: "CANCELLED" });
      expect(attempts[0]?.usage.attempts).toBe(1);
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
      const durableResults = durableToolResults(fixture.sessionManager.getEntries());
      expect(currentResults).toHaveLength(1);
      expect(durableResults).toHaveLength(1);
      expect(durableResults[0]?.content).toEqual(currentResults[0]?.content);
      expect(projection(currentResults[0]!)).toMatchObject({
        status: "cancelled",
        errorCode: "CANCELLED",
        error: { code: "CANCELLED", message: "run cancelled by owner" },
      });

      const treeBefore = await snapshotTree(fixture.runRoot);
      const eventsBefore = structuredClone(journal);
      const accountingBefore = structuredClone(attempts[0]?.usage);
      const sessionBefore = JSON.stringify({
        messages: fixture.runtime.session.messages,
        entries: fixture.sessionManager.getEntries(),
      });
      fixture.state.emitLate();
      await withTimeout(new Promise<void>((resolve) => setTimeout(resolve, 25)), "late provider observation");
      expect(fixture.state.lateEmissionAttempts).toBe(1);
      expect(fixture.state.lateEmissionAccepted).toBe(0);
      expect(fixture.state.aborts).toBe(1);
      expect(await snapshotTree(fixture.runRoot)).toEqual(treeBefore);
      expect(await fixture.readEvents()).toEqual(eventsBefore);
      expect(attempts[0]?.usage).toEqual(accountingBefore);
      expect(JSON.stringify({
        messages: fixture.runtime.session.messages,
        entries: fixture.sessionManager.getEntries(),
      })).toBe(sessionBefore);
      expect(fixture.state.calls).toHaveLength(3);
      const emittedToolCalls = fixture.runtime.session.messages.flatMap((message) =>
        message.role === "assistant" ? message.content.filter((content) => content.type === "toolCall") : []);
      expect(emittedToolCalls).toHaveLength(1);
      expect(emittedToolCalls[0]?.id).toBe(TOOL_CALL_ID);
      expect(fixture.state.fetchCalls).toBe(0);
    } finally {
      await cleanup(root, fixture, unsubscribe);
    }
  }, 15_000);
});
