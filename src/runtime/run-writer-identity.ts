/** Internal pinned-path boundary for writer arbitration. */

import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ARBITRATION_DIRECTORY,
  type ArbitrationChain,
  type ArbitrationIdentity,
} from "./run-writer-protocol.ts";
import type {
  ImmutableOperationOutcome,
  ImmutablePublicationGuard,
  ImmutablePublicationOperation,
} from "./run-writer-publisher.ts";

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const directoryFlags = constants.O_RDONLY | noFollow | directoryFlag;

export type RunWriterIdentityErrorCode =
  | "WRITER_IDENTITY_INPUT"
  | "WRITER_IDENTITY_OPEN"
  | "WRITER_IDENTITY_CHANGED";

export class RunWriterIdentityError extends Error {
  override readonly name = "RunWriterIdentityError";
  constructor(
    readonly code: RunWriterIdentityErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) { super(message); }
}

interface DirectoryIdentity {
  readonly path: string;
  readonly real: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly handle: FileHandle;
}

export interface ArbitrationDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

type Attempt<T> =
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown };

const attempt = async <T>(effect: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { status: "succeeded", value: await effect() }; }
  catch (error) { return { status: "failed", error }; }
};
const mode = (value: bigint): bigint => value & 0o7777n;
const sameDirectory = (
  value: Awaited<ReturnType<FileHandle["stat"]>>,
  expected: DirectoryIdentity,
): boolean => value.isDirectory() && mode(value.mode as bigint) === 0o700n
  && value.dev === expected.dev && value.ino === expected.ino;
const aggregate = (primary: unknown, cleanup: readonly unknown[], message: string): unknown =>
  cleanup.length === 0 ? primary : new AggregateError([primary, ...cleanup], message);

const openDirectory = async (path: string, label: string): Promise<DirectoryIdentity> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, directoryFlags);
    const value = await handle.stat({ bigint: true });
    if (!value.isDirectory() || mode(value.mode) !== 0o700n)
      throw new Error(`${label} must be an exact 0700 directory`);
    return { path, real: await realpath(path), dev: value.dev, ino: value.ino, handle };
  } catch (primary) {
    const cleanup = handle ? await attempt(() => handle!.close()) : undefined;
    const cause = cleanup?.status === "failed"
      ? new AggregateError([primary, cleanup.error], `failed to inspect and close ${label}`) : primary;
    throw new RunWriterIdentityError("WRITER_IDENTITY_OPEN", `failed to pin ${label}`, cause);
  }
};

const verifyDirectory = async (expected: DirectoryIdentity, label: string): Promise<void> => {
  try {
    const descriptor = await expected.handle.stat({ bigint: true });
    const pathname = await lstat(expected.path, { bigint: true });
    const resolved = await realpath(expected.path);
    if (!sameDirectory(descriptor, expected) || !pathname.isDirectory() || pathname.isSymbolicLink()
      || mode(pathname.mode) !== 0o700n || pathname.dev !== expected.dev || pathname.ino !== expected.ino
      || resolved !== expected.real)
      throw new Error(`${label} pathname, realpath, or descriptor identity changed`);
  } catch (cause) {
    throw new RunWriterIdentityError("WRITER_IDENTITY_CHANGED", `${label} identity is no longer pinned`, cause);
  }
};

export const runIdentityKey = (identity: ArbitrationIdentity): string =>
  `${identity.rootDev}:${identity.rootIno}:${identity.runDev}:${identity.runIno}`;

export class PinnedRunWriterIdentity {
  readonly managedRoot: string;
  readonly runName: string;
  readonly runPath: string;
  readonly arbitrationPath: string;
  readonly identity: ArbitrationIdentity;
  readonly arbitrationIdentity: ArbitrationDirectoryIdentity;
  /** Stable root/run key. Deliberately excludes replaceable arbitration metadata identity. */
  readonly key: string;
  private unusable = false;
  private readonly closeCompleted = [false, false, false];
  private closeInFlight: Promise<void> | undefined;

  private constructor(
    private readonly root: DirectoryIdentity,
    private readonly run: DirectoryIdentity,
    private readonly arbitration: DirectoryIdentity,
    runName: string,
  ) {
    this.managedRoot = root.path;
    this.runName = runName;
    this.runPath = run.path;
    this.arbitrationPath = arbitration.path;
    this.identity = { rootDev: root.dev, rootIno: root.ino, runDev: run.dev, runIno: run.ino };
    this.arbitrationIdentity = { dev: arbitration.dev, ino: arbitration.ino };
    this.key = runIdentityKey(this.identity);
  }

