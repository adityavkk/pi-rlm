/** Internal immutable-intent and hard-link publisher. No runtime ownership API is exposed here. */

import { constants } from "node:fs";
import { link, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeGenerationRecord,
  decodeReleaseRecord,
  encodeGenerationRecord,
  encodeReleaseRecord,
  generationIntentFilename,
  MAX_ARBITRATION_RECORD_BYTES,
  releaseIntentFilename,
  releaseSlotFilename,
  successorSlotFilename,
  type ArbitrationIdentity,
  type GenerationRecord,
  type ReleaseRecord,
} from "./run-writer-protocol.ts";

export interface ImmutableFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly isFile: boolean;
}
export interface ImmutableBoundedRead { readonly bytes: Uint8Array; readonly eof: boolean; }
export interface ImmutableFileHandle {
  write(bytes: Uint8Array): Promise<void>;
  read(maximumBytes: number): Promise<ImmutableBoundedRead>;
  sync(): Promise<void>;
  stat(): Promise<ImmutableFileStat>;
  close(): Promise<void>;
}
export interface ImmutableDirectoryStat {
  readonly dev: bigint; readonly ino: bigint; readonly mode: number; readonly isDirectory: boolean;
}
export interface ImmutableDirectoryHandle {
  stat(): Promise<ImmutableDirectoryStat>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface ImmutablePublisherFileSystem {
  createExclusive(path: string, mode: number): Promise<ImmutableFileHandle>;
  openExisting(path: string): Promise<ImmutableFileHandle>;
  openDirectory(path: string): Promise<ImmutableDirectoryHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
}

export type ImmutablePublicationOperation =
  | { readonly kind: "intent-open" | "intent-write" | "intent-file-sync" | "intent-close" | "intent-reopen" | "intent-read" | "intent-stat"; readonly path: string }
  | { readonly kind: "slot-open" | "slot-read" | "slot-file-sync" | "slot-close" | "slot-stat"; readonly path: string }
  | { readonly kind: "directory-open" | "directory-stat" | "directory-sync" | "directory-close"; readonly path: string }
  | { readonly kind: "link"; readonly path: string; readonly slotPath: string };
export type ImmutableOperationOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: unknown };
export interface ImmutablePublicationGuard {
  pre(operation: ImmutablePublicationOperation): Promise<void>;
  post(operation: ImmutablePublicationOperation, outcome: ImmutableOperationOutcome): Promise<void>;
}
const passGuard: ImmutablePublicationGuard = { async pre() {}, async post() {} };

export type ImmutablePublicationErrorCode =
  | "WRITER_PUBLISH_INTENT_INVALID"
  | "WRITER_PUBLISH_SLOT_CORRUPT"
  | "WRITER_PUBLISH_IO_FAILED"
  | "WRITER_PUBLISH_GUARD_FAILED";
export class ImmutablePublicationError extends Error {
  override readonly name = "ImmutablePublicationError";
  constructor(
    readonly code: ImmutablePublicationErrorCode,
    readonly phase: string,
    message: string,
    override readonly cause?: unknown,
  ) { super(message); }
}

export type ArbitrationPublicationInput =
  | { readonly directory: string; readonly record: GenerationRecord }
  | { readonly directory: string; readonly record: ReleaseRecord };
export type ArbitrationPublicationResult =
  | { readonly status: "published"; readonly record: GenerationRecord | ReleaseRecord; readonly identity: ImmutableFileStat }
  | { readonly status: "lost"; readonly winner: GenerationRecord | ReleaseRecord; readonly identity: ImmutableFileStat };
export interface ArbitrationPublicationOptions {
  readonly fileSystem?: ImmutablePublisherFileSystem;
  readonly guard?: ImmutablePublicationGuard;
}

