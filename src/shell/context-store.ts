/**
 * Host-backed immutable context store (imperative shell).
 *
 * Sources are snapshotted by content; every handle is content-addressed so the
 * same bytes always yield the same id (which makes call identity and restart
 * replay stable). Reads are byte-accurate and never split a UTF-8 code point.
 * The store persists content under `<dir>/contexts/<sha>.bin`. Journaled content
 * references support later recovery work; this store does not implement resume.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { JsonValue } from "../core/json.ts";
import { headTailPreview } from "../core/preview.ts";
import { prepareCanonicalJson } from "./canonical-json.ts";
import {
  ContextBudgetError,
  type ContextByteReservation,
  ContextChunkOverflowError,
  ContextCleanupError,
  type ContextContentReference,
  type ContextDescriptor,
  ContextIntegrityError,
  type ContextMatch,
  type ContextOperationControl,
  type ContextRead,
  ContextSpecError,
  type ContextStoreInstrumentation,
  type ContextStoreLimits,
  type ContextStoreTransaction,
  ContextUnavailableError,
  DEFAULT_CONTEXT_STORE_LIMITS,
} from "./context-store-contract.ts";
import { sha256, sha256Bytes, sha256Parts } from "./hash.ts";

export {
  ContextBudgetError,
  ContextChunkOverflowError,
  ContextCleanupError,
  ContextIntegrityError,
  ContextSpecError,
  ContextUnavailableError,
  DEFAULT_CONTEXT_STORE_LIMITS,
} from "./context-store-contract.ts";
export type {
  ContextByteReservation,
  ContextContentReference,
  ContextDescriptor,
  ContextMatch,
  ContextOperationControl,
  ContextRead,
  ContextStoreInstrumentation,
  ContextStoreLimits,
  ContextStoreTransaction,
} from "./context-store-contract.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });
const TOKEN_ESTIMATOR = "utf8-bytes/4";
const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);

interface Entry {
  readonly descriptor: ContextDescriptor;
  readonly bytesArray: Uint8Array;
}

interface OrphanEntry {
  readonly path: string;
  /** Physical bytes reachable through this path. Hard-link aliases may charge zero. */
  bytes: number;
  /** Run-local logical bytes retained by this orphan. */
  chargedBytes: number;
  readonly removable: boolean;
  reservation?: ContextByteReservation;
  cause: unknown;
}

type CandidateState = "prepared" | "temp-owned" | "published-shared" | "observed-shared";

class PreparedEntry {
  private bytesArray: Uint8Array | undefined;

  constructor(
    readonly descriptor: ContextDescriptor,
    private materializer: (() => Uint8Array) | undefined,
    private onMaterialize?: (descriptor: ContextDescriptor) => void,
  ) {}

  materialize(): Uint8Array {
    if (this.bytesArray !== undefined) return this.bytesArray;
    if (this.materializer === undefined) throw new Error(`prepared context ${this.descriptor.id} has no bytes`);
    this.bytesArray = this.materializer();
    this.materializer = undefined;
    const observer = this.onMaterialize;
    this.onMaterialize = undefined;
    observer?.(this.descriptor);
    return this.bytesArray;
  }
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

// Start offsets move forward to the next code-point boundary (skip a partial
// leading code point); end offsets move backward (never split a code point).
const forwardBoundary = (bytes: Uint8Array, index: number): number => {
  let i = Math.min(Math.max(index, 0), bytes.length);
  while (i < bytes.length && isContinuation(bytes[i] as number)) i++;
  return i;
};

const backwardBoundary = (bytes: Uint8Array, index: number): number => {
  let i = Math.min(Math.max(index, 0), bytes.length);
  while (i > 0 && i < bytes.length && isContinuation(bytes[i] as number)) i--;
  return i;
};

const CHECKPOINT_INTERVAL_BYTES = 16 * 1024;

const boundedInteger = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ContextSpecError(`${name} must be an integer between ${min} and ${max}`);
  return value;
};

