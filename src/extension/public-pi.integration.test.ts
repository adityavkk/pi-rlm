import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  type AgentSessionEvent,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  createPublicRuntimeFixture,
  PUBLIC_FIXTURE_COMMAND,
} from "./testing/public-runtime.ts";

const ui = {
  setStatus() {},
  notify() {},
  confirm: async () => true,
} as unknown as ExtensionUIContext;

type BoundMode = "tui" | "rpc" | "json" | "print";
interface ObservedMessageEvent {
  readonly type: "message_start" | "message_end";
  readonly message: {
    readonly role: string;
    readonly customType?: string;
    readonly content?: unknown;
  };
}
const observedMessage = (event: AgentSessionEvent): ObservedMessageEvent | undefined =>
  event.type === "message_start" || event.type === "message_end"
    ? event as unknown as ObservedMessageEvent
    : undefined;
const isRlmMessageEvent = (
  event: AgentSessionEvent,
  type: "message_start" | "message_end",
): boolean => {
  const observed = observedMessage(event);
  return observed?.type === type
    && observed.message.role === "custom"
    && observed.message.customType === "pi-rlm-result";
};
const messageContent = (event: AgentSessionEvent): unknown => observedMessage(event)?.message.content;

const isolatedEnv = (root: string): Record<string, string> => ({
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  PATH: process.env["PATH"] ?? "",
  NO_COLOR: "1",
});

const fixturePath = join(import.meta.dir, "testing", "public-mode-fixture.ts");
const ADAPTER_TEST_TIMEOUT_MS = 15_000;
const LIFECYCLE_TIMEOUT_MS = 5_000;

const bounded = async <T>(work: Promise<T>, label: string): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${LIFECYCLE_TIMEOUT_MS}ms`)),
          LIFECYCLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const runPrintFixture = async (mode: "text" | "json") => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-${mode}-mode-`));
  const statePath = join(root, "entries.json");
  try {
    const process = Bun.spawn(["bun", fixturePath, mode, root, statePath], {
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

/** Public AgentSession/ExtensionRunner acceptance. No hand-built ExtensionContext. */
describe("public Pi SDK extension integration", () => {
  test.each(["tui", "rpc", "json", "print"] as const)(
    "%s emits one observable custom result lifecycle and one session entry",
    async (mode: BoundMode) => {
      const root = await mkdtemp(join(tmpdir(), `pi-rlm-public-${mode}-`));
      const { runtime, sessionManager, captured } = await bounded(
        createPublicRuntimeFixture(root), `${mode} fixture creation`);
      const events: AgentSessionEvent[] = [];
      let resolveEnd!: () => void;
      const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
      const unsubscribe = runtime.session.subscribe((event) => {
        events.push(event);
        if (isRlmMessageEvent(event, "message_end")) resolveEnd();
      });
      try {
        await bounded(runtime.session.bindExtensions({ mode, uiContext: ui }), `${mode} extension binding`);
        await bounded(runtime.session.prompt(PUBLIC_FIXTURE_COMMAND, {
          source: mode === "rpc" ? "rpc" : "interactive",
        }), `${mode} command prompt`);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ended,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("custom message_end timeout")), 1_000);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }

        expect(captured).toHaveLength(1);
        expect(captured[0]?.sources).toEqual({ context: "exact public source" });
        const starts = events.filter((event) => isRlmMessageEvent(event, "message_start"));
        const ends = events.filter((event) => isRlmMessageEvent(event, "message_end"));
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(messageContent(starts[0]!)).toBe(messageContent(ends[0]!));
        expect(messageContent(starts[0]!)).toContain("OFFLINE_FIXTURE");
        const entries = sessionManager.getEntries().filter((entry) =>
          entry.type === "custom_message" && entry.customType === "pi-rlm-result");
        expect(entries).toHaveLength(1);
        expect(messageContent(starts[0]!)).toBe(entries[0]?.type === "custom_message" && entries[0].content);
      } finally {
        unsubscribe();
        // This is a headless binding test, not an AgentSessionRuntime ownership
        // test. Dispose its bound public session directly in every synthetic mode.
        runtime.session.dispose();
        await bounded(rm(root, { recursive: true, force: true }), `${mode} fixture cleanup`);
      }
    },
    ADAPTER_TEST_TIMEOUT_MS,
  );

  test.each(["text", "json"] as const)("actual runPrintMode %s adapter output is captured", async (mode) => {
    const result = await runPrintFixture(mode);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const entries = result.entries.filter((entry) =>
      entry["type"] === "custom_message" && entry["customType"] === "pi-rlm-result");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["content"]).toContain("OFFLINE_FIXTURE");
    if (mode === "text") {
      // Pi's text adapter prints only a final assistant message, not custom command messages.
      expect(result.stdout).toBe("");
    } else {
      const output = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentSessionEvent);
      const starts = output.filter((event) => isRlmMessageEvent(event, "message_start"));
      const ends = output.filter((event) => isRlmMessageEvent(event, "message_end"));
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(messageContent(starts[0]!)).toBe(messageContent(ends[0]!));
    }
  }, ADAPTER_TEST_TIMEOUT_MS);

  test("actual runRpcMode uses public JSON stdin/stdout and shuts down on stdin end", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-rpc-mode-"));
    const process = Bun.spawn(["bun", fixturePath, "rpc", root], {
      cwd: root,
      env: isolatedEnv(root),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const events: Array<Record<string, any>> = [];
    const stderr = new Response(process.stderr).text();
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let requestedEntries = false;
    let receivedEntries = false;
    const send = async (value: unknown): Promise<void> => {
      process.stdin.write(`${JSON.stringify(value)}\n`);
      await process.stdin.flush();
    };
    await send({ id: "prompt", type: "prompt", message: PUBLIC_FIXTURE_COMMAND });
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
          events.push(event);
          if (!requestedEntries && event["type"] === "message_end"
            && event["message"]?.role === "custom"
            && event["message"]?.customType === "pi-rlm-result") {
            requestedEntries = true;
            await send({ id: "entries", type: "get_entries" });
          }
          if (event["type"] === "response" && event["id"] === "entries") {
            receivedEntries = true;
            process.stdin.end();
          }
        }
      }
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutFailure = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          process.kill();
          reject(new Error("runRpcMode shutdown timeout"));
        }, 3_000);
      });
      await Promise.race([Promise.all([readOutput(), process.exited]), timeoutFailure]);
      expect(await stderr).toBe("");
      expect(process.exitCode).toBe(0);
      expect(requestedEntries).toBe(true);
      expect(receivedEntries).toBe(true);
      const starts = events.filter((event) => event["type"] === "message_start"
        && event["message"]?.role === "custom" && event["message"]?.customType === "pi-rlm-result");
      const ends = events.filter((event) => event["type"] === "message_end"
        && event["message"]?.role === "custom" && event["message"]?.customType === "pi-rlm-result");
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.["message"]?.content).toBe(ends[0]?.["message"]?.content);
      const response = events.find((event) => event["type"] === "response" && event["id"] === "entries");
      const entries = response?.["data"]?.entries.filter((entry: Record<string, unknown>) =>
        entry["type"] === "custom_message" && entry["customType"] === "pi-rlm-result");
      expect(entries).toHaveLength(1);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (process.exitCode === null) process.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, ADAPTER_TEST_TIMEOUT_MS);
});
