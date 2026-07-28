import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCheckpointStore } from "./checkpoint-store.ts";
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
});
