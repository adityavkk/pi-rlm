import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunWriterLease,
  createRunWriterGenesis,
  type RunWriterAcquisitionRole,
} from "./run-writer-arbiter.ts";
import { PinnedRunWriterIdentity } from "./run-writer-identity.ts";
import {
  MAX_ARBITRATION_ORDINAL,
  scanArbitrationDirectory,
  type ArbitrationChain,
  type GenerationRecord,
} from "./run-writer-protocol.ts";
import type { ImmutablePublicationOperation } from "./run-writer-publisher.ts";
import {
  arbiterFixture,
  publishAuthoritativePredecessor,
  readLine,
  releaseFor,
  swapDirectory,
  tokenAt,
  tokens,
  type ArbiterFixture,
} from "./run-writer-arbiter.test-helpers.ts";

const input = (fixture: ArbiterFixture, role: RunWriterAcquisitionRole = "writer") => ({
  managedRoot: fixture.root, runName: fixture.runName, role,
});
const operation: ImmutablePublicationOperation = { kind: "intent-open", path: "/not-used" };

const liveChildScript = (fixture: ArbiterFixture): string => `
  const { acquireRunWriterLease } = await import(${JSON.stringify(new URL("./run-writer-arbiter.ts", import.meta.url).href)});
  try {
    const lease = await acquireRunWriterLease(${JSON.stringify(input(fixture))});
    console.log("OWN " + lease.generation.token);
    for await (const _chunk of process.stdin) { /* parent keeps the winning lease alive */ }
    await lease.release();
  } catch (error) { console.log("ERR " + (error && error.code || error && error.name || "unknown")); }
`;
const electionChildScript = (fixture: ArbiterFixture): string => `
  const { createInterface } = await import("node:readline");
  const { acquireRunWriterLease } = await import(${JSON.stringify(new URL("./run-writer-arbiter.ts", import.meta.url).href)});
  const lines = createInterface({ input: process.stdin });
  const commands = lines[Symbol.asyncIterator]();
  let waiting = true;
  try {
    const lease = await acquireRunWriterLease(${JSON.stringify(input(fixture))}, {
      publicationGuard: {
        async pre() {
          if (!waiting) return;
          waiting = false;
          console.log("READY");
          await commands.next();
        },
        async post() {},
      },
    });
    console.log("OWN " + lease.generation.token);
    await commands.next();
    await lease.release();
  } catch (error) { console.log("ERR " + (error && error.code || error && error.name || "unknown")); }
  lines.close();
`;
const spawnChild = (script: string) => Bun.spawn({
  cmd: [process.execPath, "-e", script], stdin: "pipe", stdout: "pipe", stderr: "pipe",
});

