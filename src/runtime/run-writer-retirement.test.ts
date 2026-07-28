import { describe, expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import {
  acquireRunRetentionLease,
} from "./run-writer-arbiter.ts";
import {
  MAX_ARBITRATION_ORDINAL,
  type ArbitrationChain,
  type GenerationRecord,
} from "./run-writer-protocol.ts";
import { publishImmutableArbitrationRecord } from "./run-writer-publisher.ts";
import {
  arbiterFixture,
  releaseFor,
  tokenAt,
  tokens,
} from "./run-writer-arbiter.test-helpers.ts";

const finalChain = async (
  fixture: Awaited<ReturnType<typeof arbiterFixture>>,
  length: number,
): Promise<ArbitrationChain> => {
  const root = await lstat(fixture.root, { bigint: true });
  const run = await lstat(fixture.runPath, { bigint: true });
  const identity = { rootDev: root.dev, rootIno: root.ino, runDev: run.dev, runIno: run.ino };
  const generations = Array.from({ length }, (_, index): GenerationRecord => ({
    schemaVersion: 1,
    type: "generation",
    token: tokenAt(index + 1),
    predecessor: index === 0 ? null : tokenAt(index),
    ordinal: index + 1,
    role: index + 1 === MAX_ARBITRATION_ORDINAL ? "retirement" : "writer",
    ...identity,
    runName: fixture.runName,
    pid: 2_000_000_000,
    processNonce: tokenAt(700),
    osProcessIdentity: null,
    createdAtMs: index,
  }));
  const tip = generations.at(-1)!;
  const releases = tip.role === "retirement"
    ? new Map()
    : new Map([[tip.token, releaseFor(tip, tokenAt(900))]]);
  return { generations, releases, orphans: [], tip };
};

describe("irreversible retirement recovery", () => {
  test("freshly preflights an authoritative pending final publication before returning it", async () => {
    const fixture = await arbiterFixture({ arbitration: "empty" });
    let chain = await finalChain(fixture, MAX_ARBITRATION_ORDINAL - 1);
    let first = true;
    const modes: string[] = [];
    const options = {
      createToken: tokens(5_000),
      scan: async () => chain,
      publish: async (...args: Parameters<typeof publishImmutableArbitrationRecord>) => {
        const result = await publishImmutableArbitrationRecord(...args);
        if (args[0].record.type === "generation") {
          const generation = args[0].record;
          chain = {
            generations: [...chain.generations, generation],
            releases: chain.releases,
            orphans: [],
            tip: generation,
          };
          if (first) { first = false; throw new Error("retirement publication result lost"); }
        }
        return result;
      },
    };
    try {
      const input = {
        managedRoot: fixture.root,
        runName: fixture.runName,
        preflightRetirement: async (mode: "publishing" | "recovering") => { modes.push(mode); },
      };
      await expect(acquireRunRetentionLease(input, options)).rejects.toThrow("retirement publication result lost");
      const lease = await acquireRunRetentionLease(input, options);
      expect(lease.role).toBe("retirement");
      expect(lease.generation).toBe(chain.tip!);
      expect(modes).toEqual(["publishing", "recovering"]);
      await lease.quarantine(async (identity) => identity.generation.token);
    } finally { await fixture.cleanup(); }
  });

  test("drops unreachable process authority after repeated pinned-close failure", async () => {
    const fixture = await arbiterFixture({ arbitration: "empty" });
    const chain = await finalChain(fixture, MAX_ARBITRATION_ORDINAL);
    try {
      const acquire = () => acquireRunRetentionLease({
        managedRoot: fixture.root,
        runName: fixture.runName,
        preflightRetirement: () => {},
      }, { scan: async () => chain, livenessProbe: () => "absent" });
      const lease = await acquire();
      const pinned = (lease as unknown as {
        pinned: { arbitration: { handle: { close(): Promise<void> } } };
      }).pinned;
      const close = pinned.arbitration.handle.close.bind(pinned.arbitration.handle);
      let failures = 2;
      pinned.arbitration.handle.close = async () => {
        if (failures-- > 0) throw new Error("injected pinned close failure");
        await close();
      };
      await expect(lease.quarantine(async () => undefined)).rejects.toThrow(
        "terminal transition pinned-handle close retry failed",
      );
      const recovered = await acquire();
      expect(recovered).not.toBe(lease);
      await recovered.quarantine(async () => undefined);
    } finally { await fixture.cleanup(); }
  });

  test("recovers a crash-stranded final generation without publishing an impossible successor", async () => {
    const fixture = await arbiterFixture({ arbitration: "empty" });
    const chain = await finalChain(fixture, MAX_ARBITRATION_ORDINAL);
    const modes: string[] = [];
    let publications = 0;
    try {
      const lease = await acquireRunRetentionLease({
        managedRoot: fixture.root,
        runName: fixture.runName,
        preflightRetirement: async (mode) => { modes.push(mode); },
      }, {
        scan: async () => chain,
        livenessProbe: () => "absent",
        publish: async (...args) => { publications++; return publishImmutableArbitrationRecord(...args); },
      });
      expect(lease.generation).toBe(chain.tip!);
      expect(lease.role).toBe("retirement");
      expect(modes).toEqual(["recovering"]);
      expect(publications).toBe(0);
      await lease.quarantine(async (identity) => identity.generation.token);
    } finally { await fixture.cleanup(); }
  });
});
