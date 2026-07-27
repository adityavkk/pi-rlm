import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JournalAppendError } from "../shell/journal-store.ts";
import {
  acquireRunWriterLease,
  type RunWriterAcquisitionRole,
} from "./run-writer-arbiter.ts";
import { PinnedRunWriterIdentity } from "./run-writer-identity.ts";
import {
  encodeGenerationRecord,
  encodeReleaseRecord,
  generationIntentFilename,
  releaseIntentFilename,
  scanArbitrationDirectory,
  type GenerationRecord,
  type ReleaseRecord,
} from "./run-writer-protocol.ts";
import { publishImmutableArbitrationRecord } from "./run-writer-publisher.ts";
import { RunWriterSchedulerError, RunWriterSchedulerManagementError } from "./run-writer-scheduler.ts";
import { oneShotIntentFault } from "./run-writer-arbiter-faults.test-helpers.ts";
import {
  arbiterFixture,
  deferred,
  publishAuthoritativePredecessor,
  releaseFor,
  swapDirectory,
  tokenAt,
  tokens,
  type ArbiterFixture,
} from "./run-writer-arbiter.test-helpers.ts";

const input = (fixture: ArbiterFixture, role: RunWriterAcquisitionRole = "writer") => ({
  managedRoot: fixture.root, runName: fixture.runName, role,
});
const successorFor = (
  owner: GenerationRecord,
  generationToken: string,
  overrides: Partial<GenerationRecord> = {},
): GenerationRecord => ({
  ...owner, token: generationToken, predecessor: owner.token, ordinal: owner.ordinal + 1, role: "retention",
  pid: Math.min(0x7fff_ffff, process.pid + 1_000_000), processNonce: tokenAt(777), createdAtMs: owner.createdAtMs + 1,
  ...overrides,
});

