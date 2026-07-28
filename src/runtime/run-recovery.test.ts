import { appendFile, chmod, link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  deriveOperationIntentId,
  OPERATION_JOURNAL_SCHEMA_VERSION,
  PROVIDER_REQUEST_IDENTITY_VERSION,
  type OperationIntentIdentity,
} from "../core/operation.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { sha256 } from "../shell/hash.ts";
import { JournalStore } from "../shell/journal-store.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import type { ControllerDriver } from "./controller.ts";
import { MockController } from "./mock-controller.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { inspectRecoveredRun, RunRecoveryError, type RunRecoveryErrorCode } from "./run-recovery.ts";
import { runProgram } from "./run.ts";

const roots: string[] = [];
const temp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rlm-recovery-"));
  roots.push(dir);
  return dir;
};
const identity = (fixture: string) => ({ id: "test/recovery", version: "1", configuration: { fixture } } as const);
const program = (outputs: RlmProgram["outputs"] = [{ name: "answer", schema: { type: "string" } }]): RlmProgram => {
  const normalized = normalizeProgram({
    objective: "recover a persisted run",
    profile: "default",
    inputs: [{ name: "context", adapter: "text", description: "input" }],
    outputs,
  });
  if (!normalized.ok) throw new Error("invalid fixture program");
  return normalized.value;
};
const events = async (dir: string): Promise<RlmEvent[]> => {
  const result = await new JournalStore(dir).readEvents();
  if (!result.ok) throw result.error;
  return result.value;
};
const rewriteEvents = async (dir: string, value: readonly RlmEvent[]): Promise<void> => {
  await writeFile(join(dir, "events.jsonl"), value.map((event) =>
    `${canonicalStringify(event as unknown as JsonValue)}\n`).join(""), { mode: 0o600 });
};

const operationPair = (
  runId: string,
  frameId: string,
  operationId: string,
  kind: OperationIntentIdentity["kind"],
  attempt: number,
): readonly [
  Extract<RlmEvent, { type: "operation_intended" }>,
  Extract<RlmEvent, { type: "operation_settled" }>,
] => {
  const identity: OperationIntentIdentity = {
    schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
    runId,
    frameId,
    operationId,
    kind,
    attempt,
    requestIdentityVersion: PROVIDER_REQUEST_IDENTITY_VERSION,
    requestSha256: sha256(`${operationId}:${attempt}`),
    reservation: { logicalCalls: 1, attempts: 1, tokens: 0 },
  };
  const intent = { type: "operation_intended" as const, ...identity, intentId: deriveOperationIntentId(sha256, identity) };
  return [intent, {
    type: "operation_settled",
    schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
    runId,
    frameId,
    intentId: intent.intentId,
    outcome: "ok",
    usage: { attempts: 1, durationMs: 1 },
  }];
};

