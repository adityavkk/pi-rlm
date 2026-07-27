import { describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nodeImmutablePublisherFileSystem,
  publishImmutableArbitrationRecord,
  type ImmutableDirectoryHandle,
  type ImmutableFileHandle,
  type ImmutablePublicationGuard,
  type ImmutablePublicationOperation,
  type ImmutablePublisherFileSystem,
} from "./run-writer-publisher.ts";
import {
  encodeGenerationRecord,
  generationIntentFilename,
  scanArbitrationDirectory,
  successorSlotFilename,
  type GenerationRecord,
  type ReleaseRecord,
} from "./run-writer-protocol.ts";

const token = (digit: string): string => digit.repeat(64);
const generation = (overrides: Partial<GenerationRecord> = {}): GenerationRecord => ({
  schemaVersion: 1, type: "generation", token: token("a"), predecessor: null, ordinal: 1, role: "writer",
  rootDev: 9_007_199_254_740_993n, rootIno: 18_014_398_509_481_987n, runDev: 4n, runIno: 5n,
  runName: `run-${"1".repeat(32)}`, pid: 123, processNonce: token("b"), osProcessIdentity: null, createdAtMs: 456,
  ...overrides,
});
const release = (owner: GenerationRecord, overrides: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  schemaVersion: 1, type: "release", token: token("e"), generation: owner.token, processNonce: owner.processNonce,
  rootDev: owner.rootDev, rootIno: owner.rootIno, runDev: owner.runDev, runIno: owner.runIno, releasedAtMs: 500,
  ...overrides,
});
const directory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pi-rlm-writer-publisher-"));
  const path = join(root, "arbitration");
  await mkdir(path, { mode: 0o700 });
  return path;
};
const cleanup = (path: string): Promise<void> => rm(join(path, ".."), { recursive: true, force: true });

type FaultWhen = "before" | "after";
interface FaultTarget { readonly label: string; readonly occurrence?: number; readonly when: FaultWhen; }
class FaultInjector {
  private readonly counts = new Map<string, number>();
  fired = false;
  constructor(private readonly target: FaultTarget) {}
  async call<T>(label: string, effect: () => Promise<T>): Promise<T> {
    const occurrence = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, occurrence);
    const match = label === this.target.label && occurrence === (this.target.occurrence ?? 1);
    if (match && this.target.when === "before") { this.fired = true; throw new Error(`fault before ${label}`); }
    const result = await effect();
    if (match && this.target.when === "after") { this.fired = true; throw new Error(`fault after ${label}`); }
    return result;
  }
}
const wrapFile = (handle: ImmutableFileHandle, kind: "initial" | "reopen" | "slot", faults: FaultInjector): ImmutableFileHandle => ({
  write: (bytes) => faults.call(`${kind}-write`, () => handle.write(bytes)),
  read: (maximumBytes) => faults.call(`${kind}-read`, () => handle.read(maximumBytes)),
  sync: () => faults.call(`${kind}-sync`, () => handle.sync()),
  stat: () => faults.call(`${kind}-stat`, () => handle.stat()),
  close: () => faults.call(`${kind}-close`, () => handle.close()),
});
const faultFileSystem = (faults: FaultInjector): ImmutablePublisherFileSystem => ({
  async createExclusive(path, mode) {
    const handle = await faults.call("intent-open", () => nodeImmutablePublisherFileSystem.createExclusive(path, mode));
    return wrapFile(handle, "initial", faults);
  },
  async openExisting(path) {
    const kind = /\/(?:next-|released-)/.test(path) ? "slot" : "reopen";
    const handle = await faults.call(`${kind}-open`, () => nodeImmutablePublisherFileSystem.openExisting(path));
    return wrapFile(handle, kind, faults);
  },
  async openDirectory(path) {
    const handle = await faults.call("directory-open", () => nodeImmutablePublisherFileSystem.openDirectory(path));
    const wrapped: ImmutableDirectoryHandle = {
      stat: () => faults.call("directory-stat", () => handle.stat()),
      sync: () => faults.call("directory-sync", () => handle.sync()),
      close: () => faults.call("directory-close", () => handle.close()),
    };
    return wrapped;
  },
  link: (existingPath, newPath) => faults.call("link", () => nodeImmutablePublisherFileSystem.link(existingPath, newPath)),
});

