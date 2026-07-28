/** Exact recognition for a managed allocation that died before manifest publication. */

import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ARBITRATION_DIRECTORY,
  scanArbitrationDirectory,
  type GenerationRecord,
} from "./run-writer-protocol.ts";

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const mode = (value: bigint): bigint => value & 0o7777n;

const exactEntries = async (path: string): Promise<boolean> => {
  const directory = await opendir(path, { bufferSize: 1 });
  const names: string[] = [];
  try {
    while (names.length < 2) {
      const entry = await directory.read();
      if (!entry) break;
      names.push(entry.name);
    }
  } finally { await directory.close(); }
  return names.length === 1 && names[0] === ARBITRATION_DIRECTORY;
};

const exactIdentity = (
  generation: GenerationRecord,
  root: BigIntStats,
  run: BigIntStats,
  runName: string,
): boolean => generation.rootDev === root.dev && generation.rootIno === root.ino
  && generation.runDev === run.dev && generation.runIno === run.ino && generation.runName === runName;

/** Return only an exact bare ordinal-one genesis. Any extra run entry fails recognition. */
export const inspectBareWriterGenesis = async (
  managedRoot: string,
  runName: string,
): Promise<GenerationRecord | undefined> => {
  if (!RUN_NAME.test(runName)) return undefined;
  const runPath = join(managedRoot, runName);
  if (dirname(runPath) !== managedRoot || !await exactEntries(runPath)) return undefined;
  const [root, run] = await Promise.all([
    lstat(managedRoot, { bigint: true }),
    lstat(runPath, { bigint: true }),
  ]);
  if (!root.isDirectory() || root.isSymbolicLink() || mode(root.mode) !== 0o700n
    || !run.isDirectory() || run.isSymbolicLink() || mode(run.mode) !== 0o700n) return undefined;
  const chain = await scanArbitrationDirectory(join(runPath, ARBITRATION_DIRECTORY));
  const genesis = chain.generations[0];
  if (chain.generations.length !== 1 || !genesis || chain.tip?.token !== genesis.token
    || genesis.ordinal !== 1 || genesis.predecessor !== null || genesis.role !== "writer"
    || chain.releases.size !== 0 || chain.orphans.length !== 0
    || !exactIdentity(genesis, root, run, runName)) return undefined;
  return genesis;
};

/** Recheck the exact bare namespace after shared retention authority was acquired. */
export const assertBareGenesisRetirement = async (
  managedRoot: string,
  runName: string,
  genesisToken: string,
  retention: GenerationRecord,
): Promise<void> => {
  const runPath = join(managedRoot, runName);
  if (!await exactEntries(runPath)) throw new Error("bare genesis gained a run entry before quarantine");
  const [root, run] = await Promise.all([
    lstat(managedRoot, { bigint: true }),
    lstat(runPath, { bigint: true }),
  ]);
  const chain = await scanArbitrationDirectory(join(runPath, ARBITRATION_DIRECTORY));
  const genesis = chain.generations[0];
  if (chain.generations.length !== 2 || !genesis || genesis.token !== genesisToken
    || genesis.ordinal !== 1 || genesis.role !== "writer" || chain.tip?.token !== retention.token
    || (retention.role !== "retention" && retention.role !== "retirement")
    || chain.releases.has(retention.token) || chain.orphans.length !== 0
    || !exactIdentity(genesis, root, run, runName) || !exactIdentity(retention, root, run, runName))
    throw new Error("bare genesis arbitration changed before quarantine");
};