const expectRecoveryCode = async (promise: Promise<unknown>, code: RunRecoveryErrorCode): Promise<void> => {
  try {
    await promise;
    throw new Error("expected recovery failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RunRecoveryError);
    expect((error as RunRecoveryError).code).toBe(code);
  }
};

let backend: QuickJsBackend;
beforeAll(async () => { backend = await QuickJsBackend.create(); });
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

describe("authoritative run recovery inspection", () => {
  test("recovers a completed answer without changing any managed metadata", async () => {
    const dir = await temp();
    const result = await runProgram({
      program: program(),
      sources: { context: "source" },
      controller: new MockController([{ reasoning: "done", code: "workspace.n = 1; answer({ answer: 'recovered' }); 'ok'" }]),
      model: new MockModelClient(() => "unused", identity("completed")),
      backend,
      dir,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    const paths = ["manifest.json", ".pi-rlm-run.lock", "events.jsonl", "status.json"];
    const before = await Promise.all(paths.map((name) => readFile(join(dir, name))));

    const inspection = await inspectRecoveredRun(dir);

    expect(inspection).toMatchObject({
      runId: result.runId,
      status: "completed",
      committedCells: 1,
      committedCalls: 0,
      terminal: {
        status: "completed",
        completionMode: "answer",
        answer: { answer: "recovered" },
        output: result.output,
      },
    });
    const after = await Promise.all(paths.map((name) => readFile(join(dir, name))));
    expect(after).toEqual(before);
  });

  test("verifies committed call results and fallback answers", async () => {
    const callDir = await temp();
    const called = await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{
        reasoning: "delegate",
        code: "const result = await llm({ key: 'recover', prompt: 'recover' }); answer({ answer: result.value })",
      }]),
      model: new MockModelClient(() => "from-model", identity("call")), backend, dir: callDir,
      signal: new AbortController().signal,
    });
    expect(called.status).toBe("completed");
    expect(await inspectRecoveredRun(callDir)).toMatchObject({
      status: "completed", committedCalls: 1, terminal: { answer: { answer: "from-model" } },
    });

    const retryDir = await temp();
    let modelCalls = 0;
    await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{
        reasoning: "retry",
        code: "const first = await llm({ key: 'retry', prompt: 'same' }); const second = first.ok ? first : await llm({ key: 'retry', prompt: 'same' }); answer({ answer: second.value })",
      }]),
      model: new MockModelClient(() => {
        modelCalls += 1;
        if (modelCalls === 1) throw new Error("first attempt fails");
        return "retried";
      }, identity("retry")),
      backend, dir: retryDir, signal: new AbortController().signal,
    });
    const retryAttempts = (await events(retryDir)).filter((event): event is Extract<RlmEvent, { type: "operation_intended" }> =>
      event.type === "operation_intended" && event.kind === "llm");
    expect(retryAttempts.map((event) => event.attempt)).toEqual([1, 2]);
    expect(await inspectRecoveredRun(retryDir)).toMatchObject({ status: "completed", terminal: { answer: { answer: "retried" } } });

    const { FunctionExtractor } = await import("./extractor.ts");
    const fallbackDir = await temp();
    const fallback = await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{ reasoning: "save", code: "workspace.recovery = 'fallback'" }]),
      model: new MockModelClient(() => "unused", identity("fallback")), backend, dir: fallbackDir,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 1 },
      extractor: new FunctionExtractor((evidence) => {
        const represented = evidence.workspaceValues.find((item) => item.key === "recovery");
        if (!represented?.evidenceId) throw new Error("missing evidence");
        return { ok: true, value: { answer: "fallback" }, evidenceRefs: [represented.evidenceId] };
      }, "external", {
        closure: identity("fallback-extractor"), configuration: {}, modelRoute: null, providerPrompt: null,
      }),
      signal: new AbortController().signal,
    });
    expect(fallback.status).toBe("completed");
    expect(await inspectRecoveredRun(fallbackDir)).toMatchObject({
      status: "completed", terminal: { completionMode: "fallback_extract", answer: { answer: "fallback" } },
    });
  });

  test("validates nested frame ancestry and its parent recurse call", async () => {
    const dir = await temp();
    const result = await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{
        reasoning: "recurse",
        code: "const child = await recurse({ key: 'child', objective: 'child work' }); answer({ answer: child.value.answer })",
      }]),
      model: new MockModelClient(() => "unused", identity("recurse")), backend, dir,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(await inspectRecoveredRun(dir)).toMatchObject({ status: "completed", committedCalls: 1 });
  });

  test("recovers an authoritative failed terminal", async () => {
    const dir = await temp();
    const result = await runProgram({
      program: program(),
      sources: { context: "source" },
      controller: new MockController([{ reasoning: "fail", code: "throw new Error('guest')" }]),
      model: new MockModelClient(() => "unused", identity("failed")),
      backend,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 1 },
      dir,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    const inspection = await inspectRecoveredRun(dir);
    expect(inspection.status).toBe("failed");
    expect(inspection.terminal).toEqual({ status: "failed", error: result.error });
  });

  test("recovers a cancelled terminal as immutable state", async () => {
    const dir = await temp();
    const owner = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const controller: ControllerDriver = {
      identity: identity("cancel-controller"),
      next: async (_state, signal) => new Promise((_resolve, reject) => {
        markStarted();
        const abort = () => reject(new Error("aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
      fork: () => controller,
    };
    const running = runProgram({
      program: program(), sources: { context: "source" }, controller,
      model: new MockModelClient(() => "unused", identity("cancel")), backend, dir,
      signal: owner.signal,
    });
    await started;
    owner.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    const before = await readFile(join(dir, "events.jsonl"));
    expect(await inspectRecoveredRun(dir)).toMatchObject({
      status: "cancelled", terminal: { status: "cancelled", error: { code: "CANCELLED" } },
    });
    expect(await readFile(join(dir, "events.jsonl"))).toEqual(before);
  });

  test("classifies a pre-start source failure as an orphan with no invented terminal", async () => {
    const dir = await temp();
    const result = await runProgram({
      program: program(), sources: { context: "too large" },
      controller: new MockController([{ reasoning: "unused", code: "answer({ answer: 'unused' })" }]),
      model: new MockModelClient(() => "unused", identity("orphan")), backend, dir,
      profile: { ...DEFAULT_PROFILE, storedByteLimit: 1 }, signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "BUDGET_BYTES" } });
    expect(await events(dir)).toEqual([]);
    await expectRecoveryCode(inspectRecoveredRun(dir), "RECOVERY_ORPHAN");
  });

  test("accepts a stable nonterminal prefix without inventing a terminal", async () => {
    const dir = await temp();
    await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]),
      model: new MockModelClient(() => "unused", identity("nonterminal")), backend, dir,
      signal: new AbortController().signal,
    });
    const events = await new JournalStore(dir).readEvents();
    if (!events.ok) throw events.error;
    const prefix = events.value.filter((event) => event.type !== "frame_closed"
      && event.type !== "run_completed" && event.type !== "run_failed" && event.type !== "run_cancelled");
    await writeFile(join(dir, "events.jsonl"), prefix.map((event) => `${canonicalStringify(event as unknown as JsonValue)}\n`).join(""), { mode: 0o600 });

    const inspection = await inspectRecoveredRun(dir);
    expect(inspection.status).toBe("nonterminal");
    expect(inspection.terminal).toBeUndefined();
    expect(inspection.committedCells).toBe(1);
  });

  test("uses only the verified prefix and leaves a torn terminal tail untouched", async () => {
    const dir = await temp();
    await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]),
      model: new MockModelClient(() => "unused", identity("tail")), backend, dir,
      signal: new AbortController().signal,
    });
    await appendFile(join(dir, "events.jsonl"), '{"type":"frame_opened"');
    const before = await readFile(join(dir, "events.jsonl"));
    expect((await inspectRecoveredRun(dir)).status).toBe("completed");
    expect(await readFile(join(dir, "events.jsonl"))).toEqual(before);
  });

  test("rejects operation identity drift and incomplete fallback chains", async () => {
    const operationDir = await temp();
    await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]),
      model: new MockModelClient(() => "unused", identity("operation-drift")), backend, dir: operationDir,
      signal: new AbortController().signal,
    });
    const operationEvents = await events(operationDir);
    const frameIndex = operationEvents.findIndex((event) => event.type === "frame_opened");
    const frame = operationEvents[frameIndex] as Extract<RlmEvent, { type: "frame_opened" }>;
    const operationRun = operationEvents[0] as Extract<RlmEvent, { type: "run_started" }>;
    operationEvents.splice(frameIndex + 1, 0,
      ...operationPair(operationRun.runId, frame.frameId, "op", "llm", 1),
      ...operationPair(operationRun.runId, frame.frameId, "op", "extractor", 2),
    );
    await rewriteEvents(operationDir, operationEvents);
    await expectRecoveryCode(inspectRecoveredRun(operationDir), "RECOVERY_SEMANTIC_CORRUPTION");

    const duplicateAttemptDir = await temp();
    await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]),
      model: new MockModelClient(() => "unused", identity("duplicate-attempt")), backend, dir: duplicateAttemptDir,
      signal: new AbortController().signal,
    });
    const duplicateEvents = await events(duplicateAttemptDir);
    const duplicateFrameIndex = duplicateEvents.findIndex((event) => event.type === "frame_opened");
    const duplicateFrame = duplicateEvents[duplicateFrameIndex] as Extract<RlmEvent, { type: "frame_opened" }>;
    const duplicateRun = duplicateEvents[0] as Extract<RlmEvent, { type: "run_started" }>;
    const [duplicateIntent, duplicateSettlement] = operationPair(duplicateRun.runId, duplicateFrame.frameId, "same", "llm", 1);
    duplicateEvents.splice(duplicateFrameIndex + 1, 0, duplicateIntent, duplicateSettlement, duplicateSettlement);
    await rewriteEvents(duplicateAttemptDir, duplicateEvents);
    await expectRecoveryCode(inspectRecoveredRun(duplicateAttemptDir), "RECOVERY_SEMANTIC_CORRUPTION");

    const settlementFixture = async (fixture: string) => {
      const dir = await temp();
      await runProgram({
        program: program(), sources: { context: "source" },
        controller: new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]),
        model: new MockModelClient(() => "unused", identity(fixture)), backend, dir,
        signal: new AbortController().signal,
      });
      const journal = await events(dir);
      const index = journal.findIndex((event) => event.type === "frame_opened");
      const opened = journal[index] as Extract<RlmEvent, { type: "frame_opened" }>;
      const started = journal[0] as Extract<RlmEvent, { type: "run_started" }>;
      return { dir, journal, index, pair: operationPair(started.runId, opened.frameId, fixture, "llm", 1) };
    };
    const orphan = await settlementFixture("orphan-settlement");
    orphan.journal.splice(orphan.index + 1, 0, orphan.pair[1]);
    await rewriteEvents(orphan.dir, orphan.journal);
    await expectRecoveryCode(inspectRecoveredRun(orphan.dir), "RECOVERY_SEMANTIC_CORRUPTION");

    const conflict = await settlementFixture("conflicting-settlement");
    conflict.journal.splice(conflict.index + 1, 0, ...conflict.pair, {
      ...conflict.pair[1], outcome: "error", errorCode: "FAILED",
    });
    await rewriteEvents(conflict.dir, conflict.journal);
    await expectRecoveryCode(inspectRecoveredRun(conflict.dir), "RECOVERY_SEMANTIC_CORRUPTION");

    const { FunctionExtractor } = await import("./extractor.ts");
    const fallbackDir = await temp();
    await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{ reasoning: "save", code: "workspace.recovery = 'fallback'" }]),
      model: new MockModelClient(() => "unused", identity("fallback-chain")), backend, dir: fallbackDir,
      profile: { ...DEFAULT_PROFILE, maxControllerTurns: 1 },
      extractor: new FunctionExtractor((evidence) => {
        const represented = evidence.workspaceValues.find((item) => item.key === "recovery")!;
        return { ok: true, value: { answer: "fallback" }, evidenceRefs: [represented.evidenceId!] };
      }, "external", {
        closure: identity("fallback-chain-extractor"), configuration: {}, modelRoute: null, providerPrompt: null,
      }),
      signal: new AbortController().signal,
    });
    await rewriteEvents(fallbackDir, (await events(fallbackDir)).filter((event) => event.type !== "fallback_evidence_projected"));
    await expectRecoveryCode(inspectRecoveredRun(fallbackDir), "RECOVERY_SEMANTIC_CORRUPTION");
  });

  test("types incompatible manifests and rejects public roots and context payloads", async () => {
    const makeCompleted = async (fixture: string): Promise<string> => {
      const dir = await temp();
      await runProgram({
        program: program(), sources: { context: "source" },
        controller: new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]),
        model: new MockModelClient(() => "unused", identity(fixture)), backend, dir,
        signal: new AbortController().signal,
      });
      return dir;
    };

    const incompatible = await makeCompleted("incompatible");
    const manifest = JSON.parse(await readFile(join(incompatible, "manifest.json"), "utf8")) as Record<string, unknown>;
    ((manifest["manifest"] as Record<string, unknown>)["runtime"] as Record<string, unknown>)["dslVersion"] = "99";
    manifest["manifestHash"] = sha256(canonicalStringify(manifest["manifest"] as JsonValue));
    await writeFile(join(incompatible, "manifest.json"), `${canonicalStringify(manifest as JsonValue)}\n`, { mode: 0o600 });
    await expectRecoveryCode(inspectRecoveredRun(incompatible), "RECOVERY_INCOMPATIBLE");

    const staleIncompatible = await makeCompleted("stale-incompatible");
    const stale = JSON.parse(await readFile(join(staleIncompatible, "manifest.json"), "utf8")) as Record<string, unknown>;
    ((stale["manifest"] as Record<string, unknown>)["runtime"] as Record<string, unknown>)["dslVersion"] = "99";
    await writeFile(join(staleIncompatible, "manifest.json"), `${canonicalStringify(stale as JsonValue)}\n`, { mode: 0o600 });
    await expectRecoveryCode(inspectRecoveredRun(staleIncompatible), "RECOVERY_MANIFEST_INVALID");

    const publicRoot = await makeCompleted("public-root");
    await chmod(publicRoot, 0o755);
    await expectRecoveryCode(inspectRecoveredRun(publicRoot), "RECOVERY_DIRECTORY_INVALID");

    const publicContexts = await makeCompleted("public-contexts");
    await chmod(join(publicContexts, "contexts"), 0o755);
    await expectRecoveryCode(inspectRecoveredRun(publicContexts), "RECOVERY_CONTENT_INVALID");

    const publicPayload = await makeCompleted("public-payload");
    const answer = (await events(publicPayload)).find((event) => event.type === "answer_committed");
    if (!answer || answer.type !== "answer_committed") throw new Error("missing answer fixture");
    await chmod(join(publicPayload, "contexts", `${answer.outputSha256}.bin`), 0o644);
    await expectRecoveryCode(inspectRecoveredRun(publicPayload), "RECOVERY_CONTENT_INVALID");

    const linkedPayload = await makeCompleted("linked-payload");
    const linkedAnswer = (await events(linkedPayload)).find((event) => event.type === "answer_committed");
    if (!linkedAnswer || linkedAnswer.type !== "answer_committed") throw new Error("missing linked answer fixture");
    const payloadPath = join(linkedPayload, "contexts", `${linkedAnswer.outputSha256}.bin`);
    await link(payloadPath, `${payloadPath}.link`);
    await expectRecoveryCode(inspectRecoveredRun(linkedPayload), "RECOVERY_CONTENT_INVALID");
  });

  test("fails closed for identity drift, complete corruption, content tampering, and public modes", async () => {
    const makeCompleted = async (fixture: string): Promise<string> => {
      const dir = await temp();
      await runProgram({
        program: program(), sources: { context: "source" },
        controller: new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]),
        model: new MockModelClient(() => "unused", identity(fixture)), backend, dir,
        signal: new AbortController().signal,
      });
      return dir;
    };

    const oversizedManifest = await makeCompleted("oversized-manifest");
    await writeFile(join(oversizedManifest, "manifest.json"), Buffer.alloc(2 * 1024 * 1024 + 1), { mode: 0o600 });
    await expectRecoveryCode(inspectRecoveredRun(oversizedManifest), "RECOVERY_MANIFEST_INVALID");

    const oversizedContent = await makeCompleted("oversized-content");
    const oversizedEvents = await events(oversizedContent);
    const started = oversizedEvents.find((event) => event.type === "run_started");
    if (!started || started.type !== "run_started") throw new Error("missing start fixture");
    const impossibleBytes = started.limits.storedByteLimit + 1;
    await rewriteEvents(oversizedContent, oversizedEvents.map((event) => {
      if (event.type === "cell_committed" && event.outputRef !== undefined)
        return { ...event, outputRefBytes: impossibleBytes };
      if (event.type === "answer_committed") return { ...event, outputBytes: impossibleBytes };
      return event;
    }));
    await expectRecoveryCode(inspectRecoveredRun(oversizedContent), "RECOVERY_CONTENT_INVALID");

    const hostileCall = await temp();
    await runProgram({
      program: program(), sources: { context: "source" },
      controller: new MockController([{
        reasoning: "call", code: "const r = await llm({ key: 'k', prompt: 'p' }); answer({ answer: r.value })",
      }]),
      model: new MockModelClient(() => "model", identity("hostile-call")), backend, dir: hostileCall,
      signal: new AbortController().signal,
    });
    const hostileEvents = await events(hostileCall);
    const call = hostileEvents.find((event) => event.type === "call_committed");
    if (!call || call.type !== "call_committed" || !call.outputSha256) throw new Error("missing call fixture");
    const callValue = JSON.parse(await readFile(join(hostileCall, "contexts", `${call.outputSha256}.bin`), "utf8")) as Record<string, JsonValue>;
    callValue["unexpected"] = true;
    const callText = canonicalStringify(callValue);
    const callHash = sha256(callText);
    await writeFile(join(hostileCall, "contexts", `${callHash}.bin`), callText, { mode: 0o600 });
    await rewriteEvents(hostileCall, hostileEvents.map((event) => event.type === "call_committed" ? {
      ...event, outputRef: `ctx_${callHash}`, outputSha256: callHash, outputBytes: Buffer.byteLength(callText),
    } : event));
    await expectRecoveryCode(inspectRecoveredRun(hostileCall), "RECOVERY_CONTENT_INVALID");

    const wrongRun = await makeCompleted("wrong-run");
    await appendFile(join(wrongRun, "events.jsonl"), `${canonicalStringify({
      type: "run_failed", runId: "run_" + "0".repeat(64), code: "FAILED", message: "x",
    })}\n`);
    await expectRecoveryCode(inspectRecoveredRun(wrongRun), "RECOVERY_SEMANTIC_CORRUPTION");

    const corrupt = await makeCompleted("corrupt");
    await appendFile(join(corrupt, "events.jsonl"), "{}\n");
    await expectRecoveryCode(inspectRecoveredRun(corrupt), "RECOVERY_JOURNAL_CORRUPT");

    const tampered = await makeCompleted("content");
    const tamperedEvents = await new JournalStore(tampered).readEvents();
    if (!tamperedEvents.ok) throw tamperedEvents.error;
    const answer = tamperedEvents.value.find((event) => event.type === "answer_committed");
    if (!answer || answer.type !== "answer_committed") throw new Error("missing answer fixture");
    await writeFile(join(tampered, "contexts", `${answer.outputSha256}.bin`), "tampered", { mode: 0o600 });
    await expectRecoveryCode(inspectRecoveredRun(tampered), "RECOVERY_CONTENT_INVALID");

    const publicJournal = await makeCompleted("mode");
    await chmod(join(publicJournal, "events.jsonl"), 0o644);
    await expectRecoveryCode(inspectRecoveredRun(publicJournal), "RECOVERY_JOURNAL_CORRUPT");
  });
});