class GuardFailure extends Error {
  override readonly name = "GuardFailure";
  constructor(readonly operation: ImmutablePublicationOperation, override readonly cause: unknown) {
    super(`publication guard failed around ${operation.kind}`);
  }
}
type Attempt<T> = { readonly status: "succeeded"; readonly value: T } | { readonly status: "failed"; readonly error: unknown };
type Failure = { readonly status: "none" } | { readonly status: "failed"; readonly error: unknown };
const attempt = async <T>(effect: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { status: "succeeded", value: await effect() }; }
  catch (error) { return { status: "failed", error }; }
};
const mergeFailure = (current: Failure, error: unknown, message?: string): Failure => ({
  status: "failed",
  error: current.status === "none" ? error : new AggregateError([current.error, error], message),
});
const guarded = async <T>(
  guard: ImmutablePublicationGuard,
  operation: ImmutablePublicationOperation,
  effect: () => Promise<T>,
): Promise<T> => {
  try { await guard.pre(operation); } catch (error) { throw new GuardFailure(operation, error); }
  const effectResult = await attempt(effect);
  const outcome: ImmutableOperationOutcome = effectResult.status === "succeeded"
    ? { status: "succeeded" } : { status: "failed", error: effectResult.error };
  try { await guard.post(operation, outcome); }
  catch (error) {
    throw new GuardFailure(operation, effectResult.status === "succeeded"
      ? error : new AggregateError([effectResult.error, error]));
  }
  if (effectResult.status === "failed") throw effectResult.error;
  return effectResult.value;
};
type GuardSearch = { readonly status: "found"; readonly failure: GuardFailure } | { readonly status: "not-found" };
const findGuardFailure = (error: unknown): GuardSearch => {
  if (error instanceof GuardFailure) return { status: "found", failure: error };
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findGuardFailure(nested);
      if (found.status === "found") return found;
    }
  }
  return { status: "not-found" };
};
const ioError = (phase: string, error: unknown): never => {
  const guardSearch = findGuardFailure(error);
  if (guardSearch.status === "found") {
    const guardFailure = guardSearch.failure;
    throw new ImmutablePublicationError("WRITER_PUBLISH_GUARD_FAILED", phase, guardFailure.message, guardFailure.cause);
  }
  if (error instanceof ImmutablePublicationError) throw error;
  throw new ImmutablePublicationError("WRITER_PUBLISH_IO_FAILED", phase, `immutable publication failed during ${phase}`, error);
};
const mode = (stat: { readonly mode: number }): number => stat.mode & 0o7777;
const sameInode = (left: ImmutableFileStat, right: ImmutableFileStat): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(Buffer.from(right));
const sameArbitrationIdentity = (left: ArbitrationIdentity, right: ArbitrationIdentity): boolean =>
  left.rootDev === right.rootDev && left.rootIno === right.rootIno && left.runDev === right.runDev && left.runIno === right.runIno;

const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const stat = async (handle: FileHandle): Promise<ImmutableFileStat> => {
  const value = await handle.stat({ bigint: true });
  return {
    dev: value.dev, ino: value.ino, mode: Number(value.mode), nlink: value.nlink, size: value.size, isFile: value.isFile(),
  };
};
const fileHandle = (handle: FileHandle): ImmutableFileHandle => ({
  async write(content) { await handle.writeFile(content); },
  async read(maximumBytes) {
    const buffer = Buffer.allocUnsafe(maximumBytes);
    let length = 0;
    while (length < maximumBytes) {
      const { bytesRead } = await handle.read(buffer, length, maximumBytes - length, null);
      if (bytesRead === 0) return { bytes: buffer.subarray(0, length), eof: true };
      length += bytesRead;
    }
    return { bytes: buffer, eof: false };
  },
  async sync() { await handle.sync(); },
  stat: () => stat(handle),
  async close() { await handle.close(); },
});
export const nodeImmutablePublisherFileSystem: ImmutablePublisherFileSystem = {
  async createExclusive(path, requestedMode) {
    return fileHandle(await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, requestedMode));
  },
  async openExisting(path) { return fileHandle(await open(path, constants.O_RDWR | noFollow)); },
  async openDirectory(path) {
    const handle = await open(path, constants.O_RDONLY | directoryFlag | noFollow);
    return {
      async stat() {
        const value = await handle.stat({ bigint: true });
        return { dev: value.dev, ino: value.ino, mode: Number(value.mode), isDirectory: value.isDirectory() };
      },
      async sync() { await handle.sync(); }, async close() { await handle.close(); },
    };
  },
  async link(existingPath, newPath) { await link(existingPath, newPath); },
};

