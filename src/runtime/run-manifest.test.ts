import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { canonicalStringify } from "../core/json.ts";
import { normalizeProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import type { CellEvalOptions, InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ModelClient, ModelResponse } from "../shell/model/client.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import {
  buildRunManifest,
  claimRunDirectory,
  nodeRunDirectoryFileSystem,
  readRunManifest,
  RUN_LOCK_FILE,
  RUN_MANIFEST_FILE,
  type RunDirectoryFileSystem,
  validateRunManifest,
} from "./run-manifest.ts";
import { RLM_DSL_VERSION, runProgram, type RunInput } from "./run.ts";

const normalized = normalizeProgram({
  objective: "same program",
  profile: "default",
  inputs: [{ name: "context", adapter: "text", description: "source", constraints: "utf8" }],
  outputs: [{ name: "answer", description: "result", schema: { type: "string" } }],
  metadata: { owner: "test" },
});
if (!normalized.ok) throw new Error("invalid test program");
const program = normalized.value;
const profile = { ...DEFAULT_PROFILE, maxControllerTurns: 0 };
const limits = resolveLimits(profile, 42);
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
const manifest = (source: string, nonce: string, overrides: Partial<Parameters<typeof buildRunManifest>[0]> = {}) => buildRunManifest({
  program,
  sources: { context: source },
  profile,
  limits,
  backend,
  controller,
  authorizationMode: "confirmed",
  createRunNonce: () => nonce,
  dslVersion: RLM_DSL_VERSION,
  ...overrides,
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
const rehash = <T extends { manifest: unknown; manifestHash: string }>(document: T): T => {
  document.manifestHash = sha256(canonicalStringify(document.manifest as never));
  return document;
};

describe("source-bound run identity and manifest", () => {
  test("fixed-clock concurrent same-program runs have distinct random identities", async () => {
    const [a, b] = await Promise.all([
      runProgram(runInput(await tmp(), "same source", "nonce-a")),
      runProgram(runInput(await tmp(), "same source", "nonce-b")),
    ]);
    expect(a.runId).toBe("run_nonce-a");
    expect(b.runId).toBe("run_nonce-b");
  });

  test("binds full normalized program, resolved limits/routes, prompt renders, and no source", () => {
    const secretSource = "raw-secret-source-π";
    const document = manifest(secretSource, "nonce-private");
    expect(document.manifest.program).toEqual(program as unknown as typeof document.manifest.program);
    expect(document.manifest.program).toMatchObject({
      inputs: [{ description: "source", constraints: "utf8" }],
      outputs: [{ description: "result" }],
      metadata: { owner: "test" },
    });
    expect(document.manifest.inputs).toEqual([{
      name: "context",
      label: "context",
      mimeType: "text/plain",
      bytes: Buffer.byteLength(secretSource, "utf8"),
      sha256: sha256(secretSource),
    }]);
    expect(document.manifest.profile).toEqual(profile as unknown as typeof document.manifest.profile);
    expect(document.manifest.limits).toEqual(limits);
    expect((document.manifest.profile as unknown as typeof profile).models).toEqual(DEFAULT_PROFILE.models);
    expect(document.manifest.backend).toEqual({ id: "test-backend", version: "7.2.1" });
    expect(document.manifest.prompts.controller).toMatchObject({
      staticVersion: "2",
      turnVersion: "2",
      staticRenderedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      turnInputsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      turnRenderedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(document.manifest.prompts.extractor).toMatchObject({
      enabled: false,
      version: "2",
      promptRenderedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(document)).not.toContain(secretSource);
    expect(JSON.stringify(document)).not.toContain("grantId");
  });

  test("every program/profile/source prompt input changes manifest and prompt input hash", () => {
    const base = manifest("alpha", "same");
    const changedProgram = normalizeProgram({
      ...program,
      metadata: { owner: "changed" },
    });
    if (!changedProgram.ok) throw new Error("invalid changed program");
    const programDocument = manifest("alpha", "same", { program: changedProgram.value });
    const sourceDocument = manifest("beta", "same");
    const changedProfile = { ...profile, models: { ...profile.models, medium: "resolved-medium" } };
    const profileDocument = manifest("alpha", "same", {
      profile: changedProfile,
      limits: resolveLimits(changedProfile, 42),
    });
    for (const changed of [programDocument, sourceDocument, profileDocument]) {
      expect(changed.manifestHash).not.toBe(base.manifestHash);
      expect(changed.manifest.prompts.controller.turnInputsSha256)
        .not.toBe(base.manifest.prompts.controller.turnInputsSha256);
      expect(changed.manifest.prompts.extractor.promptInputsSha256)
        .not.toBe(base.manifest.prompts.extractor.promptInputsSha256);
    }
  });

  test("absolute deadline changes identity and backend version is mandatory", () => {
    const changedLimits = resolveLimits(profile, 43);
    expect(manifest("alpha", "same", { limits: changedLimits }).manifestHash)
      .not.toBe(manifest("alpha", "same").manifestHash);
    expect(() => manifest("alpha", "same", {
      backend: { ...backend, version: "" },
    })).toThrow("backend.version");
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

  test("strict validation rejects stale mutations, extras, prototypes, and incompatible runtime", () => {
    const original = manifest("alpha", "strict");
    const stale = structuredClone(original);
    (stale.manifest.backend as { id: string }).id = "mutated";
    expect(validateRunManifest(original, stale)).toMatchObject({ ok: false, error: { code: "MANIFEST_INVALID" } });

    const extra = structuredClone(original) as typeof original & { extra?: boolean };
    extra.extra = true;
    rehash(extra);
    expect(validateRunManifest(original, extra)).toMatchObject({ ok: false, error: { code: "MANIFEST_INVALID" } });

    const incompatible = structuredClone(original);
    (incompatible.manifest.runtime as { packageVersion: string }).packageVersion = "99.0.0";
    rehash(incompatible);
    expect(validateRunManifest(original, incompatible)).toMatchObject({ ok: false, error: { code: "MANIFEST_INVALID" } });

    const inherited = structuredClone(original);
    Object.setPrototypeOf(inherited.manifest, { injected: true });
    expect(validateRunManifest(original, inherited)).toMatchObject({ ok: false, error: { code: "MANIFEST_INVALID" } });
  });

  test("readRunManifest applies strict compatibility and canonical hash checks", async () => {
    const dir = await tmp();
    const original = manifest("alpha", "stored");
    await claimRunDirectory(dir, original);
    expect(await readRunManifest(dir)).toEqual(original);

    const incompatible = structuredClone(original);
    (incompatible.manifest.runtime as { dslVersion: string }).dslVersion = "99";
    rehash(incompatible);
    await writeFile(join(dir, RUN_MANIFEST_FILE), `${JSON.stringify(incompatible)}\n`);
    await expect(readRunManifest(dir)).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
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
          async close() { operations.push(`close:${basename(path)}`); await handle.close(); },
        };
      },
      async rename(oldPath, newPath) {
        operations.push(`rename:${basename(oldPath)}:${basename(newPath)}`);
        await nodeRunDirectoryFileSystem.rename(oldPath, newPath);
      },
    };
    await claimRunDirectory(dir, manifest("durable", "durable"), recording);
    const renameIndex = operations.findIndex((item) => item.endsWith(`:${RUN_MANIFEST_FILE}`));
    expect(operations).toContain("sync:.manifest.json.durable.tmp");
    expect(renameIndex).toBeGreaterThan(-1);
    expect(operations.slice(renameIndex + 1)).toContain(`sync:${basename(dir)}`);
    expect((await readRunManifest(dir)).manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

type FaultPoint =
  | "lock-open" | "lock-write" | "lock-sync" | "lock-close"
  | "pre-dir-sync" | "temp-open" | "temp-write" | "temp-sync" | "temp-close"
  | "rename" | "post-dir-sync";

const faultFileSystem = (dir: string, point: FaultPoint): RunDirectoryFileSystem => {
  let directorySync = 0;
  const fault = (): never => { throw Object.assign(new Error(`injected ${point}`), { code: "EIO" }); };
  return {
    ...nodeRunDirectoryFileSystem,
    async open(path, flags) {
      const name = basename(path);
      const lock = name === RUN_LOCK_FILE;
      const temp = name.endsWith(".tmp");
      if ((point === "lock-open" && lock) || (point === "temp-open" && temp)) fault();
      const handle = await nodeRunDirectoryFileSystem.open(path, flags);
      if (path === dir) directorySync++;
      return {
        async writeFile(data, encoding) {
          if ((point === "lock-write" && lock) || (point === "temp-write" && temp)) fault();
          await handle.writeFile(data, encoding);
        },
        async sync() {
          if ((point === "lock-sync" && lock)
            || (point === "temp-sync" && temp)
            || (point === "pre-dir-sync" && path === dir && directorySync === 1)
            || (point === "post-dir-sync" && path === dir && directorySync === 2)) fault();
          await handle.sync();
        },
        async close() {
          await handle.close();
          if ((point === "lock-close" && lock) || (point === "temp-close" && temp)) fault();
        },
      };
    },
    async rename(oldPath, newPath) {
      if (point === "rename") fault();
      await nodeRunDirectoryFileSystem.rename(oldPath, newPath);
    },
  };
};

describe("durable publication failure boundaries", () => {
  for (const point of [
    "lock-open", "lock-write", "lock-sync", "lock-close", "pre-dir-sync", "temp-open",
    "temp-write", "temp-sync", "temp-close", "rename", "post-dir-sync",
  ] as const) {
    test(`${point} has an unambiguous reopen/cleanup outcome`, async () => {
      const dir = await tmp();
      const document = manifest("fault-source", `fault-${point}`);
      await expect(claimRunDirectory(dir, document, faultFileSystem(dir, point)))
        .rejects.toMatchObject({ code: "MANIFEST_WRITE_FAILED" });
      const entries = await readdir(dir);
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);

      if (point === "lock-open") {
        expect(entries).not.toContain(RUN_LOCK_FILE);
        await claimRunDirectory(dir, document);
        expect(await readRunManifest(dir)).toEqual(document);
        return;
      }

      expect(entries).toContain(RUN_LOCK_FILE);
      await expect(claimRunDirectory(dir, document)).rejects.toMatchObject({ code: "RUN_DIRECTORY_IN_USE" });
      if (point === "post-dir-sync") {
        // Rename followed a synced/closed temp, so the exact manifest is safe to reopen.
        expect(await readRunManifest(dir)).toEqual(document);
      } else {
        expect(entries).not.toContain(RUN_MANIFEST_FILE);
        await expect(readRunManifest(dir)).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
      }
    });
  }

  test("manifest publication fault happens before journal or source effects", async () => {
    const dir = await tmp();
    await expect(runProgram({
      ...runInput(dir, "must-not-ingest", "run-rename-fault"),
      runDirectoryFileSystem: faultFileSystem(dir, "rename"),
    })).rejects.toMatchObject({ code: "MANIFEST_WRITE_FAILED" });
    expect(await readdir(dir)).not.toContain("events.jsonl");
    expect(await readdir(dir)).not.toContain("contexts");
    await expect(readFile(join(dir, RUN_MANIFEST_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
