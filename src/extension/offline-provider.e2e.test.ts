import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type {
  AgentSessionEvent,
  ExtensionUIContext,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { PROVIDER_REQUEST_IDENTITY_VERSION, type RlmEvent } from "../core/journal.ts";
import { buildBasePrompt } from "../runtime/controller-prompt.ts";
import {
  createOfflineProviderRuntimeFixture,
  OFFLINE_ANSWER,
  OFFLINE_COMMAND,
  OFFLINE_CONTROLLER_MODEL,
  OFFLINE_PROVIDER_ID,
  type OfflineProviderMode,
} from "./testing/offline-provider-runtime.ts";

// Compile-time public-API guard: fixture registration uses the pinned exported method.
type PublicProviderRegistration = ModelRuntime["registerProvider"];
const publicProviderRegistration: PublicProviderRegistration | undefined = undefined;
void publicProviderRegistration;

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

const isolatedEnv = (root: string): Record<string, string> => ({
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  PATH: process.env["PATH"] ?? "",
  NO_COLOR: "1",
  PI_OFFLINE: "1",
});

const fixturePath = join(import.meta.dir, "testing", "public-mode-fixture.ts");

const runCommand = async (mode: OfflineProviderMode) => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-offline-${mode}-`));
  const fixture = await createOfflineProviderRuntimeFixture(root, mode);
  const observed: AgentSessionEvent[] = [];
  const unsubscribe = fixture.runtime.session.subscribe((event) => observed.push(event));
  await fixture.runtime.session.bindExtensions({ mode: "print", uiContext: ui });
  return { root, fixture, observed, unsubscribe };
};

/** Real extension -> PiModelClient -> ModelRuntime -> controller -> QuickJS -> journal -> session. */
describe("credential-free offline Pi provider E2E", () => {
  test("success commits one exact controller request and bounded completed session result", async () => {
    const { root, fixture, observed, unsubscribe } = await runCommand("success");
    try {
      await withTimeout(fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }), "success prompt");
      expect(fixture.state.fetchCalls).toBe(0);
      expect(fixture.state.calls).toHaveLength(1);
      const call = fixture.state.calls[0]!;
      expect(`${call.model.provider}/${call.model.id}`).toBe(OFFLINE_CONTROLLER_MODEL);
      expect(call.model.provider).toBe(OFFLINE_PROVIDER_ID);
      expect(call.options).toEqual({ maxRetries: 0, maxTokens: 512, hasSignal: true, envKeys: [] });
      expect(call.signal?.aborted).toBe(false);
      expect(call.context.systemPrompt).toBe(buildBasePrompt());
      expect(call.context.messages).toHaveLength(1);
      const controllerPrompt = call.context.messages[0];
      expect(controllerPrompt?.role).toBe("user");
      expect(controllerPrompt?.content).toEqual(expect.stringContaining("Offline provider E2E"));
      expect(controllerPrompt?.content).toEqual(expect.stringContaining("context (20 bytes, ~5 tokens, sha b9fa0ae0)"));

      const events = await fixture.readEvents();
      const attempts = events.filter((event) => event.type === "provider_attempted");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        type: "provider_attempted",
        kind: "controller",
        key: "1",
        attempt: 1,
        outcome: "ok",
        requestIdentityVersion: PROVIDER_REQUEST_IDENTITY_VERSION,
        usage: { attempts: 1, inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      });
      expect(attempts[0]?.type === "provider_attempted" && attempts[0].requestSha256)
        .toMatch(/^[a-f0-9]{64}$/);
      expect(events.filter((event) => event.type === "cell_committed")).toHaveLength(1);
      const answer = events.filter((event) => event.type === "answer_committed");
      expect(answer).toHaveLength(1);
      expect(answer[0]).toMatchObject({ completionMode: "answer" });
      const terminals = terminalEvents(events);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        type: "run_completed",
        completionMode: "answer",
        outputRef: answer[0]?.type === "answer_committed" ? answer[0].outputRef : undefined,
      });

      const messages = observed.map(customMessage).filter((value): value is CustomMessage => value !== undefined);
      expect(messages).toHaveLength(1);
      expect(Buffer.byteLength(messages[0]!.content, "utf8")).toBeLessThan(64 * 1024);
      const projection = JSON.parse(messages[0]!.content) as Record<string, any>;
      expect(projection).toMatchObject({
        status: "completed",
        mode: "answer",
        answer: { answer: OFFLINE_ANSWER },
        output: { ref: terminals[0]?.type === "run_completed" ? terminals[0].outputRef : undefined },
        usage: {
          controllerTurns: 1,
          logicalCalls: 1,
          attempts: 1,
          inputTokensUsed: 11,
          outputTokensUsed: 7,
          tokensUsed: 18,
          activeLeafCalls: 0,
          tokensReserved: 0,
        },
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

  test("typed provider error commits one failed attempt, one terminal, and failed session result", async () => {
    const { root, fixture, observed, unsubscribe } = await runCommand("error");
    try {
      await withTimeout(fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }), "failure prompt");
      expect(fixture.state.fetchCalls).toBe(0);
      expect(fixture.state.calls).toHaveLength(1);
      expect(fixture.state.calls[0]?.options.maxRetries).toBe(0);
      const events = await fixture.readEvents();
      const attempts = events.filter((event) => event.type === "provider_attempted");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        type: "provider_attempted",
        kind: "controller",
        outcome: "error",
        usage: { attempts: 1, inputTokens: 11, outputTokens: 0, totalTokens: 11 },
      });
      expect(attempts[0]?.type === "provider_attempted" && attempts[0].errorCode).toBeTruthy();
      const terminals = terminalEvents(events);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.type).toBe("run_failed");
      expect(events.filter((event) => event.type === "run_cancelled" || event.type === "run_completed")).toHaveLength(0);

      const messages = observed.map(customMessage).filter((value): value is CustomMessage => value !== undefined);
      expect(messages).toHaveLength(1);
      const projection = JSON.parse(messages[0]!.content) as Record<string, any>;
      expect(projection["status"]).toBe("failed");
      expect(projection["errorCode"]).toBe(terminals[0]?.type === "run_failed" ? terminals[0].code : undefined);
      expect(projection["usage"]).toMatchObject({
        controllerTurns: 1,
        logicalCalls: 1,
        attempts: 1,
        tokensUsed: 11,
        activeLeafCalls: 0,
        tokensReserved: 0,
      });
    } finally {
      unsubscribe();
      await fixture.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("public session replacement aborts pending provider and rejects late runtime mutation", async () => {
    const { root, fixture, observed, unsubscribe } = await runCommand("pending");
    try {
      const prompt = fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" });
      await withTimeout(fixture.state.started, "provider start");
      expect(fixture.state.calls).toHaveLength(1);
      await withTimeout(fixture.runtime.newSession(), "session replacement");
      await withTimeout(prompt, "cancelled prompt");
      expect(fixture.state.aborts).toBe(1);
      expect(fixture.state.calls[0]?.signal?.aborted).toBe(true);
      const events = await fixture.readEvents();
      const attempts = events.filter((event) => event.type === "provider_attempted");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        type: "provider_attempted",
        kind: "controller",
        outcome: "cancelled",
        usage: { attempts: 1 },
      });
      expect(terminalEvents(events)).toEqual([
        expect.objectContaining({ type: "run_cancelled", code: "CANCELLED" }),
      ]);
      expect(events.filter((event) => event.type === "cell_committed" || event.type === "answer_committed")).toHaveLength(0);
      expect(observed.map(customMessage).filter(Boolean)).toHaveLength(0);

      const before = JSON.stringify(events);
      const usageBefore = JSON.stringify(attempts[0]?.type === "provider_attempted" && attempts[0].usage);
      fixture.state.emitLate();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fixture.state.lateEmissionAttempts).toBe(1);
      expect(JSON.stringify(await fixture.readEvents())).toBe(before);
      expect(JSON.stringify(attempts[0]?.type === "provider_attempted" && attempts[0].usage)).toBe(usageBefore);
      expect(fixture.state.calls).toHaveLength(1);
      expect(fixture.state.fetchCalls).toBe(0);
    } finally {
      unsubscribe();
      await fixture.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

const runPrintAdapter = async (adapter: "text" | "json", outcome: "success" | "error") => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-native-${adapter}-${outcome}-`));
  const statePath = join(root, "entries.json");
  try {
    const process = Bun.spawn(["bun", fixturePath, adapter, root, statePath, outcome], {
      cwd: root,
      env: isolatedEnv(root),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const entries = JSON.parse(await readFile(statePath, "utf8")) as Array<Record<string, unknown>>;
    return { stdout, stderr, exitCode, entries };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("offline provider through public Pi adapters", () => {
  test.each([
    ["text", "success"], ["text", "error"], ["json", "success"], ["json", "error"],
  ] as const)("runPrintMode %s exposes durable %s outcome", async (adapter, outcome) => {
    const result = await runPrintAdapter(adapter, outcome);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const entries = result.entries.filter((entry) =>
      entry["type"] === "custom_message" && entry["customType"] === "pi-rlm-result");
    expect(entries).toHaveLength(1);
    const projection = JSON.parse(String(entries[0]?.["content"])) as Record<string, unknown>;
    expect(projection["status"]).toBe(outcome === "success" ? "completed" : "failed");
    if (adapter === "text") expect(result.stdout).toBe("");
    else {
      const events = result.stdout.trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.filter((event) => event["type"] === "message_end"
        && event["message"]?.customType === "pi-rlm-result")).toHaveLength(1);
    }
  });

  test.each(["success", "error"] as const)("runRpcMode exposes %s outcome and durable entry", async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), `pi-rlm-native-rpc-${outcome}-`));
    const process = Bun.spawn(["bun", fixturePath, "rpc", root, join(root, "unused"), outcome], {
      cwd: root,
      env: isolatedEnv(root),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output: Array<Record<string, any>> = [];
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let requestedEntries = false;
    const send = async (value: unknown): Promise<void> => {
      process.stdin.write(`${JSON.stringify(value)}\n`);
      await process.stdin.flush();
    };
    await send({ id: "prompt", type: "prompt", message: OFFLINE_COMMAND });
    const readOutput = async (): Promise<void> => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as Record<string, any>;
          output.push(event);
          if (!requestedEntries && event["type"] === "message_end"
            && event["message"]?.customType === "pi-rlm-result") {
            requestedEntries = true;
            await send({ id: "entries", type: "get_entries" });
          } else if (event["type"] === "response" && event["id"] === "entries") {
            process.stdin.end();
          }
        }
      }
    };
    try {
      await withTimeout(Promise.all([readOutput(), process.exited]), "RPC adapter", 10_000);
      expect(await new Response(process.stderr).text()).toBe("");
      expect(process.exitCode).toBe(0);
      const message = output.find((event) => event["type"] === "message_end"
        && event["message"]?.customType === "pi-rlm-result");
      const projection = JSON.parse(message?.["message"]?.content ?? "null") as Record<string, unknown>;
      expect(projection["status"]).toBe(outcome === "success" ? "completed" : "failed");
      const response = output.find((event) => event["type"] === "response" && event["id"] === "entries");
      expect(response?.["data"]?.entries.filter((entry: Record<string, unknown>) =>
        entry["type"] === "custom_message" && entry["customType"] === "pi-rlm-result")).toHaveLength(1);
    } finally {
      if (process.exitCode === null) process.kill();
      await rm(root, { recursive: true, force: true });
    }
  });
});
