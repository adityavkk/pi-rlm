/** Dedicated terminal retention rename and deterministic quarantine reconciliation. */

import { constants, type BigIntStats } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ARBITRATION_DIRECTORY,
  scanArbitrationDirectory,
  type GenerationRecord,
} from "./run-writer-protocol.ts";
import type { RunWriterTerminalIdentity } from "./run-writer-arbiter.ts";
import {
  syncPrivateDirectory,
  type PrivateDirectoryFileSystem,
  type PrivateDirectoryHandle,
} from "./run-writer-directory.ts";

export type RunQuarantineState = "ACTIVE_RETENTION" | "QUARANTINE_VISIBLE_UNSYNCED" | "QUARANTINED";
export interface RunQuarantineResult {
  readonly state: "QUARANTINED";
  readonly name: string;
  readonly path: string;
}

export interface RunQuarantineDirectoryHandle extends PrivateDirectoryHandle {}
export interface RunQuarantineFileSystem extends PrivateDirectoryFileSystem {
  rename(oldPath: string, newPath: string): Promise<void>;
}

const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const nodeFileSystem: RunQuarantineFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  rename,
  openDirectory: (path) => open(path, constants.O_RDONLY | directoryFlag | noFollow),
};
const TOKEN = /^[a-f0-9]{64}$/;
const QUARANTINE = /^\.pi-rlm-quarantine-([a-f0-9]{64})-([0-9]+)-([0-9]+)$/;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
const sameRun = (
  stat: BigIntStats,
  generation: Pick<GenerationRecord, "runDev" | "runIno">,
): boolean => !stat.isSymbolicLink() && stat.isDirectory()
  && stat.dev === generation.runDev && stat.ino === generation.runIno;

export const quarantineName = (generation: GenerationRecord): string => {
  if (!TOKEN.test(generation.token)) throw new TypeError("quarantine generation token is invalid");
  return `.pi-rlm-quarantine-${generation.token}-${generation.runDev}-${generation.runIno}`;
};

export const isRunQuarantineName = (name: string): boolean => QUARANTINE.test(name);

const statAttempt = async (
  path: string,
  fileSystem: RunQuarantineFileSystem,
): Promise<BigIntStats | undefined> => {
  try { return await fileSystem.lstat(path); }
  catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
};

const syncRoot = async (
  root: string,
  generation: GenerationRecord,
  fileSystem: RunQuarantineFileSystem,
): Promise<void> => {
  await syncPrivateDirectory(
    root,
    { dev: generation.rootDev, ino: generation.rootIno },
    fileSystem,
  );
};

/** Reconcile rename-applied-then-thrown, then make the deterministic root entry durable. */
const quarantineRun = async (
  identity: RunWriterTerminalIdentity,
  fileSystem: RunQuarantineFileSystem,
  genesisFailure: boolean,
): Promise<RunQuarantineResult> => {
  const { generation } = identity;
  const retention = generation.role === "retention" || generation.role === "retirement";
  if (!retention && !(genesisFailure && generation.role === "writer" && generation.ordinal === 1))
    throw new TypeError("quarantine requires retention authority or failed ordinal-one genesis");
  const name = quarantineName(generation);
  const path = join(identity.managedRoot, name);
  if (dirname(path) !== identity.managedRoot || basename(identity.runPath) !== generation.runName)
    throw new Error("quarantine paths are not exact managed-root children");
  let state: RunQuarantineState = "ACTIVE_RETENTION";
  let old = await statAttempt(identity.runPath, fileSystem);
  let moved = await statAttempt(path, fileSystem);
  if (old && !sameRun(old, generation)) throw new Error("managed run identity changed before quarantine");
  if (moved && !sameRun(moved, generation)) throw new Error("deterministic quarantine path has another identity");
  if (old && moved) throw new Error("run and deterministic quarantine are both visible");
  if (!old && !moved) throw new Error("run disappeared before deterministic quarantine");

  if (old) {
    try { await fileSystem.rename(identity.runPath, path); }
    catch (renameError) {
      old = await statAttempt(identity.runPath, fileSystem);
      moved = await statAttempt(path, fileSystem);
      if (old || !moved || !sameRun(moved, generation)) throw renameError;
    }
    state = "QUARANTINE_VISIBLE_UNSYNCED";
  } else {
    state = "QUARANTINE_VISIBLE_UNSYNCED";
  }
  moved = await statAttempt(path, fileSystem);
  old = await statAttempt(identity.runPath, fileSystem);
  if (old || !moved || !sameRun(moved, generation))
    throw new Error("quarantine rename did not preserve the exact run inode");
  await syncRoot(identity.managedRoot, generation, fileSystem);
  state = "QUARANTINED";
  return { state, name, path };
};

export const quarantineOwnedRun = (
  identity: RunWriterTerminalIdentity,
  fileSystem: RunQuarantineFileSystem = nodeFileSystem,
): Promise<RunQuarantineResult> => quarantineRun(identity, fileSystem, false);

export const quarantineFailedGenesis = (
  managedRoot: string,
  runPath: string,
  generation: GenerationRecord,
  fileSystem: RunQuarantineFileSystem = nodeFileSystem,
): Promise<RunQuarantineResult> => quarantineRun({
  managedRoot,
  runPath,
  arbitrationPath: join(runPath, ARBITRATION_DIRECTORY),
  generation,
}, fileSystem, true);

export interface ScavengeQuarantineInput {
  readonly root: string;
  readonly name: string;
  readonly remove: (path: string) => Promise<void>;
  readonly syncAfterRemove?: boolean;
}

/** Validate terminal arbitration and inode-bound name before removing a prior quarantine. */
export const scavengeRunQuarantine = async (
  input: ScavengeQuarantineInput,
  fileSystem: RunQuarantineFileSystem = nodeFileSystem,
): Promise<void> => {
  const match = QUARANTINE.exec(input.name);
  if (!match || dirname(join(input.root, input.name)) !== input.root) throw new TypeError("invalid quarantine name");
  const path = join(input.root, input.name);
  const stat = await statAttempt(path, fileSystem);
  if (!stat) {
    if (input.syncAfterRemove !== false) await syncPrivateDirectory(input.root, undefined, fileSystem);
    return;
  }
  const chain = await scanArbitrationDirectory(join(path, ARBITRATION_DIRECTORY));
  const tip = chain.tip;
  if (!tip || tip.token !== match[1] || tip.runDev.toString(10) !== match[2]
    || tip.runIno.toString(10) !== match[3] || chain.releases.has(tip.token)
    || (tip.role !== "retention" && tip.role !== "retirement" && !(tip.role === "writer" && tip.ordinal === 1))
    || !sameRun(stat, tip))
    throw new Error("quarantine name, inode, and terminal arbitration disagree");
  try { await input.remove(path); }
  catch (removal) {
    let residual: BigIntStats | undefined;
    try { residual = await statAttempt(path, fileSystem); }
    catch (inspection) {
      throw new AggregateError([removal, inspection], "quarantine removal and residual inspection both failed");
    }
    if (residual) throw removal;
  }
  if (input.syncAfterRemove !== false) await syncRoot(input.root, tip, fileSystem);
};
