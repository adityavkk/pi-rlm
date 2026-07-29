import { constants, type BigIntStats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_LIVE_CONSENT_BYTES, parseLiveConsentText, type LiveConsent } from "./live-contract.ts";

export interface LiveConsentExpectation {
  readonly gitCommit: string;
  readonly suiteDigest: string;
  readonly fixtureDigest: string;
  readonly nowMs?: number;
}

export interface LiveConsentDependencies {
  readonly currentUid?: () => number | undefined;
  readonly randomId?: () => string;
}

export class LiveConsentError extends Error {
  readonly code:
    | "CONSENT_FILE_INVALID"
    | "CONSENT_EXPIRED"
    | "CONSENT_NOT_YET_VALID"
    | "CONSENT_COMMIT_MISMATCH"
    | "CONSENT_SUITE_MISMATCH"
    | "CONSENT_FIXTURE_MISMATCH"
    | "CONSENT_CONSUMPTION_FAILED";

  constructor(code: LiveConsentError["code"], message: string) {
    super(message);
    this.name = "LiveConsentError";
    this.code = code;
  }
}

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const sameSnapshot = (left: BigIntStats, right: BigIntStats): boolean =>
  sameFile(left, right) && left.size === right.size && left.mode === right.mode
  && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

const readBounded = async (handle: FileHandle): Promise<Uint8Array> => {
  const output = new Uint8Array(MAX_LIVE_CONSENT_BYTES + 1);
  let offset = 0;
  while (offset < output.byteLength) {
    const result = await handle.read(output, offset, output.byteLength - offset, null);
    if (result.bytesRead === 0) return output.subarray(0, offset);
    offset += result.bytesRead;
  }
  const probe = new Uint8Array(1);
  if ((await handle.read(probe, 0, 1, null)).bytesRead !== 0)
    throw new LiveConsentError("CONSENT_FILE_INVALID", "consent file exceeds its byte bound");
  return output;
};

const validateFileStat = (stat: BigIntStats, currentUid: number | undefined): void => {
  if (!stat.isFile() || stat.nlink !== 1n || (Number(stat.mode) & 0o7777) !== 0o600)
    throw new LiveConsentError("CONSENT_FILE_INVALID", "consent must be one regular 0600 file");
  if (currentUid === undefined || stat.uid !== BigInt(currentUid))
    throw new LiveConsentError("CONSENT_FILE_INVALID", "consent must be owned by the current user");
  if (stat.size > BigInt(MAX_LIVE_CONSENT_BYTES))
    throw new LiveConsentError("CONSENT_FILE_INVALID", "consent file exceeds its byte bound");
};

const validateBindings = (consent: LiveConsent, expected: LiveConsentExpectation): void => {
  const now = expected.nowMs ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new LiveConsentError("CONSENT_FILE_INVALID", "consent validation time is invalid");
  if (now < consent.issuedAtMs)
    throw new LiveConsentError("CONSENT_NOT_YET_VALID", "consent is not yet valid");
  if (now >= consent.expiresAtMs)
    throw new LiveConsentError("CONSENT_EXPIRED", "consent has expired");
  if (consent.gitCommit !== expected.gitCommit)
    throw new LiveConsentError("CONSENT_COMMIT_MISMATCH", "consent does not bind this git commit");
  if (consent.suiteDigest !== expected.suiteDigest)
    throw new LiveConsentError("CONSENT_SUITE_MISMATCH", "consent does not bind this suite");
  if (consent.fixtureDigest !== expected.fixtureDigest)
    throw new LiveConsentError("CONSENT_FIXTURE_MISMATCH", "consent does not bind these fixtures");
};

/**
 * Validate and atomically move one consent file before entering provider-capable code.
 * The original path is absent before callback execution. A crash after rename consumes authority.
 */
export const withConsumedLiveConsent = async <T>(
  path: string,
  expected: LiveConsentExpectation,
  callback: (consent: LiveConsent) => Promise<T>,
  dependencies: LiveConsentDependencies = {},
): Promise<T> => {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number")
    throw new LiveConsentError("CONSENT_FILE_INVALID", "no-follow file opening is unavailable");
  let handle: FileHandle | undefined;
  let before: BigIntStats;
  let consent: LiveConsent;
  const currentUid = dependencies.currentUid?.() ?? process.getuid?.();
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    before = await handle.stat({ bigint: true });
    validateFileStat(before, currentUid);
    const bytes = await readBounded(handle);
    const after = await handle.stat({ bigint: true });
    validateFileStat(after, currentUid);
    if (!sameSnapshot(before, after) || BigInt(bytes.byteLength) !== after.size)
      throw new LiveConsentError("CONSENT_FILE_INVALID", "consent file changed while being read");
    consent = parseLiveConsentText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validateBindings(consent, expected);
    const source = await lstat(path, { bigint: true });
    if (!sameSnapshot(before, source))
      throw new LiveConsentError("CONSENT_FILE_INVALID", "consent path changed while being read");
  } catch (error) {
    try { await handle?.close(); } catch { /* primary refusal is authoritative */ }
    if (error instanceof LiveConsentError) throw error;
    throw new LiveConsentError("CONSENT_FILE_INVALID", "consent file validation failed");
  }

  const consumedPath = join(dirname(path), `.${basename(path)}.consumed-${dependencies.randomId?.() ?? randomUUID()}`);
  let renamed = false;
  try {
    await rename(path, consumedPath);
    renamed = true;
    const consumed = await lstat(consumedPath, { bigint: true });
    validateFileStat(consumed, currentUid);
    if (!sameFile(before, consumed) || before.size !== consumed.size)
      throw new LiveConsentError("CONSENT_CONSUMPTION_FAILED", "consent consumption identity check failed");
    await handle.close();
    handle = undefined;
  } catch (error) {
    try { await handle?.close(); } catch { /* consumption already failed closed */ }
    if (error instanceof LiveConsentError) throw error;
    throw new LiveConsentError("CONSENT_CONSUMPTION_FAILED", "consent could not be consumed");
  }

  try {
    return await callback(consent);
  } finally {
    if (renamed) {
      try { await unlink(consumedPath); } catch { /* original authority remains consumed */ }
    }
  }
};
