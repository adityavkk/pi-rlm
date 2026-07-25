import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { compileShorthand } from "../core/program.ts";
import { JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ControllerDriver } from "./controller.ts";
import { DEFAULT_PROFILE, resolveLimits } from "./profile.ts";
import { buildRunManifest, claimRunDirectory, RLM_DSL_VERSION } from "./run-manifest.ts";
import {
  cleanupManagedRuns,
  defaultRunStateRoot,
  ManagedRunStore,
  RUN_ACTIVE_FILE,
  RUN_INACTIVE_FILE_PREFIX,
  RUN_LIFECYCLE_FILE,
  RunRetentionError,
  type ManagedRunLease,
  type RunLifecycleStatus,
} from "./run-retention.ts";

const root = () => mkdtemp(join(tmpdir(), "pi-rlm-retention-"));
const tokens = () => {
  let value = 0;
  return () => (++value).toString(16).padStart(32, "0");
};
const privateMode = async (path: string) => (await lstat(path)).mode & 0o777;

const fixtureProgram = (() => {
  const compiled = compileShorthand({ objective: "Retention fixture" });
  if (!compiled.ok) throw new Error("failed to compile retention fixture");
  return compiled.value;
})();
const fixtureBackend: InterpreterBackend = {
  id: "retention-fixture", version: "1", async evalCell() { throw new Error("unused"); }, async dispose() {},
};
const fixtureModel: ModelClient = {
  id: "retention-fixture",
  identity: { id: "test/retention-model", version: "1", configuration: {} },
  async complete() { throw new Error("unused"); },
};
const fixtureController: ControllerDriver = {
  identity: { id: "test/retention-controller", version: "1", configuration: {} },
  async next() { throw new Error("unused"); },
  fork() { return this; },
};

const publishTerminal = async (
  lease: ManagedRunLease,
  status: Exclude<RunLifecycleStatus, "active">,
  nonce: string,
): Promise<string> => {
  const document = buildRunManifest({
    program: fixtureProgram,
    sources: { context: "" },
    profile: DEFAULT_PROFILE,
    limits: resolveLimits(DEFAULT_PROFILE, 0),
    backend: fixtureBackend,
    model: fixtureModel,
    controller: fixtureController,
    dslVersion: RLM_DSL_VERSION,
    createRunNonce: () => nonce,
  });
  await claimRunDirectory(lease.dir, document, undefined, lease.lifecycle.claimEntries);
  const id = document.manifest.run.id;
  await lease.lifecycle.onManifest(id);
  const journal = new JournalStore(lease.dir);
  if (status === "completed") await journal.append({ type: "run_completed", runId: id, completionMode: "answer" });
  else if (status === "failed") await journal.append({ type: "run_failed", runId: id, code: "TEST_FAILURE", message: "fixture failed" });
  else await journal.append({ type: "run_cancelled", runId: id, code: "CANCELLED", message: "run cancelled by owner" });
  await lease.finish(status, id);
  return id;
};