interface VerifiedFile { readonly bytes: Uint8Array; readonly stat: ImmutableFileStat; }
const closeHandle = async (
  handle: ImmutableFileHandle,
  path: string,
  slot: boolean,
  guard: ImmutablePublicationGuard,
): Promise<void> => guarded(guard, { kind: slot ? "slot-close" : "intent-close", path }, () => handle.close());
const verifyFile = async (
  path: string,
  slot: boolean,
  expected: Uint8Array | undefined,
  fileSystem: ImmutablePublisherFileSystem,
  guard: ImmutablePublicationGuard,
): Promise<VerifiedFile> => {
  const prefix = slot ? "slot" : "intent";
  const handle = await guarded(guard, { kind: slot ? "slot-open" : "intent-reopen", path }, () => fileSystem.openExisting(path));
  let primary: Failure = { status: "none" };
  let result: Attempt<VerifiedFile> = { status: "failed", error: new Error(`${prefix} verification did not run`) };
  try {
    const before = await guarded(guard, { kind: `${prefix}-stat` as "slot-stat" | "intent-stat", path }, () => handle.stat());
    if (!before.isFile || mode(before) !== 0o600 || (before.nlink !== 1n && before.nlink !== 2n)
      || before.size > BigInt(MAX_ARBITRATION_RECORD_BYTES))
      throw new ImmutablePublicationError(
        slot ? "WRITER_PUBLISH_SLOT_CORRUPT" : "WRITER_PUBLISH_INTENT_INVALID",
        `${prefix}-verify`, `${prefix} is not a bounded canonical private regular file`,
      );
    const content = await guarded(guard, { kind: `${prefix}-read` as "slot-read" | "intent-read", path },
      () => handle.read(MAX_ARBITRATION_RECORD_BYTES + 1));
    const after = await guarded(guard, { kind: `${prefix}-stat` as "slot-stat" | "intent-stat", path }, () => handle.stat());
    if (!content.eof || content.bytes.byteLength > MAX_ARBITRATION_RECORD_BYTES || !sameInode(before, after)
      || !after.isFile || mode(after) !== 0o600 || before.nlink !== after.nlink || before.size !== after.size
      || BigInt(content.bytes.byteLength) !== after.size)
      throw new ImmutablePublicationError(
        slot ? "WRITER_PUBLISH_SLOT_CORRUPT" : "WRITER_PUBLISH_INTENT_INVALID",
        `${prefix}-verify`, `${prefix} changed, exceeded its bound, or had no verified EOF`,
      );
    if (expected && !sameBytes(content.bytes, expected))
      throw new ImmutablePublicationError(
        slot ? "WRITER_PUBLISH_SLOT_CORRUPT" : "WRITER_PUBLISH_INTENT_INVALID",
        `${prefix}-verify`, `${prefix} does not contain the exact canonical record`,
      );
    await guarded(guard, { kind: slot ? "slot-file-sync" : "intent-file-sync", path }, () => handle.sync());
    result = { status: "succeeded", value: { bytes: content.bytes, stat: after } };
  } catch (error) { primary = mergeFailure(primary, error); }
  try { await closeHandle(handle, path, slot, guard); }
  catch (error) { primary = mergeFailure(primary, error, `${prefix} verification and close failed`); }
  if (primary.status === "failed") throw primary.error;
  if (result.status === "failed") throw result.error;
  return result.value;
};
const verifyFileReconciled = async (
  path: string, slot: boolean, expected: Uint8Array | undefined,
  fileSystem: ImmutablePublisherFileSystem, guard: ImmutablePublicationGuard,
): Promise<VerifiedFile> => {
  const first = await attempt(() => verifyFile(path, slot, expected, fileSystem, guard));
  if (first.status === "succeeded") return first.value;
  if (first.error instanceof ImmutablePublicationError || findGuardFailure(first.error).status === "found") throw first.error;
  return verifyFile(path, slot, expected, fileSystem, guard);
};

const syncDirectoryOnce = async (
  directory: string,
  fileSystem: ImmutablePublisherFileSystem,
  guard: ImmutablePublicationGuard,
): Promise<void> => {
  const handle = await guarded(guard, { kind: "directory-open", path: directory }, () => fileSystem.openDirectory(directory));
  let primary: Failure = { status: "none" };
  try {
    const before = await guarded(guard, { kind: "directory-stat", path: directory }, () => handle.stat());
    if (!before.isDirectory || mode(before) !== 0o700)
      throw new ImmutablePublicationError("WRITER_PUBLISH_IO_FAILED", "directory-verify", "arbitration directory is not exact 0700");
    await guarded(guard, { kind: "directory-sync", path: directory }, () => handle.sync());
    const after = await guarded(guard, { kind: "directory-stat", path: directory }, () => handle.stat());
    if (!after.isDirectory || mode(after) !== 0o700 || before.dev !== after.dev || before.ino !== after.ino)
      throw new ImmutablePublicationError("WRITER_PUBLISH_IO_FAILED", "directory-verify", "arbitration directory changed during sync");
  } catch (error) { primary = mergeFailure(primary, error); }
  try { await guarded(guard, { kind: "directory-close", path: directory }, () => handle.close()); }
  catch (error) { primary = mergeFailure(primary, error, "directory sync and close failed"); }
  if (primary.status === "failed") throw primary.error;
};
const syncDirectory = async (
  directory: string, fileSystem: ImmutablePublisherFileSystem, guard: ImmutablePublicationGuard,
): Promise<void> => {
  const first = await attempt(() => syncDirectoryOnce(directory, fileSystem, guard));
  if (first.status === "succeeded") return;
  if (first.error instanceof ImmutablePublicationError || findGuardFailure(first.error).status === "found") throw first.error;
  await syncDirectoryOnce(directory, fileSystem, guard);
};

