/** Host-owned persistent run directories, active leases, and bounded retention. */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RlmEvent } from "../core/journal.ts";
import { JournalStore } from "../shell/journal-store.ts";
import { sha256 } from "../shell/hash.ts";
import { readRunManifest, RUN_MANIFEST_FILE } from "./run-manifest.ts";
import { MANAGED_RUN_PERSISTENCE, MANAGED_RUN_RESUME } from "./run-managed-lifecycle.ts";
import { assertFailedGenesisRetirement, inspectFailedWriterGenesis } from "./run-genesis-recovery.ts";
import { selectRetentionCandidates } from "./run-retention-policy.ts";
import {
  MANAGED_RUN_STORE_FAULTS,
  type ManagedRunStoreFaultOptions,
} from "./run-retention-test-support.ts";
import {
  acquireRunRetentionLease,
  acquireRunWriterLease,
  createRunWriterGenesis,
  recoverFailedRunWriterGenesis,
  RunWriterArbiterError,
  type RunWriterArbiterOptions,
  type RunWriterLease,
} from "./run-writer-arbiter.ts";
import {
  nodePrivateDirectoryFileSystem,
  syncPrivateDirectory,
  type PrivateDirectoryFileSystem,
} from "./run-writer-directory.ts";
import { LeaseOwnedRunPersistence } from "./run-writer-mutation.ts";
import { ARBITRATION_DIRECTORY, scanArbitrationDirectory } from "./run-writer-protocol.ts";
import {
  isRunQuarantineName,
  quarantineFailedGenesis,
  quarantineName,
  quarantineOwnedRun,
  RunQuarantineAppliedError,
  scavengeRunQuarantine,
  type RunQuarantineFileSystem,
} from "./run-writer-quarantine.ts";

export const RUN_LIFECYCLE_FILE = ".pi-rlm-lifecycle.json";
export const RUN_ACTIVE_FILE = ".pi-rlm-active.json";
export const RUN_LIFECYCLE_CLAIM_FILE = ".pi-rlm-lifecycle.claim";
export const RUN_INACTIVE_FILE_PREFIX = ".pi-rlm-inactive-";
export const MANAGED_RUN_CLAIM_ENTRIES = Object.freeze([ARBITRATION_DIRECTORY]);

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const OWNER = /^[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{64}$/;
const METADATA_LIMIT_BYTES = 64 * 1024;
const SURVIVOR_NAME_LIMIT = 255;
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
  /** Maximum filesystem entries examined by one listing. Default: 100,000. */
  readonly maxScanEntries: number;
  /** Maximum directory nesting examined. Default: 64. */
  readonly maxScanDepth: number;
  /** Maximum UTF-8 bytes in an examined path. Default: 16 KiB. */
  readonly maxScanPathBytes: number;
  /** Maximum size of one examined regular file. Default: 2 GiB. */
  readonly maxScanFileBytes: number;
  /** Maximum aggregate regular-file bytes examined by one listing. Default: 4 GiB. */
  readonly maxScanBytes: number;
}

