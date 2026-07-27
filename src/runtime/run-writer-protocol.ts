/** Internal append-only writer/retention arbitration wire protocol. */

import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";

export const ARBITRATION_DIRECTORY = ".pi-rlm-arbitration";
export const ARBITRATION_SCHEMA_VERSION = 1 as const;
export const MAX_ARBITRATION_RECORD_BYTES = 4096;
export const MAX_ARBITRATION_ORDINAL = 1024;
export const MAX_ARBITRATION_ORPHANS = 1024;
export const MAX_ARBITRATION_ENTRIES = MAX_ARBITRATION_ORDINAL * 4 + MAX_ARBITRATION_ORPHANS;

const TOKEN = /^[a-f0-9]{64}$/;
const RUN_NAME = /^run-[a-f0-9]{32}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const OS_IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;
const GENERATION_KEYS = [
  "schemaVersion", "type", "token", "predecessor", "ordinal", "role", "rootDev", "rootIno", "runDev",
  "runIno", "runName", "pid", "processNonce", "osProcessIdentity", "createdAtMs",
] as const;
const RELEASE_KEYS = [
  "schemaVersion", "type", "token", "generation", "processNonce", "rootDev", "rootIno", "runDev", "runIno",
  "releasedAtMs",
] as const;

export type ArbitrationRole = "writer" | "retention" | "retirement";
export interface ArbitrationIdentity {
  readonly rootDev: bigint;
  readonly rootIno: bigint;
  readonly runDev: bigint;
  readonly runIno: bigint;
}
export interface GenerationRecord extends ArbitrationIdentity {
  readonly schemaVersion: typeof ARBITRATION_SCHEMA_VERSION;
  readonly type: "generation";
  readonly token: string;
  readonly predecessor: string | null;
  readonly ordinal: number;
  readonly role: ArbitrationRole;
  readonly runName: string;
  readonly pid: number;
  readonly processNonce: string;
  readonly osProcessIdentity: string | null;
  readonly createdAtMs: number;
}
export interface ReleaseRecord extends ArbitrationIdentity {
  readonly schemaVersion: typeof ARBITRATION_SCHEMA_VERSION;
  readonly type: "release";
  readonly token: string;
  readonly generation: string;
  readonly processNonce: string;
  readonly releasedAtMs: number;
}

export type WriterProtocolErrorCode = "WRITER_PROTOCOL_RECORD" | "WRITER_PROTOCOL_CORRUPT" | "WRITER_PROTOCOL_LIMIT";
export class WriterProtocolError extends Error {
  override readonly name = "WriterProtocolError";
  constructor(readonly code: WriterProtocolErrorCode, message: string, override readonly cause?: unknown) { super(message); }
}

