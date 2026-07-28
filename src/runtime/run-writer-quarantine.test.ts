import { describe, expect, test } from "bun:test";
import { lstat, open, rename, rm } from "node:fs/promises";
import {
  acquireRunRetentionLease,
} from "./run-writer-arbiter.ts";
import { arbiterFixture, tokens } from "./run-writer-arbiter.test-helpers.ts";
import {
  quarantineOwnedRun,
  scavengeRunQuarantine,
  type RunQuarantineFileSystem,
} from "./run-writer-quarantine.ts";

const faultFileSystem = (fault: "rename-applied" | "root-sync-applied"): RunQuarantineFileSystem => {
  let injected = false;
  return {
    lstat,
    async rename(oldPath, newPath) {
      await rename(oldPath, newPath);
      if (fault === "rename-applied" && !injected) {
        injected = true;
        throw new Error("rename applied then threw");
      }
    },
    async openDirectory(path) {
      const handle = await open(path, "r");
      return {
        stat: (options) => handle.stat(options),
        close: () => handle.close(),
        async sync() {
          await handle.sync();
          if (fault === "root-sync-applied" && !injected) {
            injected = true;
            throw new Error("root sync applied then threw");
          }
        },
      };
    },
  };
};

describe("terminal writer quarantine", () => {
  test.each(["rename-applied", "root-sync-applied"] as const)(
    "reconciles %s and scavenges the deterministic inode-bound quarantine",
    async (fault) => {
      const fixture = await arbiterFixture();
      try {
        const lease = await acquireRunRetentionLease({
          managedRoot: fixture.root,
          runName: fixture.runName,
          preflightRetirement: async () => {},
        }, { createToken: tokens() });
        const fileSystem = faultFileSystem(fault);
        let quarantined;
        try {
          quarantined = await lease.quarantine((identity) => quarantineOwnedRun(identity, fileSystem));
        } catch (error) {
          expect(fault).toBe("root-sync-applied");
          quarantined = await lease.quarantine((identity) => quarantineOwnedRun(identity, fileSystem));
        }
        expect(quarantined.state).toBe("QUARANTINED");
        expect((await lstat(quarantined.path)).isDirectory()).toBe(true);
        await scavengeRunQuarantine({
          root: fixture.root,
          name: quarantined.name,
          remove: (path) => rm(path, { recursive: true }),
        });
        await expect(lstat(quarantined.path)).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await fixture.cleanup(); }
    },
  );

  test("reconciles a remover that deleted the whole quarantine before throwing", async () => {
    const fixture = await arbiterFixture();
    try {
      const lease = await acquireRunRetentionLease({
        managedRoot: fixture.root,
        runName: fixture.runName,
        preflightRetirement: async () => {},
      }, { createToken: tokens() });
      const quarantined = await lease.quarantine((identity) => quarantineOwnedRun(identity));
      const removalFailure = new Error("remove applied then threw");
      await expect(scavengeRunQuarantine({
        root: fixture.root,
        name: quarantined.name,
        async remove(path) {
          await rm(path, { recursive: true });
          throw removalFailure;
        },
      })).resolves.toBeUndefined();
      await expect(lstat(quarantined.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fixture.cleanup(); }
  });

  test("preserves removal and residual-inspection failures by reference", async () => {
    const fixture = await arbiterFixture();
    try {
      const lease = await acquireRunRetentionLease({
        managedRoot: fixture.root,
        runName: fixture.runName,
        preflightRetirement: async () => {},
      }, { createToken: tokens() });
      const quarantined = await lease.quarantine((identity) => quarantineOwnedRun(identity));
      const removalFailure = new Error("remove failed");
      const inspectionFailure = new Error("residual inspection failed");
      let failInspection = false;
      const base = faultFileSystem("rename-applied");
      const fileSystem: RunQuarantineFileSystem = {
        ...base,
        async lstat(path) {
          if (failInspection && path === quarantined.path) throw inspectionFailure;
          return lstat(path);
        },
      };
      const thrown = await scavengeRunQuarantine({
        root: fixture.root,
        name: quarantined.name,
        async remove() {
          failInspection = true;
          throw removalFailure;
        },
      }, fileSystem).then(() => undefined, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([removalFailure, inspectionFailure]);
      failInspection = false;
      await scavengeRunQuarantine({
        root: fixture.root,
        name: quarantined.name,
        remove: (path) => rm(path, { recursive: true }),
      });
    } finally { await fixture.cleanup(); }
  });
});