interface PublicationDescription {
  readonly bytes: Uint8Array;
  readonly uniqueName: string;
  readonly slotName: string;
  decodeWinner(bytes: Uint8Array): GenerationRecord | ReleaseRecord;
  winnerIntentName(record: GenerationRecord | ReleaseRecord): string;
}
const describe = (record: GenerationRecord | ReleaseRecord): PublicationDescription => {
  if (record.type === "generation") return {
    bytes: encodeGenerationRecord(record), uniqueName: generationIntentFilename(record.token),
    slotName: successorSlotFilename(record.predecessor),
    decodeWinner(content) {
      const winner = decodeGenerationRecord(content);
      if (winner.predecessor !== record.predecessor || winner.ordinal !== record.ordinal
        || !sameArbitrationIdentity(winner, record) || winner.runName !== record.runName)
        throw new ImmutablePublicationError("WRITER_PUBLISH_SLOT_CORRUPT", "slot-verify", "winner is invalid for the generation slot");
      return winner;
    },
    winnerIntentName(winner) {
      if (winner.type !== "generation")
        throw new ImmutablePublicationError("WRITER_PUBLISH_SLOT_CORRUPT", "slot-verify", "generation slot contains a release");
      return generationIntentFilename(winner.token);
    },
  };
  return {
    bytes: encodeReleaseRecord(record), uniqueName: releaseIntentFilename(record.token), slotName: releaseSlotFilename(record.generation),
    decodeWinner(content) {
      const winner = decodeReleaseRecord(content);
      if (winner.generation !== record.generation || winner.processNonce !== record.processNonce
        || !sameArbitrationIdentity(winner, record))
        throw new ImmutablePublicationError("WRITER_PUBLISH_SLOT_CORRUPT", "slot-verify", "winner is invalid for the release slot");
      return winner;
    },
    winnerIntentName(winner) {
      if (winner.type !== "release")
        throw new ImmutablePublicationError("WRITER_PUBLISH_SLOT_CORRUPT", "slot-verify", "release slot contains a generation");
      return releaseIntentFilename(winner.token);
    },
  };
};

const prepareIntent = async (
  path: string,
  content: Uint8Array,
  fileSystem: ImmutablePublisherFileSystem,
  guard: ImmutablePublicationGuard,
): Promise<VerifiedFile> => {
  let created: { status: "absent" } | { status: "present"; stat: ImmutableFileStat } = { status: "absent" };
  let preparation: Failure = { status: "none" };
  try {
    const handle = await guarded(guard, { kind: "intent-open", path }, () => fileSystem.createExclusive(path, 0o600));
    let useFailure: Failure = { status: "none" };
    try {
      const createdStat = await guarded(guard, { kind: "intent-stat", path }, () => handle.stat());
      created = { status: "present", stat: createdStat };
      if (!createdStat.isFile || mode(createdStat) !== 0o600 || createdStat.nlink !== 1n || createdStat.size !== 0n)
        throw new ImmutablePublicationError(
          "WRITER_PUBLISH_INTENT_INVALID", "intent-open", "new unique intent is not an empty private regular file",
        );
      await guarded(guard, { kind: "intent-write", path }, () => handle.write(content));
      await guarded(guard, { kind: "intent-file-sync", path }, () => handle.sync());
    } catch (error) { useFailure = mergeFailure(useFailure, error); }
    try { await closeHandle(handle, path, false, guard); }
    catch (error) { useFailure = mergeFailure(useFailure, error); }
    if (useFailure.status === "failed") {
      if (findGuardFailure(useFailure.error).status === "found") throw useFailure.error;
      preparation = mergeFailure(preparation, useFailure.error);
    }
  } catch (error) {
    if (findGuardFailure(error).status === "found") throw error;
    preparation = mergeFailure(preparation, error);
  }
  try {
    const verified = await verifyFileReconciled(path, false, content, fileSystem, guard);
    if (created.status === "present" && !sameInode(created.stat, verified.stat))
      throw new ImmutablePublicationError(
        "WRITER_PUBLISH_INTENT_INVALID", "intent-verify", "reopened intent does not have the created inode identity",
      );
    return verified;
  } catch (error) {
    const guardSearch = findGuardFailure(error);
    if (guardSearch.status === "found") throw guardSearch.failure;
    if (error instanceof ImmutablePublicationError) throw error;
    throw new ImmutablePublicationError(
      "WRITER_PUBLISH_INTENT_INVALID", "intent-verify", "unique intent is absent, partial, or unverifiable",
      preparation.status === "none" ? error : new AggregateError([preparation.error, error]),
    );
  }
};