export const DEFAULT_RUN_RETENTION_POLICY: Readonly<RunRetentionPolicy> = Object.freeze({
  terminalMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxTerminalRuns: 100,
  maxTerminalBytes: 1024 * 1024 * 1024,
  abandonedGraceMs: 90 * 24 * 60 * 60 * 1_000,
  maxScanEntries: 100_000,
  maxScanDepth: 64,
  maxScanPathBytes: 16 * 1024,
  maxScanFileBytes: 2 * 1024 * 1024 * 1024,
  maxScanBytes: 4 * 1024 * 1024 * 1024,
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

interface ScannedRunInfo extends ManagedRunInfo {
  readonly identity: RunIdentity;
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
  /** Includes bytes in malformed runs which could not become a ManagedRunInfo. */
  readonly scannedBytes: number;
  /** Includes every root and nested entry inspected, including invalid entries. */
  readonly scannedEntries: number;
}

export interface RunCleanupOptions {
  readonly dryRun?: boolean;
  /** Delete every safely inactive terminal run, while preserving active and not-yet-abandoned runs. */
  readonly force?: boolean;
  /** Host/session cancellation. Checked before each selected run deletion where possible. */
  readonly signal?: AbortSignal;
}

export type RunCleanupSkipReason = "already_removed" | "already_claimed";

export interface RunCleanupSkipped {
  readonly runName: string;
  readonly reason: RunCleanupSkipReason;
}

export interface RunCleanupResult extends ManagedRunListing {
  /** Names whose inode this cleanup invocation successfully removed. */
  readonly deleted: readonly string[];
  readonly skipped: readonly RunCleanupSkipped[];
  readonly wouldDelete: readonly string[];
  readonly retained: readonly string[];
}

export type RunRetentionErrorCode =
  | "RUN_RETENTION_ROOT_INVALID"
  | "RUN_RETENTION_CREATE_FAILED"
  | "RUN_RETENTION_RESUME_FAILED"
  | "RUN_RETENTION_METADATA_FAILED"
  | "RUN_RETENTION_SCAN_LIMIT"
  | "RUN_RETENTION_CLEANUP_FAILED"
  | "RUN_RETENTION_POLICY_UNSATISFIED";

export interface RunRetentionSurvivor {
  readonly kind: "temporary-file" | "run-directory" | "quarantine";
  readonly name: string;
  readonly bytes: number;
}

export class RunRetentionError extends Error {
  override readonly name = "RunRetentionError";
  constructor(
    readonly code: RunRetentionErrorCode,
    message: string,
    override readonly cause?: unknown,
    readonly result?: RunCleanupResult,
    readonly survivors: readonly RunRetentionSurvivor[] = [],
  ) { super(message); }
}

export interface RunRetentionMetadataFileHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
}

export interface RunRetentionMetadataFileSystem {
  open(path: string, flags: string | number, mode?: number): Promise<RunRetentionMetadataFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeMetadataFileSystem: RunRetentionMetadataFileSystem = {
  open: async (path, flags, mode) => open(path, flags, mode),
  rename,
  unlink,
};

export interface ManagedRunStoreOptions {
  readonly root?: string;
  readonly policy?: Partial<RunRetentionPolicy>;
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
    maxScanPathBytes: safeInteger(value.maxScanPathBytes, "maxScanPathBytes", 1),
    maxScanFileBytes: safeInteger(value.maxScanFileBytes, "maxScanFileBytes"),
    maxScanBytes: safeInteger(value.maxScanBytes, "maxScanBytes"),
  };
};

const nonemptyEnvPath = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

export const defaultRunStateRoot = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  home = homedir(),
): string => {
  if (platform === "darwin") return join(home, "Library", "Application Support", "pi-rlm", "runs");
  if (platform === "win32") return join(nonemptyEnvPath(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local"), "pi-rlm", "runs");
  return join(nonemptyEnvPath(env["XDG_STATE_HOME"]) ?? join(home, ".local", "state"), "pi-rlm", "runs");
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

class AtomicWriteCleanupError extends Error {
  override readonly name = "AtomicWriteCleanupError";
  constructor(override readonly cause: AggregateError, readonly survivor: RunRetentionSurvivor) {
    super("atomic metadata write and temporary-file cleanup both failed");
  }
}

const boundedSurvivor = async (
  path: string,
  kind: RunRetentionSurvivor["kind"],
): Promise<RunRetentionSurvivor> => {
  let bytes = 0;
  try { bytes = safeInteger((await lstat(path)).size, "surviving path size"); } catch { /* Metadata remains bounded and non-secret. */ }
  return { kind, name: basename(path).slice(0, SURVIVOR_NAME_LIMIT), bytes };
};

const privateJson = async (
  dir: string,
  name: string,
  value: object,
  token: string,
  fileSystem: RunRetentionMetadataFileSystem,
): Promise<void> => {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${token}.tmp`);
  let handle: RunRetentionMetadataFileHandle | undefined;
  let tempCreated = false;
  let primary: unknown;
  try {
    handle = await fileSystem.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    tempCreated = true;
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    primary = error;
  }
  if (handle) {
    try { await handle.close(); } catch (cleanup) {
      primary = primary === undefined ? cleanup : new AggregateError([primary, cleanup], "metadata write and close both failed");
    }
  }
  if (primary !== undefined) {
    if (tempCreated) {
      try { await fileSystem.unlink(temp); } catch (cleanup) {
        throw new AtomicWriteCleanupError(
          new AggregateError([primary, cleanup], "metadata write and temporary-file cleanup both failed"),
          await boundedSurvivor(temp, "temporary-file"),
        );
      }
    }
    throw primary;
  }
  try { await fileSystem.rename(temp, target); } catch (error) {
    try { await fileSystem.unlink(temp); } catch (cleanup) {
      throw new AtomicWriteCleanupError(
        new AggregateError([error, cleanup], "metadata rename and temporary-file cleanup both failed"),
        await boundedSurvivor(temp, "temporary-file"),
      );
    }
    throw error;
  }
  const directory = await fileSystem.open(dir, "r");
  let syncFailure: unknown;
  try { await directory.sync(); } catch (error) { syncFailure = error; }
  try { await directory.close(); } catch (cleanup) {
    throw syncFailure === undefined ? cleanup : new AggregateError([syncFailure, cleanup], "metadata directory sync and close both failed");
  }
  if (syncFailure !== undefined) throw syncFailure;
};

const readBoundedJson = async (path: string, limit = METADATA_LIMIT_BYTES): Promise<unknown> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > limit)
    throw new TypeError("metadata path must be one bounded regular file");
  return JSON.parse((await readFile(path, "utf8")).trim()) as unknown;
};

interface RootIdentity { readonly real: string; readonly dev: bigint; readonly ino: bigint }
interface RunIdentity { readonly dev: bigint; readonly ino: bigint }
interface ScanBudget { entries: number; bytes: number }
interface InternalListing extends ManagedRunListing { readonly runs: readonly ScannedRunInfo[] }

class RetentionPreflightChanged extends Error {
  override readonly name = "RetentionPreflightChanged";
}

class CleanupAborted extends Error {
  override readonly name = "CleanupAborted";
  constructor(readonly reason?: unknown) { super("managed cleanup aborted"); }
}

export interface ManagedResumeWriterIdentity {
  readonly managedName: string;
  readonly runId: string;
  readonly writerOrdinal: number;
  /** One-way identity only. Raw arbitration tokens never cross this boundary. */
  readonly writerTokenSha256: string;
}

/** Exact writer election without local active-lifecycle adoption. */
export class ManagedResumeCandidateLease {
  private adopted: ManagedRunLease | undefined;
  private released = false;

  constructor(
    private readonly store: ManagedRunStore,
    readonly name: string,
    readonly dir: string,
    private readonly metadata: RunLifecycleMetadata,
    private readonly writer: RunWriterLease,
    private readonly persistence: LeaseOwnedRunPersistence,
  ) {}

  writerIdentity(): ManagedResumeWriterIdentity {
    if (this.released || this.adopted)
      throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed resume candidate is no longer pending");
    return Object.freeze({
      managedName: this.name,
      runId: this.metadata.runId!,
      writerOrdinal: this.writer.generation.ordinal,
      writerTokenSha256: sha256(this.writer.generation.token),
    });
  }

  /** Atomically publish local active ownership under this exact writer generation. */
  async adopt(signal?: AbortSignal): Promise<ManagedRunLease> {
    if (this.released || this.adopted)
      throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed resume candidate was already resolved");
    this.adopted = await this.store.adoptResumeCandidate(
      this.name, this.dir, this.metadata, this.writer, this.persistence, signal,
    );
    return this.adopted;
  }

  /** Release the exact candidate generation, or abandon it if adoption completed. */
  async release(): Promise<void> {
    if (this.released) return;
    if (this.adopted) {
      await this.adopted.abandon();
      this.released = true;
      return;
    }
    await this.store.releaseResumeCandidate(this.name, this.writer);
    this.released = true;
  }
}

export class ManagedRunLease {
  private runId: string | undefined;
  private closed = false;
  private manifestBound = false;
  private genesisComplete = false;
  private markerReleased = false;

  constructor(
    private readonly store: ManagedRunStore,
    readonly name: string,
    readonly dir: string,
    private metadata: RunLifecycleMetadata,
    private readonly writer: RunWriterLease,
    private readonly persistence: LeaseOwnedRunPersistence,
    private readonly resumed = false,
  ) {
    if (resumed) {
      if (metadata.status !== "active" || !metadata.runId)
        throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "resumed lifecycle requires one active manifest identity");
      this.runId = metadata.runId;
      this.manifestBound = true;
      this.genesisComplete = true;
    }
    this.lifecycle = {
      claimEntries: MANAGED_RUN_CLAIM_ENTRIES,
      [MANAGED_RUN_PERSISTENCE]: persistence,
      ...(resumed ? { [MANAGED_RUN_RESUME]: {
        runId: metadata.runId!,
        runName: name,
        writerOrdinal: writer.generation.ordinal,
        writerTokenSha256: sha256(writer.generation.token),
      } } : {}),
      onManifest: async (runId: string): Promise<void> => {
        if (this.closed || !RUN_ID.test(runId))
          throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "invalid managed run identity");
        await persistence.runTransaction(async () => {
          this.metadata = await this.store.bindManifest(this.dir, this.metadata, runId, persistence);
          // Publish exposure state before this admitted scheduler transaction can
          // yield to a concurrently queued discard terminal transition.
          this.runId = runId;
          this.manifestBound = true;
        });
      },
      onRunStarted: async (runId: string): Promise<void> => {
        if (this.closed || !this.manifestBound || runId !== this.runId)
          throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "durable run start does not match managed genesis");
        this.genesisComplete = true;
      },
    };
  }

  readonly lifecycle: {
    readonly claimEntries: readonly string[];
    readonly [MANAGED_RUN_PERSISTENCE]: LeaseOwnedRunPersistence;
    readonly [MANAGED_RUN_RESUME]?: {
      readonly runId: string;
      readonly runName: string;
      readonly writerOrdinal: number;
      readonly writerTokenSha256: string;
    };
    readonly onManifest: (runId: string) => Promise<void>;
    readonly onRunStarted: (runId: string) => Promise<void>;
  };

  /** Safe exact generation binding for host resume authorization. */
  resumeWriterIdentity(): ManagedResumeWriterIdentity {
    if (!this.resumed || this.closed || !this.runId)
      throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed lease is not an open resume authority");
    return Object.freeze({
      managedName: this.name,
      runId: this.runId,
      writerOrdinal: this.writer.generation.ordinal,
      writerTokenSha256: sha256(this.writer.generation.token),
    });
  }

  private combine(primary: unknown, secondary: unknown): unknown {
    return primary === undefined ? secondary : new AggregateError([primary, secondary]);
  }

  private async releaseOwned(primary: unknown): Promise<unknown> {
    if (this.manifestBound && !this.markerReleased) {
      const failures: unknown[] = [];
      for (let attempt = 0; attempt < 2 && !this.markerReleased; attempt++) {
        try {
          await this.store.releaseLease(this.dir, this.metadata, this.persistence);
          this.markerReleased = true;
        } catch (release) { failures.push(release); }
      }
      if (!this.markerReleased) {
        this.store.retainReleaseAuthority(this);
        return this.combine(primary, new AggregateError(failures, "managed active-marker release retries failed"));
      }
    }
    const failures: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.writer.release();
        this.closed = true;
        this.store.forgetReleaseAuthority(this);
        return primary;
      } catch (release) { failures.push(release); }
    }
    // The process-global arbiter still holds the exact lease. Retain this managed
    // handle so this or any later ManagedRunStore cleanup can retry authority release.
    this.store.retainReleaseAuthority(this);
    return this.combine(primary, new AggregateError(failures, "managed writer release retries failed"));
  }

  /** Internal process-lifetime reconciliation entrypoint retained by ManagedRunStore. */
  async retryReleaseAuthority(): Promise<void> {
    if (this.closed) { this.store.forgetReleaseAuthority(this); return; }
    const failure = await this.releaseOwned(undefined);
    if (failure !== undefined)
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed release authority retry failed", failure);
  }

  private async discardGenesis(): Promise<void> {
    await this.store.discardOwned(
      this.name,
      this.dir,
      this.metadata,
      this.writer,
      () => {
        if (this.manifestBound || this.genesisComplete)
          throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "cannot discard an exposed managed run");
      },
    );
    this.closed = true;
  }

  async finish(status: Exclude<RunLifecycleStatus, "active">, runId?: string): Promise<void> {
    if (this.closed) return;
    if (!this.genesisComplete) {
      let primary: unknown = new RunRetentionError(
        "RUN_RETENTION_METADATA_FAILED",
        "terminal lifecycle requires a durable run_started genesis event",
      );
      if (!this.manifestBound) {
        try { await this.discardGenesis(); }
        catch (discard) { primary = new AggregateError([primary, discard], "invalid terminal lifecycle and genesis quarantine both failed"); }
      } else {
        primary = await this.releaseOwned(primary);
      }
      if (primary instanceof RunRetentionError) throw primary;
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed terminal finalization failed", primary);
    }
    let primary: unknown;
    try {
      const identity = runId ?? this.runId;
      if (identity === undefined || !RUN_ID.test(identity) || identity !== this.runId)
        throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "terminal lifecycle requires the bound manifest run identity");
      this.metadata = await this.store.finishLease(this.dir, this.metadata, status, identity, this.persistence);
    } catch (error) { primary = error; }
    primary = await this.releaseOwned(primary);
    if (primary instanceof RunRetentionError) throw primary;
    if (primary !== undefined)
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed terminal finalization failed", primary);
  }

  /** Release a run which threw after completed genesis but before an authoritative terminal result. */
  async abandon(): Promise<void> {
    if (this.closed) return;
    if (!this.genesisComplete && !this.manifestBound) return this.discardGenesis();
    let primary: unknown;
    try { this.metadata = await this.store.abandonLease(this.dir, this.metadata, this.persistence); }
    catch (error) { primary = error; }
    primary = await this.releaseOwned(primary);
    if (primary instanceof RunRetentionError) throw primary;
    if (primary !== undefined)
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed abandonment failed", primary);
  }

  /** Quarantine only an allocation which has never exposed a durable manifest. */
  async discard(): Promise<void> {
    if (this.closed) return;
    if (this.manifestBound)
      throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "cannot discard an exposed managed run");
    await this.discardGenesis();
  }
}

interface RetainedReleaseAuthority {
  retryReleaseAuthority(): Promise<void>;
}
const retainedReleaseAuthorities = new Map<string, RetainedReleaseAuthority>();

export class ManagedRunStore {
  readonly root: string;
  readonly policy: RunRetentionPolicy;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly probe: (pid: number) => boolean | undefined;
  private readonly metadataFileSystem: RunRetentionMetadataFileSystem;
  private readonly remover: (path: string) => Promise<void>;
  private readonly beforeDecision: (path: string) => Promise<void>;
  private readonly afterAcquisition: (path: string) => Promise<void>;
  private readonly writerOptions: RunWriterArbiterOptions;
  private readonly quarantineFileSystem?: RunQuarantineFileSystem;
  private readonly directoryFileSystem: PrivateDirectoryFileSystem;
  private readonly persistenceOptions: ConstructorParameters<typeof LeaseOwnedRunPersistence>[1];
  private rootIdentity: RootIdentity | undefined;

  constructor(options: ManagedRunStoreOptions = {}) {
    const faults = (options as ManagedRunStoreOptions & {
      readonly [MANAGED_RUN_STORE_FAULTS]?: ManagedRunStoreFaultOptions;
    })[MANAGED_RUN_STORE_FAULTS] ?? {};
    const configured = options.root ?? defaultRunStateRoot();
    if (typeof configured !== "string" || configured.trim().length === 0 || configured.trim() !== configured || !isAbsolute(configured))
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run root must be a nonempty absolute path");
    this.root = resolve(configured);
    this.policy = resolvedPolicy(options.policy);
    this.now = faults.now ?? Date.now;
    this.createToken = faults.createToken ?? (() => randomBytes(16).toString("hex"));
    this.probe = faults.processProbe ?? processProbe;
    this.metadataFileSystem = faults.metadataFileSystem ?? nodeMetadataFileSystem;
    this.remover = faults.removeDirectory ?? ((path) => rm(path, { recursive: true, force: false }));
    this.beforeDecision = faults.beforeCleanupDecision ?? (async () => {});
    this.afterAcquisition = faults.afterCleanupAcquisition ?? (async () => {});
    this.writerOptions = faults.writerArbiterOptions ?? {};
    this.quarantineFileSystem = faults.quarantineFileSystem;
    this.directoryFileSystem = faults.directoryFileSystem ?? nodePrivateDirectoryFileSystem;
    this.persistenceOptions = {
      ...(faults.runDirectoryFileSystem ? { runDirectoryFileSystem: faults.runDirectoryFileSystem } : {}),
      ...(faults.journalFileSystem ? { journalFileSystem: faults.journalFileSystem } : {}),
      ...(faults.contextStoreInstrumentation ? { contextStoreInstrumentation: faults.contextStoreInstrumentation } : {}),
    };
  }

  time(): number { return safeInteger(this.now(), "now"); }

  retainReleaseAuthority(lease: ManagedRunLease): void {
    if (!this.rootIdentity) throw new Error("managed root identity is unavailable while retaining release authority");
    retainedReleaseAuthorities.set(join(this.rootIdentity.real, lease.name), lease);
  }

  forgetReleaseAuthority(lease: ManagedRunLease): void {
    for (const [key, retained] of retainedReleaseAuthorities) {
      if (retained === lease) retainedReleaseAuthorities.delete(key);
    }
  }

  private retainWriterReleaseAuthority(name: string, writer: RunWriterLease): void {
    if (!this.rootIdentity) throw new Error("managed root identity is unavailable while retaining writer authority");
    const key = join(this.rootIdentity.real, name);
    const authority: RetainedReleaseAuthority = {
      retryReleaseAuthority: async (): Promise<void> => {
        await writer.release();
        if (retainedReleaseAuthorities.get(key) === authority) retainedReleaseAuthorities.delete(key);
      },
    };
    retainedReleaseAuthorities.set(key, authority);
  }

  private async retryReleaseAuthorities(): Promise<void> {
    await this.ensureRoot();
    for (const [canonicalDir, lease] of retainedReleaseAuthorities) {
      if (dirname(canonicalDir) !== this.rootIdentity!.real) continue;
      try { await lease.retryReleaseAuthority(); }
      catch (cause) {
        throw new RunRetentionError(
          "RUN_RETENTION_CLEANUP_FAILED",
          "failed to retry retained managed writer release authority",
          cause,
          undefined,
          [await boundedSurvivor(canonicalDir, "run-directory")],
        );
      }
    }
  }

  private token(): string {
    const value = this.createToken();
    if (!OWNER.test(value)) throw new TypeError("managed run token must be 32 lowercase hexadecimal characters");
    return value;
  }

  private ownedMetadataFileSystem(persistence: LeaseOwnedRunPersistence): RunRetentionMetadataFileSystem {
    const base = this.metadataFileSystem;
    const guardedClose = async (
      path: string,
      close: () => Promise<void>,
    ): Promise<void> => {
      let invoked = false;
      try {
        await persistence.runPathEffect(path, async () => {
          invoked = true;
          await close();
        });
      } catch (primary) {
        if (!invoked) {
          try { await close(); }
          catch (cleanup) { throw new AggregateError([primary, cleanup], "metadata close fence and handle cleanup both failed"); }
        }
        throw primary;
      }
    };
    return {
      open: async (path, flags, mode) => {
        let opened: RunRetentionMetadataFileHandle | undefined;
        try {
          opened = await persistence.runPathEffect(path, async () => {
            opened = await base.open(path, flags, mode);
            return opened;
          });
          const handle = opened;
          return {
            writeFile: (data, encoding) => persistence.runPathEffect(path, () => handle.writeFile(data, encoding)),
            sync: () => persistence.runPathEffect(path, () => handle.sync()),
            close: () => guardedClose(path, () => handle.close()),
          };
        } catch (primary) {
          if (opened) {
            try { await opened.close(); }
            catch (cleanup) { throw new AggregateError([primary, cleanup], "guarded metadata open and handle cleanup both failed"); }
          }
          throw primary;
        }
      },
      rename: (oldPath, newPath) => persistence.runPathEffect([oldPath, newPath], () => base.rename(oldPath, newPath)),
      unlink: (path) => persistence.runPathEffect(path, () => base.unlink(path)),
    };
  }

  private contained(path: string): boolean {
    const rel = relative(this.root, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
  }

  private scanLimit(message: string): RunRetentionError {
    return new RunRetentionError("RUN_RETENTION_SCAN_LIMIT", message);
  }

  private checkPath(path: string): void {
    if (Buffer.byteLength(path, "utf8") > this.policy.maxScanPathBytes)
      throw this.scanLimit("managed run scan path length limit reached");
  }

  private chargeEntry(budget: ScanBudget): void {
    if (budget.entries >= this.policy.maxScanEntries)
      throw this.scanLimit("managed run scan entry limit reached");
    budget.entries++;
  }

  /** Conservatively stop at the cap instead of asking the iterator for one unaccounted entry. */
  private stopAtEntryCap(budget: ScanBudget): void {
    if (budget.entries >= this.policy.maxScanEntries)
      throw this.scanLimit("managed run scan entry limit reached");
  }

  private chargeBytes(size: number, budget: ScanBudget): void {
    safeInteger(size, "file size");
    if (size > this.policy.maxScanFileBytes) throw this.scanLimit("managed run per-file scan byte limit reached");
    if (budget.bytes > this.policy.maxScanBytes - size) throw this.scanLimit("managed run aggregate scan byte limit reached");
    budget.bytes += size;
  }

  private async ensureRoot(): Promise<void> {
    try { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "failed to create private managed run root", cause); }
    let info = await lstat(this.root, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run root must be a real directory");
    try { await chmod(this.root, 0o700); info = await lstat(this.root, { bigint: true }); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "failed to secure managed run root", cause); }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run root identity changed while securing it");
    const identity = { real: await realpath(this.root), dev: info.dev, ino: info.ino };
    if (this.rootIdentity && (identity.real !== this.rootIdentity.real || identity.dev !== this.rootIdentity.dev || identity.ino !== this.rootIdentity.ino))
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run root identity changed");
    this.rootIdentity ??= identity;
  }

  private async syncRoot(): Promise<void> {
    await this.ensureRoot();
    await syncPrivateDirectory(
      this.root,
      { dev: this.rootIdentity!.dev, ino: this.rootIdentity!.ino },
      this.directoryFileSystem,
    );
  }

  private async ensureRunPath(dir: string): Promise<RunIdentity> {
    await this.ensureRoot();
    const name = dir.slice(this.root.length + 1);
    if (!RUN_NAME.test(name) || dir !== join(this.root, name) || dirname(dir) !== this.root || !this.contained(dir))
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "run path escapes managed root");
    const info = await lstat(dir, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run path is not a directory");
    const expectedReal = join(this.rootIdentity!.real, name);
    if (await realpath(dir) !== expectedReal)
      throw new RunRetentionError("RUN_RETENTION_ROOT_INVALID", "managed run real path escapes managed root");
    return { dev: info.dev, ino: info.ino };
  }

  private async ownedState(dir: string, expected: RunLifecycleMetadata): Promise<RunLifecycleMetadata> {
    const metadata = parseLifecycle(await readBoundedJson(join(dir, RUN_LIFECYCLE_FILE)));
    if (metadata.owner !== expected.owner || metadata.createdAtMs !== expected.createdAtMs)
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed lifecycle owner changed");
    const marker = parseMarker(await readBoundedJson(join(dir, RUN_ACTIVE_FILE)), metadata);
    if (marker.pid !== process.pid || activeOwners.get(dir) !== marker.owner)
      throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "active lease owner changed");
    return metadata;
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
    let created = false;
    try {
      await mkdir(dir, { mode: 0o700 });
      created = true;
      // The managed-root child entry is part of writer genesis and must survive a crash.
      await this.syncRoot();
      const writer = await createRunWriterGenesis(
        { managedRoot: this.root, runName: name },
        this.writerOptions,
      );
      const persistence = new LeaseOwnedRunPersistence(writer, this.persistenceOptions);
      return new ManagedRunLease(this, name, dir, metadata, writer, persistence);
    } catch (cause) {
      activeOwners.delete(dir);
      if (created) {
        let authoritativeWinner = false;
        try {
          await lstat(join(dir, ARBITRATION_DIRECTORY));
          const chain = await scanArbitrationDirectory(join(dir, ARBITRATION_DIRECTORY));
          authoritativeWinner = chain.tip !== null;
        } catch (reconciliation) {
          if (errorCode(reconciliation) !== "ENOENT") {
            throw new RunRetentionError(
              "RUN_RETENTION_CREATE_FAILED",
              "genesis creation failed and authority could not be safely reconciled",
              new AggregateError([cause, reconciliation]),
              undefined,
              [await boundedSurvivor(dir, "run-directory")],
            );
          }
        }
        if (authoritativeWinner) {
          // The winner may belong to a concurrent creator. Never infer ownership from
          // the chain tip and never quarantine a generation we did not return.
          throw new RunRetentionError(
            "RUN_RETENTION_CREATE_FAILED",
            "another authoritative genesis winner owns the allocated path",
            cause,
            undefined,
            [await boundedSurvivor(dir, "run-directory")],
          );
        }
        try {
          try { await rmdir(join(dir, ARBITRATION_DIRECTORY)); }
          catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
          await rm(dir, { recursive: true, force: true });
          await this.syncRoot();
        } catch (cleanup) {
          throw new RunRetentionError(
            "RUN_RETENTION_CREATE_FAILED",
            "run creation rollback could not prove an empty arbitration namespace",
            new AggregateError([cause, cleanup]),
            undefined,
            [await boundedSurvivor(dir, "run-directory")],
          );
        }
      }
      throw new RunRetentionError("RUN_RETENTION_CREATE_FAILED", "failed to create managed writer genesis", cause);
    }
  }

  /** Elect an exact resume writer without publishing local active ownership. */
  async openResumeCandidate(name: string): Promise<ManagedResumeCandidateLease> {
    await this.ensureRoot();
    const dir = join(this.root, name);
    if (!RUN_NAME.test(name) || dir !== join(this.root, name) || dirname(dir) !== this.root || !this.contained(dir))
      throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "invalid managed run name for resume");
    try { await this.ensureRunPath(dir); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed resume path is invalid", cause); }

    let metadata: RunLifecycleMetadata;
    try { metadata = parseLifecycle(await readBoundedJson(join(dir, RUN_LIFECYCLE_FILE))); }
    catch (cause) { throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed resume lifecycle is invalid", cause); }
    if (metadata.status !== "active" || !metadata.runId)
      throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "only active manifest-bound managed runs can resume");

    let writer: RunWriterLease;
    try {
      writer = await acquireRunWriterLease(
        { managedRoot: this.root, runName: name, role: "writer" },
        this.writerOptions,
      );
    } catch (cause) {
      throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "failed to acquire managed resume writer authority", cause);
    }
    const persistence = new LeaseOwnedRunPersistence(writer, this.persistenceOptions);
    try {
      await persistence.runTransaction(async () => {
        await this.ensureRunPath(dir);
        const current = parseLifecycle(await readBoundedJson(join(dir, RUN_LIFECYCLE_FILE)));
        if (!this.sameLifecycle(current, metadata) || current.status !== "active" || current.runId !== metadata.runId)
          throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed lifecycle changed during resume acquisition");
      });
      return new ManagedResumeCandidateLease(this, name, dir, metadata, writer, persistence);
    } catch (cause) {
      let releaseFailure: unknown;
      try { await this.releaseResumeCandidate(name, writer); }
      catch (error) { releaseFailure = error; }
      throw new RunRetentionError(
        "RUN_RETENTION_RESUME_FAILED",
        "failed to validate managed resume candidate",
        releaseFailure === undefined ? cause : new AggregateError([cause, releaseFailure]),
      );
    }
  }

  /** Internal candidate transition. The active marker and process owner publish in one writer transaction. */
  async adoptResumeCandidate(
    name: string,
    dir: string,
    metadata: RunLifecycleMetadata,
    writer: RunWriterLease,
    persistence: LeaseOwnedRunPersistence,
    signal?: AbortSignal,
  ): Promise<ManagedRunLease> {
    const checkpoint = (): void => {
      if (signal?.aborted)
        throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed resume adoption was cancelled", signal.reason);
    };
    const marker: ActiveMarker = {
      schemaVersion: 1,
      pid: process.pid,
      owner: metadata.owner,
      startedAtMs: metadata.createdAtMs,
    };
    let lease: ManagedRunLease | undefined;
    await persistence.runTransaction(async () => {
      checkpoint();
      await this.ensureRunPath(dir);
      checkpoint();
      const current = parseLifecycle(await readBoundedJson(join(dir, RUN_LIFECYCLE_FILE)));
      if (!this.sameLifecycle(current, metadata) || current.status !== "active" || current.runId !== metadata.runId)
        throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "managed lifecycle changed before active adoption");
      checkpoint();
      lease = new ManagedRunLease(this, name, dir, metadata, writer, persistence, true);
      try {
        await privateJson(dir, RUN_ACTIVE_FILE, marker, this.token(), this.ownedMetadataFileSystem(persistence));
      } catch (cause) {
        let applied = false;
        try { applied = JSON.stringify(parseMarker(await readBoundedJson(join(dir, RUN_ACTIVE_FILE)), metadata)) === JSON.stringify(marker); }
        catch { /* The replacement did not become exact authority. */ }
        if (!applied) throw cause;
      }
      activeOwners.set(dir, metadata.owner);
    });
    return lease!;
  }

  /** Release a pending candidate without touching lifecycle or active-marker state. */
  async releaseResumeCandidate(name: string, writer: RunWriterLease): Promise<void> {
    const failures: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await writer.release(); return; }
      catch (error) { failures.push(error); }
    }
    this.retainWriterReleaseAuthority(name, writer);
    throw new RunRetentionError(
      "RUN_RETENTION_METADATA_FAILED",
      "managed resume candidate release retries failed",
      new AggregateError(failures),
    );
  }

  /** Backward-compatible runtime API: acquisition and active adoption complete before return. */
  async openForResume(name: string): Promise<ManagedRunLease> {
    const candidate = await this.openResumeCandidate(name);
    try { return await candidate.adopt(); }
    catch (cause) {
      try { await candidate.release(); }
      catch (release) { cause = new AggregateError([cause, release], "resume adoption and candidate release both failed"); }
      throw new RunRetentionError("RUN_RETENTION_RESUME_FAILED", "failed to bind managed resume lifecycle", cause);
    }
  }

  async bindManifest(
    dir: string,
    expected: RunLifecycleMetadata,
    runId: string,
    persistence: LeaseOwnedRunPersistence,
  ): Promise<RunLifecycleMetadata> {
    return persistence.runPathEffect(dir, async () => {
      await this.ensureRunPath(dir);
      if (expected.status !== "active" || expected.runId !== undefined)
        throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed run identity changed before manifest binding");
      for (const name of [RUN_LIFECYCLE_FILE, RUN_ACTIVE_FILE]) {
        try {
          await readBoundedJson(join(dir, name));
          throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed lifecycle metadata already exists");
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
      const updated = { ...expected, runId, updatedAtMs: this.time() };
      const fileSystem = this.ownedMetadataFileSystem(persistence);
      try {
        await privateJson(dir, RUN_LIFECYCLE_FILE, updated, this.token(), fileSystem);
        await privateJson(
          dir,
          RUN_ACTIVE_FILE,
          { schemaVersion: 1, pid: process.pid, owner: expected.owner, startedAtMs: expected.createdAtMs },
          this.token(),
          fileSystem,
        );
      } catch (cause) {
        const survivors = cause instanceof AtomicWriteCleanupError ? [cause.survivor] : [];
        throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "failed to bind managed lifecycle under genesis", cause, undefined, survivors);
      }
      activeOwners.set(dir, expected.owner);
      return updated;
    });
  }

  private async validateTerminalEvidence(
    dir: string,
    runId: string,
    status: Exclude<RunLifecycleStatus, "active">,
  ): Promise<void> {
    const manifestInfo = await lstat(join(dir, RUN_MANIFEST_FILE));
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.nlink !== 1
      || manifestInfo.size > this.policy.maxScanFileBytes)
      throw new TypeError("terminal run manifest is not one bounded regular file");
    const document = await readRunManifest(dir);
    if (document.manifest.run.id !== runId) throw new TypeError("terminal lifecycle and strict manifest run identities differ");
    const journalInfo = await lstat(join(dir, "events.jsonl"));
    if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || journalInfo.nlink !== 1
      || journalInfo.size > this.policy.maxScanFileBytes)
      throw new TypeError("terminal journal is not one bounded regular file");
    const scanned = await new JournalStore(dir).readEvents();
    if (!scanned.ok) throw scanned.error;
    const terminals = scanned.value.filter((event): event is TerminalEvent =>
      event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled");
    const expectedType = status === "completed" ? "run_completed" : status === "failed" ? "run_failed" : "run_cancelled";
    if (terminals.length !== 1 || terminals[0]?.type !== expectedType || terminals[0].runId !== runId)
      throw new TypeError("terminal lifecycle does not match the authoritative terminal journal");
  }

  async finishLease(
    dir: string,
    expected: RunLifecycleMetadata,
    status: Exclude<RunLifecycleStatus, "active">,
    runId: string,
    persistence: LeaseOwnedRunPersistence,
  ): Promise<RunLifecycleMetadata> {
    return persistence.runPathEffect(dir, async () => {
      const metadata = await this.ownedState(dir, expected);
      if (metadata.runId !== runId || (metadata.status !== "active" && metadata.status !== status))
        throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "managed lifecycle changed before terminal update");
      try { await this.validateTerminalEvidence(dir, runId, status); }
      catch (cause) { throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "terminal run evidence is missing or inconsistent", cause); }
      const now = this.time();
      const updated: RunLifecycleMetadata = metadata.status === "active"
        ? { ...metadata, status, runId, updatedAtMs: now, terminalAtMs: now }
        : metadata;
      if (metadata.status === "active") {
        try {
          await privateJson(dir, RUN_LIFECYCLE_FILE, updated, this.token(), this.ownedMetadataFileSystem(persistence));
        } catch (cause) {
          const survivors = cause instanceof AtomicWriteCleanupError ? [cause.survivor] : [];
          throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "failed to persist terminal run lifecycle", cause, undefined, survivors);
        }
      }
      return updated;
    });
  }

  async abandonLease(
    dir: string,
    expected: RunLifecycleMetadata,
    persistence: LeaseOwnedRunPersistence,
  ): Promise<RunLifecycleMetadata> {
    return persistence.runPathEffect(dir, async () => {
      const metadata = await this.ownedState(dir, expected);
      if (metadata.status !== "active")
        throw new RunRetentionError("RUN_RETENTION_METADATA_FAILED", "thrown run unexpectedly has terminal lifecycle metadata");
      return metadata;
    });
  }

  /** Active UI metadata is removed while the authoritative writer generation is still owned. */
  async releaseLease(
    dir: string,
    expected: RunLifecycleMetadata,
    persistence: LeaseOwnedRunPersistence,
  ): Promise<void> {
    await persistence.runTransaction(async () => {
      const fileSystem = this.ownedMetadataFileSystem(persistence);
      const marker = join(dir, RUN_ACTIVE_FILE);
      const syncDirectory = async (): Promise<void> => {
        const directory = await fileSystem.open(dir, "r");
        let primary: unknown;
        try { await directory.sync(); } catch (error) { primary = error; }
        try { await directory.close(); } catch (cleanup) {
          primary = primary === undefined ? cleanup : new AggregateError([primary, cleanup]);
        }
        if (primary !== undefined) throw primary;
      };
      try {
        await fileSystem.unlink(marker);
        await syncDirectory();
        activeOwners.delete(dir);
        return;
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") {
          await syncDirectory();
          activeOwners.delete(dir);
          return;
        }
        const inactive = join(dir, `${RUN_INACTIVE_FILE_PREFIX}${expected.owner}.json`);
        try {
          await fileSystem.rename(marker, inactive);
          await syncDirectory();
          activeOwners.delete(dir);
        } catch (fallback) {
          throw new RunRetentionError(
            "RUN_RETENTION_METADATA_FAILED",
            "failed to release active run lease",
            new AggregateError([cause, fallback]),
            undefined,
            [await boundedSurvivor(inactive, "temporary-file")],
          );
        }
      }
    });
  }

  private async scanTree(path: string, budget: ScanBudget, depth = 0): Promise<number> {
    if (depth > this.policy.maxScanDepth) throw this.scanLimit("managed run scan depth limit reached");
    this.checkPath(path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("managed run tree contains a symbolic link");
    if (info.isFile()) { this.chargeBytes(info.size, budget); return info.size; }
    if (!info.isDirectory()) throw new Error("managed run tree contains a non-file entry");
    let bytes = 0;
    const directory = await opendir(path, { bufferSize: 1 });
    for await (const entry of directory) {
      this.chargeEntry(budget);
      const child = join(path, entry.name);
      this.checkPath(child);
      bytes += await this.scanTree(child, budget, depth + 1);
      if (!Number.isSafeInteger(bytes)) throw this.scanLimit("managed run byte total overflowed");
      this.stopAtEntryCap(budget);
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

  private async listInternal(): Promise<InternalListing> {
    await this.ensureRoot();
    const runs: ScannedRunInfo[] = [];
    const issues: RunRetentionIssue[] = [];
    const budget: ScanBudget = { entries: 0, bytes: 0 };
    const directory = await opendir(this.root, { bufferSize: 1 });
    for await (const entry of directory) {
      this.chargeEntry(budget);
      const name = entry.name;
      const path = join(this.root, name);
      this.checkPath(path);
      if (!RUN_NAME.test(name) || dirname(path) !== this.root || !this.contained(path)) {
        issues.push({ code: "INVALID_ENTRY", message: "managed root contains an unowned entry", runName: name });
        this.stopAtEntryCap(budget);
        continue;
      }
      try {
        // Recognized pre-lifecycle genesis is arbitration-owned, not malformed state.
        // Cleanup either wins its empty genesis slot or follows liveness takeover.
        if (await inspectFailedWriterGenesis(this.root, name)) {
          this.stopAtEntryCap(budget);
          continue;
        }
        const info = await lstat(path, { bigint: true });
        if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777n) !== 0o700n)
          throw new Error("run entry must be a private real directory");
        if (await realpath(path) !== join(this.rootIdentity!.real, name)) throw new Error("run entry real path escapes managed root");
        const bytes = await this.scanTree(path, budget);
        const metadata = parseLifecycle(await readBoundedJson(join(path, RUN_LIFECYCLE_FILE)));
        const activity = await this.activity(path, metadata);
        runs.push({ name, path, metadata, bytes, activity, identity: { dev: info.dev, ino: info.ino } });
      } catch (cause) {
        if (cause instanceof RunRetentionError && cause.code === "RUN_RETENTION_SCAN_LIMIT") throw cause;
        issues.push({ code: "SCAN_FAILED", message: "failed to validate managed run", runName: name, cause });
      }
      this.stopAtEntryCap(budget);
    }
    return { root: this.root, runs, issues, scannedBytes: budget.bytes, scannedEntries: budget.entries };
  }

  async list(): Promise<ManagedRunListing> {
    const listing = await this.listInternal();
    return { ...listing, runs: listing.runs.map(({ identity: _identity, ...run }) => run) };
  }

  private sameLifecycle(left: RunLifecycleMetadata, right: RunLifecycleMetadata): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private async validateRemovalCandidate(run: ScannedRunInfo, now: number): Promise<boolean> {
    let identity: RunIdentity;
    try { identity = await this.ensureRunPath(run.path); }
    catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
    if (identity.dev !== run.identity.dev || identity.ino !== run.identity.ino)
      throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "run identity changed after retention listing");
    const metadata = parseLifecycle(await readBoundedJson(join(run.path, RUN_LIFECYCLE_FILE)));
    if (!this.sameLifecycle(metadata, run.metadata)) return false;
    const activity = await this.activity(run.path, metadata);
    if (activity !== "inactive" && activity !== "stale") return false;
    if (metadata.status === "active") {
      if (now - metadata.updatedAtMs < this.policy.abandonedGraceMs) return false;
    } else {
      if (!metadata.runId)
        throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "terminal lifecycle has no manifest run identity");
      try { await this.validateTerminalEvidence(run.path, metadata.runId, metadata.status); }
      catch (cause) {
        throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "terminal lifecycle evidence is invalid", cause);
      }
    }
    await this.scanTree(run.path, { entries: 0, bytes: 0 });
    return true;
  }

  private async validateSelectedCandidate(
    run: ScannedRunInfo,
    now: number,
    options: RunCleanupOptions,
    alreadyRetired: boolean,
  ): Promise<boolean> {
    if (!await this.validateRemovalCandidate(run, now)) return false;
    if (alreadyRetired) return true;
    const current = await this.listInternal();
    const refreshed = current.runs.find((candidate) => candidate.name === run.name);
    if (!refreshed || refreshed.identity.dev !== run.identity.dev || refreshed.identity.ino !== run.identity.ino
      || !this.sameLifecycle(refreshed.metadata, run.metadata)) return false;
    return selectRetentionCandidates(current.runs, this.policy, now, options).has(run.name);
  }

  private writerContention(error: unknown): boolean {
    return error instanceof RunWriterArbiterError && [
      "WRITER_ARBITER_ALREADY_OWNED",
      "WRITER_ARBITER_BUSY",
      "WRITER_ARBITER_AMBIGUOUS",
      "WRITER_ARBITER_ELECTION_LOST",
      "WRITER_ARBITER_PENDING_CONFLICT",
      "WRITER_ARBITER_FENCED",
    ].includes(error.code);
  }

  private async removeCandidate(
    run: ScannedRunInfo,
    now: number,
    options: RunCleanupOptions,
  ): Promise<"deleted" | "retained" | RunCleanupSkipReason> {
    const checkpoint = (): void => {
      if (options.signal?.aborted) throw new CleanupAborted(options.signal.reason);
    };
    checkpoint();
    await this.beforeDecision(run.path);
    checkpoint();
    let lease: RunWriterLease;
    let retirementMode: "publishing" | "recovering" | undefined;
    try {
      lease = await acquireRunRetentionLease({
        managedRoot: this.root,
        runName: run.name,
        preflightRetirement: async (mode) => {
          retirementMode = mode;
          if (!await this.validateSelectedCandidate(run, now, options, mode === "recovering"))
            throw new RetentionPreflightChanged();
        },
      }, this.writerOptions);
    } catch (error) {
      if (error instanceof RetentionPreflightChanged) return "retained";
      if (this.writerContention(error)) return "already_claimed";
      if (errorCode(error) === "ENOENT") return "already_removed";
      throw error;
    }

    let terminal = false;
    try {
      await this.afterAcquisition(run.path);
      if (lease.role !== "retirement") checkpoint();
      const recoveringTerminal = retirementMode === "recovering";
      const retiredRecovery = lease.role === "retirement" && recoveringTerminal;
      const eligible = recoveringTerminal
        ? true
        : await lease.run(() => this.validateSelectedCandidate(run, now, options, retiredRecovery));
      if (!eligible) {
        if (lease.role === "retirement")
          throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "irreversible retirement policy changed after publication");
        await lease.release();
        return "retained";
      }
      if (lease.role !== "retirement") checkpoint();
      const quarantined = await lease.quarantine(
        (identity) => quarantineOwnedRun(identity, this.quarantineFileSystem),
        recoveringTerminal ? async () => {
          if (!await this.validateSelectedCandidate(run, now, options, retiredRecovery))
            throw new RetentionPreflightChanged();
        } : undefined,
      );
      terminal = true;
      await scavengeRunQuarantine(
        { root: this.root, name: quarantined.name, remove: this.remover },
        this.quarantineFileSystem,
      );
      return "deleted";
    } catch (cause) {
      if (cause instanceof RunQuarantineAppliedError) terminal = true;
      if (!terminal && lease.role !== "retirement") {
        try { await lease.release(); }
        catch (release) { throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "retention failure and release both failed", new AggregateError([cause, release])); }
      }
      if (cause instanceof CleanupAborted) throw cause;
      const quarantine = join(this.root, quarantineName(lease.generation));
      throw new RunRetentionError(
        "RUN_RETENTION_CLEANUP_FAILED",
        "shared-arbitration retention failed",
        cause,
        undefined,
        terminal ? [await boundedSurvivor(quarantine, "quarantine")] : [],
      );
    }
  }

  async discardOwned(
    name: string,
    path: string,
    _expected: RunLifecycleMetadata,
    writer: RunWriterLease,
    assertUnexposed: () => void | PromiseLike<void>,
  ): Promise<void> {
    await this.ensureRoot();
    if (!RUN_NAME.test(name) || path !== join(this.root, name) || !this.contained(path))
      throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "unsafe owned removal path");
    try {
      const quarantined = await writer.quarantineGenesis(
        (identity) => quarantineFailedGenesis(
          identity.managedRoot,
          identity.runPath,
          identity.generation,
          this.quarantineFileSystem,
        ),
        assertUnexposed,
      );
      await scavengeRunQuarantine(
        { root: this.root, name: quarantined.name, remove: this.remover },
        this.quarantineFileSystem,
      );
      activeOwners.delete(path);
    } catch (cause) {
      if (cause instanceof RunQuarantineAppliedError) activeOwners.delete(path);
      if (cause instanceof RunRetentionError && cause.message === "cannot discard an exposed managed run") throw cause;
      throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "failed to quarantine unused writer genesis", cause);
    }
  }

  async removeOwned(name: string, path: string): Promise<void> {
    const listing = await this.listInternal();
    const run = listing.runs.find((candidate) => candidate.name === name && candidate.path === path);
    if (!run) throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "owned removal target was not a validated run");
    const outcome = await this.removeCandidate(run, this.time(), { force: true });
    if (outcome === "retained" || outcome === "already_claimed")
      throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "owned removal target became active or ambiguous");
  }

  private async scavengeDeadGeneses(): Promise<void> {
    await this.ensureRoot();
    const directory = await opendir(this.root, { bufferSize: 1 });
    let examined = 0;
    try {
      for await (const entry of directory) {
        if (++examined > this.policy.maxScanEntries)
          throw this.scanLimit("dead genesis scavenging entry limit reached");
        if (!RUN_NAME.test(entry.name)) continue;
        let inspection;
        try { inspection = await inspectFailedWriterGenesis(this.root, entry.name); }
        catch { continue; }
        if (!inspection) continue;

        let lease: RunWriterLease;
        let genesisToken: string;
        let genesisAuthority = false;
        if (inspection.kind === "unclaimed") {
          try {
            lease = inspection.arbitrationExists
              ? await recoverFailedRunWriterGenesis({
                  managedRoot: this.root,
                  runName: entry.name,
                  preflight: async () => {
                    const current = await inspectFailedWriterGenesis(this.root, entry.name);
                    if (current?.kind !== "unclaimed" || current.runDev !== inspection!.runDev
                      || current.runIno !== inspection!.runIno) throw new RetentionPreflightChanged();
                  },
                }, this.writerOptions)
              : await createRunWriterGenesis(
                  { managedRoot: this.root, runName: entry.name },
                  this.writerOptions,
                );
            genesisToken = lease.generation.token;
            genesisAuthority = true;
          } catch (error) {
            let current;
            try { current = await inspectFailedWriterGenesis(this.root, entry.name); }
            catch { current = undefined; }
            if (current?.kind === "claimed" || this.writerContention(error)
              || error instanceof RetentionPreflightChanged || errorCode(error) === "ENOENT") continue;
            throw error;
          }
        } else {
          genesisToken = inspection.genesis!.token;
          try {
            lease = await acquireRunRetentionLease({
              managedRoot: this.root,
              runName: entry.name,
              preflightRetirement: async () => {
                const current = await inspectFailedWriterGenesis(this.root, entry.name);
                if (current?.kind !== "claimed" || current.genesis?.token !== genesisToken
                  || current.runDev !== inspection!.runDev || current.runIno !== inspection!.runIno)
                  throw new RetentionPreflightChanged();
              },
            }, this.writerOptions);
          } catch (error) {
            if (this.writerContention(error) || error instanceof RetentionPreflightChanged || errorCode(error) === "ENOENT") continue;
            throw error;
          }
        }

        let terminal = false;
        try {
          const guard = () => assertFailedGenesisRetirement(
            this.root,
            entry.name,
            genesisToken,
            lease.generation,
          );
          const quarantined = genesisAuthority
            ? await lease.quarantineGenesis(
                (identity) => quarantineFailedGenesis(
                  identity.managedRoot,
                  identity.runPath,
                  identity.generation,
                  this.quarantineFileSystem,
                ),
                guard,
              )
            : await lease.quarantine(
                (identity) => quarantineOwnedRun(identity, this.quarantineFileSystem),
                guard,
              );
          terminal = true;
          await scavengeRunQuarantine(
            { root: this.root, name: quarantined.name, remove: this.remover },
            this.quarantineFileSystem,
          );
        } catch (cause) {
          if (cause instanceof RunQuarantineAppliedError) terminal = true;
          if (!terminal && lease.role !== "retirement") {
            try { await lease.release(); }
            catch (release) { cause = new AggregateError([cause, release], "failed-genesis validation and release both failed"); }
          }
          throw new RunRetentionError(
            "RUN_RETENTION_CLEANUP_FAILED",
            "failed to reconcile and scavenge pre-lifecycle writer genesis",
            cause,
            undefined,
            terminal ? [await boundedSurvivor(join(this.root, quarantineName(lease.generation)), "quarantine")] : [],
          );
        }
      }
    } finally { try { await directory.close(); } catch { /* Iterator may already have closed it. */ } }
  }

  private async scavengeQuarantines(): Promise<void> {
    await this.ensureRoot();
    const directory = await opendir(this.root, { bufferSize: 1 });
    let examined = 0;
    try {
      for await (const entry of directory) {
        if (++examined > this.policy.maxScanEntries)
          throw this.scanLimit("quarantine scavenging entry limit reached");
        if (!isRunQuarantineName(entry.name)) continue;
        try {
          await scavengeRunQuarantine(
            { root: this.root, name: entry.name, remove: this.remover },
            this.quarantineFileSystem,
          );
        } catch (cause) {
          throw new RunRetentionError(
            "RUN_RETENTION_CLEANUP_FAILED",
            "failed to scavenge deterministic managed-run quarantine",
            cause,
            undefined,
            [await boundedSurvivor(join(this.root, entry.name), "quarantine")],
          );
        }
      }
    } finally { try { await directory.close(); } catch { /* Iterator may already have closed it. */ } }
  }

  async cleanup(options: RunCleanupOptions = {}): Promise<RunCleanupResult> {
    const checkpoint = (): void => {
      if (options.signal?.aborted) throw new CleanupAborted(options.signal.reason);
    };
    try {
      checkpoint();
      if (!options.dryRun) {
        await this.retryReleaseAuthorities();
        checkpoint();
        await this.scavengeQuarantines();
        checkpoint();
        await this.scavengeDeadGeneses();
        checkpoint();
      }
    } catch (cause) {
      if (cause instanceof CleanupAborted)
        throw new RunRetentionError("RUN_RETENTION_CLEANUP_FAILED", "managed cleanup was cancelled before run deletion", cause.reason);
      throw cause;
    }
    const internal = await this.listInternal();
    const listing: ManagedRunListing = {
      ...internal,
      runs: internal.runs.map(({ identity: _identity, ...run }) => run),
    };
    const now = this.time();
    const selected = selectRetentionCandidates(internal.runs, this.policy, now, options);

    const ordered = internal.runs
      .filter((run) => selected.has(run.name))
      .sort((a, b) => {
        const at = a.metadata.terminalAtMs ?? a.metadata.updatedAtMs;
        const bt = b.metadata.terminalAtMs ?? b.metadata.updatedAtMs;
        return (at - bt) || a.name.localeCompare(b.name);
      });
    const deleted: string[] = [];
    const skipped: RunCleanupSkipped[] = [];
    const failedRemovals = new Set<string>();
    const issues = [...listing.issues];
    if (!options.dryRun) {
      for (const run of ordered) {
        try {
          checkpoint();
          const outcome = await this.removeCandidate(run, now, options);
          if (outcome === "deleted") deleted.push(run.name);
          else if (outcome === "already_removed" || outcome === "already_claimed")
            skipped.push({ runName: run.name, reason: outcome });
        } catch (cause) {
          if (cause instanceof CleanupAborted) {
            const removed = new Set(deleted);
            const result: RunCleanupResult = {
              ...listing,
              issues,
              deleted: [...deleted],
              skipped: [...skipped],
              wouldDelete: [],
              retained: internal.runs.map((candidate) => candidate.name)
                .filter((name) => !removed.has(name)).sort(),
            };
            throw new RunRetentionError(
              "RUN_RETENTION_CLEANUP_FAILED",
              "managed cleanup was cancelled after a partial result",
              cause.reason,
              result,
            );
          }
          failedRemovals.add(run.name);
          issues.push({ code: "CLEANUP_FAILED", message: "failed to remove managed run", runName: run.name, cause });
        }
      }
    }
    const finalInternal = options.dryRun ? internal : await this.listInternal();
    const handled = new Set(options.dryRun ? ordered.map((run) => run.name) : []);
    const retainedByName = new Map(
      finalInternal.runs.filter((run) => !handled.has(run.name)).map((run) => [run.name, run] as const),
    );
    for (const run of internal.runs) if (failedRemovals.has(run.name)) retainedByName.set(run.name, run);
    const retainedRuns = [...retainedByName.values()];
    const retainedTerminal = retainedRuns.filter((run) => run.metadata.status !== "active");
    const policyUnsatisfied = retainedTerminal.length > this.policy.maxTerminalRuns
      || retainedTerminal.reduce((sum, run) => sum + run.bytes, 0) > this.policy.maxTerminalBytes
      || retainedTerminal.some((run) => now - run.metadata.terminalAtMs! >= this.policy.terminalMaxAgeMs);
    if (!options.dryRun && policyUnsatisfied)
      issues.push({ code: "POLICY_UNSATISFIED", message: "active, ambiguous, or failed removals prevent terminal retention bounds" });
    const invalidRetained = finalInternal.issues
      .filter((issue) => issue.code === "SCAN_FAILED" && issue.runName !== undefined && RUN_NAME.test(issue.runName))
      .map((issue) => issue.runName!);
    const result: RunCleanupResult = {
      ...listing,
      issues,
      deleted,
      skipped,
      wouldDelete: options.dryRun ? ordered.map((run) => run.name) : [],
      retained: [...new Set([...retainedRuns.map((run) => run.name), ...invalidRetained])].sort(),
    };
    if (!options.dryRun && issues.length > 0) {
      const code = policyUnsatisfied ? "RUN_RETENTION_POLICY_UNSATISFIED" : "RUN_RETENTION_CLEANUP_FAILED";
      const survivors = issues.flatMap((issue) => issue.cause instanceof RunRetentionError ? issue.cause.survivors : []);
      throw new RunRetentionError(
        code,
        "managed run cleanup could not safely enforce retention policy",
        new AggregateError(issues.map((issue) => issue.cause ?? new Error(issue.message))),
        result,
        survivors,
      );
    }
    return result;
  }
}

type TerminalEvent = Extract<RlmEvent, { type: "run_completed" | "run_failed" | "run_cancelled" }>;

/** Explicit host API for future commands/TUI consumers. */
export const listManagedRuns = (options: ManagedRunStoreOptions = {}): Promise<ManagedRunListing> =>
  new ManagedRunStore(options).list();

/** Explicit host API. Dry-run never removes; force still preserves live/ambiguous/non-abandoned runs. */
export const cleanupManagedRuns = (
  options: ManagedRunStoreOptions = {},
  cleanup: RunCleanupOptions = {},
): Promise<RunCleanupResult> => new ManagedRunStore(options).cleanup(cleanup);
