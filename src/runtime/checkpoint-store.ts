/** Fixed-slot durable checkpoint payload storage with a profile-scaled aggregate bound. */

import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../core/json.ts";
import { prepareCanonicalJson } from "../shell/canonical-json.ts";
import type { ContextStoreInstrumentation } from "../shell/context-store-contract.ts";
import { sha256Bytes } from "../shell/hash.ts";
import {
  RUN_CHECKPOINT_MAX_PHYSICAL_ENTRIES,
  RUN_CHECKPOINT_RETAINED_SLOTS,
  runCheckpointAggregateByteLimit,
  runCheckpointPayloadByteLimit,
} from "./checkpoint-types.ts";
import { checkpointControlFailure, isOptionalCheckpointStorageFailure } from "./checkpoint-failure.ts";

export const RUN_CHECKPOINT_DIRECTORY = "checkpoints";
const PENDING_FILE = ".pending.tmp";
const SLOT = /^slot-([01])\.bin$/;
const noFollow = constants.O_NOFOLLOW ?? 0;
const directoryFlag = constants.O_DIRECTORY ?? 0;

export interface RunCheckpointContentReference {
  readonly checkpointSequence: number;
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RunCheckpointPhysicalUsage {
  readonly entries: number;
  readonly bytes: number;
  readonly byteLimit: number;
  readonly entryLimit: number;
}

export class RunCheckpointStoreError extends Error {
  override readonly name: string = "RunCheckpointStoreError";
}

export class RunCheckpointCapacityError extends RunCheckpointStoreError {
  override readonly name = "RunCheckpointCapacityError";
  readonly code = "CHECKPOINT_CAPACITY";
}

const checkpointPath = (dir: string, sequence: number): string =>
  join(dir, RUN_CHECKPOINT_DIRECTORY, `slot-${sequence % RUN_CHECKPOINT_RETAINED_SLOTS}.bin`);

/** Test and diagnostics helper. Slot names are not journal authority. */
export const runCheckpointPayloadPath = checkpointPath;

const stable = (before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, after: typeof before): boolean =>
  before.dev === after.dev && before.ino === after.ino && before.size === after.size
  && before.mode === after.mode && before.nlink === after.nlink
  && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

export class RunCheckpointStore {
  private readonly directory: string;
  private readonly payloadLimit: number;
  private readonly aggregateLimit: number;

  constructor(
    private readonly dir: string,
    storedByteLimit: number,
    private readonly instrumentation: ContextStoreInstrumentation = {},
  ) {
    this.directory = join(dir, RUN_CHECKPOINT_DIRECTORY);
    this.payloadLimit = runCheckpointPayloadByteLimit(storedByteLimit);
    this.aggregateLimit = runCheckpointAggregateByteLimit(storedByteLimit);
  }

  private operation<T>(path: string, effect: () => Promise<T>): Promise<T> {
    return this.instrumentation.runFileSystemOperation?.(path, effect) ?? effect();
  }

