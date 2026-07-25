import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PUBLIC_FIXTURE_COMMAND } from "./testing/public-runtime.ts";

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
const bindingFixturePath = join(import.meta.dir, "testing", "public-binding-fixture.ts");
const ADAPTER_TEST_TIMEOUT_MS = 15_000;
const CHILD_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_RECORDS = 256;
const MAX_RECORD_BYTES = 64 * 1024;

type Child = ReturnType<typeof Bun.spawn>;

const killAndWait = async (child: Child): Promise<void> => {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
};

const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  child: Child,
  label: string,
): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        throw new Error(`${label} exceeded ${MAX_OUTPUT_BYTES} bytes`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
};

const runBoundedChild = async (
  command: string[],
  root: string,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const child = Bun.spawn(command, {
    cwd: root,
    env: isolatedEnv(root),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = readBounded(child.stdout as ReadableStream<Uint8Array>, child, "stdout");
  const stderr = readBounded(child.stderr as ReadableStream<Uint8Array>, child, "stderr");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.all([child.exited, stdout, stderr]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`child exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { exitCode: result[0], stdout: result[1], stderr: result[2] };
  } finally {
    if (timeout) clearTimeout(timeout);
    await killAndWait(child);
    await Promise.allSettled([stdout, stderr]);
  }
};

const readBoundedState = async (path: string): Promise<unknown> => {
  const info = await stat(path);
  if (info.size > MAX_OUTPUT_BYTES) throw new Error(`state exceeded ${MAX_OUTPUT_BYTES} bytes`);
  return JSON.parse(await readFile(path, "utf8"));
};

const runBindingFixture = async (mode: BoundMode) => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-public-${mode}-`));
  const statePath = join(root, "binding-result.json");
  try {
    const process = await runBoundedChild(["bun", bindingFixturePath, mode, root, statePath], root);
    return { ...process, state: await readBoundedState(statePath) as {
      captured: Array<{ sources: unknown }>;
      messages: Array<{ type: string; content: unknown }>;
      entries: Array<Record<string, unknown>>;
    } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runPrintFixture = async (mode: "text" | "json") => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-${mode}-mode-`));
  const statePath = join(root, "entries.json");
  try {
    const process = await runBoundedChild(["bun", fixturePath, mode, root, statePath], root);
    const entries = await readBoundedState(statePath) as Array<Record<string, unknown>>;
    return { ...process, entries };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Public AgentSession/ExtensionRunner acceptance. No hand-built ExtensionContext. */
describe("public Pi SDK extension integration", () => {
  test.each(["tui", "rpc", "json", "print"] as const)(
    "%s emits one observable custom result lifecycle and one session entry",
    async (mode: BoundMode) => {
      const result = await runBindingFixture(mode);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.state.captured).toHaveLength(1);
      expect(result.state.captured[0]?.sources).toEqual({ context: "exact public source" });
      const starts = result.state.messages.filter((event) => event.type === "message_start");
      const ends = result.state.messages.filter((event) => event.type === "message_end");
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.content).toBe(ends[0]?.content);
      expect(String(starts[0]?.content)).toContain("OFFLINE_FIXTURE");
      expect(result.state.entries).toHaveLength(1);
      expect(starts[0]?.content).toBe(result.state.entries[0]?.["content"]);
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

  test("bounded adapter child kills and reaps timeout and overflow failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-bounded-child-"));
    try {
      await expect(runBoundedChild([
        "bun", "--eval", "setInterval(() => {}, 1000)",
      ], root, 100)).rejects.toThrow("child exceeded 100ms");
      await expect(runBoundedChild([
        "bun", "--eval", `process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES + 1}))`,
      ], root)).rejects.toThrow(`stdout exceeded ${MAX_OUTPUT_BYTES} bytes`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, ADAPTER_TEST_TIMEOUT_MS);

  test("actual runRpcMode uses public JSON stdin/stdout and shuts down on stdin end", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-rpc-mode-"));
    let process: Child | undefined;
    let readOutputWork: Promise<void> | undefined;
    let stderrWork: Promise<string> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      process = Bun.spawn(["bun", fixturePath, "rpc", root], {
        cwd: root,
        env: isolatedEnv(root),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const child = process;
      const events: Array<Record<string, any>> = [];
      stderrWork = readBounded(child.stderr as ReadableStream<Uint8Array>, child, "RPC stderr");
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const stdin = child.stdin as unknown as {
        write(value: string): number | void;
        flush(): number | Promise<number>;
        end(): void;
      };
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "";
      let totalBytes = 0;
      let requestedEntries = false;
      let receivedEntries = false;
      const send = async (value: unknown): Promise<void> => {
        stdin.write(`${JSON.stringify(value)}\n`);
        await stdin.flush();
      };
      const readOutput = async (): Promise<void> => {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            totalBytes += chunk.value.byteLength;
            if (totalBytes > MAX_OUTPUT_BYTES)
              throw new Error(`RPC output exceeded ${MAX_OUTPUT_BYTES} bytes`);
            pending += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (!line) continue;
              if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES)
                throw new Error(`RPC record exceeded ${MAX_RECORD_BYTES} bytes`);
              const event = JSON.parse(line) as Record<string, any>;
              events.push(event);
              if (events.length > MAX_OUTPUT_RECORDS)
                throw new Error(`RPC exceeded ${MAX_OUTPUT_RECORDS} records`);
              if (!requestedEntries && event["type"] === "message_end"
                && event["message"]?.role === "custom"
                && event["message"]?.customType === "pi-rlm-result") {
                requestedEntries = true;
                await send({ id: "entries", type: "get_entries" });
              }
              if (event["type"] === "response" && event["id"] === "entries") {
                receivedEntries = true;
                stdin.end();
              }
            }
          }
          pending += decoder.decode();
          if (pending.length !== 0) throw new Error("RPC output ended with an incomplete record");
        } finally {
          reader.releaseLock();
        }
      };
      await send({ id: "prompt", type: "prompt", message: PUBLIC_FIXTURE_COMMAND });
      readOutputWork = readOutput();
      const timeoutFailure = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("runRpcMode shutdown timeout"));
        }, 5_000);
      });
      await Promise.race([Promise.all([readOutputWork, child.exited]), timeoutFailure]);
      expect(await stderrWork).toBe("");
      expect(child.exitCode).toBe(0);
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
      if (process) await killAndWait(process);
      await Promise.allSettled([
        ...(readOutputWork ? [readOutputWork] : []),
        ...(stderrWork ? [stderrWork] : []),
        ...(process ? [process.exited] : []),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  }, ADAPTER_TEST_TIMEOUT_MS);
});
