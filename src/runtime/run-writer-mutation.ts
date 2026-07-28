/** Lease-owned filesystem composition for managed-run writable state. */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ContextStoreInstrumentation } from "../shell/context-store-contract.ts";
import {
  nodeJournalFileSystem,
  type JournalFileHandle,
  type JournalFileSystem,
} from "../shell/journal-store.ts";
import {
  nodeRunDirectoryFileSystem,
  type RunDirectoryFileHandle,
  type RunDirectoryFileSystem,
} from "./run-manifest.ts";
import type { RunWriterLease } from "./run-writer-arbiter.ts";

const RUN_NAME = /^run-[a-f0-9]{32}$/;

export class RunWriterMutationPathError extends Error {
  override readonly name = "RunWriterMutationPathError";
  readonly code = "WRITER_MUTATION_PATH";
}

/**
 * Every operation enters the same lease scheduler. Its pre/post fences rescan the
 * authoritative generation and revalidate pinned root/run/arbitration identities.
 */
export class LeaseOwnedRunPersistence {
  readonly runPath: string;
  private readonly realRunPath: string;

  constructor(
    readonly managedRoot: string,
    readonly runName: string,
    private readonly lease: RunWriterLease,
  ) {
    if (!isAbsolute(managedRoot) || resolve(managedRoot) !== managedRoot || !RUN_NAME.test(runName))
      throw new RunWriterMutationPathError("managed persistence identity is invalid");
    this.runPath = join(managedRoot, runName);
    if (dirname(this.runPath) !== managedRoot || lease.runName !== runName)
      throw new RunWriterMutationPathError("managed persistence is not bound to the lease run");
    this.realRunPath = realpathSync(this.runPath);
  }

  private assertPath(path: string): void {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new RunWriterMutationPathError("managed mutation path must be absolute and normalized");
    const contained = (root: string): boolean => {
      const rel = relative(root, path);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
    };
    if (!contained(this.runPath) && !contained(this.realRunPath))
      throw new RunWriterMutationPathError("managed mutation path escapes the leased run");
  }

  async runPathEffect<T>(paths: string | readonly string[], effect: () => T | PromiseLike<T>): Promise<T> {
    for (const path of typeof paths === "string" ? [paths] : paths) this.assertPath(path);
    return this.lease.runOwnedOperation(effect);
  }

  contextInstrumentation(base: ContextStoreInstrumentation = {}): ContextStoreInstrumentation {
    return {
      ...base,
      runFileSystemOperation: <T>(path: string, effect: () => Promise<T>): Promise<T> =>
        this.runPathEffect(path, () => base.runFileSystemOperation?.(path, effect) ?? effect()),
    };
  }

  runDirectoryFileSystem(base: RunDirectoryFileSystem = nodeRunDirectoryFileSystem): RunDirectoryFileSystem {
    return {
      open: async (path, flags, mode) => {
        const handle = await this.runPathEffect(path, () => base.open(path, flags, mode));
        return this.runDirectoryHandle(path, handle);
      },
      readFile: (path) => this.runPathEffect(path, () => base.readFile(path)),
      readdir: (path) => this.runPathEffect(path, () => base.readdir(path)),
      rename: (oldPath, newPath) => this.runPathEffect([oldPath, newPath], () => base.rename(oldPath, newPath)),
      unlink: (path) => this.runPathEffect(path, () => base.unlink(path)),
    };
  }

  journalFileSystem(base: JournalFileSystem = nodeJournalFileSystem): JournalFileSystem {
    return {
      open: async (path, flags, mode) => {
        const handle = await this.runPathEffect(path, () => base.open(path, flags, mode));
        return this.journalHandle(path, handle);
      },
      readFile: (path) => this.runPathEffect(path, () => base.readFile(path)),
      rename: (oldPath, newPath) => this.runPathEffect([oldPath, newPath], () => base.rename(oldPath, newPath)),
    };
  }

  private runDirectoryHandle(path: string, handle: RunDirectoryFileHandle): RunDirectoryFileHandle {
    return {
      writeFile: (data, encoding) => this.runPathEffect(path, () => handle.writeFile(data, encoding)),
      sync: () => this.runPathEffect(path, () => handle.sync()),
      close: () => this.runPathEffect(path, () => handle.close()),
    };
  }

  private journalHandle(path: string, handle: JournalFileHandle): JournalFileHandle {
    return {
      appendFile: (data, encoding) => this.runPathEffect(path, () => handle.appendFile(data, encoding)),
      readFile: () => this.runPathEffect(path, () => handle.readFile()),
      sync: () => this.runPathEffect(path, () => handle.sync()),
      truncate: (length) => this.runPathEffect(path, () => handle.truncate(length)),
      writeFile: (data, encoding) => this.runPathEffect(path, () => handle.writeFile(data, encoding)),
      close: () => this.runPathEffect(path, () => handle.close()),
    };
  }
}
