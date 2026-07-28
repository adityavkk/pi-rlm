import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeComponentIdentity } from "../core/identity.ts";
import { deriveOperationIntentId } from "../core/operation.ts";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import { normalizeProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import { JournalStore } from "../shell/journal-store.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { ResumeFixtureController } from "./checkpoint-resume-fixture.ts";
import { managedRunPersistence } from "./run-managed-lifecycle.ts";
import { ManagedRunStore } from "./run-retention.ts";
import { RunRecoveryError, type RunRecoveryErrorCode } from "./run-recovery-types.ts";
import { resumeProgram } from "./run-resume.ts";
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
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(20).then(() => false)])) {
      const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
      throw new Error(`checkpoint producer exited before readiness: ${stderr}`);
    }
    if (Date.now() >= deadline) throw new Error("checkpoint producer readiness timed out");
  }
};

const crashAtCheckpoint = async (root: string): Promise<string> => {
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
      const { ResumeFixtureController } = await import(${JSON.stringify(fixtureUrl)});
      const { QuickJsBackend } = await import(${JSON.stringify(quickJsUrl)});
      const { MockModelClient } = await import(${JSON.stringify(mockUrl)});
      const { normalizeProgram } = await import(${JSON.stringify(programUrl)});
      const normalized = normalizeProgram(${JSON.stringify(program)});
      if (!normalized.ok) throw new Error("invalid child program");
      const store = new ManagedRunStore({ root: ${JSON.stringify(root)} });
      const lease = await store.create();
      const backend = await QuickJsBackend.create();
      const controller = new ResumeFixtureController(() => {
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
) => resumeProgram({
  controller: new ResumeFixtureController(),
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

const rewriteCheckpointPayload = async (
  dir: string,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<void> => {
  const raw = await readFile(join(dir, "events.jsonl"), "utf8");
  const priorNewline = raw.lastIndexOf("\n", raw.length - 2);
  const prefix = raw.slice(0, priorNewline + 1);
  const event = JSON.parse(raw.slice(priorNewline + 1).trim()) as Record<string, unknown>;
  if (event["type"] !== "checkpoint_committed") throw new Error("fixture journal does not end in a checkpoint");
  const digest = event["checkpointSha256"] as string;
  const payload = JSON.parse(await readFile(join(dir, "contexts", `${digest}.bin`), "utf8")) as Record<string, unknown>;
  mutate(payload);
  const payloadText = canonicalStringify(payload as unknown as JsonValue);
  const nextDigest = sha256(payloadText);
  await mkdir(join(dir, "contexts"), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "contexts", `${nextDigest}.bin`), payloadText, { flag: "wx", mode: 0o600 });
  event["checkpointRef"] = `ctx_${nextDigest}`;
  event["checkpointSha256"] = nextDigest;
  event["checkpointBytes"] = Buffer.byteLength(payloadText, "utf8");
  const { type: _type, checkpointId: _checkpointId, ...identity } = event;
  event["checkpointId"] = `cp_${sha256(canonicalStringify(identity as unknown as JsonValue))}`;
  await writeFile(join(dir, "events.jsonl"), `${prefix}${canonicalStringify(event as unknown as JsonValue)}\n`, { mode: 0o600 });
};

describe("managed checkpoint continuation", () => {
  test("fresh process resumes the next root iteration without replay or double spend", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-resume-"));
    const backend = await QuickJsBackend.create();
    try {
      const name = await crashAtCheckpoint(root);
      const store = new ManagedRunStore({ root });
      const lease = await store.openForResume(name);
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
  }, 30_000);

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
  }, 30_000);

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
          const event = JSON.parse(raw.trim().split("\n").at(-1)!) as { checkpointSha256: string };
          const path = join(lease.dir, "contexts", `${event.checkpointSha256}.bin`);
          const bytes = await readFile(path);
          bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
          await writeFile(path, bytes);
          await expectRecoveryCode(resumeWith(lease, backend), "RECOVERY_CHECKPOINT_INVALID");
        } else {
          await rewriteCheckpointPayload(lease.dir, (payload) => {
            const ledger = payload["ledger"] as { usage: { activeLeafCalls: number } };
            ledger.usage.activeLeafCalls = 1;
          });
          await expectRecoveryCode(resumeWith(lease, backend), "RECOVERY_UNSUPPORTED_STATE");
        }
        await lease.abandon();
        lease = undefined;
      } finally {
        await lease?.abandon().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test("binds every hydrated state catalog exactly to checkpoint content and journal authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-checkpoint-exact-state-"));
    const backend = await QuickJsBackend.create();
    let lease: Awaited<ReturnType<ManagedRunStore["openForResume"]>> | undefined;
    try {
      const name = await crashAtCheckpoint(root);
      lease = await new ManagedRunStore({ root }).openForResume(name);
      const eventsPath = join(lease.dir, "events.jsonl");
      const originalEvents = await readFile(eventsPath, "utf8");
      const mutations: Array<(payload: Record<string, unknown>) => void> = [
        (payload) => { ((payload["root"] as Record<string, unknown>)["workspace"] as Record<string, unknown>)["count"] = 9; },
        (payload) => { (((payload["root"] as Record<string, unknown>)["trajectory"] as Array<Record<string, unknown>>)[0]!)["code"] = "tampered"; },
        (payload) => { const usage = (payload["ledger"] as Record<string, unknown>)["usage"] as Record<string, number>; usage["storedBytes"] = (usage["storedBytes"] ?? 0) + 1; },
        (payload) => { (((payload["keyBindings"] as Array<Record<string, unknown>>)[0]!)["identityHash"]) = "0".repeat(64); },
        (payload) => { (((payload["callCache"] as Array<Record<string, unknown>>)[0]!["result"] as Record<string, unknown>)["value"]) = "tampered"; },
        (payload) => { const ordinals = payload["ordinals"] as Record<string, number>; ordinals["frameSequence"] = (ordinals["frameSequence"] ?? 0) + 1; },
        (payload) => { (((payload["artifacts"] as Array<Record<string, unknown>>)[0]!["text"])) = "tampered artifact"; },
      ];
      const model = new MockModelClient(() => "must-not-run", modelIdentity);
      for (const mutate of mutations) {
        await rewriteCheckpointPayload(lease.dir, mutate);
        await expectRecoveryCode(resumeWith(lease, backend, model), "RECOVERY_CHECKPOINT_INVALID");
        await writeFile(eventsPath, originalEvents, { mode: 0o600 });
      }
      expect(model.callCount).toBe(0);
      await lease.abandon();
      lease = undefined;
    } finally {
      await lease?.abandon().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

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
  }, 60_000);

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
  }, 30_000);

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
      await expect(store.openForResume(lease.name)).rejects.toMatchObject({ code: "RUN_RETENTION_RESUME_FAILED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