const recordError = (message: string): never => { throw new WriterProtocolError("WRITER_PROTOCOL_RECORD", message); };
const corrupt = (message: string, cause?: unknown): never => {
  throw new WriterProtocolError("WRITER_PROTOCOL_CORRUPT", message, cause);
};
const exactKeys = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) recordError(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null)
    recordError(`${label} must be a plain object`);
  const own = Reflect.ownKeys(object);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))
    recordError(`${label} fields are not exact`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      recordError(`${label} fields must be enumerable data properties`);
  }
  return object;
};
const stringField = (value: unknown, pattern: RegExp, label: string): string => {
  if (typeof value !== "string") recordError(`${label} is invalid`);
  const result = value as string;
  if (!pattern.test(result)) recordError(`${label} is invalid`);
  return result;
};
const safeInteger = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) recordError(`${label} is invalid`);
  return value as number;
};
const decimal = (value: unknown, label: string): bigint => {
  const encoded = stringField(value, DECIMAL, label);
  const parsed = BigInt(encoded);
  if (parsed.toString(10) !== encoded) recordError(`${label} is not canonical decimal`);
  return parsed;
};
const validateIdentity = (record: ArbitrationIdentity): void => {
  for (const [key, value] of Object.entries(record)) {
    if ((key.endsWith("Dev") || key.endsWith("Ino")) && (typeof value !== "bigint" || value < 0n))
      recordError(`${key} is invalid`);
  }
};
const validateGeneration = (record: GenerationRecord): void => {
  exactKeys(record, GENERATION_KEYS, "generation record");
  if (record.schemaVersion !== 1 || record.type !== "generation") recordError("generation discriminator is invalid");
  stringField(record.token, TOKEN, "generation token");
  if (record.predecessor !== null) stringField(record.predecessor, TOKEN, "generation predecessor");
  safeInteger(record.ordinal, "generation ordinal", 1);
  if (record.ordinal > MAX_ARBITRATION_ORDINAL) recordError("generation ordinal exceeds the protocol limit");
  if ((record.ordinal === 1) !== (record.predecessor === null)) recordError("generation predecessor does not match ordinal");
  if (!(["writer", "retention", "retirement"] as const).includes(record.role)) recordError("generation role is invalid");
  if ((record.ordinal === MAX_ARBITRATION_ORDINAL) !== (record.role === "retirement"))
    recordError("only the final ordinal is retirement and it is reserved for retirement");
  stringField(record.runName, RUN_NAME, "generation runName");
  safeInteger(record.pid, "generation pid", 1);
  if (record.pid > 0x7fff_ffff) recordError("generation pid is invalid");
  stringField(record.processNonce, TOKEN, "generation processNonce");
  if (record.osProcessIdentity !== null) stringField(record.osProcessIdentity, OS_IDENTITY, "generation osProcessIdentity");
  safeInteger(record.createdAtMs, "generation createdAtMs");
  validateIdentity(record);
};
const validateRelease = (record: ReleaseRecord): void => {
  exactKeys(record, RELEASE_KEYS, "release record");
  if (record.schemaVersion !== 1 || record.type !== "release") recordError("release discriminator is invalid");
  stringField(record.token, TOKEN, "release token");
  stringField(record.generation, TOKEN, "release generation");
  stringField(record.processNonce, TOKEN, "release processNonce");
  safeInteger(record.releasedAtMs, "release releasedAtMs");
  validateIdentity(record);
};
const generationWire = (record: GenerationRecord) => ({
  schemaVersion: record.schemaVersion, type: record.type, token: record.token, predecessor: record.predecessor,
  ordinal: record.ordinal, role: record.role, rootDev: record.rootDev.toString(10), rootIno: record.rootIno.toString(10),
  runDev: record.runDev.toString(10), runIno: record.runIno.toString(10), runName: record.runName, pid: record.pid,
  processNonce: record.processNonce, osProcessIdentity: record.osProcessIdentity, createdAtMs: record.createdAtMs,
});
const releaseWire = (record: ReleaseRecord) => ({
  schemaVersion: record.schemaVersion, type: record.type, token: record.token, generation: record.generation,
  processNonce: record.processNonce, rootDev: record.rootDev.toString(10), rootIno: record.rootIno.toString(10),
  runDev: record.runDev.toString(10), runIno: record.runIno.toString(10), releasedAtMs: record.releasedAtMs,
});
const bytes = (value: object): Uint8Array => {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (encoded.byteLength > MAX_ARBITRATION_RECORD_BYTES) recordError("record exceeds the byte limit");
  return encoded;
};
export const encodeGenerationRecord = (record: GenerationRecord): Uint8Array => {
  validateGeneration(record);
  return bytes(generationWire(record));
};
export const encodeReleaseRecord = (record: ReleaseRecord): Uint8Array => {
  validateRelease(record);
  return bytes(releaseWire(record));
};
const parseWire = (input: Uint8Array, label: string): Record<string, unknown> => {
  if (input.byteLength === 0 || input.byteLength > MAX_ARBITRATION_RECORD_BYTES) recordError(`${label} byte length is invalid`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); } catch (error) { throw new WriterProtocolError("WRITER_PROTOCOL_RECORD", `${label} is not UTF-8`, error); }
  if (!text.endsWith("\n") || text.endsWith("\n\n")) recordError(`${label} must have one trailing newline`);
  try { return exactKeys(JSON.parse(text) as unknown, label === "generation" ? GENERATION_KEYS : RELEASE_KEYS, label); }
  catch (error) {
    if (error instanceof WriterProtocolError) throw error;
    throw new WriterProtocolError("WRITER_PROTOCOL_RECORD", `${label} is not JSON`, error);
  }
};
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(Buffer.from(right));
export const decodeGenerationRecord = (input: Uint8Array): GenerationRecord => {
  const value = parseWire(input, "generation");
  const record: GenerationRecord = {
    schemaVersion: value["schemaVersion"] as 1, type: value["type"] as "generation",
    token: stringField(value["token"], TOKEN, "generation token"),
    predecessor: value["predecessor"] === null ? null : stringField(value["predecessor"], TOKEN, "generation predecessor"),
    ordinal: safeInteger(value["ordinal"], "generation ordinal", 1), role: value["role"] as ArbitrationRole,
    rootDev: decimal(value["rootDev"], "generation rootDev"), rootIno: decimal(value["rootIno"], "generation rootIno"),
    runDev: decimal(value["runDev"], "generation runDev"), runIno: decimal(value["runIno"], "generation runIno"),
    runName: value["runName"] as string, pid: value["pid"] as number, processNonce: value["processNonce"] as string,
    osProcessIdentity: value["osProcessIdentity"] as string | null, createdAtMs: value["createdAtMs"] as number,
  };
  validateGeneration(record);
  if (!sameBytes(input, encodeGenerationRecord(record))) recordError("generation is not canonical");
  return record;
};
export const decodeReleaseRecord = (input: Uint8Array): ReleaseRecord => {
  const value = parseWire(input, "release");
  const record: ReleaseRecord = {
    schemaVersion: value["schemaVersion"] as 1, type: value["type"] as "release",
    token: stringField(value["token"], TOKEN, "release token"), generation: stringField(value["generation"], TOKEN, "release generation"),
    processNonce: stringField(value["processNonce"], TOKEN, "release processNonce"),
    rootDev: decimal(value["rootDev"], "release rootDev"), rootIno: decimal(value["rootIno"], "release rootIno"),
    runDev: decimal(value["runDev"], "release runDev"), runIno: decimal(value["runIno"], "release runIno"),
    releasedAtMs: safeInteger(value["releasedAtMs"], "release releasedAtMs"),
  };
  validateRelease(record);
  if (!sameBytes(input, encodeReleaseRecord(record))) recordError("release is not canonical");
  return record;
};

