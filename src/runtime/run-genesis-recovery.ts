/** Conservative recognition for managed allocations that died before lifecycle binding. */

import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  parseRunManifestDocument,
  RUN_LOCK_FILE,
  RUN_MANIFEST_FILE,
  type RunManifestDocument,
} from "./run-manifest.ts";
import {
  ARBITRATION_DIRECTORY,
  decodeReleaseRecord,
  nodeArbitrationScanFileSystem,
  releaseIntentFilename,
  scanArbitrationDirectory,
  type ArbitrationChain,
  type GenerationRecord,
} from "./run-writer-protocol.ts";

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const MANIFEST_TEMP = /^\.manifest\.json\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.tmp$/;
const MAX_LOCK_BYTES = 256;
const MAX_GENESIS_MANIFEST_BYTES = 1024 * 1024;
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
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

const readPrivateBounded = async (path: string, maximum: number): Promise<Uint8Array> => {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || mode(before.mode) !== 0o600n || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximum))
      throw new TypeError("failed-genesis runtime entry is not one bounded canonical private file");
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const result = await handle.read(buffer, length, buffer.byteLength - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mode !== after.mode || before.nlink !== after.nlink)
      throw new TypeError("failed-genesis runtime entry changed or had no verified EOF");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
};

interface CanonicalRunLock { readonly runId: string; readonly manifestHash: string }
const parseCanonicalLock = (bytes: Uint8Array): CanonicalRunLock => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("run lock is not a plain object");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  if (keys.length !== 2 || keys[0] !== "manifestHash" || keys[1] !== "runId"
    || typeof item["runId"] !== "string" || !RUN_ID.test(item["runId"])
    || typeof item["manifestHash"] !== "string" || !HASH.test(item["manifestHash"])
    || canonicalStringify(item as JsonValue) !== text)
    throw new TypeError("run lock is not exact canonical production metadata");
  return { runId: item["runId"], manifestHash: item["manifestHash"] };
};

const parseCanonicalManifest = (bytes: Uint8Array): RunManifestDocument => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new TypeError("run manifest has no canonical trailing newline");
  const value = JSON.parse(text) as unknown;
  const document = parseRunManifestDocument(value);
  if (`${canonicalStringify(value as JsonValue)}\n` !== text)
    throw new TypeError("run manifest bytes are not canonical production metadata");
  return document;
};

const manifestMatchesLock = (document: RunManifestDocument, lock: CanonicalRunLock): boolean =>
  document.manifest.run.id === lock.runId && document.manifestHash === lock.manifestHash;

/** Post-lock content is eligible only when every byte is an exact production snapshot. */
const safeRuntimeEntries = async (runPath: string, names: readonly string[]): Promise<boolean> => {
  const runtime = names.filter((name) => name !== ARBITRATION_DIRECTORY);
  if (runtime.length === 0) return true;
  if (!runtime.includes(RUN_LOCK_FILE)) return false;
  const documents = runtime.filter((name) => name === RUN_MANIFEST_FILE || MANIFEST_TEMP.test(name));
  if (runtime.some((name) => name !== RUN_LOCK_FILE && name !== RUN_MANIFEST_FILE && !MANIFEST_TEMP.test(name))
    || documents.length > 1 || runtime.length !== 1 + documents.length) return false;
  try {
    const lock = parseCanonicalLock(await readPrivateBounded(join(runPath, RUN_LOCK_FILE), MAX_LOCK_BYTES));
    if (documents.length === 0) return true;
    const name = documents[0]!;
    const document = parseCanonicalManifest(
      await readPrivateBounded(join(runPath, name), MAX_GENESIS_MANIFEST_BYTES),
    );
    const temp = MANIFEST_TEMP.exec(name);
    return manifestMatchesLock(document, lock)
      && (name === RUN_MANIFEST_FILE || temp?.[1] === document.manifest.run.nonce);
  } catch { return false; }
};

const recoverableReleaseOrphans = async (
  arbitrationPath: string,
  chain: ArbitrationChain,
): Promise<boolean> => {
  for (const orphan of chain.orphans) {
    if (orphan.recordType !== "release") continue;
    if (orphan.validity !== "canonical") return false;
    try {
      const loaded = await nodeArbitrationScanFileSystem.load(join(arbitrationPath, orphan.name));
      const release = decodeReleaseRecord(loaded.bytes);
      const owner = chain.generations.find((generation) => generation.token === release.generation);
      if (!owner || orphan.name !== releaseIntentFilename(release.token) || loaded.stat.nlink !== 1n
        || release.processNonce !== owner.processNonce
        || release.rootDev !== owner.rootDev || release.rootIno !== owner.rootIno
        || release.runDev !== owner.runDev || release.runIno !== owner.runIno) return false;
    } catch { return false; }
  }
  return true;
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
    || chain.orphans.some((orphan) => orphan.validity === "unverifiable")
    || !await recoverableReleaseOrphans(join(runPath, ARBITRATION_DIRECTORY), chain)
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
