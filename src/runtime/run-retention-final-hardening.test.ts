import { describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileShorthand } from "../core/program.ts";
import { JournalStore, nodeJournalFileSystem } from "../shell/journal-store.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ModelClient } from "../shell/model/client.ts";
import type { ControllerDriver } from "./controller.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import { buildRunManifest, claimRunDirectory, RLM_DSL_VERSION } from "./run-manifest.ts";
import { managedRunPersistence } from "./run-managed-lifecycle.ts";
import { ManagedRunStore, RUN_ACTIVE_FILE, type ManagedRunLease } from "./run-retention.ts";
import { runProgram } from "./run.ts";
import { acquireRunRetentionLease } from "./run-writer-arbiter.ts";
import { publishImmutableArbitrationRecord } from "./run-writer-publisher.ts";
import {
  ARBITRATION_DIRECTORY,
  encodeGenerationRecord,
  generationIntentFilename,
  MAX_ARBITRATION_ORDINAL,
  scanArbitrationDirectory,
  successorSlotFilename,
  type GenerationRecord,
} from "./run-writer-protocol.ts";
import type { RunQuarantineFileSystem } from "./run-writer-quarantine.ts";

const privateRoot = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "pi-rlm-final-hardening-"));
  await chmod(path, 0o700);
  return path;
};
const ownerTokens = () => { let value = 0; return () => (++value).toString(16).padStart(32, "0"); };
const token64 = (value: number): string => value.toString(16).padStart(64, "0");
const program = (() => {
  const compiled = compileShorthand({ objective: "final hardening" });
  if (!compiled.ok) throw new Error("fixture program failed");
  return compiled.value;
})();
const backend: InterpreterBackend = {
  id: "fixture", version: "1", async evalCell() { throw new Error("unused"); }, async dispose() {},
};
const model: ModelClient = {
  id: "fixture", identity: { id: "fixture/model", version: "1", configuration: {} },
  async complete() { throw new Error("unused"); },
};
const controller: ControllerDriver = {
  identity: { id: "fixture/controller", version: "1", configuration: {} },
  async next() { throw new Error("controller fixture"); }, fork() { return this; },
};

const document = (nonce: string) => buildRunManifest({
  program, sources: { context: "source" }, profile: DEFAULT_PROFILE,
  limits: resolveLimits(DEFAULT_PROFILE, 0), backend, model, controller,
  dslVersion: RLM_DSL_VERSION, createRunNonce: () => nonce,
});

const publishFailedTerminalEvidence = async (lease: ManagedRunLease, nonce: string): Promise<string> => {
  const runDocument = document(nonce);
  const persistence = managedRunPersistence(lease.lifecycle);
  await claimRunDirectory(
    lease.dir,
    runDocument,
    persistence.runDirectoryFileSystem(),
    lease.lifecycle.claimEntries,
  );
  const runId = runDocument.manifest.run.id;
  await lease.lifecycle.onManifest(runId);
  const journal = new JournalStore(lease.dir, persistence.journalFileSystem());
  await journal.append({
    type: "run_started", runId, manifestHash: runDocument.manifestHash,
    limits: runDocument.manifest.limits, inputRefs: [],
  });
  await lease.lifecycle.onRunStarted(runId);
  await journal.append({ type: "run_failed", runId, code: "FIXTURE", message: "fixture" });
  return runId;
};

const failedGenesisRecord = async (root: string, runName: string): Promise<GenerationRecord> => {
  const [rootStat, runStat] = await Promise.all([
    lstat(root, { bigint: true }),
    lstat(join(root, runName), { bigint: true }),
  ]);
  return {
    schemaVersion: 1,
    type: "generation",
    token: token64(700),
    predecessor: null,
    ordinal: 1,
    role: "writer",
    rootDev: rootStat.dev,
    rootIno: rootStat.ino,
    runDev: runStat.dev,
    runIno: runStat.ino,
    runName,
    pid: 2_000_000_000,
    processNonce: token64(701),
    osProcessIdentity: null,
    createdAtMs: 1,
  };
};

type GenesisWindow =
  | "root-synced-directory"
  | "empty-arbitration"
  | "canonical-intent"
  | "malformed-intent"
  | "published-genesis"
  | "durable-manifest"
  | "retention-successor";

const createGenesisWindow = async (root: string, kind: GenesisWindow, ordinal: number): Promise<string> => {
  const runName = `run-${ordinal.toString(16).padStart(32, "0")}`;
  const runPath = join(root, runName);
  await mkdir(runPath, { mode: 0o700 });
  if (kind === "root-synced-directory") return runName;
  const arbitrationPath = join(runPath, ARBITRATION_DIRECTORY);
  await mkdir(arbitrationPath, { mode: 0o700 });
  if (kind === "empty-arbitration") return runName;
  const genesis = await failedGenesisRecord(root, runName);
  if (kind === "canonical-intent" || kind === "malformed-intent") {
    await writeFile(
      join(arbitrationPath, generationIntentFilename(genesis.token)),
      kind === "canonical-intent" ? encodeGenerationRecord(genesis) : "{",
      { mode: 0o600 },
    );
    return runName;
  }
  await publishImmutableArbitrationRecord({ directory: arbitrationPath, record: genesis });
  if (kind === "durable-manifest") {
    await writeFile(join(runPath, ".pi-rlm-run.lock"), "", { mode: 0o600 });
    await writeFile(join(runPath, "manifest.json"), "{}\n", { mode: 0o600 });
  }
  if (kind === "retention-successor") {
    await acquireRunRetentionLease({
      managedRoot: root,
      runName,
      preflightRetirement: async () => {},
    }, { livenessProbe: () => "absent" });
  }
  return runName;
};