const validateLimits = (limits: ContextStoreLimits): ContextStoreLimits => {
  const validated = {
    maxReadBytes: boundedInteger(limits.maxReadBytes, "maxReadBytes", 4, Number.MAX_SAFE_INTEGER),
    maxLines: boundedInteger(limits.maxLines, "maxLines", 1, Number.MAX_SAFE_INTEGER),
    maxLineBytes: boundedInteger(limits.maxLineBytes, "maxLineBytes", 1, Number.MAX_SAFE_INTEGER),
    maxMatches: boundedInteger(limits.maxMatches, "maxMatches", 1, Number.MAX_SAFE_INTEGER),
    maxChunks: boundedInteger(limits.maxChunks, "maxChunks", 1, Number.MAX_SAFE_INTEGER),
    maxPatternBytes: boundedInteger(limits.maxPatternBytes, "maxPatternBytes", 1, Number.MAX_SAFE_INTEGER),
  };
  if (validated.maxLineBytes > validated.maxReadBytes)
    throw new ContextSpecError("maxLineBytes must not exceed maxReadBytes");
  if (validated.maxPatternBytes > validated.maxReadBytes)
    throw new ContextSpecError("maxPatternBytes must not exceed maxReadBytes");
  return validated;
};

const checkpoint = (control: ContextOperationControl | undefined, offset = 0): void => {
  if (offset % CHECKPOINT_INTERVAL_BYTES === 0) control?.checkpoint?.();
};

const findByte = (
  bytes: Uint8Array,
  value: number,
  start: number,
  end: number,
  control?: ContextOperationControl,
): number => {
  for (let i = start; i < end; i++) {
    checkpoint(control, i);
    if (bytes[i] === value) return i;
  }
  return -1;
};

export class ContextStore {
  private readonly entries = new Map<string, Entry>();
  private readonly contentDir: string;
  private readonly limits: ContextStoreLimits;
  private trustedRoot: string | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private uniqueBytes = 0;
  private readonly orphans = new Map<string, OrphanEntry>();

  constructor(
    private readonly dir: string,
    limits: ContextStoreLimits = DEFAULT_CONTEXT_STORE_LIMITS,
    private readonly instrumentation: ContextStoreInstrumentation = {},
  ) {
    this.contentDir = join(dir, "contexts");
    this.limits = validateLimits(limits);
  }

  private contentHash(value: string | Uint8Array): string {
    const hash = this.instrumentation.hasher?.(value)
      ?? (typeof value === "string" ? sha256(value) : sha256Bytes(value));
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ContextSpecError("content hasher must return 64 lowercase hexadecimal characters");
    return hash;
  }

  private makeId(sha: string): string {
    return `ctx_${sha}`;
  }

  private makeDescriptor(label: string, mimeType: string, sha: string, bytes: number): ContextDescriptor {
    return {
      id: this.makeId(sha),
      label,
      bytes,
      estimatedTokens: estimateTokens(bytes),
      tokenEstimator: TOKEN_ESTIMATOR,
      mimeType,
      sha256: sha,
    };
  }

  private prepareText(label: string, text: string, mimeType: string): PreparedEntry {
    const sha = this.contentHash(text);
    const descriptor = this.makeDescriptor(label, mimeType, sha, Buffer.byteLength(text, "utf8"));
    return new PreparedEntry(descriptor, () => encoder.encode(text), this.instrumentation.onMaterialize);
  }

  private prepareBytes(label: string, bytes: Uint8Array, mimeType: string): PreparedEntry {
    const descriptor = this.makeDescriptor(label, mimeType, this.contentHash(bytes), bytes.length);
    return new PreparedEntry(descriptor, () => bytes.slice(), this.instrumentation.onMaterialize);
  }

  private prepareJson(label: string, value: JsonValue, control?: ContextOperationControl): PreparedEntry {
    const prepared = prepareCanonicalJson(value, control?.checkpoint);
    const descriptor = this.makeDescriptor(label, "application/json", prepared.sha256, prepared.bytes);
    return new PreparedEntry(descriptor, prepared.materialize, this.instrumentation.onMaterialize);
  }

  private async trustedRootPath(contextId: string): Promise<string> {
    let actual: string;
    try {
      actual = await realpath(this.dir);
    } catch {
      throw new ContextIntegrityError(contextId, "containment");
    }
    if (this.trustedRoot === undefined) this.trustedRoot = actual;
    if (actual !== this.trustedRoot) throw new ContextIntegrityError(contextId, "containment");
    return actual;
  }

  private contained(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
  }