describe("internal run writer arbiter identity", () => {
  test("creates ordinal-one writer genesis only in an empty managed run", async () => {
    const fixture = await arbiterFixture({ arbitration: "missing" });
    try {
      const lease = await createRunWriterGenesis(
        { managedRoot: fixture.root, runName: fixture.runName },
        { createToken: tokens(), now: () => 1 },
      );
      expect(lease.role).toBe("writer");
      expect(lease.generation).toMatchObject({ ordinal: 1, predecessor: null, role: "writer" });
      expect(await readdir(fixture.runPath)).toEqual([".pi-rlm-arbitration"]);
      expect((await scanArbitrationDirectory(fixture.arbitrationPath)).tip?.token).toBe(lease.generation.token);
      await lease.release();
      const successor = await acquireRunWriterLease(input(fixture), { createToken: tokens(20) });
      expect(successor.generation.ordinal).toBe(2);
      await successor.release();
    } finally { await fixture.cleanup(); }
  });

  test("opens only exact existing private bigint identities", async () => {
    const fixture = await arbiterFixture();
    try {
      const pinned = await PinnedRunWriterIdentity.openExisting(fixture.root, fixture.runName);
      for (const value of [...Object.values(pinned.identity), ...Object.values(pinned.arbitrationIdentity)])
        expect(typeof value).toBe("bigint");
      for (const path of [fixture.root, fixture.runPath, fixture.arbitrationPath])
        expect((await lstat(path, { bigint: true })).mode & 0o7777n).toBe(0o700n);
      await pinned.assertValid();
      await pinned.close();
      await expect(PinnedRunWriterIdentity.openExisting("relative", fixture.runName))
        .rejects.toMatchObject({ code: "WRITER_IDENTITY_INPUT" });
      await expect(PinnedRunWriterIdentity.openExisting(fixture.root, "run-not-exact"))
        .rejects.toMatchObject({ code: "WRITER_IDENTITY_INPUT" });
      await chmod(fixture.runPath, 0o755);
      await expect(PinnedRunWriterIdentity.openExisting(fixture.root, fixture.runName))
        .rejects.toMatchObject({ code: "WRITER_IDENTITY_OPEN" });
    } finally { await fixture.cleanup(); }

    const hostile = await arbiterFixture({ arbitration: "missing" });
    const outside = await mkdtemp(join(tmpdir(), "pi-rlm-writer-arbiter-outside-"));
    try {
      await mkdir(join(outside, "directory"), { mode: 0o700 });
      await symlink(join(outside, "directory"), hostile.arbitrationPath, "dir");
      await expect(PinnedRunWriterIdentity.openExisting(hostile.root, hostile.runName))
        .rejects.toMatchObject({ code: "WRITER_IDENTITY_OPEN" });
    } finally { await Promise.all([hostile.cleanup(), rm(outside, { recursive: true, force: true })]); }
  });

  test("rejects missing and empty legacy arbitration without namespace mutation", async () => {
    const missing = await arbiterFixture({ arbitration: "missing" });
    try {
      expect(await readdir(missing.runPath)).toEqual([]);
      await expect(acquireRunWriterLease(input(missing))).rejects.toMatchObject({ code: "WRITER_IDENTITY_OPEN" });
      expect(await readdir(missing.runPath)).toEqual([]);
      await expect(lstat(missing.arbitrationPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await missing.cleanup(); }

    const empty = await arbiterFixture({ arbitration: "empty" });
    let tokenCalls = 0;
    try {
      expect(await readdir(empty.arbitrationPath)).toEqual([]);
      await expect(acquireRunWriterLease(input(empty), { createToken: () => { tokenCalls++; return tokenAt(1); } }))
        .rejects.toMatchObject({ code: "WRITER_ARBITER_NO_AUTHORITY" });
      expect(await readdir(empty.arbitrationPath)).toEqual([]);
      expect(tokenCalls).toBe(0);
    } finally { await empty.cleanup(); }
  });

  test("rejects worker-thread ownership before touching authoritative metadata", async () => {
    const fixture = await arbiterFixture();
    const before = await readdir(fixture.arbitrationPath);
    const worker = new Worker(new URL("./run-writer-arbiter-worker-fixture.ts", import.meta.url));
    try {
      const result = new Promise<unknown>((resolve, reject) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = reject;
      });
      worker.postMessage(input(fixture));
      expect(await result).toBe("WRITER_ARBITER_UNSUPPORTED_REALM");
      expect(await readdir(fixture.arbitrationPath)).toEqual(before);
    } finally { worker.terminate(); await fixture.cleanup(); }
  });

  test("close makes identity unusable immediately and retries only unresolved handles", async () => {
    const fixture = await arbiterFixture();
    try {
      const pinned = await PinnedRunWriterIdentity.openExisting(fixture.root, fixture.runName);
      const internal = pinned as unknown as { arbitration: { handle: { close(): Promise<void> } } };
      const original = internal.arbitration.handle.close.bind(internal.arbitration.handle);
      const closeFailure = new Error("close once");
      let calls = 0;
      internal.arbitration.handle.close = async () => { if (++calls === 1) throw closeFailure; await original(); };
      await expect(pinned.close()).rejects.toBe(closeFailure);
      await expect(pinned.assertValid()).rejects.toMatchObject({ code: "WRITER_IDENTITY_CHANGED" });
      await pinned.close();
      await pinned.close();
      expect(calls).toBe(2);
    } finally { await fixture.cleanup(); }
  });

  test("guard always performs final identity validation after downstream pre/post success or rejection", async () => {
    const fixture = await arbiterFixture();
    try {
      for (const seam of ["pre", "post"] as const) {
        for (const outcome of ["success", "downstream", "identity", "both"] as const) {
          const pinned = await PinnedRunWriterIdentity.openExisting(fixture.root, fixture.runName);
          const original = pinned.assertValid.bind(pinned);
          const downstreamFailure = new Error(`${seam} downstream`);
          const identityFailure = new Error(`${seam} identity`);
          let assertions = 0;
          pinned.assertValid = async () => {
            assertions++;
            if ((outcome === "identity" || outcome === "both") && assertions === 2) throw identityFailure;
            await original();
          };
          const guard = pinned.publicationGuard({
            async pre() { if (seam === "pre" && (outcome === "downstream" || outcome === "both")) throw downstreamFailure; },
            async post(_operation, operationOutcome) {
              expect(operationOutcome.status).toBe("failed");
              if (seam === "post" && (outcome === "downstream" || outcome === "both")) throw downstreamFailure;
            },
          });
          const call = seam === "pre"
            ? guard.pre(operation)
            : guard.post(operation, { status: "failed", error: new Error("operation") });
          const failure = await call.then(() => undefined, (error: unknown) => error);
          expect(assertions).toBe(2);
          if (outcome === "success") expect(failure).toBeUndefined();
          if (outcome === "downstream") expect(failure).toBe(downstreamFailure);
          if (outcome === "identity") expect(failure).toBe(identityFailure);
          if (outcome === "both") {
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toEqual([downstreamFailure, identityFailure]);
          }
          await pinned.close();
        }
      }
    } finally { await fixture.cleanup(); }
  });

  test.each(["root", "run", "arbitration"] as const)("detects a $p pathname swap inside a scan", async (target) => {
    const fixture = await arbiterFixture();
    let swapped: Awaited<ReturnType<typeof swapDirectory>> | undefined;
    const path = target === "root" ? fixture.root : target === "run" ? fixture.runPath : fixture.arbitrationPath;
    const options = {
      createToken: tokens(),
      scan: async (directory: string): Promise<ArbitrationChain> => {
        if (!swapped) swapped = await swapDirectory(path);
        return scanArbitrationDirectory(directory);
      },
    };
    try {
      await expect(acquireRunWriterLease(input(fixture), options)).rejects.toBeInstanceOf(Error);
      await swapped!.restore();
      const lease = await acquireRunWriterLease(input(fixture), options);
      await lease.release();
    } finally { if (swapped) await swapped.restore(); await fixture.cleanup(); }
  });
});

describe("internal run writer arbiter election and liveness", () => {
  test("elects only one same-process contender and never creates a second owner", async () => {
    const fixture = await arbiterFixture();
    try {
      const options = { createToken: tokens() };
      const outcomes = await Promise.allSettled([
        acquireRunWriterLease(input(fixture), options), acquireRunWriterLease(input(fixture, "retention"), options),
      ]);
      const won = outcomes.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRunWriterLease>>> => item.status === "fulfilled");
      const lost = outcomes.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost[0]?.reason).toMatchObject({ code: "WRITER_ARBITER_ALREADY_OWNED" });
      await won[0]!.value.release();
    } finally { await fixture.cleanup(); }
  });

  test("synchronized hard-link election yields exactly one winner and ELECTION_LOST", async () => {
    const fixture = await arbiterFixture();
    const children = [spawnChild(electionChildScript(fixture)), spawnChild(electionChildScript(fixture))];
    try {
      expect(await Promise.all(children.map((child) => readLine(child.stdout)))).toEqual(["READY", "READY"]);
      for (const child of children) child.stdin.write("GO\n");
      const outcomes = await Promise.all(children.map((child) => readLine(child.stdout)));
      expect(outcomes.filter((line) => line.startsWith("OWN "))).toHaveLength(1);
      expect(outcomes.filter((line) => line === "ERR WRITER_ARBITER_ELECTION_LOST")).toHaveLength(1);
      const winner = children[outcomes.findIndex((line) => line.startsWith("OWN "))]!;
      winner.stdin.write("STOP\n");
      for (const child of children) child.stdin.end();
      await Promise.all(children.map((child) => child.exited));
      expect((await scanArbitrationDirectory(fixture.arbitrationPath)).generations).toHaveLength(2);
    } finally { for (const child of children) child.kill(); await fixture.cleanup(); }
  }, 15_000);

  test("rejects a live child, then permits takeover only after definite death", async () => {
    const fixture = await arbiterFixture();
    const child = spawnChild(liveChildScript(fixture));
    try {
      expect(await readLine(child.stdout)).toMatch(/^OWN /);
      await expect(acquireRunWriterLease(input(fixture))).rejects.toMatchObject({ code: "WRITER_ARBITER_BUSY", liveness: "live_or_reused" });
      child.kill("SIGKILL");
      await child.exited;
      const successor = await acquireRunWriterLease(input(fixture, "retention"));
      expect(successor.generation.ordinal).toBe(3);
      await successor.release();
    } finally { child.kill(); await fixture.cleanup(); }
  });

  test("fails closed for live, permission, unsupported, and unknown same-PID owners", async () => {
    for (const status of ["live_or_reused", "permission_denied", "unsupported"] as const) {
      const fixture = await arbiterFixture({ released: false });
      try {
        await expect(acquireRunWriterLease(input(fixture), { now: () => Number.MAX_SAFE_INTEGER, livenessProbe: () => status }))
          .rejects.toMatchObject({ code: status === "live_or_reused" ? "WRITER_ARBITER_BUSY" : "WRITER_ARBITER_AMBIGUOUS", liveness: status });
      } finally { await fixture.cleanup(); }
    }
    const fixture = await arbiterFixture({ released: false, predecessor: { pid: process.pid, processNonce: tokenAt(999) } });
    try {
      let probes = 0;
      await expect(acquireRunWriterLease(input(fixture), { livenessProbe: () => { probes++; return "absent"; } }))
        .rejects.toMatchObject({ code: "WRITER_ARBITER_AMBIGUOUS", liveness: "unsupported" });
      expect(probes).toBe(0);
    } finally { await fixture.cleanup(); }
  });

  test("definite absence and an explicit durable release each permit takeover", async () => {
    const absent = await arbiterFixture({ released: false });
    try {
      const lease = await acquireRunWriterLease(input(absent, "retention"), { createToken: tokens(), livenessProbe: () => "absent" });
      expect(lease.generation.ordinal).toBe(2);
      await lease.release();
    } finally { await absent.cleanup(); }

    const released = await arbiterFixture();
    try {
      expect(released.predecessorRelease?.generation).toBe(released.predecessor?.token);
      const lease = await acquireRunWriterLease(input(released), { createToken: tokens() });
      expect(lease.generation.ordinal).toBe(2);
      await lease.release();
    } finally { await released.cleanup(); }
  });

  test("reserves the retirement ordinal", async () => {
    const fixture = await arbiterFixture({ arbitration: "empty" });
    try {
      const root = await lstat(fixture.root, { bigint: true });
      const run = await lstat(fixture.runPath, { bigint: true });
      const identity = { rootDev: root.dev, rootIno: root.ino, runDev: run.dev, runIno: run.ino };
      const generations = Array.from({ length: MAX_ARBITRATION_ORDINAL - 1 }, (_, index): GenerationRecord => ({
        schemaVersion: 1, type: "generation", token: tokenAt(index + 1), predecessor: index === 0 ? null : tokenAt(index),
        ordinal: index + 1, role: "writer", ...identity, runName: fixture.runName, pid: 123,
        processNonce: tokenAt(800), osProcessIdentity: null, createdAtMs: index,
      }));
      const tip = generations.at(-1)!;
      const released = releaseFor(tip, tokenAt(850));
      const chain: ArbitrationChain = { generations, releases: new Map([[tip.token, released]]), orphans: [], tip };
      await expect(acquireRunWriterLease(input(fixture), { scan: async () => chain }))
        .rejects.toMatchObject({ code: "WRITER_ARBITER_ORDINAL_EXHAUSTED" });
      await expect(acquireRunWriterLease({ ...input(fixture), role: "retirement" as RunWriterAcquisitionRole }))
        .rejects.toMatchObject({ code: "WRITER_ARBITER_INPUT" });
    } finally { await fixture.cleanup(); }
  });
});