export const generationIntentFilename = (token: string): string => `gen-${stringField(token, TOKEN, "generation token")}.json`;
export const releaseIntentFilename = (token: string): string => `rel-${stringField(token, TOKEN, "release token")}.json`;
export const successorSlotFilename = (predecessor: string | null): string =>
  predecessor === null ? "next-root.claim" : `next-${stringField(predecessor, TOKEN, "predecessor token")}.claim`;
export const releaseSlotFilename = (generation: string): string => `released-${stringField(generation, TOKEN, "generation token")}.claim`;

export interface ArbitrationEntryStat {
  readonly dev: bigint; readonly ino: bigint; readonly mode: number; readonly nlink: bigint; readonly size: bigint;
  readonly isFile: boolean;
}
export interface ArbitrationDirectoryStat {
  readonly dev: bigint; readonly ino: bigint; readonly mode: number; readonly isDirectory: boolean;
}
export interface ArbitrationBoundedRead { readonly bytes: Uint8Array; readonly eof: boolean; }
export type ArbitrationDirectoryEntry =
  | { readonly name: string; readonly load: { readonly status: "loaded"; readonly bytes: Uint8Array; readonly stat: ArbitrationEntryStat } }
  | { readonly name: string; readonly load: { readonly status: "failed"; readonly error: unknown } };
export interface ArbitrationScanFileSystem {
  statDirectory(directory: string): Promise<ArbitrationDirectoryStat>;
  list(directory: string, maximum: number): Promise<readonly string[]>;
  load(path: string): Promise<{ readonly bytes: Uint8Array; readonly stat: ArbitrationEntryStat }>;
}
export interface ArbitrationOrphan {
  readonly name: string; readonly recordType: "generation" | "release"; readonly validity: "canonical" | "malformed";
}
export interface ArbitrationChain {
  readonly generations: readonly GenerationRecord[];
  readonly releases: ReadonlyMap<string, ReleaseRecord>;
  readonly orphans: readonly ArbitrationOrphan[];
  readonly tip: GenerationRecord | null;
}

const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const readBounded = async (handle: Awaited<ReturnType<typeof open>>, maximum: number): Promise<ArbitrationBoundedRead> => {
  const buffer = Buffer.allocUnsafe(maximum);
  let length = 0;
  while (length < maximum) {
    const { bytesRead } = await handle.read(buffer, length, maximum - length, null);
    if (bytesRead === 0) return { bytes: buffer.subarray(0, length), eof: true };
    length += bytesRead;
  }
  return { bytes: buffer, eof: false };
};
export const nodeArbitrationScanFileSystem: ArbitrationScanFileSystem = {
  async statDirectory(directory) {
    const handle = await open(directory, constants.O_RDONLY | directoryFlag | noFollow);
    try {
      const value = await handle.stat({ bigint: true });
      return { dev: value.dev, ino: value.ino, mode: Number(value.mode), isDirectory: value.isDirectory() };
    } finally { await handle.close(); }
  },
  async list(directory, maximum) {
    const handle = await opendir(directory);
    const names: string[] = [];
    try {
      while (true) {
        const entry = await handle.read();
        if (!entry) break;
        names.push(entry.name);
        if (names.length > maximum) break;
      }
    } finally { await handle.close(); }
    return names;
  },
  async load(path) {
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_ARBITRATION_RECORD_BYTES))
        throw new Error("arbitration entry is not a bounded regular file");
      const content = await readBounded(handle, MAX_ARBITRATION_RECORD_BYTES + 1);
      const after = await handle.stat({ bigint: true });
      if (!content.eof || content.bytes.byteLength > MAX_ARBITRATION_RECORD_BYTES
        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || BigInt(content.bytes.byteLength) !== after.size)
        throw new Error("arbitration entry changed, exceeded its bound, or had no verified EOF");
      return { bytes: content.bytes, stat: {
        dev: after.dev, ino: after.ino, mode: Number(after.mode), nlink: after.nlink, size: after.size, isFile: after.isFile(),
      } };
    } finally { await handle.close(); }
  },
};

