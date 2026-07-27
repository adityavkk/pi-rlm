import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent, ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
} from "pi-subagents/delegation";
import {
  ACTIVE_SUBAGENTS_MODEL,
  ACTIVE_SUBAGENTS_STRUCTURED,
  ACTIVE_SUBAGENTS_TEXT,
} from "./testing/active-subagents-provider.ts";
import {
  createOfflineProviderRuntimeFixture,
  OFFLINE_COMMAND,
  type OfflineProviderRuntimeFixture,
} from "./testing/offline-provider-runtime.ts";

const require = createRequire(import.meta.url);
const subagentsEntry = require.resolve("pi-subagents");
const subagentsEntryUrl = pathToFileURL(subagentsEntry).href;
const subagentsPackagePath = join(subagentsEntry, "..", "package.json");
const loadSubagentsFactory = async (): Promise<(pi: ExtensionAPI) => void> => {
  const dynamicImport = new Function("specifier", "return import(specifier)") as
    (specifier: string) => Promise<{ default?: unknown }>;
  const loaded = await dynamicImport(subagentsEntryUrl);
  if (typeof loaded.default !== "function") throw new Error("pi-subagents public extension factory is unavailable");
  return loaded.default as (pi: ExtensionAPI) => void;
};

const providerPath = join(import.meta.dir, "testing", "active-subagents-provider.ts");
const piBinary = process.env["PI_RLM_TEST_PI_BIN"]
  ?? join(import.meta.dir, "..", "..", "node_modules", ".bin", "pi");
const TIMEOUT_MS = 30_000;

const ui = {
  setStatus() {},
  setToolsExpanded() {},
  setWidget() {},
  notify() {},
  confirm: async () => true,
} as unknown as ExtensionUIContext;

interface ProtocolRecord {
  readonly channel: string;
  readonly data: Record<string, unknown>;
}

