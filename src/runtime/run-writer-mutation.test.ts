import { describe, expect, test } from "bun:test";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { JournalAppendError, JournalStore, type JournalFileSystem } from "../shell/journal-store.ts";
import { acquireRunRetentionLease, createRunWriterGenesis } from "./run-writer-arbiter.ts";
import { arbiterFixture, deferred, swapDirectory, tokens } from "./run-writer-arbiter.test-helpers.ts";
import { LeaseOwnedRunPersistence } from "./run-writer-mutation.ts";
import { quarantineOwnedRun, scavengeRunQuarantine } from "./run-writer-quarantine.ts";

const started = {
  type: "run_started" as const,
  runId: "run_test",
  manifestHash: "a".repeat(64),
  limits: {
    maxDepth: 1, maxFrames: 1, maxLogicalCalls: 1, maxAttempts: 1,
    maxControllerTurns: 1, maxConcurrency: 1, storedByteLimit: 1, deadlineMs: 1,
  },
  inputRefs: [],
};

type JournalFault = "append" | "sync" | "close";
const journalFaultFileSystem = (fault: JournalFault): JournalFileSystem => {
  let injected = false;
  return {
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode);
      const events = path.endsWith("events.jsonl");
      return {
        async appendFile(data, encoding) {
          if (events && fault === "append" && !injected) {
            injected = true;
            throw new Error("append rejected before apply");
          }
          await handle.appendFile(data, encoding);
        },
        readFile: () => handle.readFile(),
        truncate: (length) => handle.truncate(length),
        writeFile: (data, encoding) => handle.writeFile(data, encoding),
        async close() {
          await handle.close();
          if (events && fault === "close" && !injected) {
            injected = true;
            throw new Error("close applied then threw");
          }
        },
        async sync() {
          await handle.sync();
          if (events && fault === "sync" && !injected) {
            injected = true;
            throw new Error("sync applied then threw");
          }
        },
      };
    },
    readFile,
    rename,
  };
};

describe("lease-owned managed persistence", () => {
  test.each([
    ["append", false],
    ["sync", true],
    ["close", true],
  ] as const)("preserves exact JournalAppendError identity for %s faults", async (fault, durable) => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    try {
      const lease = await createRunWriterGenesis(
        { managedRoot: fixture.root, runName: fixture.runName },
        { createToken: tokens() },
      );
      const persistence = new LeaseOwnedRunPersistence(lease);
      const journal = new JournalStore(fixture.runPath, persistence.journalFileSystem(journalFaultFileSystem(fault)));
      const original = journal.append.bind(journal);
      let observed: unknown;
      journal.append = async (event) => {
        try { return await original(event); }
        catch (error) { observed = error; throw error; }
      };
      const thrown = await lease.run(() => journal.append(started)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBe(observed);
      expect(thrown).toBeInstanceOf(JournalAppendError);
      expect((thrown as JournalAppendError).eventDurable).toBe(durable);
      expect((await journal.readEvents())).toMatchObject({ ok: true, value: durable ? [started] : [] });
      await lease.release();
    } finally { await fixture.cleanup(); }
  });

  test("release cannot overtake a journal mutation between append, sync, and close", async () => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    const appended = deferred<void>();
    const continueAppend = deferred<void>();
    try {
      const lease = await createRunWriterGenesis({ managedRoot: fixture.root, runName: fixture.runName });
      const persistence = new LeaseOwnedRunPersistence(lease);
      const base = journalFaultFileSystem("append");
      let blocked = false;
      const fileSystem: JournalFileSystem = {
        ...base,
        async open(path, flags, mode) {
          const handle = await open(path, flags, mode);
          return {
            appendFile: async (data, encoding) => {
              await handle.appendFile(data, encoding);
              if (!blocked && path.endsWith("events.jsonl")) {
                blocked = true;
                appended.resolve(undefined);
                await continueAppend.promise;
              }
            },
            readFile: () => handle.readFile(),
            sync: () => handle.sync(),
            truncate: (length) => handle.truncate(length),
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
            close: () => handle.close(),
          };
        },
      };
      const journal = new JournalStore(fixture.runPath, persistence.journalFileSystem(fileSystem));
      const mutation = journal.append(started);
      await appended.promise;
      let releaseSettled = false;
      const releasing = lease.release().finally(() => { releaseSettled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseSettled).toBe(false);
      continueAppend.resolve(undefined);
      await mutation;
      await releasing;
      expect((await new JournalStore(fixture.runPath).readEvents())).toMatchObject({ ok: true, value: [started] });
    } finally { continueAppend.resolve(undefined); await fixture.cleanup(); }
  });

  test("actual guarded journal mutation excludes quarantine until durable writer release", async () => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    try {
      const writer = await createRunWriterGenesis({ managedRoot: fixture.root, runName: fixture.runName });
      const persistence = new LeaseOwnedRunPersistence(writer);
      const journal = new JournalStore(fixture.runPath, persistence.journalFileSystem());
      await journal.append(started);
      await expect(acquireRunRetentionLease({
        managedRoot: fixture.root,
        runName: fixture.runName,
        preflightRetirement: async () => {},
      })).rejects.toMatchObject({ code: "WRITER_ARBITER_ALREADY_OWNED" });
      await writer.release();
      const retention = await acquireRunRetentionLease({
        managedRoot: fixture.root,
        runName: fixture.runName,
        preflightRetirement: async () => {},
      });
      const quarantined = await retention.quarantine((identity) => quarantineOwnedRun(identity));
      await scavengeRunQuarantine({
        root: fixture.root,
        name: quarantined.name,
        remove: (path) => rm(path, { recursive: true }),
      });
    } finally { await fixture.cleanup(); }
  });

  test.each(["root", "run"] as const)("persistent %s pathname swap is rejected around an actual journal open", async (target) => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    let swapped: Awaited<ReturnType<typeof swapDirectory>> | undefined;
    try {
      const lease = await createRunWriterGenesis({ managedRoot: fixture.root, runName: fixture.runName });
      const persistence = new LeaseOwnedRunPersistence(lease);
      const fileSystem: JournalFileSystem = {
        async open(path, flags, mode) {
          if (!swapped && path.endsWith("events.jsonl"))
            swapped = await swapDirectory(target === "root" ? fixture.root : fixture.runPath);
          return open(path, flags, mode);
        },
        readFile,
        rename,
      };
      const journal = new JournalStore(fixture.runPath, persistence.journalFileSystem(fileSystem));
      await expect(journal.append(started)).rejects.toMatchObject({
        code: "WRITER_SCHEDULER_MANAGEMENT",
        phase: "post-fence",
      });
      await swapped!.restore();
      await lease.release();
    } finally {
      if (swapped) await swapped.restore();
      await fixture.cleanup();
    }
  });

  test("rejects paths outside the exact leased run before invoking an effect", async () => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    try {
      const lease = await createRunWriterGenesis({ managedRoot: fixture.root, runName: fixture.runName });
      const persistence = new LeaseOwnedRunPersistence(lease);
      let invoked = false;
      await expect(persistence.runPathEffect(join(fixture.root, "outside"), async () => { invoked = true; }))
        .rejects.toMatchObject({ code: "WRITER_MUTATION_PATH" });
      expect(invoked).toBe(false);
      await lease.release();
    } finally { await fixture.cleanup(); }
  });
});