const nextName = /^next-(root|[a-f0-9]{64})\.claim$/;
const releasedName = /^released-([a-f0-9]{64})\.claim$/;
const intentKind = (name: string): "generation" | "release" | undefined =>
  name.startsWith("gen-") && name.endsWith(".json") ? "generation"
    : name.startsWith("rel-") && name.endsWith(".json") ? "release" : undefined;
const entryIdentity = (entry: ArbitrationDirectoryEntry, label: string): ArbitrationEntryStat => {
  const load = entry.load;
  if (load.status === "failed") return corrupt(`${label} cannot be read`, load.error);
  const stat = load.stat;
  if (!stat.isFile || (stat.mode & 0o7777) !== 0o600 || stat.size !== BigInt(load.bytes.byteLength))
    corrupt(`${label} is not a canonical private regular file`);
  return stat;
};
const entryBytes = (entry: ArbitrationDirectoryEntry): Uint8Array =>
  entry.load.status === "loaded" ? entry.load.bytes : corrupt(`entry ${entry.name} cannot be read`, entry.load.error);
const sameInode = (left: ArbitrationEntryStat, right: ArbitrationEntryStat): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const sameIdentity = (left: ArbitrationIdentity, right: ArbitrationIdentity): boolean =>
  left.rootDev === right.rootDev && left.rootIno === right.rootIno && left.runDev === right.runDev && left.runIno === right.runIno;

