import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdtemp, open, readdir, rm, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCheckpointStore } from "./checkpoint-store.ts";
import type { ContextStoreInstrumentation } from "../shell/context-store-contract.ts";
import { runCheckpointAggregateByteLimit } from "./checkpoint-types.ts";

describe("bounded checkpoint payload slots", () => {
  test("retains two fixed slots and safely declines payload budget exhaustion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-slots-"));
    try {
      const storedByteLimit = 64;
      const store = new RunCheckpointStore(dir, storedByteLimit);
      let latest;
      for (let sequence = 1; sequence <= 7; sequence++) {
        latest = await store.publish(sequence, { sequence, state: `value-${sequence}` }, () => {});
        expect(latest).toBeDefined();
      }
      const usage = await store.usage();
      expect(usage.entries).toBe(2);
      expect(usage.bytes).toBeLessThanOrEqual(runCheckpointAggregateByteLimit(storedByteLimit));
      expect((await readdir(join(dir, "checkpoints"))).sort()).toEqual(["slot-0.bin", "slot-1.bin"]);
      const prior = await store.read(latest!, () => {});
      expect(JSON.parse(new TextDecoder().decode(prior))).toEqual({ sequence: 7, state: "value-7" });

      const declined = await store.publish(8, { oversized: "x".repeat(2 * 1024 * 1024) }, () => {});
      expect(declined).toBeUndefined();
      expect(await store.read(latest!, () => {})).toEqual(prior);
      expect((await readdir(join(dir, "checkpoints"))).length).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("tolerates only an exact zero-byte private pending crash leaf and preserves the authoritative slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-zero-pending-"));
    try {
      const store = new RunCheckpointStore(dir, 1024);
      const prior = await store.publish(1, { sequence: 1, state: "intact" }, () => {});
      expect(prior).toBeDefined();
      const expected = await store.read(prior!);
      const pending = join(dir, "checkpoints", ".pending.tmp");
      await writeFile(pending, new Uint8Array(), { mode: 0o600, flag: "wx" });
      expect(await store.read(prior!)).toEqual(expected);
      const next = await store.publish(2, { sequence: 2, state: "next" }, () => {});
      expect(next).toBeDefined();
      expect(await store.read(prior!)).toEqual(expected);
      expect((await readdir(join(dir, "checkpoints"))).sort()).toEqual(["slot-0.bin", "slot-1.bin"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects a zero-byte pending leaf that is not private and singly linked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-invalid-zero-"));
    try {
      const store = new RunCheckpointStore(dir, 1024);
      const prior = await store.publish(1, { sequence: 1 }, () => {});
      const pending = join(dir, "checkpoints", ".pending.tmp");
      await writeFile(pending, new Uint8Array(), { mode: 0o644, flag: "wx" });
      await expect(store.read(prior!)).rejects.toThrow("bounded private regular file");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  for (const seam of ["write", "sync", "close", "rename", "dir-sync"] as const) {
    test(`declines ordinary ${seam} storage failure without losing the prior slot`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `pi-rlm-checkpoint-${seam}-`));
      try {
        const priorStore = new RunCheckpointStore(dir, 1024);
        const prior = await priorStore.publish(1, { sequence: 1, state: "prior" }, () => {});
        const expected = await priorStore.read(prior!);
        let pendingOperations = 0;
        let fired = false;
        const storageFault = (): never => {
          fired = true;
          throw Object.assign(new Error(`injected ${seam}`), { code: "EIO" });
        };
        const instrumentation: ContextStoreInstrumentation = {
          writeFile: async (path, bytes) => {
            if (seam === "write") storageFault();
            await writeFile(path, bytes, {
              flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
              mode: 0o600,
            });
          },
          ...(seam === "sync" ? { syncFile: async () => storageFault() } : {}),
          ...(seam === "rename" ? { rename: async () => storageFault() } : { rename }),
          ...(seam === "dir-sync" ? { syncDirectory: async () => storageFault() } : {}),
          unlink,
          runFileSystemOperation: async (path, effect) => {
            const result = await effect();
            if (seam === "close" && path.endsWith(".pending.tmp") && ++pendingOperations === 4 && !fired)
              storageFault();
            return result;
          },
        };
        const faulted = new RunCheckpointStore(dir, 1024, instrumentation);
        expect(await faulted.publish(2, { sequence: 2, state: "candidate" }, () => {})).toBeUndefined();
        expect(fired).toBe(true);
        expect(await priorStore.read(prior!)).toEqual(expected);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }

  test("propagates writer fencing instead of treating checkpoint storage as optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-fenced-"));
    try {
      const fenced = Object.assign(new Error("writer fenced"), { code: "WRITER_ARBITER_FENCED" });
      const store = new RunCheckpointStore(dir, 1024, {
        runFileSystemOperation: async () => { throw fenced; },
      });
      await expect(store.publish(1, { state: "candidate" }, () => {})).rejects.toBe(fenced);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
