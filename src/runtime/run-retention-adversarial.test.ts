import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileShorthand } from "../core/program.ts";
import { JournalStore, nodeJournalFileSystem, type JournalFileSystem } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ControllerDriver } from "./controller.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import {
  buildRunManifest,
  claimRunDirectory,
  nodeRunDirectoryFileSystem,
  RLM_DSL_VERSION,
  type RunDirectoryFileSystem,
} from "./run-manifest.ts";
import {
  ManagedRunStore,
  RUN_ACTIVE_FILE,
  type ManagedRunLease,
} from "./run-retention.ts";
import { managedRunPersistence } from "./run-managed-lifecycle.ts";
import { runProgram } from "./run.ts";
import { publishImmutableArbitrationRecord } from "./run-writer-publisher.ts";
import { scanArbitrationDirectory } from "./run-writer-protocol.ts";
import { readLine, tokenAt } from "./run-writer-arbiter.test-helpers.ts";

const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "pi-rlm-retention-adversarial-"));
  await chmod(path, 0o700);
  return path;
};
const ownerTokens = () => { let value = 0; return () => (++value).toString(16).padStart(32, "0"); };
const program = (() => {
  const result = compileShorthand({ objective: "retention adversarial" });
  if (!result.ok) throw new Error("fixture program failed");
  return result.value;
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
  async next() { throw new Error("unused"); }, fork() { return this; },
};

const publishTerminal = async (lease: ManagedRunLease, nonce: string): Promise<void> => {
  const document = buildRunManifest({
    program, sources: { context: "" }, profile: DEFAULT_PROFILE,
    limits: resolveLimits(DEFAULT_PROFILE, 0), backend, model, controller,
    dslVersion: RLM_DSL_VERSION, createRunNonce: () => nonce,
  });
  await claimRunDirectory(
    lease.dir, document, managedRunPersistence(lease.lifecycle).runDirectoryFileSystem(), lease.lifecycle.claimEntries,
  );
  const id = document.manifest.run.id;
  await lease.lifecycle.onManifest(id);
  const journal = new JournalStore(lease.dir, managedRunPersistence(lease.lifecycle).journalFileSystem());
  await journal.append({
    type: "run_started", runId: id, manifestHash: document.manifestHash,
    limits: document.manifest.limits, inputRefs: [],
  });
  await lease.lifecycle.onRunStarted(id);
  await journal.append({ type: "run_failed", runId: id, code: "FIXTURE", message: "fixture" });
  await lease.finish("failed", id);
};

describe("managed lifecycle adversarial recovery", () => {
  test("keeps a live bare genesis and scavenges it after process death", async () => {
    const path = await root();
    const moduleUrl = new URL("./run-retention.ts", import.meta.url).href;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        const { ManagedRunStore } = await import(${JSON.stringify(moduleUrl)});
        const lease = await new ManagedRunStore({ root: ${JSON.stringify(path)} }).create();
        console.log(lease.name);
        await new Promise(() => {});
      `],
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const name = await readLine(child.stdout);
      expect(name).toMatch(/^run-/);
      await new ManagedRunStore({ root: path }).cleanup();
      expect((await lstat(join(path, name))).isDirectory()).toBe(true);
      child.kill("SIGKILL");
      await child.exited;
      await new ManagedRunStore({ root: path }).cleanup();
      await expect(lstat(join(path, name))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { child.kill(); await rm(path, { recursive: true, force: true }); }
  });

  test("creation failure never quarantines a different authoritative genesis winner", async () => {
    const path = await root();
    let winnerToken = "";
    let injected = false;
    const store = new ManagedRunStore({
      root: path,
      createToken: ownerTokens(),
      writerArbiterOptions: {
        createToken: () => tokenAt(10),
        async publish(input, options) {
          if (!injected && input.record.type === "generation") {
            injected = true;
            const winner = {
              ...input.record,
              token: tokenAt(99),
              pid: 2_000_000_000,
              processNonce: tokenAt(98),
            };
            winnerToken = winner.token;
            await publishImmutableArbitrationRecord({ directory: input.directory, record: winner }, options);
          }
          return publishImmutableArbitrationRecord(input, options);
        },
      },
    });
    try {
      await expect(store.create()).rejects.toMatchObject({ code: "RUN_RETENTION_CREATE_FAILED" });
      const names = await import("node:fs/promises").then((fs) => fs.readdir(path));
      expect(names).toHaveLength(1);
      const chain = await scanArbitrationDirectory(join(path, names[0]!, ".pi-rlm-arbitration"));
      expect(chain.tip?.token).toBe(winnerToken);
      expect((await lstat(join(path, names[0]!))).isDirectory()).toBe(true);
    } finally { await rm(path, { recursive: true, force: true }); }
  });

  test("discard is forbidden after manifest exposure while internal incomplete-genesis cleanup remains available", async () => {
    const path = await root();
    const store = new ManagedRunStore({ root: path, createToken: ownerTokens() });
    const lease = await store.create();
    const document = buildRunManifest({
      program, sources: { context: "" }, profile: DEFAULT_PROFILE,
      limits: resolveLimits(DEFAULT_PROFILE, 0), backend, model, controller,
      dslVersion: RLM_DSL_VERSION, createRunNonce: () => "discard-exposure",
    });
    await claimRunDirectory(
      lease.dir, document, managedRunPersistence(lease.lifecycle).runDirectoryFileSystem(), lease.lifecycle.claimEntries,
    );
    await lease.lifecycle.onManifest(document.manifest.run.id);
    await expect(lease.discard()).rejects.toThrow("cannot discard an exposed managed run");
    expect((await lstat(lease.dir)).isDirectory()).toBe(true);
    await lease.abandon();
    await expect(lstat(lease.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("syncs the managed root after run mkdir and rolls back a failed sync", async () => {
    const path = await root();
    let syncs = 0;
    const store = new ManagedRunStore({
      root: path,
      createToken: ownerTokens(),
      directoryFileSystem: {
        lstat: (target) => lstat(target, { bigint: true }),
        async openDirectory(target) {
          const handle = await open(target, "r");
          return {
            stat: (options) => handle.stat(options), close: () => handle.close(),
            async sync() {
              await handle.sync();
              if (++syncs === 1) throw new Error("root sync applied then threw");
            },
          };
        },
      },
    });
    await expect(store.create()).rejects.toMatchObject({ code: "RUN_RETENTION_CREATE_FAILED" });
    expect(syncs).toBeGreaterThanOrEqual(2);
    expect(await import("node:fs/promises").then((fs) => fs.readdir(path))).toEqual([]);
  });

  test("rechecks count policy after authority acquisition before quarantine", async () => {
    let now = 1;
    const path = await root();
    const producer = new ManagedRunStore({ root: path, now: () => now, createToken: ownerTokens() });
    const oldest = await producer.create();
    await publishTerminal(oldest, "policy-oldest");
    now = 2;
    const newest = await producer.create();
    await publishTerminal(newest, "policy-newest");
    let raced = false;
    const sweeper = new ManagedRunStore({
      root: path,
      now: () => now,
      policy: { maxTerminalRuns: 1, terminalMaxAgeMs: Number.MAX_SAFE_INTEGER },
      afterCleanupAcquisition: async (candidate) => {
        if (raced || candidate !== oldest.dir) return;
        raced = true;
        await rm(newest.dir, { recursive: true });
      },
    });
    const result = await sweeper.cleanup();
    expect(raced).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.retained).toEqual([oldest.name]);
    expect((await lstat(oldest.dir)).isDirectory()).toBe(true);
  });

  test.each(["manifest", "context", "first-journal"] as const)(
    "production composition quarantines genesis after a %s fault before durable run_started",
    async (fault) => {
      const path = await root();
      const store = new ManagedRunStore({ root: path, createToken: ownerTokens() });
      const lease = await store.create();
      const manifestFileSystem: RunDirectoryFileSystem | undefined = fault === "manifest" ? {
        ...nodeRunDirectoryFileSystem,
        async rename() { throw new Error("manifest rename fault"); },
      } : undefined;
      const journalFileSystem: JournalFileSystem | undefined = fault === "first-journal" ? {
        ...nodeJournalFileSystem,
        async open(target, flags, mode) {
          const handle = await open(target, flags, mode);
          return {
            appendFile: async () => { throw new Error("first journal append fault"); },
            readFile: () => handle.readFile(), sync: () => handle.sync(),
            truncate: (length) => handle.truncate(length),
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
            close: () => handle.close(),
          };
        },
      } : undefined;
      let result;
      let thrown: unknown;
      try {
        result = await runProgram({
          program, sources: { context: "source" }, backend, model, controller,
          dir: lease.dir, signal: new AbortController().signal, runLifecycle: lease.lifecycle,
          ...(manifestFileSystem ? { runDirectoryFileSystem: manifestFileSystem } : {}),
          ...(journalFileSystem ? { journalFileSystem } : {}),
          ...(fault === "context" ? { contextStoreInstrumentation: {
            writeFile: async () => { throw new Error("context publication fault"); },
          } } : {}),
        });
      } catch (error) { thrown = error; }
      if (thrown !== undefined) await lease.abandon();
      else await expect(lease.finish(result!.status, result!.runId)).rejects.toMatchObject({
        code: "RUN_RETENTION_METADATA_FAILED",
      });
      await expect(lstat(lease.dir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("managed release retries an ambiguous durable release and syncs successful active-marker unlink", async () => {
    const path = await root();
    let injected = false;
    let markerUnlinked = false;
    let directorySyncedAfterUnlink = false;
    const store = new ManagedRunStore({
      root: path,
      createToken: ownerTokens(),
      writerArbiterOptions: {
        createToken: (() => { let value = 200; return () => tokenAt(value++); })(),
        async publish(input, options) {
          const result = await publishImmutableArbitrationRecord(input, options);
          if (!injected && input.record.type === "release") {
            injected = true;
            throw new Error("release applied then threw");
          }
          return result;
        },
      },
      metadataFileSystem: {
        async open(target, flags, mode) {
          const handle = await open(target, flags, mode);
          return {
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
            close: () => handle.close(),
            async sync() {
              await handle.sync();
              if (flags === "r" && markerUnlinked) directorySyncedAfterUnlink = true;
            },
          };
        },
        rename,
        async unlink(target) {
          await import("node:fs/promises").then((fs) => fs.unlink(target));
          if (target.endsWith(RUN_ACTIVE_FILE)) markerUnlinked = true;
        },
      },
    });
    const lease = await store.create();
    await publishTerminal(lease, "release-retry");
    expect(injected).toBe(true);
    expect(directorySyncedAfterUnlink).toBe(true);
    await expect(readFile(join(lease.dir, RUN_ACTIVE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