describe("immutable arbitration publisher", () => {
  test("publishes canonical 0600 bytes through one hard link with bigint inode verification", async () => {
    const path = await directory();
    try {
      const record = generation();
      const result = await publishImmutableArbitrationRecord({ directory: path, record });
      expect(result.status).toBe("published");
      const intentPath = join(path, generationIntentFilename(record.token));
      const slotPath = join(path, successorSlotFilename(null));
      expect(await readFile(intentPath)).toEqual(Buffer.from(encodeGenerationRecord(record)));
      const intent = await lstat(intentPath, { bigint: true });
      const slot = await lstat(slotPath, { bigint: true });
      expect(intent.mode & 0o777n).toBe(0o600n);
      expect(intent.dev).toBe(slot.dev);
      expect(intent.ino).toBe(slot.ino);
      expect(intent.nlink).toBe(2n);
      expect(typeof result.identity.ino).toBe("bigint");
    } finally { await cleanup(path); }
  });

  test("uses the same immutable publication for a canonical release slot", async () => {
    const path = await directory();
    try {
      const owner = generation();
      const ownerRelease = release(owner);
      expect((await publishImmutableArbitrationRecord({ directory: path, record: owner })).status).toBe("published");
      expect((await publishImmutableArbitrationRecord({ directory: path, record: ownerRelease })).status).toBe("published");
      expect((await scanArbitrationDirectory(path)).releases.get(owner.token)).toEqual(ownerRelease);
    } finally { await cleanup(path); }
  });

  test.each([
    { label: "initial-write", when: "after" },
    { label: "initial-sync", when: "after" },
    { label: "initial-close", when: "after" },
    { label: "reopen-open", when: "after" },
    { label: "reopen-stat", when: "after" },
    { label: "reopen-read", when: "after" },
    { label: "reopen-sync", when: "after" },
    { label: "reopen-close", when: "after" },
    { label: "directory-open", occurrence: 1, when: "after" },
    { label: "directory-stat", occurrence: 1, when: "after" },
    { label: "directory-sync", occurrence: 1, when: "after" },
    { label: "directory-close", occurrence: 1, when: "after" },
    { label: "link", when: "after" },
    { label: "slot-open", when: "after" },
    { label: "slot-stat", when: "after" },
    { label: "slot-read", when: "after" },
    { label: "slot-sync", when: "after" },
    { label: "slot-close", when: "after" },
    { label: "reopen-open", occurrence: 2, when: "after" },
    { label: "reopen-stat", occurrence: 3, when: "after" },
    { label: "reopen-read", occurrence: 2, when: "after" },
    { label: "reopen-sync", occurrence: 2, when: "after" },
    { label: "reopen-close", occurrence: 2, when: "after" },
    { label: "directory-open", occurrence: 2, when: "after" },
    { label: "directory-sync", occurrence: 2, when: "after" },
    { label: "directory-close", occurrence: 2, when: "after" },
  ] as FaultTarget[])("reconciles the first applied-then-throw call for generation and release at $label", async (target) => {
    for (const recordType of ["generation", "release"] as const) {
      const path = await directory();
      try {
        const owner = generation();
        if (recordType === "release")
          expect((await publishImmutableArbitrationRecord({ directory: path, record: owner })).status).toBe("published");
        const faults = new FaultInjector(target);
        if (recordType === "generation") {
          const result = await publishImmutableArbitrationRecord(
            { directory: path, record: owner }, { fileSystem: faultFileSystem(faults) },
          );
          expect(result.status).toBe("published");
          expect((await scanArbitrationDirectory(path)).generations).toEqual([owner]);
        } else {
          const ownerRelease = release(owner);
          const result = await publishImmutableArbitrationRecord(
            { directory: path, record: ownerRelease }, { fileSystem: faultFileSystem(faults) },
          );
          expect(result.status).toBe("published");
          expect((await scanArbitrationDirectory(path)).releases.get(owner.token)).toEqual(ownerRelease);
        }
        expect(faults.fired).toBe(true);
      } finally { await cleanup(path); }
    }
  });

  test.each([
    { label: "intent-open", when: "before" },
    { label: "link", when: "before" },
  ] as FaultTarget[])("retries the same token after a non-reconciled pre-apply $label fault", async (target) => {
    const path = await directory();
    try {
      const faults = new FaultInjector(target);
      const fileSystem = faultFileSystem(faults);
      const record = generation();
      await expect(publishImmutableArbitrationRecord({ directory: path, record }, { fileSystem })).rejects.toBeInstanceOf(Error);
      expect(faults.fired).toBe(true);
      expect((await publishImmutableArbitrationRecord({ directory: path, record }, { fileSystem })).status).toBe("published");
    } finally { await cleanup(path); }
  });

  test.each([
    { label: "initial-write", when: "before" },
    { label: "intent-open", when: "after" },
  ] as FaultTarget[])("never claims a partial unique intent after $label fails", async (target) => {
    const path = await directory();
    try {
      const faults = new FaultInjector(target);
      const record = generation();
      await expect(publishImmutableArbitrationRecord({ directory: path, record }, { fileSystem: faultFileSystem(faults) }))
        .rejects.toMatchObject({ code: "WRITER_PUBLISH_INTENT_INVALID" });
      await expect(lstat(join(path, successorSlotFilename(null)))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(publishImmutableArbitrationRecord({ directory: path, record }))
        .rejects.toMatchObject({ code: "WRITER_PUBLISH_INTENT_INVALID" });
    } finally { await cleanup(path); }
  });

  test("rejects prefix writes and bounded reads without a verified EOF", async () => {
    for (const failure of ["write-prefix", "read-prefix"] as const) {
      const path = await directory();
      try {
        const fileSystem: ImmutablePublisherFileSystem = {
          ...nodeImmutablePublisherFileSystem,
          async createExclusive(filePath, mode) {
            const handle = await nodeImmutablePublisherFileSystem.createExclusive(filePath, mode);
            if (failure !== "write-prefix") return handle;
            return { ...handle, async write(bytes) {
              await handle.write(bytes.subarray(0, 7));
              throw new Error("partial write");
            } };
          },
          async openExisting(filePath) {
            const handle = await nodeImmutablePublisherFileSystem.openExisting(filePath);
            if (failure !== "read-prefix" || /\/(?:next-|released-)/.test(filePath)) return handle;
            return { ...handle, async read(maximumBytes) {
              const result = await handle.read(maximumBytes);
              return { bytes: result.bytes.subarray(0, 7), eof: false };
            } };
          },
        };
        await expect(publishImmutableArbitrationRecord({ directory: path, record: generation() }, { fileSystem }))
          .rejects.toMatchObject({ code: "WRITER_PUBLISH_INTENT_INVALID" });
        await expect(lstat(join(path, successorSlotFilename(null)))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await cleanup(path); }
    }
  });

  test("does not swallow Promise.reject(undefined) from guards or filesystem phases", async () => {
    for (const failure of ["guard-pre", "guard-post", "filesystem"] as const) {
      const path = await directory();
      try {
        const failedPosts: ImmutablePublicationOperation[] = [];
        const guard: ImmutablePublicationGuard = {
          async pre(operation) { if (failure === "guard-pre" && operation.kind === "intent-open") await Promise.reject(undefined); },
          async post(operation, outcome) {
            if (outcome.status === "failed") failedPosts.push(operation);
            if (failure === "guard-post" && operation.kind === "intent-open") await Promise.reject(undefined);
          },
        };
        const fileSystem = failure === "filesystem" ? {
          ...nodeImmutablePublisherFileSystem,
          async createExclusive(): Promise<ImmutableFileHandle> { return Promise.reject(undefined); },
        } : nodeImmutablePublisherFileSystem;
        await expect(publishImmutableArbitrationRecord({ directory: path, record: generation() }, { fileSystem, guard }))
          .rejects.toMatchObject({ code: failure === "filesystem" ? "WRITER_PUBLISH_INTENT_INVALID" : "WRITER_PUBLISH_GUARD_FAILED" });
        if (failure === "filesystem") expect(failedPosts.some(({ kind }) => kind === "intent-open")).toBe(true);
      } finally { await cleanup(path); }
    }
  });

  test("rejects non-0700 directories", async () => {
    const path = await directory();
    try {
      await chmod(path, 0o755);
      await expect(publishImmutableArbitrationRecord({ directory: path, record: generation() }))
        .rejects.toMatchObject({ code: "WRITER_PUBLISH_IO_FAILED" });
      await expect(scanArbitrationDirectory(path)).rejects.toMatchObject({ code: "WRITER_PROTOCOL_CORRUPT" });
    } finally { await cleanup(path); }
  });

  test("retries a release after its successor is already published", async () => {
    const path = await directory();
    try {
      const owner = generation();
      const ownerRelease = release(owner);
      expect((await publishImmutableArbitrationRecord({ directory: path, record: owner })).status).toBe("published");
      const faults = new FaultInjector({ label: "link", when: "before" });
      await expect(publishImmutableArbitrationRecord({ directory: path, record: ownerRelease }, { fileSystem: faultFileSystem(faults) }))
        .rejects.toBeInstanceOf(Error);
      const successor = generation({ token: token("c"), predecessor: owner.token, ordinal: 2, role: "retention" });
      expect((await publishImmutableArbitrationRecord({ directory: path, record: successor })).status).toBe("published");
      expect((await publishImmutableArbitrationRecord({ directory: path, record: ownerRelease })).status).toBe("published");
      const inspected = await scanArbitrationDirectory(path);
      expect(inspected.generations).toEqual([owner, successor]);
      expect(inspected.releases.get(owner.token)).toEqual(ownerRelease);
    } finally { await cleanup(path); }
  });

  test("rejects an externally hard-linked intent before creating an authoritative slot", async () => {
    const path = await directory();
    try {
      const record = generation();
      const intentPath = join(path, generationIntentFilename(record.token));
      const externalPath = join(path, "..", "external-intent-link");
      await writeFile(intentPath, Buffer.from(encodeGenerationRecord(record)), { mode: 0o600 });
      await link(intentPath, externalPath);
      expect((await lstat(intentPath, { bigint: true })).nlink).toBe(2n);
      await expect(publishImmutableArbitrationRecord({ directory: path, record }))
        .rejects.toMatchObject({ code: "WRITER_PUBLISH_INTENT_INVALID" });
      await expect(lstat(join(path, successorSlotFilename(null)))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(intentPath, { bigint: true })).nlink).toBe(2n);
    } finally { await cleanup(path); }
  });

  test("fails closed when a losing contender observes a corrupt winner", async () => {
    const path = await directory();
    try {
      const winner = generation();
      expect((await publishImmutableArbitrationRecord({ directory: path, record: winner })).status).toBe("published");
      await writeFile(join(path, successorSlotFilename(null)), Buffer.from("{corrupt"));
      const loser = generation({ token: token("c"), role: "retention", processNonce: token("d") });
      await expect(publishImmutableArbitrationRecord({ directory: path, record: loser }))
        .rejects.toMatchObject({ code: "WRITER_PUBLISH_SLOT_CORRUPT" });
    } finally { await cleanup(path); }
  });

  test("two contenders elect exactly one and the loser remains an explicit orphan", async () => {
    const path = await directory();
    try {
      const writer = generation();
      const retention = generation({
        token: token("c"), role: "retention", pid: 456, processNonce: token("d"), createdAtMs: 457,
      });
      const results = await Promise.all([
        publishImmutableArbitrationRecord({ directory: path, record: writer }),
        publishImmutableArbitrationRecord({ directory: path, record: retention }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["lost", "published"]);
      const inspected = await scanArbitrationDirectory(path);
      expect(inspected.generations).toHaveLength(1);
      expect([writer.token, retention.token]).toContain(inspected.tip!.token);
      expect(inspected.orphans).toEqual([{
        name: generationIntentFilename(inspected.tip!.token === writer.token ? retention.token : writer.token),
        recordType: "generation", validity: "canonical",
      }]);
    } finally { await cleanup(path); }
  });

  test("runs guard pre/post around every seam and has no rename or unlink authority", async () => {
    const path = await directory();
    try {
      const pre: ImmutablePublicationOperation[] = [];
      const post: { operation: ImmutablePublicationOperation; status: "succeeded" | "failed" }[] = [];
      const guard: ImmutablePublicationGuard = {
        async pre(operation) { pre.push(operation); },
        async post(operation, outcome) { post.push({ operation, status: outcome.status }); },
      };
      let renameCalls = 0;
      let unlinkCalls = 0;
      const fileSystem = Object.assign({}, nodeImmutablePublisherFileSystem, {
        async rename() { renameCalls++; }, async unlink() { unlinkCalls++; },
      });
      expect((await publishImmutableArbitrationRecord({ directory: path, record: generation() }, { fileSystem, guard })).status)
        .toBe("published");
      expect(pre.length).toBeGreaterThan(0);
      expect(post.map(({ operation }) => operation)).toEqual(pre);
      expect(post.every(({ status }) => status === "succeeded")).toBe(true);
      expect(renameCalls).toBe(0);
      expect(unlinkCalls).toBe(0);
    } finally { await cleanup(path); }
  });
});
