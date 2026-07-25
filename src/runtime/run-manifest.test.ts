import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { normalizeProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import type { CellEvalOptions, InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ModelClient, ModelResponse } from "../shell/model/client.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import {
  buildRunManifest,
  nodeRunDirectoryFileSystem,
  readRunManifest,
  RUN_MANIFEST_FILE,
  type RunDirectoryFileSystem,
  validateRunManifest,
} from "./run-manifest.ts";
import { RLM_DSL_VERSION, runProgram, type RunInput } from "./run.ts";

const normalized = normalizeProgram({
  objective: "same program",
  profile: "default",
  inputs: [{ name: "context", adapter: "text", description: "source" }],
  outputs: [{ name: "answer", schema: { type: "string" } }],
});
if (!normalized.ok) throw new Error("invalid test program");
const program = normalized.value;
const profile = { ...DEFAULT_PROFILE, maxControllerTurns: 0 };
const backend: InterpreterBackend = {
  id: "test-backend",
  version: "7.2.1",
  async evalCell(_options: CellEvalOptions) { throw new Error("interpreter must not run"); },
  async dispose() {},
};
const controller: ControllerDriver = {
  async next(_state: FrameState): Promise<Cell> { throw new Error("controller must not run"); },
  fork() { return this; },
};
const model: ModelClient = {
  id: "test-model",
  async complete(): Promise<ModelResponse> { throw new Error("model must not run"); },
};
const manifest = (source: string, nonce: string) => buildRunManifest({
  program,
  sources: { context: source },
  profile,
  backend,
  controller,
  authorizationMode: "confirmed",
  createRunNonce: () => nonce,
  dslVersion: RLM_DSL_VERSION,
});
const runInput = (dir: string, source: string, nonce: string): RunInput => ({
  program,
  sources: { context: source },
  profile,
  backend,
  controller,
  model,
  dir,
  signal: new AbortController().signal,
  clock: { now: () => 42 },
  authorizationMode: "confirmed",
  createRunNonce: () => nonce,
});
const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-manifest-"));

describe("source-bound run identity and manifest", () => {
  test("fixed-clock concurrent same-program runs have distinct random identities", async () => {
    const [a, b] = await Promise.all([
      runProgram(runInput(await tmp(), "same source", "nonce-a")),
      runProgram(runInput(await tmp(), "same source", "nonce-b")),
    ]);
    expect(a.runId).toBe("run_nonce-a");
    expect(b.runId).toBe("run_nonce-b");
    expect(a.runId).not.toBe(b.runId);
  });

  test("ordered inputs bind full source hash/bytes while omitting raw source and grant secrets", () => {
    const secretSource = "raw-secret-source-π";
    const document = manifest(secretSource, "nonce-private");
    expect(document.manifest.inputs).toEqual([{
      name: "context",
      label: "context",
      mimeType: "text/plain",
      bytes: Buffer.byteLength(secretSource, "utf8"),
      sha256: sha256(secretSource),
    }]);
    expect(document.manifest.backend).toEqual({ id: "test-backend", version: "7.2.1" });
    expect(document.manifest.launchAuthorization).toEqual({ mode: "confirmed" });
    expect(JSON.stringify(document)).not.toContain(secretSource);
    expect(JSON.stringify(document)).not.toContain("grantId");
  });

  test("source changes mismatch and manifest hashing is deterministic except for nonce", () => {
    const a = manifest("alpha", "nonce-a");
    const same = manifest("alpha", "nonce-a");
    const sourceChanged = manifest("beta", "nonce-a");
    const nonceChanged = manifest("alpha", "nonce-b");
    expect(a.manifestHash).toBe(same.manifestHash);
    expect(sourceChanged.manifestHash).not.toBe(a.manifestHash);
    expect(nonceChanged.manifestHash).not.toBe(a.manifestHash);
    expect(validateRunManifest(sourceChanged, a)).toMatchObject({ ok: false, error: { code: "MANIFEST_MISMATCH" } });
  });

  test("shared directory permits one writer and permanently rejects reuse", async () => {
    const dir = await tmp();
    const settled = await Promise.allSettled([
      runProgram(runInput(dir, "alpha", "concurrent-a")),
      runProgram(runInput(dir, "alpha", "concurrent-b")),
    ]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "RUN_DIRECTORY_IN_USE" });
    await expect(runProgram(runInput(dir, "alpha", "reuse"))).rejects.toMatchObject({ code: "RUN_DIRECTORY_IN_USE" });
  });

  test("manifest uses synced temp, atomic rename, and directory sync", async () => {
    const dir = await tmp();
    const operations: string[] = [];
    const recording: RunDirectoryFileSystem = {
      ...nodeRunDirectoryFileSystem,
      async open(path, flags) {
        operations.push(`open:${basename(path)}:${flags}`);
        const handle = await nodeRunDirectoryFileSystem.open(path, flags);
        return {
          async writeFile(data, encoding) { operations.push(`write:${basename(path)}`); await handle.writeFile(data, encoding); },
          async sync() { operations.push(`sync:${basename(path)}`); await handle.sync(); },
          async close() { await handle.close(); },
        };
      },
      async rename(oldPath, newPath) {
        operations.push(`rename:${basename(oldPath)}:${basename(newPath)}`);
        await nodeRunDirectoryFileSystem.rename(oldPath, newPath);
      },
    };
    await runProgram({ ...runInput(dir, "durable", "durable"), runDirectoryFileSystem: recording });
    const renameIndex = operations.findIndex((item) => item.endsWith(`:${RUN_MANIFEST_FILE}`));
    expect(operations.some((item) => item === "sync:.manifest.json.durable.tmp")).toBe(true);
    expect(renameIndex).toBeGreaterThan(-1);
    expect(operations.slice(renameIndex + 1)).toContain(`sync:${basename(dir)}`);
    const stored = await readRunManifest(dir);
    expect(stored.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("manifest publication fault fails before journal or source effects", async () => {
    const dir = await tmp();
    const fault: RunDirectoryFileSystem = {
      ...nodeRunDirectoryFileSystem,
      async rename() { throw Object.assign(new Error("injected rename fault"), { code: "EIO" }); },
    };
    await expect(runProgram({ ...runInput(dir, "must-not-ingest", "fault"), runDirectoryFileSystem: fault }))
      .rejects.toMatchObject({ code: "MANIFEST_WRITE_FAILED" });
    expect(await readdir(dir)).not.toContain("events.jsonl");
    expect(await readdir(dir)).not.toContain("contexts");
    await expect(readFile(join(dir, RUN_MANIFEST_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