describe("internal run writer arbiter pending reconciliation", () => {
  test("retries the exact authoritative pending generation after applied-then-throw", async () => {
    const fixture = await arbiterFixture();
    const fault = { ambiguous: true };
    let first = true;
    const observed: string[] = [];
    const options = {
      createToken: tokens(),
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        if (args[0].record.type === "generation") observed.push(args[0].record.token);
        const result = await publishImmutableArbitrationRecord(...args);
        if (first && args[0].record.type === "generation") { first = false; throw fault; }
        return result;
      },
    };
    try {
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toBe(fault);
      const lease = await acquireRunWriterLease(input(fixture), options);
      expect(observed).toEqual([lease.generation.token, lease.generation.token]);
      expect((await scanArbitrationDirectory(fixture.arbitrationPath)).tip).toEqual(lease.generation);
      await lease.release();
    } finally { await fixture.cleanup(); }
  });

  test("retires only a malformed unreferenced generation intent and reserves one fresh token", async () => {
    const fixture = await arbiterFixture();
    const fault = oneShotIntentFault("generation", "partial-write");
    const createToken = tokens();
    try {
      await expect(acquireRunWriterLease(input(fixture), { createToken, publisherFileSystem: fault.fileSystem }))
        .rejects.toMatchObject({ code: "WRITER_PUBLISH_INTENT_INVALID" });
      expect(fault.state.fired).toBe(true);
      const lease = await acquireRunWriterLease(input(fixture), { createToken, publisherFileSystem: fault.fileSystem });
      expect(lease.generation.token).toBe(tokenAt(2));
      expect((await scanArbitrationDirectory(fixture.arbitrationPath)).orphans).toContainEqual({
        name: generationIntentFilename(tokenAt(1)), recordType: "generation", validity: "malformed",
      });
      await lease.release();
    } finally { await fixture.cleanup(); }
  });

  test("accepts a retired generation made authoritative between rotation scan and replacement publish", async () => {
    const fixture = await arbiterFixture();
    const replacementStarted = deferred<void>();
    const publishReplacement = deferred<void>();
    const firstFailure = new Error("intent durable before publication");
    let retired: GenerationRecord | undefined;
    let reportedMalformed = false;
    let blockedReplacement = false;
    const options = {
      createToken: tokens(10),
      scan: async (directory: string) => {
        const chain = await scanArbitrationDirectory(directory);
        if (!retired || reportedMalformed) return chain;
        const name = generationIntentFilename(retired.token);
        if (!chain.orphans.some((orphan) => orphan.name === name)) return chain;
        reportedMalformed = true;
        return { ...chain, orphans: chain.orphans.map((orphan) => orphan.name === name
          ? { ...orphan, validity: "malformed" as const }
          : orphan) };
      },
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        const record = args[0].record;
        if (record.type === "generation" && !retired) {
          retired = record;
          await writeFile(join(args[0].directory, generationIntentFilename(record.token)), encodeGenerationRecord(record), {
            flag: "wx", mode: 0o600,
          });
          throw firstFailure;
        }
        if (record.type === "generation" && record.token !== retired?.token && !blockedReplacement) {
          blockedReplacement = true;
          replacementStarted.resolve(undefined);
          await publishReplacement.promise;
        }
        return publishImmutableArbitrationRecord(...args);
      },
    };
    try {
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toBe(firstFailure);
      const acquisition = acquireRunWriterLease(input(fixture), options);
      await replacementStarted.promise;
      expect((await publishImmutableArbitrationRecord({
        directory: fixture.arbitrationPath, record: retired!,
      })).status).toBe("published");
      publishReplacement.resolve(undefined);
      const lease = await acquisition;
      expect(lease.generation).toEqual(retired!);
      await lease.release();
      const later = await acquireRunWriterLease(input(fixture, "retention"), options);
      await later.release();
    } finally { publishReplacement.resolve(undefined); await fixture.cleanup(); }
  });

  test("retains the exact token after a definitely pre-apply generation fault", async () => {
    const fixture = await arbiterFixture();
    const fault = oneShotIntentFault("generation", "preapply");
    const createToken = tokens(20);
    try {
      await expect(acquireRunWriterLease(input(fixture), { createToken, publisherFileSystem: fault.fileSystem }))
        .rejects.toBeInstanceOf(Error);
      const lease = await acquireRunWriterLease(input(fixture), { createToken, publisherFileSystem: fault.fileSystem });
      expect(lease.generation.token).toBe(tokenAt(20));
      expect((await scanArbitrationDirectory(fixture.arbitrationPath)).orphans)
        .not.toContainEqual(expect.objectContaining({ name: generationIntentFilename(tokenAt(20)) }));
      await lease.release();
    } finally { await fixture.cleanup(); }
  });

  test("terminalizes a lost-then-throw pending election before a later acquisition", async () => {
    const fixture = await arbiterFixture();
    const fault = new Error("lost then throw");
    let winner: GenerationRecord | undefined;
    let first = true;
    const options = {
      createToken: tokens(30),
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        if (first && args[0].record.type === "generation") {
          first = false;
          winner = {
            ...args[0].record, token: tokenAt(700), role: "retention", pid: 2_000_000_000,
            processNonce: tokenAt(701), createdAtMs: args[0].record.createdAtMs + 1,
          };
          await publishImmutableArbitrationRecord({ directory: args[0].directory, record: winner }, args[1]);
          const lost = await publishImmutableArbitrationRecord(...args);
          expect(lost.status).toBe("lost");
          throw fault;
        }
        return publishImmutableArbitrationRecord(...args);
      },
    };
    try {
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toBe(fault);
      await publishImmutableArbitrationRecord({
        directory: fixture.arbitrationPath, record: releaseFor(winner!, tokenAt(702)),
      });
      await expect(acquireRunWriterLease(input(fixture), options))
        .rejects.toMatchObject({ code: "WRITER_ARBITER_ELECTION_LOST" });
      const lease = await acquireRunWriterLease(input(fixture, "retention"), options);
      expect(lease.generation.predecessor).toBe(winner!.token);
      await lease.release();
    } finally { await fixture.cleanup(); }
  });

  test("terminalizes a durably released and superseded pending generation", async () => {
    const fixture = await arbiterFixture();
    const fault = new Error("published then superseded");
    let first = true;
    let successor: GenerationRecord | undefined;
    const options = {
      createToken: tokens(40),
      livenessProbe: () => "absent" as const,
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        const result = await publishImmutableArbitrationRecord(...args);
        if (first && args[0].record.type === "generation") {
          first = false;
          const release = releaseFor(args[0].record, tokenAt(710));
          successor = successorFor(args[0].record, tokenAt(711));
          await publishImmutableArbitrationRecord({ directory: args[0].directory, record: release }, args[1]);
          await publishImmutableArbitrationRecord({ directory: args[0].directory, record: successor }, args[1]);
          throw fault;
        }
        return result;
      },
    };
    try {
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toBe(fault);
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toMatchObject({ code: "WRITER_ARBITER_FENCED" });
      const lease = await acquireRunWriterLease(input(fixture, "retention"), options);
      expect(lease.generation.predecessor).toBe(successor!.token);
      await lease.release();
    } finally { await fixture.cleanup(); }
  });

  test("binds a pending acquisition to arbitration dev+ino while keeping the stable run owner key", async () => {
    const fixture = await arbiterFixture();
    let first = true;
    const options = {
      createToken: tokens(50),
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        if (first && args[0].record.type === "generation") { first = false; throw new Error("preapply"); }
        return publishImmutableArbitrationRecord(...args);
      },
    };
    let swapped: Awaited<ReturnType<typeof swapDirectory>> | undefined;
    try {
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toBeInstanceOf(Error);
      swapped = await swapDirectory(fixture.arbitrationPath);
      await publishAuthoritativePredecessor(fixture);
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toMatchObject({ code: "WRITER_IDENTITY_CHANGED" });
      await swapped.restore();
      const lease = await acquireRunWriterLease(input(fixture), options);
      const activeSwap = await swapDirectory(fixture.arbitrationPath);
      await publishAuthoritativePredecessor(fixture);
      await expect(acquireRunWriterLease(input(fixture, "retention"), options))
        .rejects.toMatchObject({ code: "WRITER_ARBITER_ALREADY_OWNED" });
      await activeSwap.restore();
      await lease.release();
    } finally { if (swapped) await swapped.restore(); await fixture.cleanup(); }
  });
});

