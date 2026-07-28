/** Lease-owned filesystem composition for managed-run writable state. */

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

export class RunWriterMutationPathError extends Error {
  override readonly name = "RunWriterMutationPathError";
  readonly code = "WRITER_MUTATION_PATH";
}

/**
 * Every operation enters the same lease scheduler. Its pre/post fences rescan the
 * authoritative generation and revalidate pinned root/run/arbitration identities.
 */
export class LeaseOwnedRunPersistence {
  readonly managedRoot: string;
  readonly runName: string;
  readonly runPath: string;
  private readonly realRunPath: string;

  constructor(private readonly lease: RunWriterLease) {
    const identity = lease.mutationIdentity();
    this.managedRoot = identity.managedRoot;
    this.runName = identity.runName;
    this.runPath = identity.runPath;
    this.realRunPath = identity.realRunPath;
    if (!isAbsolute(this.managedRoot) || resolve(this.managedRoot) !== this.managedRoot
      || !isAbsolute(this.runPath) || resolve(this.runPath) !== this.runPath
      || !isAbsolute(identity.realManagedRoot) || resolve(identity.realManagedRoot) !== identity.realManagedRoot
      || !isAbsolute(this.realRunPath) || resolve(this.realRunPath) !== this.realRunPath
      || dirname(this.runPath) !== this.managedRoot || dirname(this.realRunPath) !== identity.realManagedRoot
      || lease.runName !== this.runName || this.realRunPath !== resolve(identity.realManagedRoot, this.runName))
      throw new RunWriterMutationPathError("managed persistence is not bound to the lease-pinned run identity");
  }

  private assertPath(path: string): void {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new RunWriterMutationPathError("managed mutation path must be absolute and normalized");
    const contained = (root: string): boolean => {
      const rel = relative(root, path);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
    };
    // ContextStore deliberately canonicalizes its trusted root. Both names were
    // pinned to the same inode hierarchy when this capability was constructed.
    if (!contained(this.runPath) && !contained(this.realRunPath))
      throw new RunWriterMutationPathError("managed mutation path escapes the leased run");
  }

  /** Hold lease admission and one outer fence for a complete logical mutation. */
  runTransaction<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    return this.lease.runOwnedTransaction(effect);
  }

  async runPathEffect<T>(paths: string | readonly string[], effect: () => T | PromiseLike<T>): Promise<T> {
    for (const path of typeof paths === "string" ? [paths] : paths) this.assertPath(path);
    return this.lease.runOwnedOperation(effect);
  }

  contextInstrumentation(base: ContextStoreInstrumentation = {}): ContextStoreInstrumentation {
    return {
      ...base,
      runTransaction: <T>(effect: () => Promise<T>): Promise<T> =>
        this.runTransaction(() => base.runTransaction?.(effect) ?? effect()),
      runFileSystemOperation: <T>(path: string, effect: () => Promise<T>): Promise<T> =>
        this.runPathEffect(path, () => base.runFileSystemOperation?.(path, effect) ?? effect()),
    };
  }

  runDirectoryFileSystem(base: RunDirectoryFileSystem = nodeRunDirectoryFileSystem): RunDirectoryFileSystem {
    return {
      runTransaction: <T>(effect: () => Promise<T>): Promise<T> =>
        this.runTransaction(() => base.runTransaction?.(effect) ?? effect()),
      open: async (path, flags, mode) => {
        let opened: RunDirectoryFileHandle | undefined;
        try {
          opened = await this.runPathEffect(path, async () => {
            opened = await base.open(path, flags, mode);
            return opened;
          });
          return this.runDirectoryHandle(path, opened);
        } catch (primary) {
          if (opened) {
            try { await opened.close(); }
            catch (cleanup) { throw new AggregateError([primary, cleanup], "guarded open and handle cleanup both failed"); }
          }
          throw primary;
        }
      },
      readFile: (path) => this.runPathEffect(path, () => base.readFile(path)),
      readdir: (path) => this.runPathEffect(path, () => base.readdir(path)),
      rename: (oldPath, newPath) => this.runPathEffect([oldPath, newPath], () => base.rename(oldPath, newPath)),
      unlink: (path) => this.runPathEffect(path, () => base.unlink(path)),
    };
  }

  journalFileSystem(base: JournalFileSystem = nodeJournalFileSystem): JournalFileSystem {
    return {
      runTransaction: <T>(effect: () => Promise<T>): Promise<T> =>
        this.runTransaction(() => base.runTransaction?.(effect) ?? effect()),
      open: async (path, flags, mode) => {
        let opened: JournalFileHandle | undefined;
        try {
          opened = await this.runPathEffect(path, async () => {
            opened = await base.open(path, flags, mode);
            return opened;
          });
          return this.journalHandle(path, opened);
        } catch (primary) {
          if (opened) {
            try { await opened.close(); }
            catch (cleanup) { throw new AggregateError([primary, cleanup], "guarded open and handle cleanup both failed"); }
          }
          throw primary;
        }
      },
      readFile: (path) => this.runPathEffect(path, () => base.readFile(path)),
      rename: (oldPath, newPath) => this.runPathEffect([oldPath, newPath], () => base.rename(oldPath, newPath)),
    };
  }

  private async guardedClose(path: string, close: () => Promise<void>): Promise<void> {
    let invoked = false;
    try {
      await this.runPathEffect(path, async () => {
        invoked = true;
        await close();
      });
    } catch (primary) {
      if (!invoked) {
        try { await close(); }
        catch (cleanup) { throw new AggregateError([primary, cleanup], "close fence and handle cleanup both failed"); }
      }
      throw primary;
    }
  }

  private runDirectoryHandle(path: string, handle: RunDirectoryFileHandle): RunDirectoryFileHandle {
    return {
      writeFile: (data, encoding) => this.runPathEffect(path, () => handle.writeFile(data, encoding)),
      sync: () => this.runPathEffect(path, () => handle.sync()),
      close: () => this.guardedClose(path, () => handle.close()),
    };
  }

  private journalHandle(path: string, handle: JournalFileHandle): JournalFileHandle {
    return {
      appendFile: (data, encoding) => this.runPathEffect(path, () => handle.appendFile(data, encoding)),
      readFile: () => this.runPathEffect(path, () => handle.readFile()),
      sync: () => this.runPathEffect(path, () => handle.sync()),
      truncate: (length) => this.runPathEffect(path, () => handle.truncate(length)),
      writeFile: (data, encoding) => this.runPathEffect(path, () => handle.writeFile(data, encoding)),
      close: () => this.guardedClose(path, () => handle.close()),
    };
  }
}
