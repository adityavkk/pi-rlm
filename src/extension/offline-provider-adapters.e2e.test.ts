import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { OFFLINE_ANSWER, OFFLINE_COMMAND } from "./testing/offline-provider-runtime.ts";

const MAX_ADAPTER_BYTES = 256 * 1024;
const MAX_RPC_RECORDS = 256;
const MAX_RPC_LINE_BYTES = 64 * 1024;
const ADAPTER_TIMEOUT_MS = 10_000;
const ANSWER_SHA = "a1962b5a13bb394a10d97d3c6acadac0d02bc24ddebe0f80d05a96b9b4dddf90";
const ANSWER_REF = `ctx_${ANSWER_SHA}`;
const fixturePath = join(import.meta.dir, "testing", "public-mode-fixture.ts");

const isolatedEnv = (root: string): Record<string, string> => ({
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  PATH: process.env["PATH"] ?? "",
  NO_COLOR: "1",
  PI_OFFLINE: "1",
});

type Child = ReturnType<typeof Bun.spawn>;

const killAndWait = async (child: Child): Promise<void> => {
  if (child.exitCode === null) child.kill();
  await Promise.race([
    child.exited.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
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
      if (bytes > MAX_ADAPTER_BYTES) {
        child.kill();
        throw new Error(`${label} exceeded ${MAX_ADAPTER_BYTES} bytes`);
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

const waitBounded = async (child: Child, work: Promise<unknown>): Promise<number> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      Promise.all([work, child.exited]).then(([, code]) => code),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`adapter exceeded ${ADAPTER_TIMEOUT_MS}ms`));
        }, ADAPTER_TIMEOUT_MS);
      }),
    ]);
    return exitCode;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const readBoundedJson = async (path: string): Promise<unknown> => {
  const info = await stat(path);
  if (info.size > MAX_ADAPTER_BYTES) throw new Error(`fixture result exceeded ${MAX_ADAPTER_BYTES} bytes`);
  return JSON.parse(await readFile(path, "utf8"));
};

interface FixtureResult {
  readonly schemaVersion: 1;
  readonly entries: Array<Record<string, any>>;
  readonly provider: {
    readonly fetchAttempts: number;
    readonly calls: Array<Record<string, any>>;
  };
}

const assertFixtureResult = (value: unknown): FixtureResult => {
  const result = value as FixtureResult;
  expect(Object.keys(result).sort()).toEqual(["entries", "provider", "schemaVersion"]);
  expect(result.schemaVersion).toBe(1);
  expect(Array.isArray(result.entries)).toBe(true);
  expect(Object.keys(result.provider).sort()).toEqual(["calls", "fetchAttempts"]);
  expect(result.provider.fetchAttempts).toBe(0);
  expect(result.provider.calls).toEqual([{
    model: { provider: "pi-rlm-offline", id: "controller", api: "pi-rlm-offline-api" },
    options: { maxRetries: 0, maxTokens: 512, hasSignal: true, envKeys: [] },
  }]);
  return result;
};

const assertProjection = (value: unknown, outcome: "success" | "error"): void => {
  const projection = value as Record<string, any>;
  expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeLessThan(64 * 1024);
  expect(projection["runId"]).toMatch(/^run_[a-f0-9]{64}$/);
  const duration = projection["usage"]?.providerDurationMs;
  expect(Number.isSafeInteger(duration)).toBe(true);
  expect(duration).toBeGreaterThanOrEqual(0);
  if (outcome === "success") {
    expect(projection).toEqual({
      answer: { answer: OFFLINE_ANSWER }, mode: "answer",
      output: { bytes: 36, ref: ANSWER_REF, sha256: ANSWER_SHA }, runId: projection["runId"], status: "completed",
      truncation: { omittedBytes: 0, originalBytes: 36, truncated: false },
      usage: {
        activeLeafCalls: 0, attempts: 1, controllerTurns: 1, costUsd: 0, framesOpened: 0,
        inputTokensUsed: 11, logicalCalls: 1, outputTokensUsed: 7, providerDurationMs: duration,
        storedBytes: 58, tokensReserved: 0, tokensUsed: 18,
      },
      warningCodes: [],
    });
  } else {
    expect(projection).toEqual({
      error: { code: "FAILED", message: "model provider failed" }, errorCode: "FAILED", mode: null,
      output: null, runId: projection["runId"], status: "failed",
      truncation: { omittedBytes: 0, originalBytes: 0, truncated: false },
      usage: {
        activeLeafCalls: 0, attempts: 1, controllerTurns: 1, costUsd: 0, framesOpened: 0,
        inputTokensUsed: 11, logicalCalls: 1, outputTokensUsed: 0, providerDurationMs: duration,
        storedBytes: 20, tokensReserved: 0, tokensUsed: 11,
      },
      warningCodes: [],
    });
  }
};

const withParentFetchTripwire = async <T>(work: () => Promise<T>): Promise<{ value: T; fetchAttempts: number }> => {
  const originalFetch = globalThis.fetch;
  let fetchAttempts = 0;
  const tripwire = (async () => {
    fetchAttempts += 1;
    throw new Error("offline adapter parent blocked fetch");
  }) as unknown as typeof fetch;
  globalThis.fetch = tripwire;
  try {
    return { value: await work(), fetchAttempts };
  } finally {
    if (globalThis.fetch === tripwire) globalThis.fetch = originalFetch;
  }
};