  /** Validate a real, non-symlink contexts directory beneath the stable run root. */
  private async contentDirectory(contextId: string, create: boolean): Promise<string> {
    const root = await this.trustedRootPath(contextId);
    if (create) {
      try {
        await mkdir(this.contentDir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    let info;
    try {
      info = await lstat(this.contentDir);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") throw new ContextUnavailableError(contextId);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ContextIntegrityError(contextId, "type");
    const actual = await realpath(this.contentDir);
    const expected = join(root, "contexts");
    if (actual !== expected || !this.contained(root, actual)) throw new ContextIntegrityError(contextId, "containment");
    return actual;
  }

  private payloadPath(directory: string, name: string, contextId: string): string {
    const path = join(directory, name);
    if (dirname(path) !== directory || !this.contained(directory, path))
      throw new ContextIntegrityError(contextId, "containment");
    return path;
  }

  private async revalidateDirectory(directory: string, contextId: string): Promise<void> {
    if (await this.contentDirectory(contextId, false) !== directory)
      throw new ContextIntegrityError(contextId, "containment");
  }

  private async openPayload(path: string, directory: string, contextId: string) {
    if (dirname(path) !== directory || !this.contained(directory, path))
      throw new ContextIntegrityError(contextId, "containment");
    await this.revalidateDirectory(directory, contextId);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new ContextUnavailableError(contextId);
      if (code === "ELOOP" || code === "EMLINK") throw new ContextIntegrityError(contextId, "type");
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new ContextIntegrityError(contextId, "type");
      await this.revalidateDirectory(directory, contextId);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async syncPayload(path: string, directory: string, reference: ContextContentReference): Promise<void> {
    if (this.instrumentation.syncFile) {
      await this.instrumentation.syncFile(path);
      return;
    }
    const handle = await this.openPayload(path, directory, reference.id);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string, contextId: string): Promise<void> {
    await this.revalidateDirectory(directory, contextId);
    if (this.instrumentation.syncDirectory) {
      await this.instrumentation.syncDirectory(directory);
    } else {
      const handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isDirectory()) throw new ContextIntegrityError(contextId, "type");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.revalidateDirectory(directory, contextId);
  }

  private async verifyPayload(
    path: string,
    directory: string,
    reference: ContextContentReference,
  ): Promise<Uint8Array> {
    const handle = await this.openPayload(path, directory, reference.id);
    try {
      const bytes = new Uint8Array(await handle.readFile());
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new ContextIntegrityError(reference.id, "type");
      if (bytes.length !== reference.bytes || info.size !== reference.bytes)
        throw new ContextIntegrityError(reference.id, "length");
      if (this.contentHash(bytes) !== reference.sha256) throw new ContextIntegrityError(reference.id, "hash");
      await this.revalidateDirectory(directory, reference.id);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async acquireMutation(): Promise<() => void> {
    const previous = this.mutationTail;
    let unlock!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      unlock();
    };
  }

  private async beginPrepared(
    prepared: readonly PreparedEntry[],
    control?: ContextOperationControl,
  ): Promise<ContextStoreTransaction<ContextDescriptor[]>> {
    const release = await this.acquireMutation();
    let createdDir = false;
    let mutationDirectory: string | undefined;
    let bytesInserted = false;
    let delta = 0;
    const staged: Array<{
      readonly entry: Entry;
      reservation?: ContextByteReservation;
      state: CandidateState;
      tempPath?: string;
      finalPath?: string;
    }> = [];

    const retainedPayload = async (
      path: string,
      maximum: number,
      contextId: string,
    ): Promise<{ readonly exists: boolean; readonly bytes: number }> => {
      try {
        let bytes: number;
        if (this.instrumentation.fileBytes) {
          bytes = await this.instrumentation.fileBytes(path);
        } else {
          if (mutationDirectory === undefined) return { exists: true, bytes: maximum };
          const handle = await this.openPayload(path, mutationDirectory, contextId);
          try {
            bytes = (await handle.stat()).size;
          } finally {
            await handle.close();
          }
        }
        return { exists: true, bytes: Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maximum ? bytes : maximum };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return error instanceof ContextUnavailableError || code === "ENOENT" || code === "ENOTDIR"
          ? { exists: false, bytes: 0 }
          : { exists: true, bytes: maximum };
      }
    };
    const remove = this.instrumentation.unlink ?? unlink;
    const rollbackStaged = async (): Promise<void> => {
      for (const { entry } of staged) {
        if (this.entries.get(entry.descriptor.id) === entry) this.entries.delete(entry.descriptor.id);
      }
      if (bytesInserted) this.uniqueBytes -= delta;

      const failures: Array<{ path: string; bytes: number; cause: unknown }> = [];
      for (const candidate of staged) {
        const { descriptor } = candidate.entry;
        const published = candidate.state === "published-shared";
        let tempFailure: { readonly path: string; readonly bytes: number; readonly cause: unknown } | undefined;
        if (candidate.tempPath !== undefined) {
          try {
            if (mutationDirectory !== undefined) await this.revalidateDirectory(mutationDirectory, descriptor.id);
            await remove(candidate.tempPath);
            if (mutationDirectory !== undefined) await this.revalidateDirectory(mutationDirectory, descriptor.id);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
              const retained = await retainedPayload(candidate.tempPath, descriptor.bytes, descriptor.id);
              if (retained.exists) tempFailure = { path: candidate.tempPath, bytes: retained.bytes, cause };
            }
          }
        }

        if (published) {
          // A published content address is immediately shareable. Without a
          // cross-process lease, rollback must never unlink the final name.
          candidate.reservation?.commit?.();
          const finalPath = candidate.finalPath as string;
          if (!this.orphans.has(finalPath)) {
            this.orphans.set(finalPath, {
              path: finalPath,
              bytes: descriptor.bytes,
              chargedBytes: descriptor.bytes,
              removable: false,
              cause: new Error("published context retained because it may be referenced by another transaction"),
            });
            this.uniqueBytes += descriptor.bytes;
          }
          if (tempFailure) {
            this.orphans.set(tempFailure.path, {
              ...tempFailure,
              chargedBytes: 0,
              removable: true,
            });
            failures.push(
              { path: finalPath, bytes: descriptor.bytes, cause: this.orphans.get(finalPath)?.cause },
              tempFailure,
            );
          }
          continue;
        }

        if (tempFailure) {
          candidate.reservation?.release(descriptor.bytes - tempFailure.bytes);
          const orphan: OrphanEntry = {
            ...tempFailure,
            chargedBytes: tempFailure.bytes,
            removable: true,
          };
          if (candidate.reservation) orphan.reservation = candidate.reservation;
          this.orphans.set(tempFailure.path, orphan);
          this.uniqueBytes += tempFailure.bytes;
          failures.push(tempFailure);
        } else {
          candidate.reservation?.rollback();
        }
      }
      if (createdDir && this.orphans.size === 0 && mutationDirectory !== undefined)
        await rmdir(mutationDirectory).catch(() => undefined);
      if (failures.length > 0) throw new ContextCleanupError(failures);
    };

    try {
      const canonical = new Map<string, ContextDescriptor>();
      for (const [id, entry] of this.entries) canonical.set(id, entry.descriptor);
      const additions: PreparedEntry[] = [];
      const descriptors = prepared.map((candidate) => {
        const existing = canonical.get(candidate.descriptor.id);
        if (existing) return existing;
        canonical.set(candidate.descriptor.id, candidate.descriptor);
        additions.push(candidate);
        return candidate.descriptor;
      });
      for (const candidate of additions) {
        if (delta > Number.MAX_SAFE_INTEGER - candidate.descriptor.bytes)
          throw new ContextSpecError("context output is too large");
        delta += candidate.descriptor.bytes;
      }
      const maxOutputBytes = control?.maxOutputBytes === undefined
        ? Number.MAX_SAFE_INTEGER
        : boundedInteger(control.maxOutputBytes, "maxOutputBytes", 0, Number.MAX_SAFE_INTEGER);
      if (delta > maxOutputBytes)
        throw new ContextBudgetError(`context output requires ${delta} bytes; ${maxOutputBytes} bytes remain`);

      for (const candidate of additions) {
        const reservation = control?.reserveBytes?.(candidate.descriptor.bytes);
        try {
          control?.checkpoint?.();
          const bytesArray = candidate.materialize();
          if (bytesArray.length !== candidate.descriptor.bytes || this.contentHash(bytesArray) !== candidate.descriptor.sha256)
            throw new Error(`prepared context ${candidate.descriptor.id} changed before commit`);
          const stagedCandidate: (typeof staged)[number] = {
            entry: { descriptor: candidate.descriptor, bytesArray },
            state: "prepared",
          };
          if (reservation) stagedCandidate.reservation = reservation;
          staged.push(stagedCandidate);
        } catch (error) {
          reservation?.rollback();
          throw error;
        }
      }
      if (staged.length > 0) {
        try {
          await lstat(this.contentDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") createdDir = true;
          else throw error;
        }
        mutationDirectory = await this.contentDirectory(staged[0]!.entry.descriptor.id, true);
      }
      for (const candidate of staged) {
        control?.checkpoint?.();
        const { entry } = candidate;
        const directory = mutationDirectory as string;
        const finalPath = this.payloadPath(directory, `${entry.descriptor.sha256}.bin`, entry.descriptor.id);
        const orphan = this.orphans.get(finalPath);
        if (orphan) throw new ContextCleanupError([{ path: finalPath, bytes: orphan.bytes, cause: orphan.cause }]);

        const tempPath = this.payloadPath(
          directory,
          `.${entry.descriptor.sha256}.${randomUUID()}.tmp`,
          entry.descriptor.id,
        );
        candidate.tempPath = tempPath;
        candidate.finalPath = finalPath;
        candidate.state = "temp-owned";
        if (this.instrumentation.writeFile) {
          await this.instrumentation.writeFile(tempPath, entry.bytesArray);
        } else {
          await writeFile(tempPath, entry.bytesArray, {
            flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
            mode: 0o600,
          });
        }
        await this.syncPayload(tempPath, directory, entry.descriptor);
        // The synced pathname, not the earlier in-memory buffer, is the
        // publication candidate. Re-read it through a no-follow handle.
        await this.verifyPayload(tempPath, directory, entry.descriptor);

        await this.revalidateDirectory(directory, entry.descriptor.id);
        try {
          if (this.instrumentation.rename) {
            await this.instrumentation.rename(tempPath, finalPath);
            candidate.tempPath = undefined;
          } else {
            await link(tempPath, finalPath);
          }
          candidate.state = "published-shared";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          candidate.state = "observed-shared";
        }
        await this.revalidateDirectory(directory, entry.descriptor.id);

        if (candidate.tempPath !== undefined) {
          await remove(candidate.tempPath);
          candidate.tempPath = undefined;
          await this.revalidateDirectory(directory, entry.descriptor.id);
        }
        await this.verifyPayload(finalPath, directory, entry.descriptor);
        await this.syncDirectory(directory, entry.descriptor.id);
      }
      for (const { entry } of staged) this.entries.set(entry.descriptor.id, entry);
      this.uniqueBytes += delta;
      bytesInserted = true;
      control?.checkpoint?.();

      let active = true;
      return {
        value: descriptors,
        commit: () => {
          if (!active) return;
          active = false;
          for (const candidate of staged) candidate.reservation?.commit?.();
          release();
        },
        rollback: async () => {
          if (!active) return;
          active = false;
          try {
            await rollbackStaged();
          } finally {
            release();
          }
        },
      };
    } catch (error) {
      try {
        await rollbackStaged();
      } finally {
        release();
      }
      throw error;
    }
  }

  private async commitPrepared(
    prepared: readonly PreparedEntry[],
    control?: ContextOperationControl,
  ): Promise<ContextDescriptor[]> {
    const transaction = await this.beginPrepared(prepared, control);
    transaction.commit();
    return transaction.value;
  }

  private async intern(
    label: string,
    text: string,
    mimeType: string,
    control?: ContextOperationControl,
  ): Promise<ContextDescriptor> {
    return (await this.commitPrepared([this.prepareText(label, text, mimeType)], control))[0] as ContextDescriptor;
  }

  async ingestText(
    label: string,
    text: string,
    mimeType = "text/plain",
    control?: ContextOperationControl,
  ): Promise<ContextDescriptor> {
    return this.intern(label, text, mimeType, control);
  }

  /** Stage all initial sources as one unique-byte transaction. */
  beginIngestTexts(
    sources: readonly { readonly label: string; readonly text: string; readonly mimeType?: string }[],
    control?: ContextOperationControl,
  ): Promise<ContextStoreTransaction<ContextDescriptor[]>> {
    return this.beginPrepared(
      sources.map((source) => this.prepareText(source.label, source.text, source.mimeType ?? "text/plain")),
      control,
    );
  }

  get(id: string): ContextDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }

  totalBytes(): number {
    return this.uniqueBytes;
  }

  orphanedBytes(): number {
    let bytes = 0;
    for (const orphan of this.orphans.values()) bytes += orphan.chargedBytes;
    return bytes;
  }

  /**
   * Retry transaction-exclusive temporary cleanup. Published final names are
   * intentionally retained: another process may already have committed a
   * reference, and pathname ownership cannot prove otherwise.
   */
  async cleanupOrphans(control?: ContextOperationControl): Promise<void> {
    const release = await this.acquireMutation();
    const remove = this.instrumentation.unlink ?? unlink;
    const failures: Array<{ path: string; bytes: number; cause: unknown }> = [];
    try {
      for (const [path, orphan] of this.orphans) {
        if (!orphan.removable) continue;
        control?.checkpoint?.();
        try {
          await remove(path);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
            let bytes = orphan.bytes;
            let exists = true;
            try {
              const measured = this.instrumentation.fileBytes
                ? await this.instrumentation.fileBytes(path)
                : (await lstat(path)).size;
              if (Number.isSafeInteger(measured) && measured >= 0 && measured <= bytes) bytes = measured;
            } catch (measurementCause) {
              const code = (measurementCause as NodeJS.ErrnoException).code;
              if (code === "ENOENT" || code === "ENOTDIR") exists = false;
            }
            if (exists) {
              const released = Math.min(orphan.chargedBytes, orphan.bytes - bytes);
              if (released > 0) {
                orphan.reservation?.release(released);
                this.uniqueBytes -= released;
                orphan.chargedBytes -= released;
              }
              orphan.bytes = bytes;
              orphan.cause = cause;
              failures.push({ path, bytes: orphan.bytes, cause });
              continue;
            }
          }
        }
        this.orphans.delete(path);
        this.uniqueBytes -= orphan.chargedBytes;
        orphan.reservation?.rollback();
      }
      if (this.entries.size === 0 && this.orphans.size === 0) {
        const directory = await this.contentDirectory("contexts", false).catch(() => undefined);
        if (directory !== undefined) await rmdir(directory).catch(() => undefined);
      }
      if (failures.length > 0) throw new ContextCleanupError(failures);
    } finally {
      release();
    }
  }

  private entryOrThrow(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new ContextUnavailableError(id);
    return entry;
  }

  read(
    id: string,
    options: { offsetBytes?: number; lengthBytes?: number } = {},
    control?: ContextOperationControl,
  ): ContextRead {
    const { bytesArray } = this.entryOrThrow(id);
    const offset = options.offsetBytes === undefined
      ? 0
      : boundedInteger(options.offsetBytes, "offsetBytes", 0, Number.MAX_SAFE_INTEGER);
    const length = options.lengthBytes === undefined
      ? this.limits.maxReadBytes
      : boundedInteger(options.lengthBytes, "lengthBytes", 0, this.limits.maxReadBytes);
    control?.checkpoint?.();
    const start = forwardBoundary(bytesArray, offset);
    const end = Math.max(start, backwardBoundary(bytesArray, Math.min(bytesArray.length, start + length)));
    const text = decoder.decode(bytesArray.subarray(start, end));
    control?.checkpoint?.();
    return { text, startByte: start, endByte: end, truncated: end < bytesArray.length };
  }

  /**
   * Return a 1-based line window with half-open UTF-8 byte offsets. LF and CRLF
   * delimiters are excluded from the last selected line; delimiters between
   * selected lines retain their original bytes. A trailing delimiter creates a
   * final empty line. Invalid bounds are rejected; requests past the last line
   * return an empty slice at EOF.
   */
  lines(
    id: string,
    options: { startLine: number; count: number },
    control?: ContextOperationControl,
  ): ContextRead {
    const { bytesArray } = this.entryOrThrow(id);
    const startLine = boundedInteger(options.startLine, "startLine", 1, Number.MAX_SAFE_INTEGER);
    const count = boundedInteger(options.count, "count", 1, this.limits.maxLines);

    let currentLine = 1;
    let startByte = 0;
    while (currentLine < startLine) {
      const newline = findByte(bytesArray, 0x0a, startByte, bytesArray.length, control);
      if (newline === -1)
        return { text: "", startByte: bytesArray.length, endByte: bytesArray.length, truncated: false };
      startByte = newline + 1;
      currentLine++;
    }

    let lineStart = startByte;
    let endByte = startByte;
    for (let selected = 0; selected < count; selected++) {
      const newline = findByte(bytesArray, 0x0a, lineStart, bytesArray.length, control);
      const rawEnd = newline === -1 ? bytesArray.length : newline;
      const lineEnd = rawEnd > lineStart && bytesArray[rawEnd - 1] === 0x0d ? rawEnd - 1 : rawEnd;
      const lineBytes = lineEnd - lineStart;
      if (lineBytes > this.limits.maxLineBytes)
        throw new ContextSpecError(`line ${currentLine + selected} exceeds maxLineBytes ${this.limits.maxLineBytes}`);
      endByte = lineEnd;
      if (endByte - startByte > this.limits.maxReadBytes)
        throw new ContextSpecError(`line window exceeds maxReadBytes ${this.limits.maxReadBytes}`);
      if (newline === -1 || selected + 1 === count) {
        const text = decoder.decode(bytesArray.subarray(startByte, endByte));
        control?.checkpoint?.();
        return { text, startByte, endByte, truncated: newline !== -1 };
      }
      lineStart = newline + 1;
    }

    throw new ContextSpecError("invalid line window");
  }

  grep(
    id: string,
    options: { pattern: string; caseSensitive?: boolean; maxMatches: number; syntax?: "literal" },
    control?: ContextOperationControl,
  ): ContextMatch[] {
    const { bytesArray } = this.entryOrThrow(id);
    if (typeof options.pattern !== "string") throw new ContextSpecError("pattern must be a string");
    const patternBytes = encoder.encode(options.pattern).length;
    if (patternBytes > this.limits.maxPatternBytes)
      throw new ContextSpecError(`pattern exceeds maxPatternBytes ${this.limits.maxPatternBytes}`);
    if (options.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean")
      throw new ContextSpecError("caseSensitive must be a boolean");
    if (options.syntax !== undefined && options.syntax !== "literal")
      throw new ContextSpecError(`grep syntax ${JSON.stringify(options.syntax)} is unsupported in v1; use literal syntax`);
    const maxMatches = boundedInteger(options.maxMatches, "maxMatches", 1, this.limits.maxMatches);
    const caseSensitive = options.caseSensitive === true;
    const needle = caseSensitive ? options.pattern : options.pattern.toLowerCase();
    const matches: ContextMatch[] = [];
    let returnedBytes = 0;
    let lineStart = 0;
    let lineNumber = 1;

    while (lineStart <= bytesArray.length && matches.length < maxMatches) {
      const newline = findByte(bytesArray, 0x0a, lineStart, bytesArray.length, control);
      const lineEnd = newline === -1 ? bytesArray.length : newline;
      const lineBytes = lineEnd - lineStart;
      if (lineBytes > this.limits.maxLineBytes)
        throw new ContextSpecError(`line ${lineNumber} exceeds maxLineBytes ${this.limits.maxLineBytes}`);
      const text = decoder.decode(bytesArray.subarray(lineStart, lineEnd));
      const hit = (caseSensitive ? text : text.toLowerCase()).includes(needle);
      if (hit) {
        returnedBytes += lineBytes;
        if (returnedBytes > this.limits.maxReadBytes)
          throw new ContextSpecError(`grep results exceed maxReadBytes ${this.limits.maxReadBytes}`);
        matches.push({ text, line: lineNumber, startByte: lineStart, contextId: id });
      }
      if (newline === -1) break;
      lineStart = newline + 1;
      lineNumber++;
    }
    control?.checkpoint?.();
    return matches;
  }

  async chunks(
    id: string,
    options: { targetTokens: number; overlapTokens?: number; maxChunks: number; boundary?: "line" | "none" },
    control?: ContextOperationControl,
  ): Promise<ContextDescriptor[]> {
    const { bytesArray, descriptor } = this.entryOrThrow(id);
    const maxTargetTokens = Math.floor(this.limits.maxReadBytes / 4);
    const targetTokens = boundedInteger(options.targetTokens, "targetTokens", 1, maxTargetTokens);
    const overlapTokens = options.overlapTokens === undefined
      ? 0
      : boundedInteger(options.overlapTokens, "overlapTokens", 1, targetTokens - 1);
    const maxChunks = boundedInteger(options.maxChunks, "maxChunks", 1, this.limits.maxChunks);
    if (options.boundary !== undefined && options.boundary !== "line" && options.boundary !== "none")
      throw new ContextSpecError('boundary must be "line" or "none"');
    const targetBytes = targetTokens * 4;
    const overlapBytes = overlapTokens * 4;
    const ranges: Array<{ start: number; end: number }> = [];

    // Every range starts at the prior range's valid boundary. Zero-overlap
    // ranges are adjacent; overlapping ranges move backward without gaps.
    for (let start = 0; start < bytesArray.length;) {
      if (ranges.length >= maxChunks) throw new ContextChunkOverflowError(maxChunks + 1, maxChunks);
      let end = backwardBoundary(bytesArray, Math.min(bytesArray.length, start + targetBytes));
      if (options.boundary === "line" && end < bytesArray.length) {
        const newline = findByte(
          bytesArray,
          0x0a,
          end,
          Math.min(bytesArray.length, end + targetBytes),
          control,
        );
        if (newline !== -1) end = newline + 1;
      }
      if (end <= start) throw new ContextSpecError("chunk options do not make forward progress");
      if (end - start > this.limits.maxReadBytes)
        throw new ContextSpecError(`chunk exceeds maxReadBytes ${this.limits.maxReadBytes}`);
      ranges.push({ start, end });
      if (end >= bytesArray.length) break;
      let nextStart = overlapBytes === 0 ? end : backwardBoundary(bytesArray, end - overlapBytes);
      if (nextStart <= start) nextStart = forwardBoundary(bytesArray, start + 1);
      if (nextStart <= start || nextStart > end)
        throw new ContextSpecError("chunk options do not make forward progress");
      start = nextStart;
      control?.checkpoint?.();
    }

    const prepared = ranges.map((range, index) =>
      this.prepareBytes(
        `${descriptor.label}#chunk${index + 1}`,
        bytesArray.subarray(range.start, range.end),
        descriptor.mimeType,
      ));
    return this.commitPrepared(prepared, control);
  }

  async beginDerive(
    spec: { key: string; value: string | JsonValue; label?: string },
    control?: ContextOperationControl,
  ): Promise<ContextStoreTransaction<ContextDescriptor>> {
    const label = spec.label ?? `derived:${spec.key}`;
    const prepared = typeof spec.value === "string"
      ? this.prepareText(label, spec.value, "text/plain")
      : this.prepareJson(label, spec.value, control);
    const transaction = await this.beginPrepared([prepared], control);
    return {
      value: transaction.value[0] as ContextDescriptor,
      commit: () => transaction.commit(),
      rollback: () => transaction.rollback(),
    };
  }

  async derive(
    spec: { key: string; value: string | JsonValue; label?: string },
    control?: ContextOperationControl,
  ): Promise<ContextDescriptor> {
    const transaction = await this.beginDerive(spec, control);
    transaction.commit();
    return transaction.value;
  }

  async concat(
    spec: { key: string; refs: Array<{ id: string }>; separator?: string; label?: string },
    control?: ContextOperationControl,
  ): Promise<ContextDescriptor> {
    const separator = spec.separator ?? "\n";
    const parts = spec.refs.map((ref) => this.entryOrThrow(ref.id).bytesArray);
    const separatorBytes = Buffer.byteLength(separator, "utf8");
    let bytes = 0;
    for (let i = 0; i < parts.length; i++) {
      const added = (parts[i] as Uint8Array).length + (i > 0 ? separatorBytes : 0);
      if (bytes > Number.MAX_SAFE_INTEGER - added) throw new ContextSpecError("concat output is too large");
      bytes += added;
      control?.checkpoint?.();
    }
    const maxOutputBytes = control?.maxOutputBytes ?? Number.MAX_SAFE_INTEGER;
    if (bytes > maxOutputBytes && ![...this.entries.values()].some((entry) => entry.descriptor.bytes === bytes))
      throw new ContextBudgetError(`context output requires ${bytes} bytes; ${maxOutputBytes} bytes remain`);
    const values = function* (): Generator<string | Uint8Array> {
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) yield separator;
        yield parts[i] as Uint8Array;
      }
    };
    const descriptor = this.makeDescriptor(
      spec.label ?? `concat:${spec.key}`,
      "text/plain",
      sha256Parts(values()),
      bytes,
    );
    const prepared = new PreparedEntry(descriptor, () => {
      const out = new Uint8Array(bytes);
      const encodedSeparator = parts.length > 1 ? encoder.encode(separator) : new Uint8Array();
      let offset = 0;
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          out.set(encodedSeparator, offset);
          offset += encodedSeparator.length;
        }
        const part = parts[i] as Uint8Array;
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }, this.instrumentation.onMaterialize);
    return (await this.commitPrepared([prepared], control))[0] as ContextDescriptor;
  }

  preview(id: string, headBytes = 512, tailBytes = 256): string {
    const entry = this.entries.get(id);
    if (!entry) return "";
    return headTailPreview(decoder.decode(entry.bytesArray), { headBytes, tailBytes }).text;
  }

  async load(id: string): Promise<string> {
    const entry = this.entries.get(id);
    if (entry) return decoder.decode(entry.bytesArray);
    throw new ContextUnavailableError(id);
  }

  async loadFromDisk(reference: ContextContentReference): Promise<Uint8Array> {
    if (typeof reference !== "object" || reference === null)
      throw new ContextSpecError("context reference must be an object");
    if (!/^ctx_[0-9a-f]{64}$/.test(reference.id))
      throw new ContextSpecError("context id must be ctx_ followed by 64 lowercase hexadecimal characters");
    if (!/^[0-9a-f]{64}$/.test(reference.sha256) || reference.id !== this.makeId(reference.sha256))
      throw new ContextSpecError("context id and SHA-256 must be the same fixed lowercase hexadecimal digest");
    boundedInteger(reference.bytes, "bytes", 0, Number.MAX_SAFE_INTEGER);
    const directory = await this.contentDirectory(reference.id, false);
    const path = this.payloadPath(directory, `${reference.sha256}.bin`, reference.id);
    await this.revalidateDirectory(directory, reference.id);
    const bytes = await this.verifyPayload(path, directory, reference);
    await this.revalidateDirectory(directory, reference.id);
    return bytes;
  }
}
