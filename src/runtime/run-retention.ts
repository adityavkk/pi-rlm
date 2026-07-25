/** Host-owned persistent run directories, active leases, and bounded retention. */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RUN_LIFECYCLE_FILE = ".pi-rlm-lifecycle.json";
export const RUN_ACTIVE_FILE = ".pi-rlm-active.json";
export const MANAGED_RUN_CLAIM_ENTRIES = Object.freeze([RUN_LIFECYCLE_FILE, RUN_ACTIVE_FILE]);

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const OWNER = /^[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{64}$/;
const METADATA_LIMIT_BYTES = 64 * 1024;
const activeOwners = new Map<string, string>();

export interface RunRetentionPolicy {
  /** Terminal runs older than this are removed. Default: 30 days. */
  readonly terminalMaxAgeMs: number;
  /** Maximum retained terminal runs. Default: 100. */
  readonly maxTerminalRuns: number;
  /** Maximum aggregate terminal payload bytes. Default: 1 GiB. */
  readonly maxTerminalBytes: number;
  /** Nonterminal runs need this stale period before abandoned cleanup. Default: 90 days. */
  readonly abandonedGraceMs: number;
  /** Maximum filesystem entries examined in one exact byte scan. Default: 100,000. */
  readonly maxScanEntries: number;
  /** Maximum directory nesting examined. Default: 64. */
  readonly maxScanDepth: number;
}

export const DEFAULT_RUN_RETENTION_POLICY: Readonly<RunRetentionPolicy> = Object.freeze({
  terminalMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxTerminalRuns: 100,
  maxTerminalBytes: 1024 * 1024 * 1024,
  abandonedGraceMs: 90 * 24 * 60 * 60 * 1_000,
  maxScanEntries: 100_000,
  maxScanDepth: 64,
});

export type RunLifecycleStatus = "active" | "completed" | "failed" | "cancelled";

export interface RunLifecycleMetadata {
  readonly schemaVersion: 1;
  readonly status: RunLifecycleStatus;
  readonly owner: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly runId?: string;
  readonly terminalAtMs?: number;
}

interface ActiveMarker {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly owner: string;
  readonly startedAtMs: number;
}

export type ManagedRunActivity = "owned" | "live" | "inactive" | "stale" | "ambiguous";

export interface ManagedRunInfo {
  readonly name: string;
  readonly path: string;
  readonly metadata: RunLifecycleMetadata;
  readonly bytes: number;
  readonly activity: ManagedRunActivity;
}

export interface RunRetentionIssue {
  readonly code: "INVALID_ENTRY" | "SCAN_FAILED" | "CLEANUP_FAILED" | "POLICY_UNSATISFIED";
  readonly runName?: string;
  readonly message: string;
  readonly cause?: unknown;
}

export interface ManagedRunListing {
  readonly root: string;
  readonly runs: readonly ManagedRunInfo[];
  readonly issues: readonly RunRetentionIssue[];
}

export interface RunCleanupOptions {
  readonly dryRun?: boolean;
  /** Delete every safely inactive terminal run, while preserving active and not-yet-abandoned runs. */
  readonly force?: boolean;
}

export interface RunCleanupResult extends ManagedRunListing {
  readonly deleted: readonly string[];
  readonly wouldDelete: readonly string[];
  readonly retained: readonly string[];
}

export type RunRetentionErrorCode =
  | "RUN_RETENTION_ROOT_INVALID"
  | "RUN_RETENTION_CREATE_FAILED"
  | "RUN_RETENTION_METADATA_FAILED"
  | "RUN_RETENTION_CLEANUP_FAILED"
  | "RUN_RETENTION_POLICY_UNSATISFIED";

export class RunRetentionError extends Error {
  override readonly name = "RunRetentionError";
  constructor(
    readonly code: RunRetentionErrorCode,
    message: string,
    override readonly cause?: unknown,
    readonly result?: RunCleanupResult,
  ) { super(message); }
}

export interface ManagedRunStoreOptions {
  readonly root?: string;
  readonly policy?: Partial<RunRetentionPolicy>;
  readonly now?: () => number;
  readonly createToken?: () => string;
  /** true: live, false: definitely absent, undefined: unsupported/ambiguous. */
  readonly processProbe?: (pid: number) => boolean | undefined;
  /** Fault-test seam. Production default is recursive node:fs removal. */
  readonly removeDirectory?: (path: string) => Promise<void>;
}

const safeInteger = (value: number, field: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${field} must be a safe integer >= ${minimum}`);
  return value;
};

const resolvedPolicy = (partial: Partial<RunRetentionPolicy> | undefined): RunRetentionPolicy => {
  const value = { ...DEFAULT_RUN_RETENTION_POLICY, ...partial };
  return {
    terminalMaxAgeMs: safeInteger(value.terminalMaxAgeMs, "terminalMaxAgeMs"),
    maxTerminalRuns: safeInteger(value.maxTerminalRuns, "maxTerminalRuns"),
    maxTerminalBytes: safeInteger(value.maxTerminalBytes, "maxTerminalBytes"),
    abandonedGraceMs: safeInteger(value.abandonedGraceMs, "abandonedGraceMs"),
    maxScanEntries: safeInteger(value.maxScanEntries, "maxScanEntries", 1),
    maxScanDepth: safeInteger(value.maxScanDepth, "maxScanDepth", 1),
  };
};

export const defaultRunStateRoot = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  home = homedir(),
): string => {
  if (platform === "darwin") return join(home, "Library", "Application Support", "pi-rlm", "runs");
  if (platform === "win32") return join(env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "pi-rlm", "runs");
  return join(env["XDG_STATE_HOME"] ?? join(home, ".local", "state"), "pi-rlm", "runs");
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

const processProbe = (pid: number): boolean | undefined => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "ESRCH" ? false : undefined; }
};

const exactFields = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  return required.every((field) => keys.includes(field)) && keys.every((field) => allowed.includes(field));
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : undefined;

const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const parseLifecycle = (value: unknown): RunLifecycleMetadata => {
  const item = record(value);
  if (!item || !exactFields(item, ["schemaVersion", "status", "owner", "createdAtMs", "updatedAtMs"], ["runId", "terminalAtMs"])
    || item["schemaVersion"] !== 1
    || (item["status"] !== "active" && item["status"] !== "completed" && item["status"] !== "failed" && item["status"] !== "cancelled")
    || typeof item["owner"] !== "string" || !OWNER.test(item["owner"])
    || !timestamp(item["createdAtMs"]) || !timestamp(item["updatedAtMs"])
    || item["updatedAtMs"] < item["createdAtMs"]
    || (item["runId"] !== undefined && (typeof item["runId"] !== "string" || !RUN_ID.test(item["runId"]))))
    throw new TypeError("invalid run lifecycle metadata");
  const terminal = item["status"] !== "active";
  if (terminal !== timestamp(item["terminalAtMs"]) || (terminal && (item["terminalAtMs"] as number) < item["updatedAtMs"]))
    throw new TypeError("invalid terminal lifecycle metadata");
  return item as unknown as RunLifecycleMetadata;
};

const parseMarker = (value: unknown, metadata: RunLifecycleMetadata): ActiveMarker => {
  const item = record(value);
  if (!item || !exactFields(item, ["schemaVersion", "pid", "owner", "startedAtMs"])
    || item["schemaVersion"] !== 1 || !Number.isSafeInteger(item["pid"]) || (item["pid"] as number) <= 0
    || item["owner"] !== metadata.owner || item["startedAtMs"] !== metadata.createdAtMs)
    throw new TypeError("invalid active lease marker");
  return item as unknown as ActiveMarker;
};

const privateJson = async (dir: string, name: string, value: object, token: string): Promise<void> => {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${token}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, target); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
  const directory = await open(dir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
};

const readBoundedJson = async (path: string): Promise<unknown> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > METADATA_LIMIT_BYTES)
    throw new TypeError("metadata path must be one bounded regular file");
  return JSON.parse((await readFile(path, "utf8")).trim()) as unknown;
};

interface RootIdentity { readonly real: string; readonly dev: number; readonly ino: number }
interface ScanBudget { entries: number }

export class ManagedRunLease {
  private runId: string | undefined;
  private closed = false;

  constructor(
    private readonly store: ManagedRunStore,
    readonly name: string,
    readonly dir: string,
    private metadata: RunLifecycleMetadata,
  ) {}

  readonly lifecycle = {
    claimEntries: MANAGED_RUN_CLAIM_ENTRIES,
    onManifest: async (runId: string): Promise<void> => {
      if (this.closed || !RUN_ID.test(runId)) throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "invalid managed run identity");
      this.runId = runId;
      this.metadata = { ...this.metadata, runId, updatedAtMs: this.store.time() };
      await this.store.writeLifecycle(this.dir, this.metadata);
    },
  };

  async finish(status: Exclude<RunLifecycleStatus, "active">, runId?: string): Promise<void> {
    if (this.closed) return;
    const identity = runId ?? this.runId;
    if (identity !== undefined && (!RUN_ID.test(identity) || (this.runId !== undefined && identity !== this.runId)))
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed run identity changed before terminal update");
    const now = this.store.time();
    this.metadata = { ...this.metadata, status, ...(identity ? { runId: identity } : {}), updatedAtMs: now, terminalAtMs: now };
    try { await this.store.writeLifecycle(this.dir, this.metadata); await this.store.release(this.dir, this.metadata); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "failed to persist terminal run lifecycle", cause); }
    this.closed = true;
  }

  /** Remove an allocation that never became visible to its cancelled caller. */
  async discard(): Promise<void> {
    if (this.closed) return;
    try { await this.store.release(this.dir, this.metadata); await this.store.removeOwned(this.name, this.dir); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "failed to remove unused run allocation", cause); }
    this.closed = true;
  }
}

export class ManagedRunStore {
  readonly root: string;
  readonly policy: RunRetentionPolicy;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly probe: (pid: number) => boolean | undefined;
  private readonly remover: (path: string) => Promise<void>;
  private rootIdentity: RootIdentity | undefined;

  constructor(options: ManagedRunStoreOptions = {}) {
    this.root = resolve(options.root ?? defaultRunStateRoot());
    if (!isAbsolute(this.root)) throw new TypeError("managed run root must be absolute");
    this.policy = resolvedPolicy(options.policy);
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? (() => randomBytes(16).toString("hex"));
    this.probe = options.processProbe ?? processProbe;
    this.remover = options.removeDirectory ?? ((path) => rm(path, { recursive: true, force: false }));
  }

  time(): number { return safeInteger(this.now(), "now"); }

  private token(): string {
    const value = this.createToken();
    if (!OWNER.test(value)) throw new TypeError("managed run token must be 32 lowercase hexadecimal characters");
    return value;
  }

  private contained(path: string): boolean {
    const rel = relative(this.root, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
  }

  private async ensureRoot(): Promise<void> {
    try { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "failed to create private managed run root", cause); }
    let info = await lstat(this.root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run root must be a real directory");
    try { await chmod(this.root, 0o700); info = await lstat(this.root); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "failed to secure managed run root", cause); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run root identity changed while securing it");
    const identity = { real: await realpath(this.root), dev: info.dev, ino: info.ino };
    if (this.rootIdentity && (identity.real !== this.rootIdentity.real || identity.dev !== this.rootIdentity.dev || identity.ino !== this.rootIdentity.ino))
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run root identity changed");
    this.rootIdentity ??= identity;
  }

  async create(): Promise<ManagedRunLease> {
    await this.cleanup();
    await this.ensureRoot();
    const name = `run-${this.token()}`;
    const dir = join(this.root, name);
    if (!RUN_NAME.test(name) || dirname(dir) !== this.root || !this.contained(dir))
      throw new RunRetentionError("RUN_RETENTION_CREATE_FAILED", "unsafe managed run directory name");
    const owner = this.token();
    const createdAtMs = this.time();
    const metadata: RunLifecycleMetadata = { schemaVersion: 1, status: "active", owner, createdAtMs, updatedAtMs: createdAtMs };
    try {
      await mkdir(dir, { mode: 0o700 });
      activeOwners.set(dir, owner);
      await this.writeLifecycle(dir, metadata);
      await privateJson(dir, RUN_ACTIVE_FILE, { schemaVersion: 1, pid: process.pid, owner, startedAtMs: createdAtMs }, this.token());
      return new ManagedRunLease(this, name, dir, metadata);
    } catch (cause) {
      activeOwners.delete(dir);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new RunRetentionError("RUN_RETENTION_CREATE_FAILED", "failed to create managed run directory", cause);
    }
  }

  async writeLifecycle(dir: string, metadata: RunLifecycleMetadata): Promise<void> {
    await this.ensureRunPath(dir);
    try { await privateJson(dir, RUN_LIFECYCLE_FILE, metadata, this.token()); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "failed to persist run lifecycle metadata", cause); }
  }

  private async ensureRunPath(dir: string): Promise<void> {
    await this.ensureRoot();
    const name = dir.slice(this.root.length + 1);
    if (!RUN_NAME.test(name) || dirname(dir) !== this.root || !this.contained(dir))
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "run path escapes managed root");
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run path is not a directory");
  }

  async release(dir: string, metadata: RunLifecycleMetadata): Promise<void> {
    await this.ensureRunPath(dir);
    const path = join(dir, RUN_ACTIVE_FILE);
    const marker = parseMarker(await readBoundedJson(path), metadata);
    if (marker.pid !== process.pid || activeOwners.get(dir) !== marker.owner)
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "active lease owner changed before release");
    await unlink(path);
    activeOwners.delete(dir);
  }

  private async scanBytes(path: string, budget: ScanBudget, depth = 0): Promise<number> {
    if (depth > this.policy.maxScanDepth) throw new Error("run tree exceeds maximum scan depth");
    budget.entries++;
    if (budget.entries > this.policy.maxScanEntries) throw new Error("managed run scan entry limit exceeded");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("managed run tree contains a symbolic link");
    if (info.isFile()) return safeInteger(info.size, "file size");
    if (!info.isDirectory()) throw new Error("managed run tree contains a non-file entry");
    let bytes = 0;
    for (const name of (await readdir(path)).sort()) {
      bytes += await this.scanBytes(join(path, name), budget, depth + 1);
      if (!Number.isSafeInteger(bytes)) throw new Error("managed run byte total overflowed");
    }
    return bytes;
  }

  private async activity(dir: string, metadata: RunLifecycleMetadata): Promise<ManagedRunActivity> {
    const owned = activeOwners.get(dir);
    if (owned === metadata.owner) return "owned";
    try {
      const marker = parseMarker(await readBoundedJson(join(dir, RUN_ACTIVE_FILE)), metadata);
      if (marker.pid === process.pid) return "ambiguous";
      const live = this.probe(marker.pid);
      return live === true ? "live" : live === false ? "stale" : "ambiguous";
    } catch (error) {
      if (errorCode(error) === "ENOENT") return metadata.status === "active" ? "stale" : "inactive";
      throw error;
    }
  }

  async list(): Promise<ManagedRunListing> {
    await this.ensureRoot();
    const runs: ManagedRunInfo[] = [];
    const issues: RunRetentionIssue[] = [];
    const budget: ScanBudget = { entries: 0 };
    for (const name of (await readdir(this.root)).sort()) {
      const path = join(this.root, name);
      if (!RUN_NAME.test(name) || dirname(path) !== this.root || !this.contained(path)) {
        issues.push({ code: "INVALID_ENTRY", message: "managed root contains an unowned entry", runName: name });
        continue;
      }
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700)
          throw new Error("run entry must be a private real directory");
        const metadata = parseLifecycle(await readBoundedJson(join(path, RUN_LIFECYCLE_FILE)));
        const [bytes, activity] = await Promise.all([this.scanBytes(path, budget), this.activity(path, metadata)]);
        runs.push({ name, path, metadata, bytes, activity });
      } catch (cause) {
        issues.push({ code: "SCAN_FAILED", message: "failed to validate managed run", runName: name, cause });
      }
    }
    return { root: this.root, runs, issues };
  }

  async removeOwned(name: string, path: string): Promise<void> {
    await this.ensureRoot();
    if (!RUN_NAME.test(name) || path !== join(this.root, name) || !this.contained(path)) throw new Error("unsafe removal path");
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("removal target is not a run directory");
    await this.scanBytes(path, { entries: 0 });
    const stable = await lstat(path);
    if (stable.dev !== before.dev || stable.ino !== before.ino || stable.isSymbolicLink() || !stable.isDirectory())
      throw new Error("removal target identity changed");
    await this.remover(path);
  }

  async cleanup(options: RunCleanupOptions = {}): Promise<RunCleanupResult> {
    const listing = await this.list();
    const now = this.time();
    const terminal = listing.runs
      .filter((run) => run.metadata.status !== "active")
      .sort((a, b) => (a.metadata.terminalAtMs! - b.metadata.terminalAtMs!) || a.name.localeCompare(b.name));
    const removable = (run: ManagedRunInfo): boolean => run.activity === "inactive" || run.activity === "stale";
    const selected = new Set<string>();
    for (const run of terminal) {
      if (removable(run) && (options.force || now - run.metadata.terminalAtMs! >= this.policy.terminalMaxAgeMs)) selected.add(run.name);
    }
    let remainingCount = terminal.length - selected.size;
    for (const run of terminal) {
      if (remainingCount <= this.policy.maxTerminalRuns) break;
      if (!selected.has(run.name) && removable(run)) { selected.add(run.name); remainingCount--; }
    }
    let remainingBytes = terminal.reduce((sum, run) => sum + (selected.has(run.name) ? 0 : run.bytes), 0);
    for (const run of terminal) {
      if (remainingBytes <= this.policy.maxTerminalBytes) break;
      if (!selected.has(run.name) && removable(run)) { selected.add(run.name); remainingBytes -= run.bytes; }
    }
    const abandoned = listing.runs
      .filter((run) => run.metadata.status === "active" && removable(run)
        && now - run.metadata.updatedAtMs >= this.policy.abandonedGraceMs)
      .sort((a, b) => (a.metadata.updatedAtMs - b.metadata.updatedAtMs) || a.name.localeCompare(b.name));
    for (const run of abandoned) selected.add(run.name);

    const ordered = listing.runs
      .filter((run) => selected.has(run.name))
      .sort((a, b) => {
        const at = a.metadata.terminalAtMs ?? a.metadata.updatedAtMs;
        const bt = b.metadata.terminalAtMs ?? b.metadata.updatedAtMs;
        return (at - bt) || a.name.localeCompare(b.name);
      });
    const deleted: string[] = [];
    const issues = [...listing.issues];
    if (!options.dryRun) {
      for (const run of ordered) {
        try { await this.removeOwned(run.name, run.path); deleted.push(run.name); }
        catch (cause) { issues.push({ code: "CLEANUP_FAILED", message: "failed to remove managed run", runName: run.name, cause }); }
      }
    }
    const plannedDeleted = new Set(options.dryRun ? ordered.map((run) => run.name) : deleted);
    const retainedRuns = listing.runs.filter((run) => !plannedDeleted.has(run.name));
    const retainedTerminal = retainedRuns.filter((run) => run.metadata.status !== "active");
    const policyUnsatisfied = retainedTerminal.length > this.policy.maxTerminalRuns
      || retainedTerminal.reduce((sum, run) => sum + run.bytes, 0) > this.policy.maxTerminalBytes
      || retainedTerminal.some((run) => now - run.metadata.terminalAtMs! >= this.policy.terminalMaxAgeMs);
    if (!options.dryRun && policyUnsatisfied)
      issues.push({ code: "POLICY_UNSATISFIED", message: "active, ambiguous, or failed removals prevent terminal retention bounds" });
    const result: RunCleanupResult = {
      ...listing,
      issues,
      deleted,
      wouldDelete: options.dryRun ? ordered.map((run) => run.name) : [],
      retained: retainedRuns.map((run) => run.name).sort(),
    };
    if (!options.dryRun && issues.length > 0) {
      const code = policyUnsatisfied ? "RUN_RETENTION_POLICY_UNSATISFIED" : "RUN_RETENTION_CLEANUP_FAILED";
      throw new RunRetentionError(code, "managed run cleanup could not safely enforce retention policy", new AggregateError(issues.map((issue) => issue.cause ?? new Error(issue.message))), result);
    }
    return result;
  }
}

/** Explicit host API for future commands/TUI consumers. */
export const listManagedRuns = (options: ManagedRunStoreOptions = {}): Promise<ManagedRunListing> =>
  new ManagedRunStore(options).list();

/** Explicit host API. Dry-run never removes; force still preserves live/ambiguous/non-abandoned runs. */
export const cleanupManagedRuns = (
  options: ManagedRunStoreOptions = {},
  cleanup: RunCleanupOptions = {},
): Promise<RunCleanupResult> => new ManagedRunStore(options).cleanup(cleanup);