const withTimeout = async <T>(work: Promise<T>, label: string, ms = 8_000): Promise<T> => {
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

const controllerCode = (structured: boolean): string => `
  const delegated = await agent({
    key: ${JSON.stringify(structured ? "active-structured" : "active-text")},
    agent: 'reviewer',
    task: 'Run the active package fixture and return its deterministic result.',
    context: input,
    model: { tier: 'small' },
    ${structured ? "schema: { type: 'object', required: ['verdict', 'count'], properties: { verdict: { type: 'string' }, count: { type: 'number' } }, additionalProperties: false }," : ""}
  });
  answer({ answer: delegated.ok ? ${structured ? "JSON.stringify(delegated.value)" : "delegated.value"} : delegated.error.code });`;

const installChildHelper = async (root: string): Promise<string> => {
  const path = join(root, "pi-active-subagents-child.mjs");
  await writeFile(path, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const source = process.env;
appendFileSync(source.PI_RLM_ACTIVE_SUBAGENTS_OBSERVATIONS, JSON.stringify({ event: "helper-started", pid: process.pid }) + "\\n", { mode: 0o600 });
writeFileSync(source.PI_RLM_ACTIVE_SUBAGENTS_OBSERVATIONS + ".args", process.argv.slice(2).join("\\n") + "\\n", { mode: 0o600 });
const fixed = new Set([
  "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "npm_config_cache", "BUN_INSTALL_CACHE_DIR", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "PATH", "TMPDIR",
  "PI_CODING_AGENT_PACKAGE_ROOT", "PI_RLM_ACTIVE_SUBAGENTS_OBSERVATIONS",
  "PI_RLM_ACTIVE_SUBAGENTS_PENDING", "NO_COLOR", "TERM",
]);
const env = {};
for (const [key, value] of Object.entries(source)) {
  if (value !== undefined && (fixed.has(key) || key.startsWith("PI_SUBAGENT_"))) env[key] = value;
}
const child = Bun.spawn([source.PI_RLM_ACTIVE_PI_BIN, ...process.argv.slice(2), "-e", source.PI_RLM_ACTIVE_PROVIDER_EXTENSION], {
  env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
};

const readObservations = async (path: string): Promise<Array<Record<string, unknown>>> => {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
};

const setFixtureEnvironment = (root: string, helper: string, observations: string, pending: boolean): (() => void) => {
  const keys = [
    "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR",
    "npm_config_cache", "BUN_INSTALL_CACHE_DIR", "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    "PI_SUBAGENT_CHILD", "PI_SUBAGENT_PI_BINARY", "PI_RLM_ACTIVE_PI_BIN", "PI_RLM_ACTIVE_PROVIDER_EXTENSION",
    "PI_RLM_ACTIVE_SUBAGENTS_OBSERVATIONS", "PI_RLM_ACTIVE_SUBAGENTS_PENDING",
  ] as const;
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"),
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-transpiler-cache"),
    PI_SUBAGENT_PI_BINARY: helper,
    PI_RLM_ACTIVE_PI_BIN: piBinary,
    PI_RLM_ACTIVE_PROVIDER_EXTENSION: providerPath,
    PI_RLM_ACTIVE_SUBAGENTS_OBSERVATIONS: observations,
  });
  // The test runner itself may be a pi-subagents child. The fixture is a new,
  // isolated public parent session and must not inherit that recursion marker.
  delete process.env["PI_SUBAGENT_CHILD"];
  if (pending) process.env["PI_RLM_ACTIVE_SUBAGENTS_PENDING"] = "1";
  else delete process.env["PI_RLM_ACTIVE_SUBAGENTS_PENDING"];
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
};

const createActiveFixture = async (root: string, structured: boolean, pending = false, toolLaunch = false) => {
  const observations = join(root, "child-observations.jsonl");
  for (const name of ["home", "config", "cache", "data", "state", "tmp", "npm-cache", "bun-cache", "bun-transpiler-cache"])
    await mkdir(join(root, name), { recursive: true });
  const helper = await installChildHelper(root);
  const restoreEnvironment = setFixtureEnvironment(root, helper, observations, pending);
  const protocol: ProtocolRecord[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let fixture: OfflineProviderRuntimeFixture | undefined;
  try {
    const registerSubagentExtension = await loadSubagentsFactory();
    fixture = await createOfflineProviderRuntimeFixture(root, "success", {
      controllerCode: controllerCode(structured),
      ...(toolLaunch ? { hostScript: [
        { type: "toolCall" as const, id: "active-subagents-tool", name: "rlm_run", arguments: {
          objective: "Active package tool fixture", context: "exact active package source",
        } },
        { type: "stop" as const, text: "active package tool complete" },
      ] } : {}),
      agentPolicy: { allowedAgents: ["reviewer"] },
      profileOverrides: {
        maxLogicalCalls: 2,
        maxAttempts: 2,
        wallMs: 25_000,
        cellWallMs: 20_000,
        models: {
          small: ACTIVE_SUBAGENTS_MODEL,
          medium: "pi-rlm-offline/controller",
          large: "pi-rlm-offline/controller",
        },
      },
      extensionSetup(pi: ExtensionAPI) {
        registerSubagentExtension(pi);
        for (const channel of [
          SUBAGENT_DELEGATION_REQUEST_EVENT,
          SUBAGENT_DELEGATION_STARTED_EVENT,
          SUBAGENT_DELEGATION_RESPONSE_EVENT,
          SUBAGENT_DELEGATION_CANCEL_EVENT,
        ]) {
          pi.events.on(channel, (data) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return;
            protocol.push({ channel, data: structuredClone(data as Record<string, unknown>) });
            if (channel === SUBAGENT_DELEGATION_STARTED_EVENT) resolveStarted();
          });
        }
      },
    });
    return { fixture, observations, protocol, started, restoreEnvironment };
  } catch (error) {
    restoreEnvironment();
    await fixture?.dispose();
    throw error;
  }
};

const resultContents = (events: readonly AgentSessionEvent[]): string[] => events.flatMap((event) => {
  if (event.type !== "message_end") return [];
  const message = event.message as unknown as { customType?: unknown; content?: unknown };
  return message.customType === "pi-rlm-result" && typeof message.content === "string" ? [message.content] : [];
});

const exactIdentity = (data: Record<string, unknown>) => ({
  version: data["version"],
  requestId: data["requestId"],
  ownerRunId: data["ownerRunId"],
  nodeId: data["nodeId"],
});

const expectExactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
};
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};
const waitForProcessExit = async (pid: number, label: string, ms = 8_000): Promise<void> => withTimeout((async () => {
  while (processAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 10));
})(), label, ms);
const terminateObservedProcesses = async (observations: string): Promise<void> => {
  const records = await readObservations(observations);
  const pids = [...new Set(records.map((entry) => entry["pid"]).filter((value): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value !== process.pid))];
  for (const pid of pids) if (processAlive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (const pid of pids) {
    if (!processAlive(pid)) continue;
    try { await waitForProcessExit(pid, "fixture process TERM", 1_000); }
    catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  for (const pid of pids) if (processAlive(pid)) await waitForProcessExit(pid, "fixture process KILL", 2_000);
};

/** Real pi-subagents package bridge, real child Pi CLI, public offline provider. */
describe("active pi-subagents public delegation fixture", () => {
  test.each([["text", false], ["structured", true]] as const)(
    "loads pi-subagents@0.36.0 and projects a %s child result",
    async (_label, structured) => {
      const root = await mkdtemp(join(tmpdir(), "pi-rlm-active-subagents-"));
      let active: Awaited<ReturnType<typeof createActiveFixture>> | undefined;
      const events: AgentSessionEvent[] = [];
      let unsubscribe: (() => void) | undefined;
      try {
        const packageJson = JSON.parse(await readFile(subagentsPackagePath, "utf8")) as { version: string };
        expect(packageJson.version).toBe("0.36.0");
        active = await createActiveFixture(root, structured);
        unsubscribe = active.fixture.runtime.session.subscribe((event) => events.push(event));
        await active.fixture.runtime.session.bindExtensions({ mode: "print", uiContext: ui });
        await withTimeout(active.fixture.runtime.session.prompt(OFFLINE_COMMAND, { source: "interactive" }), "active delegation", 25_000);

        expect(active.fixture.state.fetchCalls).toBe(0);
        expect(active.protocol.map((entry) => entry.channel)).toEqual([
          SUBAGENT_DELEGATION_STARTED_EVENT, SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT,
        ]);
        const request = active.protocol[1]!;
        const started = active.protocol[0]!;
        const response = active.protocol[2]!;
        expectExactKeys(request.data, [
          "version", "requestId", "ownerRunId", "nodeId", "agent", "task", "context", "cwd", "model",
          "timeoutMs", "turnBudget", "toolBudget", "artifacts", "result",
        ]);
        expect(request.data).toEqual({
          ...exactIdentity(request.data),
          agent: "reviewer",
          task: request.data["task"],
          context: "fresh",
          cwd: root,
          model: ACTIVE_SUBAGENTS_MODEL,
          timeoutMs: request.data["timeoutMs"],
          turnBudget: { maxTurns: 40, graceTurns: 4 },
          toolBudget: { soft: 80, hard: 100 },
          artifacts: true,
          result: structured ? {
            kind: "structured",
            schema: { type: "object", required: ["verdict", "count"], properties: {
              verdict: { type: "string" }, count: { type: "number" },
            }, additionalProperties: false },
          } : { kind: "text" },
        });
        expect(request.data["task"]).toBeString();
        expect(request.data["task"] as string).toContain("active package fixture");
        expect(request.data["task"] as string).toContain('"version":"pi-rlm.agent-context.v1"');
        expect(request.data["timeoutMs"]).toBeNumber();
        expectExactKeys(started.data, ["version", "requestId", "ownerRunId", "nodeId"]);
        expect(started.data).toEqual(exactIdentity(request.data));
        expectExactKeys(response.data, [
          "version", "requestId", "ownerRunId", "nodeId", "status", "result", "runId", "agent", "model",
          "thinking", "exitCode", "usage",
        ]);
        expect(exactIdentity(response.data)).toEqual(exactIdentity(request.data));
        const responseThinking = response.data["thinking"];
        const responseRunId = response.data["runId"];
        const responseUsage = response.data["usage"] as Record<string, unknown>;
        expect(typeof responseThinking).toBe("string");
        expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(responseThinking as string);
        expect(responseRunId).toBeString();
        expect(responseRunId as string).toMatch(/^[a-f0-9]{8}$/);
        expect(responseUsage["durationMs"]).toBeNumber();
        expect(response.data).toEqual({
          ...exactIdentity(request.data), status: "completed",
          result: structured ? { kind: "structured", value: ACTIVE_SUBAGENTS_STRUCTURED }
            : { kind: "text", text: ACTIVE_SUBAGENTS_TEXT },
          runId: responseRunId, agent: "reviewer", model: `${ACTIVE_SUBAGENTS_MODEL}:${responseThinking}`,
          thinking: responseThinking, exitCode: 0,
          usage: {
            input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1,
            toolCalls: structured ? 1 : 0, durationMs: responseUsage["durationMs"],
          },
        });
        const projected = JSON.parse(resultContents(events)[0]!) as { answer: { answer: unknown } };
        expect(structured ? JSON.parse(projected.answer.answer as string) : projected.answer.answer)
          .toEqual(structured ? ACTIVE_SUBAGENTS_STRUCTURED : ACTIVE_SUBAGENTS_TEXT);
        expect(await readObservations(active.observations)).toEqual([
          expect.objectContaining({ event: "helper-started", pid: expect.any(Number) }),
          expect.objectContaining({
            event: "started",
            model: ACTIVE_SUBAGENTS_MODEL,
            structured,
            envKeys: [],
            providerCredentialEnvKeys: [],
            parentCapabilityPresent: true,
            tmpdir: join(root, "tmp"),
            taskSeen: true,
          }),
        ]);
      } finally {
        unsubscribe?.();
        await active?.fixture.dispose();
        if (active) await terminateObservedProcesses(active.observations);
        active?.restoreEnvironment();
        await rm(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test.each(["abort", "session-switch"] as const)("public AgentSession %s cancels the exact active child attempt", async (action) => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-active-subagents-abort-"));
    let active: Awaited<ReturnType<typeof createActiveFixture>> | undefined;
    const events: AgentSessionEvent[] = [];
    let unsubscribe: (() => void) | undefined;
    try {
      active = await createActiveFixture(root, false, true, true);
      unsubscribe = active.fixture.runtime.session.subscribe((event) => events.push(event));
      await active.fixture.runtime.session.bindExtensions({ mode: "tui", uiContext: ui });
      const pending = active.fixture.runtime.session.prompt("Run the active package tool fixture.", { source: "interactive" });
      await withTimeout(active.started, "active bridge start");
      await withTimeout((async () => {
        while (!(await readObservations(active!.observations)).some((entry) => entry["event"] === "started"))
          await new Promise((resolve) => setTimeout(resolve, 10));
      })(), "active child provider start");
      if (action === "abort") active.fixture.runtime.session.abort();
      else await withTimeout(active.fixture.runtime.newSession(), "active session replacement");
      await withTimeout(pending, `active delegation ${action}`);

      const request = active.protocol[1]!;
      const cancellation = active.protocol[2]!;
      expectExactKeys(cancellation.data, ["version", "requestId", "ownerRunId", "nodeId"]);
      expect(cancellation.data).toEqual(exactIdentity(request.data));
      const observations = await readObservations(active.observations);
      const helperPid = observations.find((entry) => entry["event"] === "helper-started")?.["pid"];
      const childPid = observations.find((entry) => entry["event"] === "started")?.["pid"];
      expect(typeof helperPid).toBe("number");
      expect(typeof childPid).toBe("number");
      await waitForProcessExit(helperPid as number, "active helper reap");
      await waitForProcessExit(childPid as number, "active child reap");
      if (action === "abort") {
        await withTimeout((async () => {
          while (!active!.protocol.some((entry) => entry.channel === SUBAGENT_DELEGATION_RESPONSE_EVENT))
            await new Promise((resolve) => setTimeout(resolve, 10));
        })(), "active cancellation terminal", 5_000);
        expect(active.protocol.map((entry) => entry.channel)).toEqual([
          SUBAGENT_DELEGATION_STARTED_EVENT, SUBAGENT_DELEGATION_REQUEST_EVENT,
          SUBAGENT_DELEGATION_CANCEL_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT,
        ]);
        const terminal = active.protocol[3]!;
        const terminalError = terminal.data["error"];
        expectExactKeys(terminal.data, [
          "version", "requestId", "ownerRunId", "nodeId", "status", "runId", "agent", "model",
          "thinking", "exitCode", "usage", ...(terminalError === undefined ? [] : ["error"]),
        ]);
        if (terminalError !== undefined)
          expect(terminalError).toBe("Subagent produced no output (possible model cold-start or empty response).");
        const terminalThinking = terminal.data["thinking"];
        const terminalRunId = terminal.data["runId"];
        const terminalExitCode = terminal.data["exitCode"];
        const terminalDuration = (terminal.data["usage"] as Record<string, unknown>)["durationMs"];
        expect(typeof terminalThinking).toBe("string");
        expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(terminalThinking as string);
        expect(terminalRunId).toBeString();
        expect(terminalRunId as string).toMatch(/^[a-f0-9]{8}$/);
        expect(terminalExitCode).toBeNumber();
        expect(terminalExitCode as number).toBeGreaterThan(0);
        expect(terminalDuration).toBeNumber();
        expect(terminal.data).toEqual({
          ...exactIdentity(request.data), status: "cancelled",
          ...(terminalError === undefined ? {} : { error: terminalError }),
          runId: terminalRunId, agent: "reviewer", model: `${ACTIVE_SUBAGENTS_MODEL}:${terminalThinking}`,
          thinking: terminalThinking, exitCode: terminalExitCode,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0, durationMs: terminalDuration },
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(active.protocol.map((entry) => entry.channel)).toEqual([
          SUBAGENT_DELEGATION_STARTED_EVENT, SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_CANCEL_EVENT,
        ]);
      }
      expect(resultContents(events)).toEqual([]);
      expect(active.fixture.state.fetchCalls).toBe(0);
    } finally {
      unsubscribe?.();
      await active?.fixture.dispose();
      if (active) await terminateObservedProcesses(active.observations);
      active?.restoreEnvironment();
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