const inspectSlot = async (
  directory: string,
  slotPath: string,
  own: VerifiedFile,
  description: PublicationDescription,
  fileSystem: ImmutablePublisherFileSystem,
  guard: ImmutablePublicationGuard,
): Promise<ArbitrationPublicationResult> => {
  const slot = await verifyFileReconciled(slotPath, true, undefined, fileSystem, guard);
  let winner: GenerationRecord | ReleaseRecord;
  try { winner = description.decodeWinner(slot.bytes); }
  catch (error) {
    if (error instanceof ImmutablePublicationError) throw error;
    throw new ImmutablePublicationError("WRITER_PUBLISH_SLOT_CORRUPT", "slot-verify", "slot record is malformed", error);
  }
  const winnerPath = join(directory, description.winnerIntentName(winner));
  const winnerIntent = await verifyFileReconciled(winnerPath, false, slot.bytes, fileSystem, guard);
  if (!sameInode(slot.stat, winnerIntent.stat) || slot.stat.nlink !== 2n || winnerIntent.stat.nlink !== 2n)
    throw new ImmutablePublicationError("WRITER_PUBLISH_SLOT_CORRUPT", "slot-verify", "slot does not hard-link its canonical intent");
  if (sameInode(slot.stat, own.stat)) return { status: "published", record: winner, identity: slot.stat };
  return { status: "lost", winner, identity: slot.stat };
};

export const publishImmutableArbitrationRecord = async (
  input: ArbitrationPublicationInput,
  options: ArbitrationPublicationOptions = {},
): Promise<ArbitrationPublicationResult> => {
  const fileSystem = options.fileSystem ?? nodeImmutablePublisherFileSystem;
  const guard = options.guard ?? passGuard;
  const description = describe(input.record);
  const uniquePath = join(input.directory, description.uniqueName);
  const slotPath = join(input.directory, description.slotName);
  let own: VerifiedFile;
  try {
    own = await prepareIntent(uniquePath, description.bytes, fileSystem, guard);
    await syncDirectory(input.directory, fileSystem, guard);
  } catch (error) { ioError("intent-publication", error); }
  if (own!.stat.nlink === 2n) {
    let reconciled: ArbitrationPublicationResult;
    try { reconciled = await inspectSlot(input.directory, slotPath, own!, description, fileSystem, guard); }
    catch (error) {
      if (error instanceof ImmutablePublicationError) throw error;
      throw new ImmutablePublicationError(
        "WRITER_PUBLISH_INTENT_INVALID", "link-reconciliation",
        "two-link intent does not have its exact authoritative slot", error,
      );
    }
    if (reconciled.status !== "published")
      throw new ImmutablePublicationError(
        "WRITER_PUBLISH_INTENT_INVALID", "link-reconciliation",
        "two-link intent is not linked to its own authoritative slot",
      );
    try { await syncDirectory(input.directory, fileSystem, guard); }
    catch (error) { ioError("slot-directory-sync", error); }
    return reconciled;
  }
  if (own!.stat.nlink !== 1n)
    throw new ImmutablePublicationError(
      "WRITER_PUBLISH_INTENT_INVALID", "link", "intent must have exactly one link before election",
    );
  let linkFailure: Failure = { status: "none" };
  try { await guarded(guard, { kind: "link", path: uniquePath, slotPath }, () => fileSystem.link(uniquePath, slotPath)); }
  catch (error) {
    if (findGuardFailure(error).status === "found") ioError("link", error);
    linkFailure = mergeFailure(linkFailure, error);
  }
  let result: ArbitrationPublicationResult;
  try { result = await inspectSlot(input.directory, slotPath, own!, description, fileSystem, guard); }
  catch (error) {
    if (linkFailure.status === "failed" && !(error instanceof ImmutablePublicationError))
      ioError("link-reconciliation", new AggregateError([linkFailure.error, error]));
    ioError("link-reconciliation", error);
  }
  try { await syncDirectory(input.directory, fileSystem, guard); }
  catch (error) { ioError("slot-directory-sync", error); }
  return result!;
};