export const inspectArbitrationDirectory = (input: readonly ArbitrationDirectoryEntry[]): ArbitrationChain => {
  if (input.length > MAX_ARBITRATION_ENTRIES)
    throw new WriterProtocolError("WRITER_PROTOCOL_LIMIT", "arbitration directory entry limit exceeded");
  const entries = new Map<string, ArbitrationDirectoryEntry>();
  for (const entry of input) {
    if (entries.has(entry.name)) corrupt("arbitration directory contains a duplicate entry name");
    entries.set(entry.name, entry);
  }
  const referenced = new Set<string>();
  const generations = new Map<string, GenerationRecord>();
  const successors = new Map<string, GenerationRecord>();
  const releases = new Map<string, ReleaseRecord>();
  for (const entry of input) {
    const next = nextName.exec(entry.name);
    const released = releasedName.exec(entry.name);
    if (!next && !released) continue;
    const slotStat = entryIdentity(entry, `slot ${entry.name}`);
    if (slotStat.nlink !== 2n) corrupt(`slot ${entry.name} has an invalid link count`);
    try {
      if (next) {
        const predecessor = next[1] === "root" ? null : next[1]!;
        const generation = decodeGenerationRecord(entryBytes(entry));
        if (generation.predecessor !== predecessor) corrupt(`slot ${entry.name} references the wrong predecessor`);
        const intentName = generationIntentFilename(generation.token);
        const intent = entries.get(intentName);
        if (!intent) corrupt(`slot ${entry.name} has no generation intent`);
        const intentStat = entryIdentity(intent!, `intent ${intentName}`);
        if (!sameInode(slotStat, intentStat) || intentStat.nlink !== 2n) corrupt(`slot ${entry.name} does not match its intent inode`);
        referenced.add(intentName);
        if (generations.has(generation.token)) corrupt("generation token is referenced more than once");
        generations.set(generation.token, generation);
        successors.set(predecessor ?? "root", generation);
      } else {
        const generationToken = released![1]!;
        const release = decodeReleaseRecord(entryBytes(entry));
        if (release.generation !== generationToken) corrupt(`slot ${entry.name} references the wrong generation`);
        const intentName = releaseIntentFilename(release.token);
        const intent = entries.get(intentName);
        if (!intent) corrupt(`slot ${entry.name} has no release intent`);
        const intentStat = entryIdentity(intent!, `intent ${intentName}`);
        if (!sameInode(slotStat, intentStat) || intentStat.nlink !== 2n) corrupt(`slot ${entry.name} does not match its intent inode`);
        referenced.add(intentName);
        if (releases.has(generationToken)) corrupt("generation has more than one release slot");
        releases.set(generationToken, release);
      }
    } catch (error) {
      if (error instanceof WriterProtocolError && error.code === "WRITER_PROTOCOL_CORRUPT") throw error;
      corrupt(`slot ${entry.name} contains a malformed authoritative record`, error);
    }
  }
  const orphans: ArbitrationOrphan[] = [];
  for (const entry of input) {
    if (nextName.test(entry.name) || releasedName.test(entry.name) || referenced.has(entry.name)) continue;
    const kind = intentKind(entry.name);
    if (!kind) corrupt(`unexpected arbitration entry ${entry.name}`);
    let validity: ArbitrationOrphan["validity"] = "malformed";
    if (entry.load.status === "loaded") {
      const { bytes: content, stat } = entry.load;
      try {
        const expectedName = kind === "generation"
          ? generationIntentFilename(decodeGenerationRecord(content).token)
          : releaseIntentFilename(decodeReleaseRecord(content).token);
        if (expectedName === entry.name && stat.isFile && (stat.mode & 0o7777) === 0o600
          && stat.nlink === 1n && stat.size === BigInt(content.byteLength)) validity = "canonical";
      } catch { /* An unreferenced malformed intent is explicitly non-authoritative. */ }
    }
    orphans.push({ name: entry.name, recordType: kind!, validity });
  }
  if (orphans.length > MAX_ARBITRATION_ORPHANS)
    throw new WriterProtocolError("WRITER_PROTOCOL_LIMIT", "arbitration orphan budget exceeded");
  const chain: GenerationRecord[] = [];
  let predecessor: string | null = null;
  let identity: GenerationRecord | undefined;
  while (true) {
    const generation = successors.get(predecessor ?? "root");
    if (!generation) break;
    if (generation.ordinal !== chain.length + 1) corrupt("generation ordinals are not contiguous");
    if (identity && (!sameIdentity(identity, generation) || identity.runName !== generation.runName))
      corrupt("generation chain changes run identity");
    identity ??= generation;
    chain.push(generation);
    const release = releases.get(generation.token);
    if (generation.role === "retirement" && release) corrupt("retirement generation cannot be released");
    if (release && (!sameIdentity(generation, release) || release.processNonce !== generation.processNonce))
      corrupt("release does not match its generation owner and identity");
    predecessor = generation.token;
  }
  if (chain.length !== generations.size) corrupt("generation slot is not reachable from next-root.claim");
  for (const generationToken of releases.keys()) if (!generations.has(generationToken)) corrupt("release references an unknown generation");
  return { generations: chain, releases, orphans: orphans.sort((a, b) => a.name.localeCompare(b.name)), tip: chain.at(-1) ?? null };
};

export const scanArbitrationDirectory = async (
  directory: string,
  fileSystem: ArbitrationScanFileSystem = nodeArbitrationScanFileSystem,
): Promise<ArbitrationChain> => {
  const directoryAttempt = await (async (): Promise<
    { status: "loaded"; stat: ArbitrationDirectoryStat } | { status: "failed"; error: unknown }
  > => {
    try { return { status: "loaded", stat: await fileSystem.statDirectory(directory) }; }
    catch (error) { return { status: "failed", error }; }
  })();
  if (directoryAttempt.status === "failed") return corrupt("arbitration directory cannot be inspected", directoryAttempt.error);
  const directoryStat = directoryAttempt.stat;
  if (!directoryStat.isDirectory || (directoryStat.mode & 0o7777) !== 0o700)
    corrupt("arbitration directory is not canonical private metadata");
  const names = await fileSystem.list(directory, MAX_ARBITRATION_ENTRIES);
  if (names.length > MAX_ARBITRATION_ENTRIES)
    throw new WriterProtocolError("WRITER_PROTOCOL_LIMIT", "arbitration directory entry limit exceeded");
  const entries: ArbitrationDirectoryEntry[] = [];
  for (const name of [...names].sort()) {
    try { entries.push({ name, load: { status: "loaded", ...await fileSystem.load(join(directory, name)) } }); }
    catch (error) { entries.push({ name, load: { status: "failed", error } }); }
  }
  return inspectArbitrationDirectory(entries);
};
