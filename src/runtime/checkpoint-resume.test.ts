import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeComponentIdentity } from "../core/identity.ts";
import type { RlmEvent } from "../core/journal.ts";
import type { ControllerDriver } from "./controller.ts";
import { deriveOperationIntentId } from "../core/operation.ts";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import { normalizeProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import {
  JournalStore,
  nodeJournalFileSystem,
  type JournalFileSystem,
} from "../shell/journal-store.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { OperationAbortedError } from "./abort.ts";
import {
  NestedResumeFixtureController,
  ResumeFixtureController,
} from "./checkpoint-resume-fixture.ts";
import { runCheckpointPayloadPath } from "./checkpoint-store.ts";
import { managedRunPersistence } from "./run-managed-lifecycle.ts";
import {
  nodeRunDirectoryFileSystem,
  RUN_LOCK_FILE,
  RUN_MANIFEST_FILE,
  type RunDirectoryFileSystem,
} from "./run-manifest.ts";
import { ManagedRunStore } from "./run-retention.ts";
import { managedRunStoreTestOptions } from "./run-retention-test-support.ts";
import { RunRecoveryError, type RunRecoveryErrorCode } from "./run-recovery-types.ts";
import { inspectManagedResumeCandidate } from "./run-inspection.ts";
import { inspectResumableManagedRun, resumeProgram } from "./run-resume.ts";
import { runProgram } from "./run.ts";

const modelIdentity: RuntimeComponentIdentity = {
  id: "pi-rlm/test-resume-model",
  version: "1",
  configuration: { fixture: "checkpoint-resume-v1" },
};

const program = (() => {
  const normalized = normalizeProgram({
    objective: "resume exactly once",
    profile: "default",
    inputs: [{ name: "context", adapter: "text", description: "source" }],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid resume fixture program");
  return normalized.value;
})();

const waitForFile = async (path: string, child: ReturnType<typeof Bun.spawn>): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (!existsSync(path)) {
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(20).then(() => false)])) {
      const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
      throw new Error(`checkpoint producer exited before readiness: ${stderr}`);
    }
    if (Date.now() >= deadline) throw new Error("checkpoint producer readiness timed out");
  }
};

