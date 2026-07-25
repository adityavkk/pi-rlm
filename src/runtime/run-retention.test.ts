import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  cleanupManagedRuns,
  defaultRunStateRoot,
  ManagedRunStore,
  RUN_ACTIVE_FILE,
  RUN_LIFECYCLE_FILE,
  RunRetentionError,
  type RunLifecycleStatus,
} from "./run-retention.ts";

const root = () => mkdtemp(join(tmpdir(), "pi-rlm-retention-"));
const runId = (digit: string) => `run_${digit.repeat(64)}`;
const tokens = () => {
  let value = 0;
  return () => (++value).toString(16).padStart(32, "0");
};
const privateMode = async (path: string) => (await lstat(path)).mode & 0o777;

describe("managed run lifecycle", () => {
  test("uses platform state roots without a shared temporary directory", () => {
    expect(defaultRunStateRoot({ XDG_STATE_HOME: "/state" }, "linux", "/home/a")).toBe("/state/pi-rlm/runs");
    expect(defaultRunStateRoot({}, "linux", "/home/a")).toBe("/home/a/.local/state/pi-rlm/runs");
    expect(defaultRunStateRoot({}, "darwin", "/Users/a")).toContain("Library/Application Support/pi-rlm/runs");
    expect(defaultRunStateRoot({ LOCALAPPDATA: "C:\\state" }, "win32", "C:\\Users\\a")).toContain("pi-rlm");
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
    await lease.lifecycle.onManifest(runId("a"));
    now = 30;
    await lease.finish("completed", runId("a"));
    const listed = await store.list();
    expect(listed.issues).toEqual([]);
    expect(listed.runs[0]).toMatchObject({
      activity: "inactive",
      metadata: { status: "completed", runId: runId("a"), createdAtMs: 10, updatedAtMs: 30, terminalAtMs: 30 },
    });
    await expect(readFile(join(lease.dir, RUN_ACTIVE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["completed", "failed", "cancelled"] as const)("records %s as a retained terminal lifecycle", async (status) => {
    const store = new ManagedRunStore({ root: await root(), createToken: tokens() });
    const lease = await store.create();
    await lease.lifecycle.onManifest(runId(status === "completed" ? "a" : status === "failed" ? "b" : "c"));
    await lease.finish(status);
    expect((await store.list()).runs[0]?.metadata.status).toBe(status);
  });

  test("discard recursively removes a late allocation that never reached its caller", async () => {
    const store = new ManagedRunStore({ root: await root(), createToken: tokens() });
    const lease = await store.create();
    const dir = lease.dir;
    await lease.discard();
    await expect(lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const terminalFixture = async (
  store: ManagedRunStore,
  status: Exclude<RunLifecycleStatus, "active">,
  id: string,
  bytes: number,
): Promise<string> => {
  const lease = await store.create();
  await lease.lifecycle.onManifest(runId(id));
  await writeFile(join(lease.dir, "payload.bin"), Buffer.alloc(bytes), { mode: 0o600 });
  await lease.finish(status);
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
      await new Promise((resolve) => setTimeout(resolve, 10000));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
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

    child.kill();
    await child.exited;
    expect((await host.cleanup()).deleted).toEqual([name]);
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

  test("public cleanup API exposes dry-run and force controls", async () => {
    const path = await root();
    const producer = new ManagedRunStore({ root: path, createToken: tokens() });
    const name = await terminalFixture(producer, "completed", "6", 1);
    const dry = await cleanupManagedRuns({ root: path }, { dryRun: true, force: true });
    expect(dry.wouldDelete).toEqual([name]);
  });
});