  /** Opens existing arbitration metadata only. Genesis creation is intentionally a separate, unimplemented authority. */
  static async openExisting(managedRoot: string, runName: string): Promise<PinnedRunWriterIdentity> {
    if (typeof managedRoot !== "string" || !isAbsolute(managedRoot) || resolve(managedRoot) !== managedRoot)
      throw new RunWriterIdentityError("WRITER_IDENTITY_INPUT", "managed root must be an absolute normalized path");
    if (typeof runName !== "string" || !RUN_NAME.test(runName))
      throw new RunWriterIdentityError("WRITER_IDENTITY_INPUT", "run name is not an exact managed run child name");
    const runPath = join(managedRoot, runName);
    if (dirname(runPath) !== managedRoot)
      throw new RunWriterIdentityError("WRITER_IDENTITY_INPUT", "run path is not an exact managed root child");

    let root: DirectoryIdentity | undefined;
    let run: DirectoryIdentity | undefined;
    let arbitration: DirectoryIdentity | undefined;
    try {
      root = await openDirectory(managedRoot, "managed root");
      run = await openDirectory(runPath, "managed run");
      if (run.real !== join(root.real, runName)) throw new Error("managed run realpath is not the pinned root child");
      await verifyDirectory(root, "managed root");
      await verifyDirectory(run, "managed run");
      const arbitrationPath = join(runPath, ARBITRATION_DIRECTORY);
      arbitration = await openDirectory(arbitrationPath, "arbitration directory");
      if (arbitration.real !== join(run.real, ARBITRATION_DIRECTORY))
        throw new Error("arbitration realpath is not the exact pinned run child");
      const pinned = new PinnedRunWriterIdentity(root, run, arbitration, runName);
      await pinned.assertValid();
      return pinned;
    } catch (primary) {
      const results = await Promise.all([
        arbitration, run, root,
      ].filter((item): item is DirectoryIdentity => item !== undefined).map((item) => attempt(() => item.handle.close())));
      const cleanup = results.flatMap((result) => result.status === "failed" ? [result.error] : []);
      if (cleanup.length === 0 && primary instanceof RunWriterIdentityError) throw primary;
      throw new RunWriterIdentityError(
        "WRITER_IDENTITY_OPEN", "failed to pin managed arbitration paths",
        aggregate(primary, cleanup, "path pinning and descriptor cleanup failed"),
      );
    }
  }

  async assertValid(): Promise<void> {
    if (this.unusable) throw new RunWriterIdentityError("WRITER_IDENTITY_CHANGED", "pinned run identity is closed");
    // Node has no portable openat-style API. Descriptor plus pathname/realpath checks bind cooperating
    // processes, but a same-user attacker can still swap and restore a parent between these syscalls.
    await verifyDirectory(this.root, "managed root");
    await verifyDirectory(this.run, "managed run");
    await verifyDirectory(this.arbitration, "arbitration directory");
    if (this.run.real !== join(this.root.real, this.runName)
      || this.arbitration.real !== join(this.run.real, ARBITRATION_DIRECTORY))
      throw new RunWriterIdentityError("WRITER_IDENTITY_CHANGED", "pinned directory hierarchy changed");
  }

  async scan(scan: (directory: string) => Promise<ArbitrationChain>): Promise<ArbitrationChain> {
    await this.assertValid();
    const result = await attempt(() => scan(this.arbitrationPath));
    const after = await attempt(() => this.assertValid());
    if (result.status === "failed" && after.status === "failed")
      throw new AggregateError([result.error, after.error], "arbitration scan and identity revalidation failed");
    if (after.status === "failed") throw after.error;
    if (result.status === "failed") throw result.error;
    return result.value;
  }

  publicationGuard(next?: ImmutablePublicationGuard): ImmutablePublicationGuard {
    const compose = async (downstream: () => Promise<void>): Promise<void> => {
      await this.assertValid();
      const nextResult = await attempt(downstream);
      const finalResult = await attempt(() => this.assertValid());
      if (nextResult.status === "failed" && finalResult.status === "failed")
        throw new AggregateError([nextResult.error, finalResult.error], "downstream guard and identity validation failed");
      if (finalResult.status === "failed") throw finalResult.error;
      if (nextResult.status === "failed") throw nextResult.error;
    };
    return {
      pre: (operation: ImmutablePublicationOperation): Promise<void> =>
        compose(() => next ? next.pre(operation) : Promise.resolve()),
      post: (operation: ImmutablePublicationOperation, outcome: ImmutableOperationOutcome): Promise<void> =>
        compose(() => next ? next.post(operation, outcome) : Promise.resolve()),
    };
  }

  async close(): Promise<void> {
    this.unusable = true;
    if (this.closeCompleted.every(Boolean)) return;
    if (this.closeInFlight) return this.closeInFlight;
    const handles = [this.arbitration.handle, this.run.handle, this.root.handle] as const;
    const operation = (async (): Promise<void> => {
      const indices = handles.map((_, index) => index).filter((index) => !this.closeCompleted[index]);
      const results = await Promise.allSettled(indices.map((index) => handles[index]!.close()));
      const failures: unknown[] = [];
      results.forEach((result, offset) => {
        const index = indices[offset]!;
        if (result.status === "fulfilled") this.closeCompleted[index] = true;
        else failures.push(result.reason);
      });
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "pinned directory closes failed");
    })();
    this.closeInFlight = operation;
    try { await operation; }
    finally { if (this.closeInFlight === operation) this.closeInFlight = undefined; }
  }
}
