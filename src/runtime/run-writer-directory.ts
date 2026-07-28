/** Exact private-directory sync with descriptor and pathname revalidation. */

import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;

export interface PrivateDirectoryHandle {
  stat(options: { readonly bigint: true }): Promise<BigIntStats>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PrivateDirectoryFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  openDirectory(path: string): Promise<PrivateDirectoryHandle>;
}

export const nodePrivateDirectoryFileSystem: PrivateDirectoryFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  openDirectory: (path) => open(path, constants.O_RDONLY | directoryFlag | noFollow),
};

export interface PrivateDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const mode = (value: bigint): bigint => value & 0o7777n;
const valid = (stat: BigIntStats, expected?: PrivateDirectoryIdentity): boolean =>
  stat.isDirectory() && !stat.isSymbolicLink() && mode(stat.mode) === 0o700n
  && (expected === undefined || (stat.dev === expected.dev && stat.ino === expected.ino));

const attempt = async (effect: () => Promise<void>): Promise<unknown | undefined> => {
  try { await effect(); return undefined; } catch (error) { return error; }
};

/** Sync one exact 0700 directory and prove its pathname still names the opened inode. */
export const syncPrivateDirectory = async (
  path: string,
  expected?: PrivateDirectoryIdentity,
  fileSystem: PrivateDirectoryFileSystem = nodePrivateDirectoryFileSystem,
): Promise<PrivateDirectoryIdentity> => {
  const handle = await fileSystem.openDirectory(path);
  let result: PrivateDirectoryIdentity | undefined;
  let primary: unknown;
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    const pathnameBefore = await fileSystem.lstat(path);
    const identity = expected ?? { dev: descriptorBefore.dev, ino: descriptorBefore.ino };
    if (!valid(descriptorBefore, identity) || !valid(pathnameBefore, identity))
      throw new Error("private directory descriptor or pathname identity is invalid before sync");
    await handle.sync();
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathnameAfter = await fileSystem.lstat(path);
    if (!valid(descriptorAfter, identity) || !valid(pathnameAfter, identity))
      throw new Error("private directory descriptor or pathname identity changed during sync");
    result = identity;
  } catch (error) { primary = error; }
  const cleanup = await attempt(() => handle.close());
  if (primary !== undefined && cleanup !== undefined)
    throw new AggregateError([primary, cleanup], "private directory sync and close both failed");
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
  return result!;
};