const crashAtCheckpoint = async (
  root: string,
  controllerExport = "ResumeFixtureController",
): Promise<string> => {
  const ready = join(tmpdir(), `pi-rlm-resume-ready-${crypto.randomUUID()}.json`);
  const retentionUrl = new URL("./run-retention.ts", import.meta.url).href;
  const runUrl = new URL("./run.ts", import.meta.url).href;
  const fixtureUrl = new URL("./checkpoint-resume-fixture.ts", import.meta.url).href;
  const quickJsUrl = new URL("../shell/interpreter/quickjs.ts", import.meta.url).href;
  const mockUrl = new URL("../shell/model/mock.ts", import.meta.url).href;
  const programUrl = new URL("../core/program.ts", import.meta.url).href;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const { writeFileSync } = await import("node:fs");
      const { ManagedRunStore } = await import(${JSON.stringify(retentionUrl)});
      const { runProgram } = await import(${JSON.stringify(runUrl)});
      const fixture = await import(${JSON.stringify(fixtureUrl)});
      const Controller = fixture[${JSON.stringify(controllerExport)}];
      if (typeof Controller !== "function") throw new Error("invalid checkpoint fixture controller");
      const { QuickJsBackend } = await import(${JSON.stringify(quickJsUrl)});
      const { MockModelClient } = await import(${JSON.stringify(mockUrl)});
      const { normalizeProgram } = await import(${JSON.stringify(programUrl)});
      const normalized = normalizeProgram(${JSON.stringify(program)});
      if (!normalized.ok) throw new Error("invalid child program");
      const store = new ManagedRunStore({ root: ${JSON.stringify(root)} });
      const lease = await store.create();
      const backend = await QuickJsBackend.create();
      const controller = new Controller(() => {
        writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ name: lease.name }), { mode: 0o600 });
        return new Promise(() => {});
      });
      await runProgram({
        program: normalized.value,
        sources: { context: "durable source" },
        controller,
        model: new MockModelClient(() => "spent-once", ${JSON.stringify(modelIdentity)}),
        backend,
        dir: lease.dir,
        signal: new AbortController().signal,
        runLifecycle: lease.lifecycle,
      });
    `],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForFile(ready, child);
    const { name } = JSON.parse(await readFile(ready, "utf8")) as { name: string };
    child.kill(9);
    await child.exited;
    return name;
  } finally {
    if (child.exitCode === null) { child.kill(9); await child.exited; }
    await rm(ready, { force: true });
  }
};

const resumeWith = (
  lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>>,
  backend: QuickJsBackend,
  model = new MockModelClient(() => "must-not-run", modelIdentity),
  controller: ControllerDriver = new ResumeFixtureController(),
) => resumeProgram({
  controller,
  model,
  backend,
  dir: lease.dir,
  signal: new AbortController().signal,
  runLifecycle: lease.lifecycle,
});

const expectRecoveryCode = async (work: Promise<unknown>, code: RunRecoveryErrorCode): Promise<void> => {
  try { await work; throw new Error("expected recovery rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(RunRecoveryError);
    expect((error as RunRecoveryError).code).toBe(code);
  }
};

const writeJournalEvents = async (dir: string, events: readonly RlmEvent[]): Promise<void> => {
  await writeFile(
    join(dir, "events.jsonl"),
    events.map((event) => `${canonicalStringify(event as unknown as JsonValue)}\n`).join(""),
    { mode: 0o600 },
  );
};

const rewriteCheckpointPayload = async (
  dir: string,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<void> => {
  const raw = await readFile(join(dir, "events.jsonl"), "utf8");
  const priorNewline = raw.lastIndexOf("\n", raw.length - 2);
  const prefix = raw.slice(0, priorNewline + 1);
  const event = JSON.parse(raw.slice(priorNewline + 1).trim()) as Record<string, unknown>;
  if (event["type"] !== "checkpoint_committed") throw new Error("fixture journal does not end in a checkpoint");
  const sequence = event["checkpointSequence"] as number;
  const path = runCheckpointPayloadPath(dir, sequence);
  const payload = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(payload);
  const payloadText = canonicalStringify(payload as unknown as JsonValue);
  const nextDigest = sha256(payloadText);
  await writeFile(path, payloadText, { mode: 0o600 });
  event["checkpointRef"] = `ctx_${nextDigest}`;
  event["checkpointSha256"] = nextDigest;
  event["checkpointBytes"] = Buffer.byteLength(payloadText, "utf8");
  const { type: _type, checkpointId: _checkpointId, ...identity } = event;
  event["checkpointId"] = `cp_${sha256(canonicalStringify(identity as unknown as JsonValue))}`;
  await writeFile(join(dir, "events.jsonl"), `${prefix}${canonicalStringify(event as unknown as JsonValue)}\n`, { mode: 0o600 });
};

describe("managed checkpoint continuation", () => {
  test("rejects both missing recurse executions and missing completed child frames before hydration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-nested-corrupt-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root, "NestedResumeFixtureController");
      lease = await new ManagedRunStore({ root }).openForResume(name);
      const read = await new JournalStore(lease.dir).readEvents();
      if (!read.ok) throw read.error;
      const original = [...read.value];
      const child = original.find((event) => event.type === "frame_opened" && event.parentFrameId !== null);
      if (!child || child.type !== "frame_opened") throw new Error("missing completed child fixture");

      await writeJournalEvents(lease.dir, original.filter((event) =>
        event.type !== "call_committed" || event.kind !== "recurse"));
      await expectRecoveryCode(
        resumeWith(lease, backend, undefined, new NestedResumeFixtureController()),
        "RECOVERY_SEMANTIC_CORRUPTION",
      );

      const childCells = original.filter((event) => event.type === "cell_committed" && event.frameId === child.frameId).length;
      await writeJournalEvents(lease.dir, original
        .filter((event) => !("frameId" in event) || event.frameId !== child.frameId)
        .map((event) => event.type === "checkpoint_committed"
          ? { ...event, nextControllerTurn: event.nextControllerTurn - childCells }
          : event));
      await expectRecoveryCode(
        resumeWith(lease, backend, undefined, new NestedResumeFixtureController()),
        "RECOVERY_SEMANTIC_CORRUPTION",
      );
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("hydrates a completed nested frame and reuses its recurse result on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-nested-positive-"));
    const backend = await QuickJsBackend.create();
    try {
      const name = await crashAtCheckpoint(root, "NestedResumeFixtureController");
      const lease = await new ManagedRunStore({ root }).openForResume(name);
      const model = new MockModelClient(() => "must-not-run", modelIdentity);
      const result = await resumeWith(lease, backend, model, new NestedResumeFixtureController());
      await lease.finish(result.status, result.runId);
      expect(result).toMatchObject({
        status: "completed",
        answer: { answer: "nested:nested:true" },
        ledger: { usage: { framesOpened: 1, controllerTurns: 3, activeLeafCalls: 0 } },
      });
      expect(model.callCount).toBe(0);
      const read = await new JournalStore(lease.dir).readEvents();
      if (!read.ok) throw read.error;
      expect(read.value.filter((event) => event.type === "frame_opened" && event.parentFrameId !== null)).toHaveLength(1);
      expect(read.value.filter((event) => event.type === "call_committed" && event.kind === "recurse")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("preserves cancellation during bounded journal reads and prefix hashing", async () => {
    const target = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-journal-cancel-"));
    try {
      const event: RlmEvent = { type: "frame_opened", frameId: "f0", parentFrameId: null, depth: 0, objective: "x" };
      const line = `${canonicalStringify(event as unknown as JsonValue)}\n`;
      const raw = line.repeat(2_000);
      expect(Buffer.byteLength(raw)).toBeGreaterThan(64 * 1024);
      await writeFile(join(target, "events.jsonl"), raw, { mode: 0o600 });

      const readCancellation = new OperationAbortedError(new Error("cancelled during journal read"));
      const midRead: JournalFileSystem = {
        ...nodeJournalFileSystem,
        async open(path, flags, mode) {
          const handle = await nodeJournalFileSystem.open(path, flags, mode);
          let reads = 0;
          return {
            appendFile: (data, encoding) => handle.appendFile(data, encoding),
            close: () => handle.close(),
            read: (buffer, offset, length, position) => {
              if (++reads === 2) return Promise.reject(readCancellation);
              return handle.read(buffer, offset, length, position);
            },
            readFile: () => handle.readFile(),
            stat: () => handle.stat(),
            sync: () => handle.sync(),
            truncate: (length) => handle.truncate(length),
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
          };
        },
      };
      await expect(new JournalStore(target, midRead).inspectTail()).rejects.toBe(readCancellation);

      let checkpoints = 0;
      await new JournalStore(target).inspectTail({ checkpoint: () => { checkpoints++; } });
      const hashCancellation = new OperationAbortedError(new Error("cancelled during journal hash"));
      let remaining = checkpoints - 1;
      await expect(new JournalStore(target).inspectTail({
        checkpoint: () => { if (--remaining === 0) throw hashCancellation; },
      })).rejects.toBe(hashCancellation);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("preserves abort, deadline, and writer failures from manifest and lock authority reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-authority-control-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root);
      let fault: { readonly leaf: string; readonly error: unknown } | undefined;
      const authorityFileSystem: RunDirectoryFileSystem = {
        ...nodeRunDirectoryFileSystem,
        async open(path, flags, mode) {
          const handle = await nodeRunDirectoryFileSystem.open(path, flags, mode);
          if (!handle.read || !handle.stat) return handle;
          return {
            close: () => handle.close(),
            read: async (buffer, offset, length, position) => {
              if (fault && path.endsWith(`/${fault.leaf}`)) {
                const error = fault.error;
                fault = undefined;
                throw error;
              }
              return handle.read!(buffer, offset, length, position);
            },
            stat: () => handle.stat!(),
            sync: () => handle.sync(),
            writeFile: (data, encoding) => handle.writeFile(data, encoding),
          };
        },
      };
      const store = new ManagedRunStore(managedRunStoreTestOptions({ root, runDirectoryFileSystem: authorityFileSystem }));
      lease = await store.openForResume(name);
      const abort = new OperationAbortedError(new Error("cancelled during manifest read"));
      fault = { leaf: RUN_MANIFEST_FILE, error: abort };
      await expect(resumeWith(lease, backend)).rejects.toBe(abort);

      const deadline = Object.assign(new Error("deadline during lock read"), { code: "BUDGET_DEADLINE" });
      fault = { leaf: RUN_LOCK_FILE, error: deadline };
      await expect(resumeWith(lease, backend)).rejects.toBe(deadline);

      const writer = Object.assign(new Error("writer fenced during lock read"), { code: "WRITER_ARBITER_FENCED" });
      fault = { leaf: RUN_LOCK_FILE, error: writer };
      await expect(resumeWith(lease, backend)).rejects.toBe(writer);
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("fresh process resumes the next root iteration without replay or double spend", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-resume-"));
    const backend = await QuickJsBackend.create();
    try {
      const name = await crashAtCheckpoint(root);
      const store = new ManagedRunStore({ root });
      const beforeLease = await inspectManagedResumeCandidate(name, { root });
      expect(beforeLease).toMatchObject({
        managedName: name,
        checkpointSequence: 1,
        nextIteration: 2,
        nextControllerTurn: 2,
        incompleteTailBytes: 0,
      });
      expect(Object.keys(beforeLease)).not.toContain("path");
      const lease = await store.openForResume(name);
      const writerIdentity = lease.resumeWriterIdentity();
      expect(writerIdentity).toMatchObject({ managedName: name, runId: beforeLease.runId, writerOrdinal: 2 });
      expect(writerIdentity.writerTokenSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(writerIdentity)).not.toContain("token\"");
      await appendFile(join(lease.dir, "events.jsonl"), '{"type":');
      const model = new MockModelClient(() => "must-not-run", modelIdentity);
      const result = await resumeWith(lease, backend, model);
      await lease.finish(result.status, result.runId);

      expect(result).toMatchObject({
        status: "completed",
        completionMode: "answer",
        answer: { answer: "1:spent-once:true:true" },
        ledger: { usage: { controllerTurns: 2, logicalCalls: 1, attempts: 1, activeLeafCalls: 0, tokensReserved: 0 } },
      });
      expect(model.callCount).toBe(0);
      const read = await new JournalStore(lease.dir).readEvents();
      if (!read.ok) throw read.error;
      expect(read.value.filter((event) => event.type === "run_started")).toHaveLength(1);
      expect(read.value.filter((event) => event.type === "frame_opened" && event.parentFrameId === null)).toHaveLength(1);
      expect(read.value.filter((event) => event.type === "cell_committed")).toHaveLength(2);
      expect(read.value.filter((event) => event.type === "operation_intended" && event.kind === "llm")).toHaveLength(1);
      expect(read.value.filter((event) => event.type === "call_committed" && event.kind === "llm")).toHaveLength(1);
      expect(read.value.filter((event) => event.type === "run_completed")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("enforces consumed manifest and checkpoint identity inside recovery before hydration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-consumed-identity-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    let contextOperations = 0;
    try {
      const name = await crashAtCheckpoint(root);
      const inspected = await inspectManagedResumeCandidate(name, { root });
      const store = new ManagedRunStore(managedRunStoreTestOptions({
        root,
        contextStoreInstrumentation: {
          async runFileSystemOperation(_path, effect) { contextOperations++; return effect(); },
        },
      }));
      lease = await store.openForResume(name);
      const writer = lease.resumeWriterIdentity();
      const expectedIdentity = {
        managedName: inspected.managedName,
        runId: inspected.runId,
        manifestHash: inspected.manifestHash,
        checkpointSequence: inspected.checkpointSequence,
        checkpointSha256: inspected.checkpointSha256,
        checkpointPrefixSha256: inspected.checkpointPrefixSha256,
        writerOrdinal: writer.writerOrdinal,
        writerTokenSha256: writer.writerTokenSha256,
      };
      await expectRecoveryCode(resumeProgram({
        controller: new ResumeFixtureController(),
        model: new MockModelClient(() => "must-not-run", modelIdentity),
        backend,
        dir: lease.dir,
        signal: new AbortController().signal,
        runLifecycle: lease.lifecycle,
        expectedIdentity: { ...expectedIdentity, writerOrdinal: expectedIdentity.writerOrdinal + 1 },
      }), "RECOVERY_IDENTITY_MISMATCH");
      expect(contextOperations).toBe(0);

      const manifestPath = join(lease.dir, RUN_MANIFEST_FILE);
      const originalManifest = await readFile(manifestPath);
      const document = JSON.parse(originalManifest.toString("utf8")) as {
        manifest: Record<string, unknown>;
        manifestHash: string;
      };
      const launchAuthorization = document.manifest["launchAuthorization"] as Record<string, unknown>;
      launchAuthorization["mode"] = launchAuthorization["mode"] === "direct" ? "confirmed" : "direct";
      document.manifestHash = sha256(canonicalStringify(document.manifest as unknown as JsonValue));
      await writeFile(manifestPath, `${canonicalStringify(document as unknown as JsonValue)}\n`, { mode: 0o600 });

      const attempt = () => resumeProgram({
        controller: new ResumeFixtureController(),
        model: new MockModelClient(() => "must-not-run", modelIdentity),
        backend,
        dir: lease!.dir,
        signal: new AbortController().signal,
        runLifecycle: lease!.lifecycle,
        expectedIdentity,
      });
      await expectRecoveryCode(attempt(), "RECOVERY_IDENTITY_MISMATCH");
      expect(contextOperations).toBe(0);

      await writeFile(manifestPath, originalManifest, { mode: 0o600 });
      await rewriteCheckpointPayload(lease.dir, (payload) => {
        const run = payload["run"] as Record<string, unknown>;
        run["nextControllerTurn"] = (run["nextControllerTurn"] as number) + 1;
      });
      await expectRecoveryCode(attempt(), "RECOVERY_IDENTITY_MISMATCH");
      expect(contextOperations).toBe(0);
    } finally {
      await lease?.abandon().catch(() => undefined);
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("rejects component drift before controller, model, or backend execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-components-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root);
      lease = await new ManagedRunStore({ root }).openForResume(name);
      const model = new MockModelClient(() => "must-not-run", {
        ...modelIdentity,
        configuration: { fixture: "drifted" },
      });
      await expectRecoveryCode(resumeWith(lease, backend, model), "RECOVERY_COMPONENT_MISMATCH");
      expect(model.callCount).toBe(0);
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("rejects corrupt checkpoint bytes and unsupported hydrated activity before execution", async () => {
    const backend = await QuickJsBackend.create();
    for (const kind of ["corrupt", "active-state"] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-rlm-checkpoint-${kind}-`));
      let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
      try {
        const name = await crashAtCheckpoint(root);
        lease = await new ManagedRunStore({ root }).openForResume(name);
        if (kind === "corrupt") {
          const raw = await readFile(join(lease.dir, "events.jsonl"), "utf8");
          const event = JSON.parse(raw.trim().split("\n").at(-1)!) as { checkpointSequence: number };
          const path = runCheckpointPayloadPath(lease.dir, event.checkpointSequence);
          const bytes = await readFile(path);
          bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
          await writeFile(path, bytes);
          await expectRecoveryCode(resumeWith(lease, backend), "RECOVERY_CHECKPOINT_INVALID");
        } else {
          const eventsPath = join(lease.dir, "events.jsonl");
          const originalEvents = await readFile(eventsPath, "utf8");
          const unsupportedMutations: Array<(payload: Record<string, unknown>) => void> = [
            (payload) => { ((payload["ledger"] as { usage: { activeLeafCalls: number } }).usage).activeLeafCalls = 1; },
            (payload) => { ((payload["ledger"] as { usage: { tokensReserved: number } }).usage).tokensReserved = 1; },
            (payload) => { payload["scopeUsage"] = [{ scope: "active-scope", usage: { attempts: 0, durationMs: 0 } }]; },
            (payload) => {
              const frames = payload["frames"] as Array<Record<string, unknown>>;
              const rootFrame = frames[0]!;
              frames.push({
                frameId: `${rootFrame["frameId"]}:nested`,
                lineage: `${rootFrame["frameId"]}:nested`,
                parentFrameId: rootFrame["frameId"],
                depth: 1,
                objective: "unsupported nested frame",
                state: "open",
                nextIteration: 1,
              });
            },
          ];
          for (const mutate of unsupportedMutations) {
            await rewriteCheckpointPayload(lease.dir, mutate);
            await expectRecoveryCode(resumeWith(lease, backend), "RECOVERY_UNSUPPORTED_STATE");
            await writeFile(eventsPath, originalEvents, { mode: 0o600 });
          }
        }
        await lease.abandon();
        lease = undefined;
      } finally {
        await lease?.abandon().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 180_000);

  test("binds every hydrated state catalog exactly to checkpoint content and journal authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-exact-state-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root);
      lease = await new ManagedRunStore({ root }).openForResume(name);
      const eventsPath = join(lease.dir, "events.jsonl");
      const originalEvents = await readFile(eventsPath, "utf8");
      const originalCheckpointEvent = JSON.parse(originalEvents.trim().split("\n").at(-1)!) as { checkpointSequence: number };
      const checkpointPath = runCheckpointPayloadPath(lease.dir, originalCheckpointEvent.checkpointSequence);
      const originalPayload = await readFile(checkpointPath);
      await rewriteCheckpointPayload(lease.dir, (payload) => {
        (payload["controller"] as Record<string, unknown>)["state"] = { index: 99, nextIteration: 2 };
      });
      await expectRecoveryCode(inspectResumableManagedRun({
        controller: new ResumeFixtureController(),
        model: new MockModelClient(() => "must-not-run", modelIdentity),
        backend, dir: lease.dir, signal: new AbortController().signal, runLifecycle: lease.lifecycle,
      }), "RECOVERY_CONTROLLER_STATE_INVALID");
      await writeFile(checkpointPath, originalPayload, { mode: 0o600 });
      await writeFile(eventsPath, originalEvents, { mode: 0o600 });
      const mutations: Array<(payload: Record<string, unknown>) => void> = [
        (payload) => { ((payload["root"] as Record<string, unknown>)["workspace"] as Record<string, unknown>)["count"] = 9; },
        (payload) => { (((payload["root"] as Record<string, unknown>)["trajectory"] as Array<Record<string, unknown>>)[0]!)["code"] = "tampered"; },
        (payload) => { const usage = (payload["ledger"] as Record<string, unknown>)["usage"] as Record<string, number>; usage["storedBytes"] = (usage["storedBytes"] ?? 0) + 1; },
        (payload) => { (((payload["keyBindings"] as Array<Record<string, unknown>>)[0]!)["identityHash"]) = "0".repeat(64); },
        (payload) => { (((payload["callCache"] as Array<Record<string, unknown>>)[0]!["result"] as Record<string, unknown>)["value"]) = "tampered"; },
        (payload) => { const ordinals = payload["ordinals"] as Record<string, number>; ordinals["frameSequence"] = (ordinals["frameSequence"] ?? 0) + 1; },
        (payload) => {
          const attempts = (payload["ordinals"] as Record<string, unknown>)["operationAttempts"] as Array<Record<string, number>>;
          attempts[0]!["value"] = (attempts[0]!["value"] ?? 0) + 1;
        },
        (payload) => { (((payload["artifacts"] as Array<Record<string, unknown>>)[0]!["text"])) = "tampered artifact"; },
      ];
      const model = new MockModelClient(() => "must-not-run", modelIdentity);
      for (const mutate of mutations) {
        await rewriteCheckpointPayload(lease.dir, mutate);
        await expectRecoveryCode(resumeWith(lease, backend, model), "RECOVERY_CHECKPOINT_INVALID");
        await writeFile(eventsPath, originalEvents, { mode: 0o600 });
      }
      const lines = originalEvents.trim().split("\n");
      const checkpoint = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      checkpoint["journalPrefixSha256"] = "0".repeat(64);
      const { type: _type, checkpointId: _checkpointId, ...identity } = checkpoint;
      checkpoint["checkpointId"] = `cp_${sha256(canonicalStringify(identity as unknown as JsonValue))}`;
      lines[lines.length - 1] = canonicalStringify(checkpoint as unknown as JsonValue);
      await writeFile(eventsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
      await expectRecoveryCode(resumeWith(lease, backend, model), "RECOVERY_CHECKPOINT_INVALID");
      expect(model.callCount).toBe(0);
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("rejects authoritative unsafe tails and unsettled operation intents", async () => {
    const backend = await QuickJsBackend.create();
    for (const kind of ["unsafe", "ambiguous"] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-rlm-checkpoint-${kind}-`));
      let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
      try {
        const name = await crashAtCheckpoint(root);
        lease = await new ManagedRunStore({ root }).openForResume(name);
        const persistence = managedRunPersistence(lease.lifecycle);
        const journal = new JournalStore(lease.dir, persistence.journalFileSystem());
        const read = await journal.readEvents();
        if (!read.ok) throw read.error;
        const checkpoint = read.value.at(-1);
        if (!checkpoint || checkpoint.type !== "checkpoint_committed") throw new Error("missing fixture checkpoint");
        if (kind === "unsafe") {
          await journal.append({
            type: "phase",
            frameId: checkpoint.frameId,
            iteration: checkpoint.nextIteration,
            ordinal: 0,
            name: "unsafe-tail",
          });
          await expectRecoveryCode(resumeWith(lease, backend), "RECOVERY_UNSAFE_TAIL");
        } else {
          const prior = read.value.find((event) => event.type === "operation_intended" && event.kind === "llm");
          if (!prior || prior.type !== "operation_intended") throw new Error("missing fixture operation intent");
          const identity = {
            schemaVersion: prior.schemaVersion,
            runId: prior.runId,
            frameId: prior.frameId,
            operationId: prior.operationId,
            kind: prior.kind,
            key: prior.key,
            attempt: prior.attempt + 1,
            requestIdentityVersion: prior.requestIdentityVersion,
            requestSha256: prior.requestSha256,
            reservation: { ...prior.reservation, logicalCalls: 1 },
          } as const;
          await journal.append({ type: "operation_intended", ...identity, intentId: deriveOperationIntentId(sha256, identity) });
          await expectRecoveryCode(resumeWith(lease, backend), "RECOVERY_AMBIGUOUS");
        }
        await lease.abandon();
        lease = undefined;
      } finally {
        await lease?.abandon().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 180_000);

  test("classifies pre-v4 manifests as incompatible before checkpoint or model effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-pre-v4-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root);
      lease = await new ManagedRunStore({ root }).openForResume(name);
      const path = join(lease.dir, "manifest.json");
      const document = JSON.parse(await readFile(path, "utf8")) as { manifest: Record<string, unknown>; manifestHash: string };
      document.manifest["schemaVersion"] = 3;
      document.manifestHash = sha256(canonicalStringify(document.manifest as unknown as JsonValue));
      await writeFile(path, `${canonicalStringify(document as unknown as JsonValue)}\n`);
      const model = new MockModelClient(() => "must-not-run", modelIdentity);
      await expectRecoveryCode(resumeWith(lease, backend, model), "RECOVERY_INCOMPATIBLE");
      expect(model.callCount).toBe(0);
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("rejects an unsupported private-cursor controller before controller or provider effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-unsupported-controller-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root);
      lease = await new ManagedRunStore({ root }).openForResume(name);
      let controllerCalls = 0;
      const unsupported: ControllerDriver = {
        identity: new ResumeFixtureController().identity,
        async next() { controllerCalls++; return { reasoning: "must not run", code: "1" }; },
        fork() { return this; },
      };
      const model = new MockModelClient(() => "must-not-run", modelIdentity);
      await expectRecoveryCode(resumeProgram({
        controller: unsupported, model, backend, dir: lease.dir,
        signal: new AbortController().signal, runLifecycle: lease.lifecycle,
      }), "RECOVERY_CONTROLLER_UNSUPPORTED");
      expect(controllerCalls).toBe(0);
      expect(model.callCount).toBe(0);
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("inspects resumability without repairing a proven torn suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-inspect-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root);
      lease = await new ManagedRunStore({ root }).openForResume(name);
      const path = join(lease.dir, "events.jsonl");
      await appendFile(path, '{"type":');
      const before = await readFile(path);
      const inspected = await inspectResumableManagedRun({
        controller: new ResumeFixtureController(),
        model: new MockModelClient(() => "must-not-run", modelIdentity),
        backend, dir: lease.dir, signal: new AbortController().signal, runLifecycle: lease.lifecycle,
      });
      expect(inspected.incompleteTailBytes).toBe(Buffer.byteLength('{"type":'));
      expect(await readFile(path)).toEqual(before);
      await expect(resumeProgram({
        controller: new ResumeFixtureController(),
        model: new MockModelClient(() => "must-not-run", modelIdentity),
        backend, dir: lease.dir, signal: new AbortController().signal,
        clock: { now: () => Number.MAX_SAFE_INTEGER },
        runLifecycle: lease.lifecycle,
      })).rejects.toBeInstanceOf(OperationAbortedError);
      expect(await readFile(path)).toEqual(before);
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("terminal managed runs are immutable at exact-name reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-terminal-"));
    const backend = await QuickJsBackend.create();
    try {
      const store = new ManagedRunStore({ root });
      const lease = await store.create();
      const result = await runProgram({
        program,
        sources: { context: "durable source" },
        controller: new ResumeFixtureController(),
        model: new MockModelClient(() => "spent-once", modelIdentity),
        backend,
        dir: lease.dir,
        signal: new AbortController().signal,
        runLifecycle: lease.lifecycle,
      });
      await lease.finish(result.status, result.runId);
      expect(result.status).toBe("completed");
      await expectRecoveryCode(inspectManagedResumeCandidate(lease.name, { root }), "RECOVERY_TERMINAL");
      await expect(store.openForResume(lease.name)).rejects.toMatchObject({ code: "RUN_RETENTION_RESUME_FAILED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