  private async ensureDirectory(create: boolean): Promise<void> {
    if (create) {
      try { await this.operation(this.directory, () => mkdir(this.directory, { mode: 0o700 })); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const info = await this.operation(this.directory, () => lstat(this.directory));
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new RunCheckpointStoreError("checkpoint directory is not a private real directory");
    const [root, actual] = await Promise.all([
      this.operation(this.dir, () => realpath(this.dir)),
      this.operation(this.directory, () => realpath(this.directory)),
    ]);
    if (actual !== join(root, RUN_CHECKPOINT_DIRECTORY))
      throw new RunCheckpointStoreError("checkpoint directory escapes the run directory");
  }

  private async names(): Promise<string[]> {
    const directory = await this.operation(this.directory, () => opendir(this.directory, { bufferSize: 1 }));
    const names: string[] = [];
    try {
      while (names.length <= RUN_CHECKPOINT_MAX_PHYSICAL_ENTRIES) {
        const entry = await directory.read();
        if (!entry) return names.sort();
        names.push(entry.name);
      }
      throw new RunCheckpointStoreError("checkpoint storage exceeds its entry limit");
    } finally { await directory.close(); }
  }

  private async privateFileSize(path: string, allowEmpty = false): Promise<number> {
    const handle = await this.operation(path, () => open(path, constants.O_RDONLY | noFollow));
    try {
      const before = await this.operation(path, () => handle.stat());
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0
        || before.size < (allowEmpty ? 0 : 1) || before.size > this.payloadLimit)
        throw new RunCheckpointStoreError("checkpoint entry is not one bounded private regular file");
      const after = await this.operation(path, () => handle.stat());
      if (!stable(before, after)) throw new RunCheckpointStoreError("checkpoint entry changed during inspection");
      return before.size;
    } finally { await this.operation(path, () => handle.close()); }
  }

  private async inspectEntries(): Promise<RunCheckpointPhysicalUsage> {
    const names = await this.names();
    let bytes = 0;
    for (const name of names) {
      if (name !== PENDING_FILE && !SLOT.test(name))
        throw new RunCheckpointStoreError("checkpoint directory contains an unexpected entry");
      // O_CREAT|O_EXCL may leave exactly zero bytes after a crash. Only the
      // fixed pending leaf receives that tolerance; authoritative slots do not.
      const size = await this.privateFileSize(join(this.directory, name), name === PENDING_FILE);
      if (bytes > this.aggregateLimit - size)
        throw new RunCheckpointCapacityError("checkpoint storage exceeds its aggregate byte limit");
      bytes += size;
    }
    return {
      entries: names.length,
      bytes,
      byteLimit: this.aggregateLimit,
      entryLimit: RUN_CHECKPOINT_MAX_PHYSICAL_ENTRIES,
    };
  }

  private async removePending(): Promise<void> {
    const path = join(this.directory, PENDING_FILE);
    try {
      await this.privateFileSize(path, true);
      const remove = this.instrumentation.unlink ?? unlink;
      await this.operation(path, () => remove(path));
      await this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async syncDirectory(): Promise<void> {
    if (this.instrumentation.syncDirectory) {
      await this.operation(this.directory, () => this.instrumentation.syncDirectory!(this.directory));
      return;
    }
    const handle = await this.operation(
      this.directory,
      () => open(this.directory, constants.O_RDONLY | directoryFlag | noFollow),
    );
    try {
      const info = await this.operation(this.directory, () => handle.stat());
      if (!info.isDirectory()) throw new RunCheckpointStoreError("checkpoint directory identity changed");
      await this.operation(this.directory, () => handle.sync());
    } finally { await this.operation(this.directory, () => handle.close()); }
  }

  private async writePending(bytes: Uint8Array): Promise<void> {
    const path = join(this.directory, PENDING_FILE);
    if (this.instrumentation.writeFile) {
      await this.operation(path, () => this.instrumentation.writeFile!(path, bytes));
      if (this.instrumentation.syncFile)
        await this.operation(path, () => this.instrumentation.syncFile!(path));
      else {
        const handle = await this.operation(path, () => open(path, constants.O_RDONLY | noFollow));
        try { await this.operation(path, () => handle.sync()); }
        finally { await this.operation(path, () => handle.close()); }
      }
      return;
    }
    await this.operation(path, () => writeFile(path, bytes, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode: 0o600,
    }));
    const handle = await this.operation(path, () => open(path, constants.O_RDONLY | noFollow));
    try { await this.operation(path, () => handle.sync()); }
    finally { await this.operation(path, () => handle.close()); }
  }

  /** Publish into the non-authoritative parity slot. Undefined means safely declined. */
  async publish(
    sequence: number,
    payload: JsonValue,
    checkpoint: () => void,
  ): Promise<RunCheckpointContentReference | undefined> {
    const prepared = prepareCanonicalJson(payload, checkpoint);
    if (prepared.bytes < 1 || prepared.bytes > this.payloadLimit) return undefined;
    checkpoint();
    try {
      await this.ensureDirectory(true);
      await this.removePending();
      const usage = await this.inspectEntries();
      if (usage.entries > RUN_CHECKPOINT_RETAINED_SLOTS
        || usage.bytes > this.aggregateLimit - prepared.bytes) return undefined;
      const bytes = prepared.materialize();
      await this.writePending(bytes);
      if (await this.privateFileSize(join(this.directory, PENDING_FILE)) !== prepared.bytes)
        throw new RunCheckpointStoreError("checkpoint pending payload length changed");
      checkpoint();
      const target = checkpointPath(this.dir, sequence);
      const move = this.instrumentation.rename ?? rename;
      await this.operation(target, () => move(join(this.directory, PENDING_FILE), target));
      await this.syncDirectory();
      const final = await this.read({
        checkpointSequence: sequence,
        id: `ctx_${prepared.sha256}`,
        sha256: prepared.sha256,
        bytes: prepared.bytes,
      }, checkpoint);
      if (final.byteLength !== prepared.bytes) throw new RunCheckpointStoreError("published checkpoint length changed");
      await this.inspectEntries();
      return {
        checkpointSequence: sequence,
        id: `ctx_${prepared.sha256}`,
        sha256: prepared.sha256,
        bytes: prepared.bytes,
      };
    } catch (error) {
      let cleanupError: unknown;
      try { await this.removePending(); } catch (cleanup) { cleanupError = cleanup; }
      checkpoint();
      const controlFailure = checkpointControlFailure(error)
        ?? (cleanupError === undefined ? undefined : checkpointControlFailure(cleanupError));
      if (controlFailure !== undefined) throw controlFailure;
      if (isOptionalCheckpointStorageFailure(error)
        && (cleanupError === undefined || isOptionalCheckpointStorageFailure(cleanupError))) return undefined;
      if (cleanupError !== undefined)
        throw new AggregateError([error, cleanupError], "checkpoint publication and pending cleanup both failed");
      throw error;
    }
  }

  async read(reference: RunCheckpointContentReference, checkpoint: () => void = () => {}): Promise<Uint8Array> {
    if (!Number.isSafeInteger(reference.checkpointSequence) || reference.checkpointSequence < 1
      || !/^ctx_[a-f0-9]{64}$/.test(reference.id) || !/^[a-f0-9]{64}$/.test(reference.sha256)
      || reference.id !== `ctx_${reference.sha256}` || !Number.isSafeInteger(reference.bytes)
      || reference.bytes < 1 || reference.bytes > this.payloadLimit)
      throw new RunCheckpointStoreError("checkpoint reference is invalid or exceeds its profile bound");
    checkpoint();
    await this.ensureDirectory(false);
    await this.inspectEntries();
    const path = checkpointPath(this.dir, reference.checkpointSequence);
    const handle = await this.operation(path, () => open(path, constants.O_RDONLY | noFollow));
    try {
      const before = await this.operation(path, () => handle.stat());
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0
        || before.size !== reference.bytes || before.size > this.payloadLimit)
        throw new RunCheckpointStoreError("checkpoint payload is not a bounded private regular file");
      const bytes = Buffer.alloc(reference.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        checkpoint();
        const result = await this.operation(path, () => handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset));
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await this.operation(path, () => handle.stat());
      if (offset !== reference.bytes || !stable(before, after))
        throw new RunCheckpointStoreError("checkpoint payload changed during its bounded read");
      const result = new Uint8Array(bytes);
      if (sha256Bytes(result) !== reference.sha256)
        throw new RunCheckpointStoreError("checkpoint payload hash is invalid");
      checkpoint();
      return result;
    } finally { await this.operation(path, () => handle.close()); }
  }

  async usage(): Promise<RunCheckpointPhysicalUsage> {
    await this.ensureDirectory(false);
    return this.inspectEntries();
  }
}