const runPrintAdapter = async (adapter: "text" | "json", outcome: "success" | "error") => {
  const root = await mkdtemp(join(tmpdir(), `pi-rlm-native-${adapter}-${outcome}-`));
  const statePath = join(root, "fixture-result.json");
  let child: Child | undefined;
  try {
    const parent = await withParentFetchTripwire(async () => {
      child = Bun.spawn(["bun", fixturePath, adapter, root, statePath, outcome], {
        cwd: root,
        env: isolatedEnv(root),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = readBounded(child.stdout as ReadableStream<Uint8Array>, child, "stdout");
      const stderr = readBounded(child.stderr as ReadableStream<Uint8Array>, child, "stderr");
      const exitCode = await waitBounded(child, Promise.all([stdout, stderr]));
      return { stdout: await stdout, stderr: await stderr, exitCode };
    });
    const fixtureResult = assertFixtureResult(await readBoundedJson(statePath));
    return { ...parent.value, fixtureResult, parentFetchAttempts: parent.fetchAttempts };
  } finally {
    if (child) await killAndWait(child);
    await rm(root, { recursive: true, force: true });
  }
};

const customEntryProjection = (result: FixtureResult): unknown => {
  const entries = result.entries.filter((entry) =>
    entry["type"] === "custom_message" && entry["customType"] === "pi-rlm-result");
  expect(entries).toHaveLength(1);
  return JSON.parse(String(entries[0]?.["content"]));
};

describe("offline provider through bounded public Pi adapters", () => {
  test.each([
    ["text", "success"], ["text", "error"], ["json", "success"], ["json", "error"],
  ] as const)("runPrintMode %s exposes exact bounded %s result", async (adapter, outcome) => {
    const result = await runPrintAdapter(adapter, outcome);
    expect(result.parentFetchAttempts).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    assertProjection(customEntryProjection(result.fixtureResult), outcome);
    if (adapter === "text") {
      expect(result.stdout).toBe("");
    } else {
      const records = result.stdout.trim().split("\n").filter(Boolean);
      expect(records.length).toBeLessThanOrEqual(MAX_RPC_RECORDS);
      const events = records.map((line) => {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_RPC_LINE_BYTES);
        return JSON.parse(line) as Record<string, any>;
      });
      const messages = events.filter((event) => event["type"] === "message_end"
        && event["message"]?.customType === "pi-rlm-result");
      expect(messages).toHaveLength(1);
      assertProjection(JSON.parse(messages[0]!["message"].content), outcome);
    }
  }, 15_000);

  test.each(["success", "error"] as const)("runRpcMode exposes exact bounded %s result", async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), `pi-rlm-native-rpc-${outcome}-`));
    const statePath = join(root, "fixture-result.json");
    let child: Child | undefined;
    try {
      const parent = await withParentFetchTripwire(async () => {
        child = Bun.spawn(["bun", fixturePath, "rpc", root, statePath, outcome], {
          cwd: root,
          env: isolatedEnv(root),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const output: Array<Record<string, any>> = [];
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
        const send = async (value: unknown): Promise<void> => {
          stdin.write(`${JSON.stringify(value)}\n`);
          await stdin.flush();
        };
        await send({ id: "prompt", type: "prompt", message: OFFLINE_COMMAND });
        const readOutput = async (): Promise<void> => {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            totalBytes += chunk.value.byteLength;
            if (totalBytes > MAX_ADAPTER_BYTES) {
              child!.kill();
              throw new Error(`RPC stdout exceeded ${MAX_ADAPTER_BYTES} bytes`);
            }
            pending += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (!line) continue;
              if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
                child!.kill();
                throw new Error(`RPC record exceeded ${MAX_RPC_LINE_BYTES} bytes`);
              }
              output.push(JSON.parse(line) as Record<string, any>);
              if (output.length > MAX_RPC_RECORDS) {
                child!.kill();
                throw new Error(`RPC exceeded ${MAX_RPC_RECORDS} records`);
              }
              const event = output.at(-1)!;
              if (!requestedEntries && event["type"] === "message_end"
                && event["message"]?.customType === "pi-rlm-result") {
                requestedEntries = true;
                await send({ id: "entries", type: "get_entries" });
              } else if (event["type"] === "response" && event["id"] === "entries") {
                stdin.end();
              }
            }
          }
          pending += decoder.decode();
          if (pending.length !== 0) throw new Error("RPC stdout ended with an incomplete record");
        };
        const stderr = readBounded(child.stderr as ReadableStream<Uint8Array>, child, "RPC stderr");
        const exitCode = await waitBounded(child, Promise.all([readOutput(), stderr]));
        return { output, stderr: await stderr, exitCode };
      });
      expect(parent.fetchAttempts).toBe(0);
      expect(parent.value.stderr).toBe("");
      expect(parent.value.exitCode).toBe(0);
      const message = parent.value.output.filter((event) => event["type"] === "message_end"
        && event["message"]?.customType === "pi-rlm-result");
      expect(message).toHaveLength(1);
      assertProjection(JSON.parse(message[0]!["message"].content), outcome);
      const response = parent.value.output.filter((event) => event["type"] === "response" && event["id"] === "entries");
      expect(response).toHaveLength(1);
      const durable = response[0]!["data"].entries.filter((entry: Record<string, unknown>) =>
        entry["type"] === "custom_message" && entry["customType"] === "pi-rlm-result");
      expect(durable).toHaveLength(1);
      assertProjection(JSON.parse(String(durable[0]!["content"])), outcome);
      const fixtureResult = assertFixtureResult(await readBoundedJson(statePath));
      assertProjection(customEntryProjection(fixtureResult), outcome);
    } finally {
      if (child) await killAndWait(child);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