describe("final managed lifecycle hardening", () => {
  test("runs direct managed persistence through a symlinked root component", async () => {
    const parent = await privateRoot();
    const actualParent = join(parent, "actual");
    const aliasParent = join(parent, "alias");
    await mkdir(actualParent, { mode: 0o700 });
    await symlink(actualParent, aliasParent, "dir");
    const lexicalRoot = join(aliasParent, "runs");
    const store = new ManagedRunStore({ root: lexicalRoot, createToken: ownerTokens() });
    const lease = await store.create();
    try {
      const result = await runProgram({
        program,
        sources: { context: "source" },
        backend,
        model,
        controller,
        dir: lease.dir,
        profile: DEFAULT_PROFILE,
        signal: new AbortController().signal,
        runLifecycle: lease.lifecycle,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "CONTROLLER_FAILED" } });
      await lease.finish(result.status, result.runId);
      expect(await store.list()).toMatchObject({ issues: [], runs: [{ activity: "inactive" }] });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  test("rejects caller-supplied filesystem implementations for managed runs", async () => {
    const root = await privateRoot();
    const store = new ManagedRunStore({ root, createToken: ownerTokens() });
    const journalLease = await store.create();
    await expect(runProgram({
      program,
      sources: { context: "source" },
      backend,
      model,
      controller,
      dir: journalLease.dir,
      signal: new AbortController().signal,
      runLifecycle: journalLease.lifecycle,
      journalFileSystem: nodeJournalFileSystem,
    })).rejects.toThrow("managed runs reject caller-supplied persistence implementations");
    await journalLease.discard();

    const contextLease = await store.create();
    let invoked = false;
    await expect(runProgram({
      program,
      sources: { context: "source" },
      backend,
      model,
      controller,
      dir: contextLease.dir,
      signal: new AbortController().signal,
      runLifecycle: contextLease.lifecycle,
      contextStoreInstrumentation: { onMaterialize() { invoked = true; } },
    })).rejects.toThrow("managed runs reject caller-supplied persistence implementations");
    expect(invoked).toBe(false);
    await contextLease.discard();
  });

  test("rechecks exposure after an admitted manifest bind before concurrent discard", async () => {
    const root = await privateRoot();
    const store = new ManagedRunStore({ root, createToken: ownerTokens() });
    const lease = await store.create();
    const runDocument = document("concurrent-discard");
    const persistence = managedRunPersistence(lease.lifecycle);
    await claimRunDirectory(
      lease.dir, runDocument, persistence.runDirectoryFileSystem(), lease.lifecycle.claimEntries,
    );
    let entered!: () => void;
    let proceed!: () => void;
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const binding = persistence.runTransaction(async () => {
      entered();
      await gate;
      await lease.lifecycle.onManifest(runDocument.manifest.run.id);
    });
    await admitted;
    const discard = lease.discard();
    proceed();
    await binding;
    await expect(discard).rejects.toThrow("cannot discard an exposed managed run");

    const journal = new JournalStore(lease.dir, persistence.journalFileSystem());
    const runId = runDocument.manifest.run.id;
    await journal.append({
      type: "run_started", runId, manifestHash: runDocument.manifestHash,
      limits: runDocument.manifest.limits, inputRefs: [],
    });
    await lease.lifecycle.onRunStarted(runId);
    await journal.append({ type: "run_failed", runId, code: "FIXTURE", message: "fixture" });
    await lease.finish("failed", runId);
    expect((await lstat(lease.dir)).isDirectory()).toBe(true);
  });

  test.each([
    "root-synced-directory",
    "empty-arbitration",
    "canonical-intent",
    "malformed-intent",
    "published-genesis",
    "durable-manifest",
    "retention-successor",
  ] as const)("reconciles the %s failed-genesis crash window", async (kind) => {
    const root = await privateRoot();
    const runName = await createGenesisWindow(root, kind, 100 + [
      "root-synced-directory", "empty-arbitration", "canonical-intent", "malformed-intent",
      "published-genesis", "durable-manifest", "retention-successor",
    ].indexOf(kind));
    const store = new ManagedRunStore({
      root,
      createToken: ownerTokens(),
      writerArbiterOptions: { livenessProbe: () => "absent" },
    });
    await store.cleanup();
    expect(await readdir(root)).toEqual([]);
    const replacement = await store.create();
    await replacement.discard();
    expect(await readdir(root)).toEqual([]);
    expect(runName).toMatch(/^run-/);
  });

  test("retains and later retries writer-release authority after repeated faults", async () => {
    const root = await privateRoot();
    let releaseAttempts = 0;
    const store = new ManagedRunStore({
      root,
      createToken: ownerTokens(),
      writerArbiterOptions: {
        async publish(input, options) {
          if (input.record.type === "release" && ++releaseAttempts <= 4)
            throw new Error("repeated release fault");
          return publishImmutableArbitrationRecord(input, options);
        },
      },
    });
    const lease = await store.create();
    const runId = await publishFailedTerminalEvidence(lease, "repeated-release");
    await expect(lease.finish("failed", runId)).rejects.toMatchObject({ code: "RUN_RETENTION_METADATA_FAILED" });
    expect(releaseAttempts).toBe(2);
    await expect(new ManagedRunStore({ root }).cleanup()).rejects.toMatchObject({ code: "RUN_RETENTION_CLEANUP_FAILED" });
    expect(releaseAttempts).toBe(4);
    await new ManagedRunStore({ root }).cleanup();
    expect(releaseAttempts).toBe(5);
    const listing = await new ManagedRunStore({ root }).list();
    expect(listing.runs[0]?.activity).toBe("inactive");
    expect((await new ManagedRunStore({ root }).cleanup({ force: true })).deleted).toEqual([lease.name]);
  });

  test("retries an applied active-marker unlink when its first directory sync fails", async () => {
    const root = await privateRoot();
    let markerAbsent = false;
    let directorySyncs = 0;
    const store = new ManagedRunStore({
      root,
      createToken: ownerTokens(),
      metadataFileSystem: {
        async open(path, flags, mode) {
          const handle = await open(path, flags, mode);
          return {
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
            close: () => handle.close(),
            async sync() {
              await handle.sync();
              if (flags === "r" && markerAbsent && ++directorySyncs === 1)
                throw new Error("directory sync lost after marker unlink");
            },
          };
        },
        rename,
        async unlink(path) {
          await import("node:fs/promises").then((fs) => fs.unlink(path));
          if (path.endsWith(RUN_ACTIVE_FILE)) markerAbsent = true;
        },
      },
    });
    const lease = await store.create();
    const runId = await publishFailedTerminalEvidence(lease, "marker-sync-retry");
    await lease.finish("failed", runId);
    expect(directorySyncs).toBe(2);
    expect((await store.list()).runs[0]?.activity).toBe("inactive");
  });

  test("retries a failed final-ordinal quarantine through ManagedRunStore in the same process", async () => {
    const root = await privateRoot();
    const producer = new ManagedRunStore({ root, createToken: ownerTokens() });
    const lease = await producer.create();
    const runId = await publishFailedTerminalEvidence(lease, "retirement-retry");
    await lease.finish("failed", runId);

    const arbitrationPath = join(lease.dir, ARBITRATION_DIRECTORY);
    const chain = await scanArbitrationDirectory(arbitrationPath);
    let predecessor = chain.tip!;
    const processNonce = token64(800_000);
    for (let ordinal = predecessor.ordinal + 1; ordinal < MAX_ARBITRATION_ORDINAL; ordinal++) {
      const generation: GenerationRecord = {
        schemaVersion: 1,
        type: "generation",
        token: token64(100_000 + ordinal),
        predecessor: predecessor.token,
        ordinal,
        role: "writer",
        rootDev: predecessor.rootDev,
        rootIno: predecessor.rootIno,
        runDev: predecessor.runDev,
        runIno: predecessor.runIno,
        runName: predecessor.runName,
        pid: 2_000_000_000,
        processNonce,
        osProcessIdentity: null,
        createdAtMs: ordinal,
      };
      const intent = join(arbitrationPath, generationIntentFilename(generation.token));
      await writeFile(intent, encodeGenerationRecord(generation), { mode: 0o600, flag: "wx" });
      await link(intent, join(arbitrationPath, successorSlotFilename(predecessor.token)));
      predecessor = generation;
    }

    let failRename = true;
    const quarantineFileSystem: RunQuarantineFileSystem = {
      lstat: (path) => lstat(path, { bigint: true }),
      async rename(oldPath, newPath) {
        if (failRename) { failRename = false; throw new Error("pre-rename retirement fault"); }
        await rename(oldPath, newPath);
      },
      async openDirectory(path) {
        const handle = await open(path, "r");
        return {
          stat: (options) => handle.stat(options),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    let nextToken = 900_000;
    const sweeper = new ManagedRunStore({
      root,
      quarantineFileSystem,
      writerArbiterOptions: {
        livenessProbe: () => "absent",
        createToken: () => token64(nextToken++),
      },
    });
    await expect(sweeper.cleanup({ force: true })).rejects.toMatchObject({ code: "RUN_RETENTION_CLEANUP_FAILED" });
    expect((await lstat(lease.dir)).isDirectory()).toBe(true);
    expect((await sweeper.cleanup({ force: true })).deleted).toEqual([lease.name]);
    await expect(lstat(lease.dir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
