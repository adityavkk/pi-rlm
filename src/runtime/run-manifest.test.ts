import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { canonicalStringify } from "../core/json.ts";
import { normalizeProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import type { CellEvalOptions, InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { RuntimeComponentIdentity } from "../core/identity.ts";
import type { ModelClient, ModelResponse } from "../shell/model/client.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";
import { FunctionExtractor } from "./extractor.ts";
import { ModelController } from "./model-controller.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import { providerRequestIdentity, PROVIDER_REQUEST_IDENTITY_VERSION } from "./provider.ts";
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
const TEST_MODEL_IDENTITY: RuntimeComponentIdentity = {
  id: "test/model-client", version: "1", configuration: { route: "test/model" },
};
const controller: ControllerDriver = {
  identity: { id: "test/controller", version: "1", configuration: { route: "test/model", maxOutputTokens: 64 } },
  async next(_state: FrameState): Promise<Cell> { throw new Error("controller must not run"); },
  fork() { return this; },
};
const model: ModelClient = {
  id: "test-model",
  identity: TEST_MODEL_IDENTITY,
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
  model: overrides.model ?? model,
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
    expect(a.runId).toBe(`run_${sha256("nonce-a")}`);
    expect(b.runId).toBe(`run_${sha256("nonce-b")}`);
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
      staticVersion: "3",
      turnVersion: "2",
      staticRenderedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      bindingInputsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(document.manifest.prompts.extractor).toMatchObject({
      enabled: false,
      version: "2",
      configuration: { contract: "provenance-envelope-v1" },
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
      expect(changed.manifest.prompts.controller.bindingInputsSha256)
        .not.toBe(base.manifest.prompts.controller.bindingInputsSha256);
      expect(changed.manifest.prompts.extractor.bindingInputsSha256)
        .not.toBe(base.manifest.prompts.extractor.bindingInputsSha256);
    }
  });

  test("binds canonical model, controller, and extractor instance configuration", () => {
    const client = (route: string): ModelClient => ({
      id: "configured-model",
      identity: { id: "test/configured-model", version: "1", configuration: { route } },
      async complete(): Promise<ModelResponse> { throw new Error("unused"); },
    });
    const modelA = client("provider/model-a");
    const modelB = client("provider/model-b");
    const controllerA = new ModelController(modelA, { model: "provider/controller", maxOutputTokens: 64 });
    const controllerB = new ModelController(modelA, { model: "provider/controller", maxOutputTokens: 65 });
    const extractorA = new FunctionExtractor(async () => ({ ok: false, code: "FAILED", message: "unused" }), "external", {
      closure: { id: "host/extractor-closure", version: "1", configuration: {} },
      configuration: { temperature: 0 },
      modelRoute: null,
      providerPrompt: null,
    });
    const extractorB = new FunctionExtractor(async () => ({ ok: false, code: "FAILED", message: "unused" }), "external", {
      closure: { id: "host/extractor-closure", version: "1", configuration: {} },
      configuration: { temperature: 1 },
      modelRoute: null,
      providerPrompt: null,
    });
    const base = manifest("alpha", "configured", { model: modelA, controller: controllerA, extractor: extractorA });
    for (const changed of [
      manifest("alpha", "configured", { model: modelB, controller: controllerA, extractor: extractorA }),
      manifest("alpha", "configured", { model: modelA, controller: controllerB, extractor: extractorA }),
      manifest("alpha", "configured", { model: modelA, controller: controllerA, extractor: extractorB }),
    ]) expect(changed.manifestHash).not.toBe(base.manifestHash);
    expect(base.manifest.components).toMatchObject({
      model: { configuration: { route: "provider/model-a" } },
      controller: { configuration: { modelRoute: "provider/controller", maxOutputTokens: 64 } },
      extractor: { configuration: { mode: "external", configuration: { temperature: 0 } } },
    });
  });

  test("binds agent delegation policy identity into manifest and prompt hashes", () => {
    const delegation = (allowedAgents: string[]) => ({
      identity: {
        id: "pi-rlm/agent-delegation",
        version: "pi-rlm.agent-policy.v1",
        configuration: { allowedAgents, cwdSha256: sha256("/tmp/project"), approvalPolicy: null },
      },
    });
    const absent = manifest("alpha", "delegation");
    const reviewer = manifest("alpha", "delegation", { agentDelegation: delegation(["reviewer"]) });
    const worker = manifest("alpha", "delegation", { agentDelegation: delegation(["worker"]) });
    expect(absent.manifest.components.agentDelegation).toBeNull();
    expect(reviewer.manifest.components.agentDelegation).toEqual(delegation(["reviewer"]).identity);
    expect(reviewer.manifestHash).not.toBe(absent.manifestHash);
    expect(reviewer.manifestHash).not.toBe(worker.manifestHash);
    expect(reviewer.manifest.prompts.controller.bindingInputsSha256)
      .not.toBe(absent.manifest.prompts.controller.bindingInputsSha256);
  });

  test("missing opaque component identity fails before nonce or run effects", () => {
    let nonceCalls = 0;
    const noIdentityModel = { id: "opaque", async complete() { throw new Error("unused"); } } as unknown as ModelClient;
    const noIdentityController = {
      async next() { throw new Error("unused"); },
      fork() { return this; },
    } as unknown as ControllerDriver;
    const noIdentityExtractor = { async extract() { return { ok: false as const, code: "FAILED" as const, message: "unused" }; } };
    expect(() => manifest("alpha", "missing", { model: noIdentityModel, createRunNonce: () => { nonceCalls++; return "never"; } }))
      .toThrow("model.identity");
    expect(() => manifest("alpha", "missing", { controller: noIdentityController, createRunNonce: () => { nonceCalls++; return "never"; } }))
      .toThrow("controller.identity");
    expect(() => manifest("alpha", "missing", { extractor: noIdentityExtractor as unknown as import("./extractor.ts").Extractor, createRunNonce: () => { nonceCalls++; return "never"; } }))
      .toThrow("extractor.identity");
    expect(nonceCalls).toBe(0);
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

  test("rejects rehashed unsupported or non-derivable prompt metadata", () => {
    const original = manifest("alpha", "prompt-strict");
    const mutations: Array<(document: typeof original) => void> = [
      (document) => { (document.manifest.prompts.controller as { staticVersion: string }).staticVersion = "999"; },
      (document) => { (document.manifest.prompts.controller as { staticRenderedSha256: string }).staticRenderedSha256 = sha256("arbitrary"); },
      (document) => { (document.manifest.prompts.controller as { turnConfiguration: unknown }).turnConfiguration = { projection: "invented" }; },
      (document) => { (document.manifest.prompts.extractor as { bindingInputsSha256: string }).bindingInputsSha256 = sha256("arbitrary"); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      rehash(changed);
      expect(validateRunManifest(original, changed)).toMatchObject({ ok: false, error: { code: "MANIFEST_INVALID" } });
    }
  });

  test("runtime-dynamic provider prompts are journaled by hash, not predicted in the manifest", async () => {
    const dir = await tmp();
    const prompt = "runtime-only prompt with private evidence";
    const dynamicProfile = { ...profile, maxControllerTurns: 1 };
    const dynamicModel: ModelClient = {
      id: "dynamic-model",
      identity: { id: "test/dynamic-model", version: "1", configuration: { route: "provider/dynamic" } },
      async complete(): Promise<ModelResponse> { return { text: "unused", usage: { attempts: 1, durationMs: 0 } }; },
    };
    const dynamicController: ControllerDriver = {
      identity: {
        id: "test/dynamic-controller", version: "1",
        configuration: { renderer: { id: "host/dynamic-prompt", version: "7", configuration: { template: "bounded-v1" } } },
      },
      async next(_state, _signal, operation): Promise<Cell> {
        await operation.complete(dynamicModel, { prompt });
        throw new Error("stop after observed provider request");
      },
      fork() { return this; },
    };
    await runProgram({
      ...runInput(dir, "alpha", "dynamic-prompt"),
      profile: dynamicProfile,
      model: dynamicModel,
      controller: dynamicController,
    });
    const storedManifest = await readFile(join(dir, RUN_MANIFEST_FILE), "utf8");
    expect(storedManifest).not.toContain(prompt);
    expect(storedManifest).not.toContain("turnRenderedSha256");
    const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const attempted = events.find((event) => event.type === "provider_attempted");
    expect(attempted).toMatchObject({
      requestIdentityVersion: PROVIDER_REQUEST_IDENTITY_VERSION,
      requestSha256: providerRequestIdentity(dynamicModel, { prompt }).sha256,
      outcome: "ok",
    });
    expect(JSON.stringify(attempted)).not.toContain(prompt);
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
    await expect(readRunManifest(dir)).rejects.toMatchObject({ code: "MANIFEST_INCOMPATIBLE" });
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
  | "lock-open" | "readdir" | "lock-write" | "lock-sync" | "lock-close" | "lock-write-close"
  | "pre-dir-open" | "pre-dir-sync" | "pre-dir-close"
  | "temp-open" | "temp-write" | "temp-sync" | "temp-close" | "rename"
  | "post-dir-open" | "post-dir-sync" | "post-dir-close"
  | "lock-cleanup-unlink" | "temp-cleanup-unlink";

const faultFileSystem = (dir: string, point: FaultPoint): RunDirectoryFileSystem => {
  let directoryOpen = 0;
  const fault = (at: string): never => { throw Object.assign(new Error(`injected ${point} at ${at}`), { code: "EIO" }); };
  return {
    ...nodeRunDirectoryFileSystem,
    async open(path, flags) {
      const name = basename(path);
      const lock = name === RUN_LOCK_FILE;
      const temp = name.endsWith(".tmp");
      let directoryPhase: "pre" | "post" | undefined;
      if (path === dir) {
        directoryOpen++;
        directoryPhase = directoryOpen === 1 ? "pre" : "post";
      }
      if ((point === "lock-open" && lock)
        || (point === "temp-open" && temp)
        || (point === "pre-dir-open" && directoryPhase === "pre")
        || (point === "post-dir-open" && directoryPhase === "post")) fault("open");
      const handle = await nodeRunDirectoryFileSystem.open(path, flags);
      return {
        async writeFile(data, encoding) {
          if ((point === "lock-write" || point === "lock-write-close") && lock) fault("write");
          if ((point === "temp-write" || point === "temp-cleanup-unlink") && temp) fault("write");
          await handle.writeFile(data, encoding);
        },
        async sync() {
          if ((point === "lock-sync" && lock)
            || (point === "temp-sync" && temp)
            || (point === "pre-dir-sync" && directoryPhase === "pre")
            || (point === "post-dir-sync" && directoryPhase === "post")) fault("sync");
          await handle.sync();
        },
        async close() {
          await handle.close();
          if ((point === "lock-close" || point === "lock-write-close") && lock) fault("close");
          if ((point === "temp-close" && temp)
            || (point === "pre-dir-close" && directoryPhase === "pre")
            || (point === "post-dir-close" && directoryPhase === "post")) fault("close");
        },
      };
    },
    async readdir(path) {
      if ((point === "readdir" || point === "lock-cleanup-unlink") && path === dir) fault("readdir");
      return nodeRunDirectoryFileSystem.readdir(path);
    },
    async rename(oldPath, newPath) {
      if (point === "rename") fault("rename");
      await nodeRunDirectoryFileSystem.rename(oldPath, newPath);
    },
    async unlink(path) {
      const name = basename(path);
      if ((point === "lock-cleanup-unlink" && name === RUN_LOCK_FILE)
        || (point === "temp-cleanup-unlink" && name.endsWith(".tmp"))) fault("unlink");
      await nodeRunDirectoryFileSystem.unlink(path);
    },
  };
};

const earlyClaimFaults: readonly FaultPoint[] = [
  "lock-open", "readdir", "lock-write", "lock-sync", "lock-close", "lock-write-close",
];
const publicationFaults: readonly FaultPoint[] = [
  "pre-dir-open", "pre-dir-sync", "pre-dir-close", "temp-open", "temp-write", "temp-sync", "temp-close",
  "rename", "post-dir-open", "post-dir-sync", "post-dir-close",
];

describe("durable publication failure boundaries", () => {
  for (const point of earlyClaimFaults) {
    test(`${point} cleans the incomplete lock and permits an unambiguous retry`, async () => {
      const dir = await tmp();
      const document = manifest("fault-source", `fault-${point}`);
      let thrown: unknown;
      try { await claimRunDirectory(dir, document, faultFileSystem(dir, point)); } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({
        code: point === "lock-close" || point === "lock-write-close" ? "MANIFEST_CLEANUP_FAILED" : "MANIFEST_WRITE_FAILED",
      });
      if (point === "lock-write-close") {
        const cause = (thrown as { cause?: unknown }).cause;
        expect(cause).toBeInstanceOf(AggregateError);
        expect((cause as AggregateError).errors).toHaveLength(2);
      }
      expect(await readdir(dir)).toEqual([]);
      await claimRunDirectory(dir, document);
      expect(await readRunManifest(dir)).toEqual(document);
    });
  }

  for (const point of publicationFaults) {
    test(`${point} leaves a claimed directory with no temporary ambiguity`, async () => {
      const dir = await tmp();
      const document = manifest("fault-source", `fault-${point}`);
      await expect(claimRunDirectory(dir, document, faultFileSystem(dir, point)))
        .rejects.toMatchObject({ code: point.endsWith("-close") ? "MANIFEST_CLEANUP_FAILED" : "MANIFEST_WRITE_FAILED" });
      const entries = await readdir(dir);
      expect(entries).toContain(RUN_LOCK_FILE);
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
      await expect(claimRunDirectory(dir, document)).rejects.toMatchObject({ code: "RUN_DIRECTORY_IN_USE" });
      if (point.startsWith("post-dir-")) expect(await readRunManifest(dir)).toEqual(document);
      else {
        expect(entries).not.toContain(RUN_MANIFEST_FILE);
        await expect(readRunManifest(dir)).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
      }
    });
  }

  test("lock cleanup unlink failure is typed, compounded, and permanently fail-closed", async () => {
    const dir = await tmp();
    const document = manifest("fault-source", "lock-cleanup");
    let thrown: unknown;
    try { await claimRunDirectory(dir, document, faultFileSystem(dir, "lock-cleanup-unlink")); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "MANIFEST_CLEANUP_FAILED" });
    expect((thrown as { cause: AggregateError }).cause).toBeInstanceOf(AggregateError);
    expect((thrown as { cause: AggregateError }).cause.errors).toHaveLength(2);
    expect(await readdir(dir)).toEqual([RUN_LOCK_FILE]);
    await expect(claimRunDirectory(dir, document)).rejects.toMatchObject({ code: "RUN_DIRECTORY_IN_USE" });
    await expect(readRunManifest(dir)).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  test("temp cleanup unlink failure is typed, compounded, and leaves one non-valid temp", async () => {
    const dir = await tmp();
    const document = manifest("fault-source", "temp-cleanup");
    let thrown: unknown;
    try { await claimRunDirectory(dir, document, faultFileSystem(dir, "temp-cleanup-unlink")); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "MANIFEST_CLEANUP_FAILED" });
    expect((thrown as { cause: AggregateError }).cause.errors).toHaveLength(2);
    const entries = await readdir(dir);
    expect(entries).toContain(RUN_LOCK_FILE);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toHaveLength(1);
    expect(entries).not.toContain(RUN_MANIFEST_FILE);
    await expect(claimRunDirectory(dir, document)).rejects.toMatchObject({ code: "RUN_DIRECTORY_IN_USE" });
    await expect(readRunManifest(dir)).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  test("nonempty-directory rejection cleans its provisional lock", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "owner-state"), "existing");
    await expect(claimRunDirectory(dir, manifest("fault-source", "nonempty")))
      .rejects.toMatchObject({ code: "RUN_DIRECTORY_NOT_EMPTY" });
    expect(await readdir(dir)).toEqual(["owner-state"]);
  });

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