describe("internal run writer arbiter release, close, and fencing", () => {
  test("retires a malformed pending release intent to one fresh release token", async () => {
    const fixture = await arbiterFixture();
    const fault = oneShotIntentFault("release", "partial-write");
    const options = { createToken: tokens(100), publisherFileSystem: fault.fileSystem };
    try {
      const lease = await acquireRunWriterLease(input(fixture), options);
      await expect(lease.release()).rejects.toBeInstanceOf(RunWriterSchedulerManagementError);
      await lease.release();
      const chain = await scanArbitrationDirectory(fixture.arbitrationPath);
      expect(chain.releases.get(lease.generation.token)?.token).toBe(tokenAt(102));
      expect(chain.orphans).toContainEqual({
        name: releaseIntentFilename(tokenAt(101)), recordType: "release", validity: "malformed",
      });
    } finally { await fixture.cleanup(); }
  });

  test("accepts a retired release made authoritative between rotation scan and replacement publish", async () => {
    const fixture = await arbiterFixture();
    const replacementStarted = deferred<void>();
    const publishReplacement = deferred<void>();
    const releaseFailure = new Error("release intent durable before publication");
    let retired: ReleaseRecord | undefined;
    let reportedMalformed = false;
    let blockedReplacement = false;
    const options = {
      createToken: tokens(110),
      scan: async (directory: string) => {
        const chain = await scanArbitrationDirectory(directory);
        if (!retired || reportedMalformed) return chain;
        const name = releaseIntentFilename(retired.token);
        if (!chain.orphans.some((orphan) => orphan.name === name)) return chain;
        reportedMalformed = true;
        return { ...chain, orphans: chain.orphans.map((orphan) => orphan.name === name
          ? { ...orphan, validity: "malformed" as const }
          : orphan) };
      },
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        const record = args[0].record;
        if (record.type === "release" && !retired) {
          retired = record;
          await writeFile(join(args[0].directory, releaseIntentFilename(record.token)), encodeReleaseRecord(record), {
            flag: "wx", mode: 0o600,
          });
          throw releaseFailure;
        }
        if (record.type === "release" && record.token !== retired?.token && !blockedReplacement) {
          blockedReplacement = true;
          replacementStarted.resolve(undefined);
          await publishReplacement.promise;
        }
        return publishImmutableArbitrationRecord(...args);
      },
    };
    try {
      const lease = await acquireRunWriterLease(input(fixture), options);
      await expect(lease.release()).rejects.toMatchObject({ managementError: releaseFailure });
      const releasing = lease.release();
      await replacementStarted.promise;
      expect((await publishImmutableArbitrationRecord({
        directory: fixture.arbitrationPath, record: retired!,
      })).status).toBe("published");
      publishReplacement.resolve(undefined);
      await releasing;
      expect((await scanArbitrationDirectory(fixture.arbitrationPath)).releases.get(lease.generation.token)).toEqual(retired!);
      const later = await acquireRunWriterLease(input(fixture, "retention"), options);
      await later.release();
    } finally { publishReplacement.resolve(undefined); await fixture.cleanup(); }
  });

  test("release retries its exact token before tip checks after a successor exists", async () => {
    const fixture = await arbiterFixture();
    let failRelease = true;
    const options = {
      createToken: tokens(),
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        const result = await publishImmutableArbitrationRecord(...args);
        if (failRelease && args[0].record.type === "release") { failRelease = false; throw new Error("ambiguous release"); }
        return result;
      },
    };
    try {
      const lease = await acquireRunWriterLease(input(fixture), options);
      await expect(lease.release()).rejects.toBeInstanceOf(RunWriterSchedulerManagementError);
      const successor = successorFor(lease.generation, tokenAt(60));
      expect((await publishImmutableArbitrationRecord({ directory: fixture.arbitrationPath, record: successor })).status).toBe("published");
      await lease.release();
      const chain = await scanArbitrationDirectory(fixture.arbitrationPath);
      expect(chain.releases.get(lease.generation.token)?.token).toBe(tokenAt(2));
      expect(chain.tip).toEqual(successor);
    } finally { await fixture.cleanup(); }
  });

  test("retries only an unresolved pinned close after durable release", async () => {
    const fixture = await arbiterFixture();
    try {
      const lease = await acquireRunWriterLease(input(fixture), { createToken: tokens(120) });
      const pinned = (lease as unknown as { pinned: PinnedRunWriterIdentity }).pinned;
      const internal = pinned as unknown as { arbitration: { handle: { close(): Promise<void> } } };
      const original = internal.arbitration.handle.close.bind(internal.arbitration.handle);
      const closeFailure = new Error("close once");
      let closes = 0;
      internal.arbitration.handle.close = async () => { if (++closes === 1) throw closeFailure; await original(); };
      await expect(lease.release()).rejects.toMatchObject({
        phase: "release-transition", managementError: closeFailure,
      });
      await lease.release();
      expect(closes).toBe(2);
      expect((await scanArbitrationDirectory(fixture.arbitrationPath)).releases.get(lease.generation.token)?.token)
        .toBe(tokenAt(121));
    } finally { await fixture.cleanup(); }
  });

  test("post-fence rejects a stale lease, then exact release reconciliation succeeds", async () => {
    const fixture = await arbiterFixture();
    try {
      const options = { createToken: tokens(140), now: () => 10 };
      const lease = await acquireRunWriterLease(input(fixture), options);
      const release: ReleaseRecord = releaseFor(lease.generation, tokenAt(141));
      const successor = successorFor(lease.generation, tokenAt(142));
      const failure = await lease.run(async () => {
        await publishImmutableArbitrationRecord({ directory: fixture.arbitrationPath, record: release });
        await publishImmutableArbitrationRecord({ directory: fixture.arbitrationPath, record: successor });
        return "effect-completed";
      }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(RunWriterSchedulerManagementError);
      expect((failure as RunWriterSchedulerManagementError).phase).toBe("post-fence");
      expect((failure as RunWriterSchedulerManagementError).managementError).toMatchObject({ code: "WRITER_ARBITER_FENCED" });
      await lease.release();
      await expect(lease.run(() => "stale")).rejects.toMatchObject({ code: "WRITER_SCHEDULER_CLOSED" });
    } finally { await fixture.cleanup(); }
  });

  test("lease composition preserves Journal-like identity, nesting, and release ordering", async () => {
    const fixture = await arbiterFixture();
    try {
      const lease = await acquireRunWriterLease(input(fixture), { createToken: tokens(160) });
      const journal = new JournalAppendError("event", true, new Error("disk"));
      await expect(lease.run(() => { throw journal; })).rejects.toBe(journal);
      const log: string[] = [];
      await lease.run(async () => { log.push("outer"); await lease.run(() => { log.push("nested"); }); });
      const gate = deferred<void>();
      const first = lease.run(async () => { log.push("first-start"); await gate.promise; log.push("first-end"); });
      const second = lease.run(() => { log.push("second"); });
      const released = lease.release();
      await expect(lease.run(() => "late")).rejects.toBeInstanceOf(RunWriterSchedulerError);
      gate.resolve(undefined);
      await Promise.all([first, second, released]);
      expect(log).toEqual(["outer", "nested", "first-start", "first-end", "second"]);
    } finally { await fixture.cleanup(); }
  });
});
