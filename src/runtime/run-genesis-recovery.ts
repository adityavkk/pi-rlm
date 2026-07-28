/** Conservative recognition for managed allocations that died before lifecycle binding. */

import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUN_LOCK_FILE, RUN_MANIFEST_FILE } from "./run-manifest.ts";
import {
  ARBITRATION_DIRECTORY,
  scanArbitrationDirectory,
  type ArbitrationChain,
  type GenerationRecord,
} from "./run-writer-protocol.ts";

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const MANIFEST_TEMP = /^\.manifest\.json\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tmp$/;
const LIFECYCLE_TEMP = /^\.\.pi-rlm-(?:lifecycle|active)\.json\.[a-f0-9]{32}\.tmp$/;
const mode = (value: bigint): bigint => value & 0o7777n;

export interface FailedWriterGenesisInspection {
  readonly kind: "unclaimed" | "claimed";
  readonly arbitrationExists: boolean;
  readonly runDev: bigint;
  readonly runIno: bigint;
  readonly chain?: ArbitrationChain;
  readonly genesis?: GenerationRecord;
}

const sameIdentity = (
  generation: GenerationRecord,
  root: BigIntStats,
  run: BigIntStats,
  runName: string,
): boolean => generation.rootDev === root.dev && generation.rootIno === root.ino
  && generation.runDev === run.dev && generation.runIno === run.ino && generation.runName === runName;

const boundedRunEntries = async (path: string): Promise<readonly string[] | undefined> => {
  const directory = await opendir(path, { bufferSize: 1 });
  const names: string[] = [];
  try {
    while (names.length <= 8) {
      const entry = await directory.read();
      if (!entry) return names;
      names.push(entry.name);
    }
    return undefined;
  } finally { await directory.close(); }
};

const privateRegular = async (path: string): Promise<boolean> => {
  const stat = await lstat(path, { bigint: true });
  return stat.isFile() && !stat.isSymbolicLink() && mode(stat.mode) === 0o600n && stat.nlink === 1n;
};

const safeRuntimeEntries = async (runPath: string, names: readonly string[]): Promise<boolean> => {
  const runtime = names.filter((name) => name !== ARBITRATION_DIRECTORY);
  if (runtime.some((name) => name === ".pi-rlm-lifecycle.json" || name === ".pi-rlm-active.json")) return false;
  if (runtime.some((name) => name !== RUN_LOCK_FILE && name !== RUN_MANIFEST_FILE
    && !MANIFEST_TEMP.test(name) && !LIFECYCLE_TEMP.test(name))) return false;
  if (runtime.some((name) => name !== RUN_LOCK_FILE) && !runtime.includes(RUN_LOCK_FILE)) return false;
  return (await Promise.all(runtime.map((name) => privateRegular(join(runPath, name))))).every(Boolean);
};

/**
 * Recognize only namespaces reachable from managed genesis code. Unclaimed
 * arbitration is safely electable; claimed arbitration still requires liveness
 * takeover before quarantine. Unknown entries remain ambiguous.
 */
export const inspectFailedWriterGenesis = async (
  managedRoot: string,
  runName: string,
): Promise<FailedWriterGenesisInspection | undefined> => {
  if (!RUN_NAME.test(runName)) return undefined;
  const runPath = join(managedRoot, runName);
  if (dirname(runPath) !== managedRoot) return undefined;
  const [root, run] = await Promise.all([
    lstat(managedRoot, { bigint: true }),
    lstat(runPath, { bigint: true }),
  ]);
  if (!root.isDirectory() || root.isSymbolicLink() || mode(root.mode) !== 0o700n
    || !run.isDirectory() || run.isSymbolicLink() || mode(run.mode) !== 0o700n
    || await realpath(runPath) !== join(await realpath(managedRoot), runName)) return undefined;

  const names = await boundedRunEntries(runPath);
  if (!names) return undefined;
  if (names.length === 0)
    return { kind: "unclaimed", arbitrationExists: false, runDev: run.dev, runIno: run.ino };
  if (!names.includes(ARBITRATION_DIRECTORY) || !await safeRuntimeEntries(runPath, names)) return undefined;
  const arbitration = await lstat(join(runPath, ARBITRATION_DIRECTORY), { bigint: true });
  if (!arbitration.isDirectory() || arbitration.isSymbolicLink() || mode(arbitration.mode) !== 0o700n) return undefined;

  const chain = await scanArbitrationDirectory(join(runPath, ARBITRATION_DIRECTORY));
  if (!chain.tip) {
    const onlyRecoverableGenesisIntents = chain.generations.length === 0 && chain.releases.size === 0
      && chain.orphans.every((orphan) => orphan.recordType === "generation" && orphan.validity !== "unverifiable");
    if (!onlyRecoverableGenesisIntents || names.length !== 1) return undefined;
    return { kind: "unclaimed", arbitrationExists: true, runDev: run.dev, runIno: run.ino, chain };
  }

  const genesis = chain.generations[0];
  if (!genesis || genesis.ordinal !== 1 || genesis.predecessor !== null || genesis.role !== "writer"
    || chain.orphans.some((orphan) => orphan.recordType !== "generation" || orphan.validity === "unverifiable")
    || chain.generations.some((generation) => !sameIdentity(generation, root, run, runName))) return undefined;
  return {
    kind: "claimed",
    arbitrationExists: true,
    runDev: run.dev,
    runIno: run.ino,
    chain,
    genesis,
  };
};

/** Recheck the exact failed-genesis namespace under terminal scheduler admission. */
export const assertFailedGenesisRetirement = async (
  managedRoot: string,
  runName: string,
  genesisToken: string,
  authority: GenerationRecord,
): Promise<void> => {
  const inspection = await inspectFailedWriterGenesis(managedRoot, runName);
  if (inspection?.kind !== "claimed" || inspection.genesis?.token !== genesisToken
    || inspection.chain?.tip?.token !== authority.token
    || inspection.chain.releases.has(authority.token)
    || inspection.runDev !== authority.runDev || inspection.runIno !== authority.runIno)
    throw new Error("failed genesis changed or gained lifecycle binding before quarantine");
};