describe("managed run lifecycle", () => {
  test("uses platform state roots without a shared temporary directory", () => {
    expect(defaultRunStateRoot({ XDG_STATE_HOME: "/state" }, "linux", "/home/a")).toBe("/state/pi-rlm/runs");
    expect(defaultRunStateRoot({ XDG_STATE_HOME: "  " }, "linux", "/home/a")).toBe("/home/a/.local/state/pi-rlm/runs");
    expect(defaultRunStateRoot({}, "linux", "/home/a")).toBe("/home/a/.local/state/pi-rlm/runs");
    expect(defaultRunStateRoot({}, "darwin", "/Users/a")).toContain("Library/Application Support/pi-rlm/runs");
    expect(defaultRunStateRoot({ LOCALAPPDATA: " " }, "win32", "C:\\Users\\a")).toContain("AppData");
    expect(defaultRunStateRoot({ LOCALAPPDATA: "C:\\state" }, "win32", "C:\\Users\\a")).toContain("pi-rlm");
    expect(() => new ManagedRunStore({ root: "relative/runs" })).toThrow(expect.objectContaining({ code: "RUN_RETENTION_ROOT_INVALID" }));
    expect(() => new ManagedRunStore({ root: "   " })).toThrow(expect.objectContaining({ code: "RUN_RETENTION_ROOT_INVALID" }));
  });

  test("binds created, manifest, and terminal metadata with private modes", async () => {
    let now = 10;
    const store = new ManagedRunStore({ root: await root(), now: () => now, createToken: tokens() });
    const lease = await store.create();
    expect(lease.name).toMatch(/^run-[a-f0-9]{32}$/);
    expect(await privateMode(store.root)).toBe(0o700);
    expect(await privateMode(lease.dir)).toBe(0o700);
    expect(await privateMode(join(lease.dir, RUN_LIFECYCLE_FILE))).toBe(0o600);
    expect(await privateMode(join(lease.dir, RUN_ACTIVE_FILE))).toBe(0o600);
    expect((await store.list()).runs[0]).toMatchObject({ activity: "owned", metadata: { status: "active", createdAtMs: 10 } });

    now = 20;
    const id = await publishTerminal(lease, "completed", "bound-fixture");
    now = 30;
    const listed = await store.list();
    expect(listed.issues).toEqual([]);
    expect(listed.runs[0]).toMatchObject({
      activity: "inactive",
      metadata: { status: "completed", runId: id, createdAtMs: 10, updatedAtMs: 20, terminalAtMs: 20 },
    });
    await expect(readFile(join(lease.dir, RUN_ACTIVE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["completed", "failed", "cancelled"] as const)("records %s as a retained terminal lifecycle", async (status) => {
    const store = new ManagedRunStore({ root: await root(), createToken: tokens() });
    const lease = await store.create();
    await publishTerminal(lease, status, `status-${status}`);
    expect((await store.list()).runs[0]?.metadata.status).toBe(status);
  });

  test("discard recursively removes a late allocation that never reached its caller", async () => {
    const store = new ManagedRunStore({ root: await root(), createToken: tokens() });
    const lease = await store.create();
    const dir = lease.dir;
    await lease.discard();
    await expect(lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("finish without strict manifest and terminal journal evidence releases an abandoned lifecycle", async () => {
    const store = new ManagedRunStore({ root: await root(), createToken: tokens() });
    const lease = await store.create();
    await expect(lease.finish("failed", `run_${"a".repeat(64)}`)).rejects.toMatchObject({ code: "RUN_RETENTION_METADATA_FAILED" });
    expect((await store.list()).runs[0]).toMatchObject({ metadata: { status: "active" }, activity: "stale" });
    await expect(readFile(join(lease.dir, RUN_ACTIVE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("marker unlink failure falls back to an owner-bound inactive tombstone", async () => {
    const path = await root();
    const metadataFileSystem = {
      async open(path: string, flags: string | number, mode?: number) { return open(path, flags, mode); },
      rename,
      async unlink(path: string) {
        if (path.endsWith(RUN_ACTIVE_FILE)) throw Object.assign(new Error("injected active marker unlink failure"), { code: "EIO" });
        await unlink(path);
      },
    };
    const store = new ManagedRunStore({ root: path, createToken: tokens(), metadataFileSystem });
    const lease = await store.create();
    await publishTerminal(lease, "completed", "marker-unlink-fallback");
    const listed = (await store.list()).runs[0]!;
    expect(listed.activity).toBe("inactive");
    expect(await readdir(lease.dir)).toContain(`${RUN_INACTIVE_FILE_PREFIX}${listed.metadata.owner}.json`);
    await expect(readFile(join(lease.dir, RUN_ACTIVE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await new ManagedRunStore({ root: path }).cleanup({ force: true })).deleted).toEqual([lease.name]);
  });

  test.each(["rename", "sync"] as const)("compounded tombstone %s failure releases in-process ownership with a typed error", async (fault) => {
    const path = await root();
    let tombstoneMoved = false;
    const metadataFileSystem = {
      async open(path: string, flags: string | number, mode?: number) {
        const handle = await open(path, flags, mode);
        return {
          writeFile: (data: string, encoding: BufferEncoding) => handle.writeFile(data, encoding),
          async sync() {
            if (fault === "sync" && tombstoneMoved && flags === "r")
              throw Object.assign(new Error("injected tombstone directory sync failure"), { code: "EIO" });
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
      async rename(from: string, to: string) {
        if (from.endsWith(RUN_ACTIVE_FILE)) {
          if (fault === "rename") throw Object.assign(new Error("injected tombstone rename failure"), { code: "EIO" });
          await rename(from, to);
          tombstoneMoved = true;
          return;
        }
        await rename(from, to);
      },
      async unlink(path: string) {
        if (path.endsWith(RUN_ACTIVE_FILE)) throw Object.assign(new Error("injected active marker unlink failure"), { code: "EIO" });
        await unlink(path);
      },
    };
    const store = new ManagedRunStore({ root: path, createToken: tokens(), metadataFileSystem });
    const lease = await store.create();
    await expect(publishTerminal(lease, "completed", `marker-${fault}`)).rejects.toMatchObject({
      code: "RUN_RETENTION_METADATA_FAILED",
      cause: expect.any(AggregateError),
    });
    const listed = (await store.list()).runs[0]!;
    expect(listed.activity).not.toBe("owned");
    expect(listed.activity).toBe(fault === "rename" ? "ambiguous" : "inactive");
    if (fault === "sync")
      expect(await readdir(lease.dir)).toContain(`${RUN_INACTIVE_FILE_PREFIX}${listed.metadata.owner}.json`);
  });
});

const terminalFixture = async (
  store: ManagedRunStore,
  status: Exclude<RunLifecycleStatus, "active">,
  id: string,
  bytes: number,
): Promise<string> => {
  const lease = await store.create();
  await publishTerminal(lease, status, `terminal-${id}`);
  await writeFile(join(lease.dir, "payload.bin"), Buffer.alloc(bytes), { mode: 0o600 });
  return lease.name;
};

describe("bounded deterministic retention", () => {
  test("dry-run and cleanup select oldest-first across age, count, and exact aggregate bytes", async () => {
    let now = 10;
    const path = await root();
    const producer = new ManagedRunStore({ root: path, now: () => now, createToken: tokens() });
    const oldest = await terminalFixture(producer, "completed", "1", 8);
    now = 20;
    const middle = await terminalFixture(producer, "failed", "2", 8);
    now = 30;
    const newest = await terminalFixture(producer, "cancelled", "3", 8);

    now = 40;
    const produced = await producer.list();
    const newestBytes = produced.runs.find((run) => run.name === newest)!.bytes;
    const policy = {
      terminalMaxAgeMs: 15,
      maxTerminalRuns: 2,
      maxTerminalBytes: newestBytes,
      abandonedGraceMs: 100,
    };
    const sweeper = new ManagedRunStore({ root: path, now: () => now, policy });
    const dry = await sweeper.cleanup({ dryRun: true });
    expect(dry.wouldDelete).toEqual([oldest, middle]);
    expect(dry.deleted).toEqual([]);
    expect((await sweeper.list()).runs).toHaveLength(3);

    const cleaned = await sweeper.cleanup();
    expect(cleaned.deleted).toEqual([oldest, middle]);
    expect(cleaned.retained).toEqual([newest]);
    expect((await sweeper.list()).runs.map((run) => run.name)).toEqual([newest]);
  });

  test("force removes all inactive terminals but not a live nonterminal lease", async () => {
    const path = await root();
    const createToken = tokens();
    const terminalStore = new ManagedRunStore({ root: path, createToken });
    const terminal = await terminalFixture(terminalStore, "completed", "4", 1);
    const liveStore = new ManagedRunStore({ root: path, createToken, processProbe: () => true });
    const live = await liveStore.create();
    const result = await liveStore.cleanup({ force: true });
    expect(result.deleted).toEqual([terminal]);
    expect(result.retained).toContain(live.name);
    await live.discard();
  });

  test("removes only old abandoned runs with a definitely stale or absent marker", async () => {
    let now = 1;
    const path = await root();
    const producer = new ManagedRunStore({ root: path, now: () => now, createToken: tokens() });
    const stale = await producer.create();
    now = 200;
    const restarted = new ManagedRunStore({
      root: path,
      now: () => now,
      policy: { abandonedGraceMs: 100 },
      processProbe: () => false,
    });
    // Same-process registry is authoritative until process exit, so this lease remains protected.
    expect((await restarted.cleanup()).retained).toContain(stale.name);
    await stale.discard();

    const abandonedName = "run-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const abandonedDir = join(path, abandonedName);
    await mkdir(abandonedDir, { mode: 0o700 });
    const abandonedOwner = "f".repeat(32);
    await writeFile(join(abandonedDir, RUN_LIFECYCLE_FILE), JSON.stringify({
      schemaVersion: 1, status: "active", owner: abandonedOwner, createdAtMs: 1, updatedAtMs: 1,
    }), { mode: 0o600 });
    await writeFile(join(abandonedDir, RUN_ACTIVE_FILE), JSON.stringify({
      schemaVersion: 1, pid: 999_999, owner: abandonedOwner, startedAtMs: 1,
    }), { mode: 0o600 });
    expect((await restarted.cleanup()).deleted).toEqual([abandonedName]);
  });

  test("keeps a live child-process lease, then reclaims it after process crash and restart grace", async () => {
    const path = await root();
    const moduleUrl = new URL("./run-retention.ts", import.meta.url).href;
    const script = `
      const { ManagedRunStore } = await import(${JSON.stringify(moduleUrl)});
      const lease = await new ManagedRunStore({ root: ${JSON.stringify(path)} }).create();
      process.stdout.write(lease.name + "\\n");
      await Bun.stdin.text();
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const name = new TextDecoder().decode(first.value).trim();
    expect(name).toMatch(/^run-[a-f0-9]{32}$/);

    const host = new ManagedRunStore({
      root: path,
      now: () => Date.now() + 1_000,
      policy: { abandonedGraceMs: 0 },
    });
    expect((await host.list()).runs[0]).toMatchObject({ name, activity: "live" });
    expect((await host.cleanup()).retained).toEqual([name]);

    child.stdin.end();
    await child.exited;
    expect((await host.cleanup()).deleted).toEqual([name]);
  });

  test("a cleanup process cannot delete a run while another process publishes its lease under the lifecycle claim", async () => {
    const path = await root();
    const moduleUrl = new URL("./run-retention.ts", import.meta.url).href;
    const script = `
      const fs = await import("node:fs/promises");
      const { ManagedRunStore, RUN_ACTIVE_FILE } = await import(${JSON.stringify(moduleUrl)});
      let paused = false;
      const metadataFileSystem = {
        async open(path, flags, mode) {
          const handle = await fs.open(path, flags, mode);
          return {
            async writeFile(data, encoding) {
              if (!paused && path.includes(RUN_ACTIVE_FILE)) {
                paused = true;
                process.stdout.write("CLAIMED\\n");
                await Bun.stdin.text();
              }
              await handle.writeFile(data, encoding);
            },
            async sync() { await handle.sync(); },
            async close() { await handle.close(); },
          };
        },
        rename: fs.rename,
        unlink: fs.unlink,
      };
      const lease = await new ManagedRunStore({ root: ${JSON.stringify(path)}, metadataFileSystem }).create();
      process.stdout.write("READY " + lease.name + "\\n");
      await new Promise(() => {});
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const claimed = new TextDecoder().decode((await reader.read()).value).trim();
    expect(claimed).toBe("CLAIMED");
    expect((await new ManagedRunStore({ root: path, policy: { abandonedGraceMs: 0 } }).cleanup()).skipped)
      .toEqual([{ runName: expect.stringMatching(/^run-/), reason: "already_claimed" }]);
    child.stdin.end();
    const ready = new TextDecoder().decode((await reader.read()).value).trim();
    reader.releaseLock();
    const name = ready.replace(/^READY /, "");
    expect(name).toMatch(/^run-[a-f0-9]{32}$/);
    const host = new ManagedRunStore({ root: path, policy: { abandonedGraceMs: 0 } });
    expect((await host.cleanup()).retained).toContain(name);
    child.kill();
    await child.exited;
    expect((await host.cleanup()).deleted).toEqual([name]);
  });

  test("two process-isolated managers list the same candidate before exactly one deletes it", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "process-cleaners", 1);
    const moduleUrl = new URL("./run-retention.ts", import.meta.url).href;
    const script = `
      const { ManagedRunStore } = await import(${JSON.stringify(moduleUrl)});
      const store = new ManagedRunStore({
        root: ${JSON.stringify(path)},
        beforeCleanupDecision: async () => {
          process.stdout.write("LISTED\\n");
          await Bun.stdin.text();
        },
      });
      const result = await store.cleanup({ force: true });
      process.stdout.write(JSON.stringify({ deleted: result.deleted, skipped: result.skipped }) + "\\n");
    `;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    }));
    const readers = children.map((child) => child.stdout.getReader());
    for (const reader of readers)
      expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("LISTED");
    for (const child of children) child.stdin.end();
    const outcomes: Array<{ deleted: string[]; skipped: Array<{ runName: string; reason: string }> }> = [];
    for (const reader of readers) {
      outcomes.push(JSON.parse(new TextDecoder().decode((await reader.read()).value).trim()));
      reader.releaseLock();
    }
    await Promise.all(children.map((child) => child.exited));
    expect(outcomes.flatMap((outcome) => outcome.deleted)).toEqual([name]);
    expect(outcomes.flatMap((outcome) => outcome.skipped)).toEqual([
      { runName: name, reason: expect.stringMatching(/^already_(?:removed|claimed)$/) },
    ]);
    expect(await readdir(path)).toEqual([]);
  });

  test.each(["manifest.json", "events.jsonl", RUN_LIFECYCLE_FILE])(
    "missing %s evidence remains a typed retained run",
    async (evidence) => {
      const path = await root();
      const producer = new ManagedRunStore({ root: path, createToken: tokens() });
      const name = await terminalFixture(producer, "completed", `missing-${evidence}`, 1);
      await unlink(join(path, name, evidence));
      let failure: unknown;
      try { await producer.cleanup({ force: true }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({
        code: expect.stringMatching(/^RUN_RETENTION_(?:CLEANUP_FAILED|POLICY_UNSATISFIED)$/),
        result: { deleted: [], skipped: [], retained: [name] },
      });
      expect((await lstat(join(path, name))).isDirectory()).toBe(true);
      expect((failure as RunRetentionError).result?.issues.some((issue) => issue.runName === name)).toBe(true);
    },
  );

  test.each(["stale", "ambiguous"] as const)("a %s cross-process lifecycle claim is skipped as already claimed", async (kind) => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", `process-claim-${kind}`, 1);
    const claimPath = join(path, name, ".pi-rlm-lifecycle.claim");
    const script = `
      const { open } = await import("node:fs/promises");
      const handle = await open(${JSON.stringify(claimPath)}, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid }) + "\\n");
      await handle.sync();
      await handle.close();
      process.stdout.write("READY\\n");
      await new Promise(() => {});
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode((await child.stdout.getReader().read()).value).trim()).toBe("READY");
    if (kind === "stale") { child.kill(); await child.exited; }
    expect((await new ManagedRunStore({ root: path }).cleanup({ force: true })).skipped)
      .toEqual([{ runName: name, reason: "already_claimed" }]);
    expect((await lstat(join(path, name))).isDirectory()).toBe(true);
    if (kind === "ambiguous") { child.kill(); await child.exited; }
  });

  test("cleanup failure is typed, observable, and reports the retained run", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "5", 1);
    const failing = new ManagedRunStore({
      root: path,
      policy: { terminalMaxAgeMs: 0 },
      removeDirectory: async () => { throw Object.assign(new Error("injected removal failure"), { code: "EIO" }); },
    });
    let failure: unknown;
    try { await failing.cleanup(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RunRetentionError);
    expect(failure).toMatchObject({ code: "RUN_RETENTION_POLICY_UNSATISFIED", result: { retained: [name] } });
  });

  test("remover ENOENT retains a quarantine that still exists and exposes the typed residual", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens(), now: () => 1 });
    const name = await terminalFixture(producer, "completed", "remover-enoent-residual", 1);
    const nested = Object.assign(new Error("nested removal evidence disappeared"), { code: "ENOENT" });
    const removal = Object.assign(new Error("injected remover ENOENT", { cause: nested }), { code: "ENOENT" });
    const failing = new ManagedRunStore({
      root: path,
      now: () => 2,
      removeDirectory: async () => { throw removal; },
    });
    let failure: unknown;
    try { await failing.cleanup({ force: true }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RunRetentionError);
    expect(failure).toMatchObject({
      code: "RUN_RETENTION_CLEANUP_FAILED",
      result: { deleted: [], skipped: [], retained: [name] },
      survivors: [{ kind: "quarantine" }],
    });
    const quarantines = (await readdir(path)).filter((entry) => entry.startsWith(".pi-rlm-quarantine-"));
    expect(quarantines).toHaveLength(1);
    expect((await lstat(join(path, quarantines[0]!))).isDirectory()).toBe(true);
    expect((failure as RunRetentionError).cause).toBeInstanceOf(AggregateError);
  });

  test("remover failure skips a loser only when the whole quarantine is absent", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens(), now: () => 1 });
    const name = await terminalFixture(producer, "completed", "remover-absent", 1);
    const sweeper = new ManagedRunStore({
      root: path,
      now: () => 2,
      removeDirectory: async (quarantine) => {
        await rm(quarantine, { recursive: true });
        throw Object.assign(new Error("remover lost its completed result"), { code: "EIO" });
      },
    });
    const result = await sweeper.cleanup({ force: true });
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([{ runName: name, reason: "already_removed" }]);
    expect(result.retained).toEqual([]);
    expect((await readdir(path)).filter((entry) => entry.startsWith(".pi-rlm-quarantine-"))).toEqual([]);
  });

  test("rereads a selected lifecycle under claim and retains a newly published lease", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "lease-race", 1);
    const listed = (await producer.list()).runs[0]!;
    const sweeper = new ManagedRunStore({
      root: path,
      beforeCleanupDecision: async (runPath) => {
        await writeFile(join(runPath, RUN_ACTIVE_FILE), JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          owner: listed.metadata.owner,
          startedAtMs: listed.metadata.createdAtMs,
        }), { mode: 0o600 });
      },
    });
    const result = await sweeper.cleanup({ force: true });
    expect(result.deleted).toEqual([]);
    expect(result.retained).toContain(name);
    expect(await lstat(listed.path)).toMatchObject({ isDirectory: expect.any(Function) });
  });

  test("quarantine deletion preserves a replacement published at the old run name", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "replacement", 1);
    const oldPath = join(path, name);
    const sweeper = new ManagedRunStore({
      root: path,
      createToken: tokens(),
      removeDirectory: async (quarantine) => {
        await mkdir(oldPath, { mode: 0o700 });
        await writeFile(join(oldPath, "replacement"), "keep", { mode: 0o600 });
        await rm(quarantine, { recursive: true });
      },
    });
    expect((await sweeper.cleanup({ force: true })).deleted).toEqual([name]);
    expect(await readFile(join(oldPath, "replacement"), "utf8")).toBe("keep");
  });

  test("serializes two concurrent cleanup decisions with one exclusive lifecycle claim", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "concurrent", 1);
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    let enteredRemoval!: () => void;
    const removalEntered = new Promise<void>((resolve) => { enteredRemoval = resolve; });
    let removals = 0;
    const first = new ManagedRunStore({
      root: path,
      removeDirectory: async (quarantine) => {
        removals++;
        enteredRemoval();
        await removalGate;
        await rm(quarantine, { recursive: true });
      },
    });
    const second = new ManagedRunStore({ root: path });
    const firstWork = first.cleanup({ force: true });
    await removalEntered;
    let secondFailure: unknown;
    try { await second.cleanup({ force: true }); } catch (error) { secondFailure = error; }
    releaseRemoval();
    const firstResult = await firstWork;
    expect(firstResult.deleted).toEqual([name]);
    expect(secondFailure).toMatchObject({ code: "RUN_RETENTION_CLEANUP_FAILED" });
    expect(removals).toBe(1);
  });
});

describe("malformed and link rejection", () => {
  test("reports malformed entries and never follows a run-directory symlink", async () => {
    const path = await root();
    const outside = await root();
    await writeFile(join(outside, "keep"), "outside");
    await symlink(outside, join(path, "run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "dir");
    await writeFile(join(path, "not-a-run"), "malformed");
    const store = new ManagedRunStore({ root: path });
    const listing = await store.list();
    expect(listing.issues).toHaveLength(2);
    await expect(store.cleanup()).rejects.toMatchObject({ code: "RUN_RETENTION_CLEANUP_FAILED" });
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("outside");
  });

  test("rejects a symlink root before changing its target permissions", async () => {
    const parent = await root();
    const outside = await root();
    await chmod(outside, 0o755);
    const linked = join(parent, "managed-link");
    await symlink(outside, linked, "dir");
    await expect(new ManagedRunStore({ root: linked }).list()).rejects.toMatchObject({ code: "RUN_RETENTION_ROOT_INVALID" });
    expect(await privateMode(outside)).toBe(0o755);
  });

  test("rejects root identity changes and non-private run modes", async () => {
    const path = await root();
    const store = new ManagedRunStore({ root: path, createToken: tokens() });
    const lease = await store.create();
    await chmod(lease.dir, 0o755);
    expect((await store.list()).issues[0]).toMatchObject({ code: "SCAN_FAILED", runName: lease.name });
    await chmod(lease.dir, 0o700);
    await lease.discard();
  });

  test("stops a huge invalid root fanout at the single global entry cap", async () => {
    const path = await root();
    await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(join(path, `invalid-${index}`), "x")));
    const store = new ManagedRunStore({ root: path, policy: { maxScanEntries: 1 } });
    await expect(store.list()).rejects.toMatchObject({ code: "RUN_RETENTION_SCAN_LIMIT" });
  });

  test("retains and types a lifecycle status that disagrees with the authoritative terminal journal", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "mismatch", 1);
    const lifecyclePath = join(path, name, RUN_LIFECYCLE_FILE);
    const lifecycle = JSON.parse(await readFile(lifecyclePath, "utf8")) as Record<string, unknown>;
    lifecycle["status"] = "failed";
    await writeFile(lifecyclePath, `${JSON.stringify(lifecycle)}\n`, { mode: 0o600 });
    await expect(producer.cleanup({ force: true })).rejects.toMatchObject({ code: "RUN_RETENTION_CLEANUP_FAILED" });
    expect((await producer.list()).runs.map((run) => run.name)).toContain(name);
  });

  test("rejects a configured non-directory root", async () => {
    const parent = await root();
    const file = join(parent, "root-file");
    await writeFile(file, "not a directory");
    await expect(new ManagedRunStore({ root: file }).list()).rejects.toMatchObject({ code: "RUN_RETENTION_ROOT_INVALID" });
  });

  test("public cleanup API exposes dry-run and force controls", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "6", 1);
    const dry = await cleanupManagedRuns({ root: path }, { dryRun: true, force: true });
    expect(dry.wouldDelete).toEqual([name]);
  });
});
