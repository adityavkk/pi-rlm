import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARBITRATION_DIRECTORY,
  type GenerationRecord,
  type ReleaseRecord,
} from "./run-writer-protocol.ts";
import { publishImmutableArbitrationRecord } from "./run-writer-publisher.ts";

export const RUN_NAME = `run-${"1".repeat(32)}`;

export interface ArbiterFixture {
  readonly root: string;
  readonly runName: string;
  readonly runPath: string;
  readonly arbitrationPath: string;
  readonly predecessor: GenerationRecord | null;
  readonly predecessorRelease: ReleaseRecord | null;
  cleanup(): Promise<void>;
}

export interface ArbiterFixtureOptions {
  readonly arbitration?: "seeded" | "empty" | "missing";
  readonly predecessor?: Partial<GenerationRecord>;
  readonly released?: boolean;
}

export const tokenAt = (value: number): string => value.toString(16).padStart(64, "0");
export const releaseFor = (owner: GenerationRecord, releaseToken: string, releasedAtMs = 10): ReleaseRecord => ({
  schemaVersion: 1, type: "release", token: releaseToken, generation: owner.token,
  processNonce: owner.processNonce, rootDev: owner.rootDev, rootIno: owner.rootIno,
  runDev: owner.runDev, runIno: owner.runIno, releasedAtMs,
});

export const publishAuthoritativePredecessor = async (
  fixture: Pick<ArbiterFixture, "root" | "runPath" | "runName" | "arbitrationPath">,
  overrides: Partial<GenerationRecord> = {},
  released = true,
): Promise<{ readonly owner: GenerationRecord; readonly release: ReleaseRecord | null }> => {
  const root = await lstat(fixture.root, { bigint: true });
  const run = await lstat(fixture.runPath, { bigint: true });
  const owner: GenerationRecord = {
    schemaVersion: 1, type: "generation", token: tokenAt(900), predecessor: null, ordinal: 1, role: "writer",
    rootDev: root.dev, rootIno: root.ino, runDev: run.dev, runIno: run.ino,
    runName: fixture.runName, pid: 2_000_000_000, processNonce: tokenAt(901),
    osProcessIdentity: null, createdAtMs: 0, ...overrides,
  };
  await publishImmutableArbitrationRecord({ directory: fixture.arbitrationPath, record: owner });
  const ownerRelease = released ? releaseFor(owner, tokenAt(902)) : null;
  if (ownerRelease) await publishImmutableArbitrationRecord({ directory: fixture.arbitrationPath, record: ownerRelease });
  return { owner, release: ownerRelease };
};

export const arbiterFixture = async (options: ArbiterFixtureOptions = {}): Promise<ArbiterFixture> => {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-writer-arbiter-"));
  const runPath = join(root, RUN_NAME);
  const arbitrationPath = join(runPath, ARBITRATION_DIRECTORY);
  await chmod(root, 0o700);
  await mkdir(runPath, { mode: 0o700 });
  const fixture = {
    root, runName: RUN_NAME, runPath, arbitrationPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  const arbitration = options.arbitration ?? "seeded";
  if (arbitration !== "missing") await mkdir(arbitrationPath, { mode: 0o700 });
  const seeded = arbitration === "seeded"
    ? await publishAuthoritativePredecessor(fixture, options.predecessor, options.released ?? true)
    : { owner: null, release: null };
  return { ...fixture, predecessor: seeded.owner, predecessorRelease: seeded.release };
};

export const tokens = (start = 1): (() => string) => {
  let next = start;
  return () => tokenAt(next++);
};

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export interface SwappedDirectory { restore(): Promise<void>; }
export const swapDirectory = async (path: string): Promise<SwappedDirectory> => {
  const moved = `${path}.pinned-original`;
  await rename(path, moved);
  await mkdir(path, { mode: 0o700 });
  let restored = false;
  return {
    async restore() {
      if (restored) return;
      restored = true;
      await rm(path, { recursive: true, force: true });
      await rename(moved, path);
    },
  };
};

export const readLine = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
      const text = Buffer.concat(chunks).toString("utf8");
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally { reader.releaseLock(); }
};
