import { describe, expect, test } from "bun:test";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { JournalAppendError, JournalStore, type JournalFileSystem } from "../shell/journal-store.ts";
import { createRunWriterGenesis } from "./run-writer-arbiter.ts";
import { arbiterFixture, tokens } from "./run-writer-arbiter.test-helpers.ts";
import { LeaseOwnedRunPersistence } from "./run-writer-mutation.ts";

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

const syncAfterApplyFault = (): JournalFileSystem => ({
  async open(path, flags, mode) {
    const handle = await open(path, flags, mode);
    let syncs = 0;
    return {
      appendFile: (data, encoding) => handle.appendFile(data, encoding),
      readFile: () => handle.readFile(),
      truncate: (length) => handle.truncate(length),
      writeFile: (data, encoding) => handle.writeFile(data, encoding),
      close: () => handle.close(),
      async sync() {
        await handle.sync();
        if (++syncs === 1 && path.endsWith("events.jsonl")) throw new Error("sync applied then threw");
      },
    };
  },
  readFile: async (path) => Bun.file(path).arrayBuffer().then((value) => Buffer.from(value)),
  rename: async (oldPath, newPath) => { await import("node:fs/promises").then((fs) => fs.rename(oldPath, newPath)); },
});

describe("lease-owned managed persistence", () => {
  test("preserves the exact real JournalAppendError and durable bit through nested guards", async () => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    try {
      const lease = await createRunWriterGenesis(
        { managedRoot: fixture.root, runName: fixture.runName },
        { createToken: tokens() },
      );
      const persistence = new LeaseOwnedRunPersistence(fixture.root, fixture.runName, lease);
      const journal = new JournalStore(fixture.runPath, persistence.journalFileSystem(syncAfterApplyFault()));
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
      expect((thrown as JournalAppendError).eventDurable).toBe(true);
      expect((await journal.readEvents())).toMatchObject({ ok: true, value: [started] });
      await lease.release();
    } finally { await fixture.cleanup(); }
  });

  test("rejects paths outside the exact leased run before invoking an effect", async () => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    try {
      const lease = await createRunWriterGenesis({ managedRoot: fixture.root, runName: fixture.runName });
      const persistence = new LeaseOwnedRunPersistence(fixture.root, fixture.runName, lease);
      let invoked = false;
      await expect(persistence.runPathEffect(join(fixture.root, "outside"), async () => { invoked = true; }))
        .rejects.toMatchObject({ code: "WRITER_MUTATION_PATH" });
      expect(invoked).toBe(false);
      await lease.release();
    } finally { await fixture.cleanup(); }
  });
});
