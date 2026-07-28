import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { callError } from "../core/errors.ts";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { JournalStore } from "../shell/journal-store.ts";
import { MockModelClient } from "../shell/model/mock.ts";

setDefaultTimeout(15_000);
import { FunctionExtractor } from "./extractor.ts";
import type { ControllerDriver } from "./controller.ts";
import { MockController } from "./mock-controller.ts";
import { ModelInvocationError } from "./provider.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import {
  inspectManagedRunPage,
  MAX_RUN_INSPECTION_AGGREGATE_ITEMS,
  RunInspectionError,
  type RunInspectionRequest,
} from "./run-inspection.ts";
import { ManagedRunStore, type ManagedRunLease } from "./run-retention.ts";
import { runProgram, type RunResult } from "./run.ts";

const roots: string[] = [];
let backend: QuickJsBackend;
beforeAll(async () => { backend = await QuickJsBackend.create(); });
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "pi-rlm-inspection-"));
  roots.push(value);
  return value;
};
const identity = (fixture: string) => ({ id: "test/inspection", version: "1", configuration: { fixture } } as const);
const program = (): RlmProgram => {
  const normalized = normalizeProgram({
    objective: "SECRET_OBJECTIVE must never enter inspection",
    profile: "default",
    inputs: [{ name: "context", adapter: "text", description: "SECRET_INPUT_DESCRIPTION" }],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid inspection fixture program");
  return normalized.value;
};

interface ManagedFixture {
  readonly root: string;
  readonly lease: ManagedRunLease;
  readonly result: RunResult;
}

const managedRun = async (
  fixture: string,
  controller: ControllerDriver,
  options: {
    readonly profile?: typeof DEFAULT_PROFILE;
    readonly extractor?: FunctionExtractor;
    readonly model?: MockModelClient;
  } = {},
): Promise<ManagedFixture> => {
  const stateRoot = await root();
  const store = new ManagedRunStore({ root: stateRoot });
  const lease = await store.create();
  const result = await runProgram({
    program: program(), sources: { context: "SECRET_SOURCE_CONTENT" }, controller,
    model: options.model ?? new MockModelClient(() => "SECRET_MODEL_ANSWER", identity(`${fixture}-model`)),
    backend, dir: lease.dir, signal: new AbortController().signal,
    runLifecycle: lease.lifecycle, ...(options.profile ? { profile: options.profile } : {}),
    ...(options.extractor ? { extractor: options.extractor } : {}),
  });
  await lease.finish(result.status, result.runId);
  return { root: stateRoot, lease, result };
};

const request = (runName: string, view: RunInspectionRequest["view"], extra: Partial<RunInspectionRequest> = {}): RunInspectionRequest => ({
  version: 1, runName, view, ...extra,
});

const expectInspectionCode = async (promise: Promise<unknown>, code: RunInspectionError["code"]): Promise<void> => {
  try {
    await promise;
    throw new Error("expected inspection failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RunInspectionError);
    expect((error as RunInspectionError).code).toBe(code);
  }
};

const events = async (dir: string): Promise<RlmEvent[]> => {
  const value = await new JournalStore(dir).readEvents();
  if (!value.ok) throw value.error;
  return value.value;
};

const rewriteEvents = async (dir: string, value: readonly RlmEvent[]): Promise<void> => {
  await writeFile(join(dir, "events.jsonl"), value.map((event) =>
    `${canonicalStringify(event as unknown as JsonValue)}\n`).join(""), { mode: 0o600 });
};

describe("bounded managed run inspection pages", () => {
  test("pages direct cells from a fixed journal prefix without exposing content", async () => {
    const fixture = await managedRun("direct", new MockController([
      { reasoning: "SECRET_REASONING_ONE", code: "workspace.first = 'SECRET_WORKSPACE'; 'first'" },
      { reasoning: "SECRET_REASONING_TWO", code: "answer({ answer: 'SECRET_FINAL_ANSWER' }); 'second'" },
    ]));
    expect(fixture.result.status).toBe("completed");

    const first = await inspectManagedRunPage(request(fixture.lease.name, "cells", {
      pageSize: 1,
    }), { root: fixture.root });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toContain(fixture.result.runId);
    const second = await inspectManagedRunPage(request(fixture.lease.name, "cells", {
      pageSize: 1, cursor: first.nextCursor,
    }), { root: fixture.root });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(first.journalPrefixSha256).toBe(second.journalPrefixSha256);
    expect(first.items[0]).toMatchObject({ kind: "cell", iteration: 1, hasResult: true });
    expect(second.items[0]).toMatchObject({ kind: "cell", iteration: 2, committedOutputBytes: expect.any(Number) });

    const serialized = JSON.stringify([first, second]);
    for (const secret of ["SECRET_SOURCE_CONTENT", "SECRET_OBJECTIVE", "SECRET_INPUT_DESCRIPTION", "SECRET_REASONING", "SECRET_WORKSPACE", "SECRET_FINAL_ANSWER"])
      expect(serialized).not.toContain(secret);

    const summary = await inspectManagedRunPage(request(fixture.lease.name, "summary"), { root: fixture.root });
    expect(summary.items[0]).toMatchObject({
      kind: "summary", status: "completed", completionMode: "answer", frames: 1, cells: 2, committedCalls: 0,
    });
    const budget = await inspectManagedRunPage(request(fixture.lease.name, "budget"), { root: fixture.root });
    expect(budget.items[0]).toMatchObject({ kind: "budget", observedLowerBounds: { frames: 1, cells: 2 } });
    expect(first.serializedBytes).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(canonicalStringify(first as unknown as JsonValue), "utf8")).toBe(first.serializedBytes);
  });

  test("projects nested frames and calls with bounded keys", async () => {
    const fixture = await managedRun("nested", new MockController([{
      reasoning: "parent secret", code: "phase('SECRET_PHASE_SOURCE'); const child = await recurse({ key: 'SECRET_CALL_KEY', objective: 'SECRET_CHILD_PROMPT' }); answer({ answer: child.value.answer })",
    }]));
    expect(fixture.result.status).toBe("completed");

    const frames = await inspectManagedRunPage(request(fixture.lease.name, "frames"), { root: fixture.root });
    expect(frames.items).toHaveLength(2);
    const rootFrameId = (frames.items[0] as { frameId: string }).frameId;
    expect(frames.items[1]).toMatchObject({ kind: "frame", parentFrameId: rootFrameId, depth: 1 });
    expect(JSON.stringify(frames)).not.toContain("SECRET_CHILD_PROMPT");
    expect(JSON.stringify(frames)).not.toContain("SECRET_PHASE_SOURCE");

    const calls = await inspectManagedRunPage(request(fixture.lease.name, "calls"), { root: fixture.root });
    expect(calls.items).toHaveLength(1);
    expect(calls.items[0]).toMatchObject({
      kind: "call", callKind: "recurse", key: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: 15 }, ok: true,
    });
    expect(JSON.stringify(calls)).not.toContain("SECRET_CALL_KEY");
    const childId = (frames.items[1] as { frameId: string }).frameId;
    const filtered = await inspectManagedRunPage(request(fixture.lease.name, "frames", { frameId: childId }), { root: fixture.root });
    expect(filtered.items).toHaveLength(1);
  });

  test("distinguishes fallback completion without returning the answer", async () => {
    const extractor = new FunctionExtractor((evidence) => {
      const item = evidence.workspaceValues.find((value) => value.key === "saved");
      if (!item?.evidenceId) throw new Error("missing evidence");
      return { ok: true, value: { answer: "SECRET_FALLBACK_ANSWER" }, evidenceRefs: [item.evidenceId] };
    }, "external", {
      closure: identity("fallback-extractor"), configuration: {}, modelRoute: null, providerPrompt: null,
    });
    const fixture = await managedRun("fallback", new MockController([{
      reasoning: "fallback secret", code: "workspace.saved = 'represented'; 'not an answer'",
    }]), { profile: { ...DEFAULT_PROFILE, maxControllerTurns: 1 }, extractor });
    expect(fixture.result.status).toBe("completed");

    const page = await inspectManagedRunPage(request(fixture.lease.name, "summary"), { root: fixture.root });
    expect(page.items[0]).toMatchObject({ kind: "summary", status: "completed", completionMode: "fallback_extract" });
    expect(JSON.stringify(page)).not.toContain("SECRET_FALLBACK_ANSWER");
  });

  test("returns bounded cell, provider, and terminal error metadata", async () => {
    const long = `FAIL_${"x".repeat(200)}`;
    const fixture = await managedRun("failed", new MockController([{
      reasoning: "failure", code: `throw new Error('${long}')`,
    }]), { profile: { ...DEFAULT_PROFILE, maxControllerTurns: 1 } });
    expect(fixture.result.status).toBe("failed");

    const summary = await inspectManagedRunPage(request(fixture.lease.name, "summary"), { root: fixture.root });
    expect(summary.items[0]).toMatchObject({
      kind: "summary", status: "failed", error: { message: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    });
    const errors = await inspectManagedRunPage(request(fixture.lease.name, "errors"), { root: fixture.root });
    expect(errors.items.some((item) => item.kind === "error" && item.source === "cell")).toBe(true);
    expect(errors.items.some((item) => item.kind === "error" && item.source === "run")).toBe(true);
    expect(JSON.stringify([summary, errors])).not.toContain(long);
    for (const item of errors.items) if (item.kind === "error") {
      expect(item.error.code.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(item.error.message?.sha256 ?? "").toMatch(/^(|[a-f0-9]{64})$/);
    }
  });

  test("rejects arbitrary paths, hostile cursors, cross-run cursors, and changed bindings", async () => {
    const firstFixture = await managedRun("cursor-one", new MockController([
      { reasoning: "one", code: "workspace.one = 1" },
      { reasoning: "two", code: "answer({ answer: 'done' })" },
    ]));
    const secondFixture = await managedRun("cursor-two", new MockController([
      { reasoning: "one", code: "workspace.one = 1" },
      { reasoning: "two", code: "answer({ answer: 'done' })" },
    ]));
    const first = await inspectManagedRunPage(request(firstFixture.lease.name, "cells", { pageSize: 1 }), { root: firstFixture.root });
    expect(first.nextCursor).toBeDefined();

    for (const name of ["../run-" + "a".repeat(32), "/tmp/run-" + "a".repeat(32), "run-" + "A".repeat(32)])
      await expectInspectionCode(inspectManagedRunPage(request(name, "summary"), { root: firstFixture.root }), "RUN_INSPECTION_INVALID_REQUEST");
    await expectInspectionCode(inspectManagedRunPage(request(firstFixture.lease.name, "cells", {
      cursor: "not+base64", pageSize: 1,
    }), { root: firstFixture.root }), "RUN_INSPECTION_INVALID_CURSOR");
    await expectInspectionCode(inspectManagedRunPage(request(secondFixture.lease.name, "cells", {
      cursor: first.nextCursor, pageSize: 1,
    }), { root: secondFixture.root }), "RUN_INSPECTION_INVALID_CURSOR");
    const staleValue = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as Record<string, JsonValue>;
    ((staleValue["payload"] as Record<string, JsonValue>)["journalPrefixSha256"]) = "0".repeat(64);
    const staleCursor = Buffer.from(canonicalStringify(staleValue as JsonValue)).toString("base64url");
    await expectInspectionCode(inspectManagedRunPage(request(firstFixture.lease.name, "cells", {
      cursor: staleCursor, pageSize: 1,
    }), { root: firstFixture.root }), "RUN_INSPECTION_INVALID_CURSOR");
    const offsetValue = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as Record<string, JsonValue>;
    ((offsetValue["payload"] as Record<string, JsonValue>)["offset"]) = 2;
    const forgedOffset = Buffer.from(canonicalStringify(offsetValue as JsonValue)).toString("base64url");
    await expectInspectionCode(inspectManagedRunPage(request(firstFixture.lease.name, "cells", {
      cursor: forgedOffset, pageSize: 1,
    }), { root: firstFixture.root }), "RUN_INSPECTION_INVALID_CURSOR");
    await expectInspectionCode(inspectManagedRunPage(request(firstFixture.lease.name, "calls", {
      cursor: first.nextCursor, pageSize: 1,
    }), { root: firstFixture.root }), "RUN_INSPECTION_INVALID_CURSOR");
    await expectInspectionCode(inspectManagedRunPage(request(firstFixture.lease.name, "cells", {
      pageSize: 201,
    }), { root: firstFixture.root }), "RUN_INSPECTION_INVALID_REQUEST");
  }, 15_000);

  test("continues an authenticated cursor over an unchanged prefix while the journal grows", async () => {
    const fixture = await managedRun("active-prefix", new MockController([
      { reasoning: "one", code: "workspace.one = 1" },
      { reasoning: "two", code: "answer({ answer: 'done' })" },
    ]));
    const first = await inspectManagedRunPage(request(fixture.lease.name, "cells", { pageSize: 1 }), { root: fixture.root });
    await writeFile(join(fixture.lease.dir, "events.jsonl"), Buffer.concat([
      await readFile(join(fixture.lease.dir, "events.jsonl")), Buffer.from('{"type":"phase"'),
    ]), { mode: 0o600 });
    const second = await inspectManagedRunPage(request(fixture.lease.name, "cells", {
      pageSize: 1, cursor: first.nextCursor,
    }), { root: fixture.root });
    expect(second.items).toHaveLength(1);
    expect(second.journalPrefixSha256).toBe(first.journalPrefixSha256);
  });

  test("projects failed then successful recurse executions under one logical call", async () => {
    let childRuns = 0;
    const retrying: ControllerDriver = {
      identity: identity("retry-controller"),
      async next(state) {
        if (state.objective === "SECRET_OBJECTIVE must never enter inspection") return {
          reasoning: "retry",
          code: "const a = await recurse({ key: 'retry', objective: 'child' }); const b = await recurse({ key: 'retry', objective: 'child' }); answer({ answer: !a.ok && b.ok ? b.value : 'bad' })",
        };
        childRuns += 1;
        if (childRuns === 1) throw new ModelInvocationError(callError("FAILED", "transient"), ZERO_CALL_USAGE);
        return { reasoning: "ok", code: "answer('retried')" };
      },
      fork() { return this; },
    };
    const fixture = await managedRun("retry", retrying);
    expect(fixture.result.status).toBe("completed");
    const calls = await inspectManagedRunPage(request(fixture.lease.name, "calls"), { root: fixture.root });
    expect(calls.items).toHaveLength(1);
    expect(calls.items[0]).toMatchObject({ kind: "call", callKind: "recurse", executions: 2, ok: true });
    const frames = await inspectManagedRunPage(request(fixture.lease.name, "frames"), { root: fixture.root });
    expect(frames.items).toHaveLength(3);

    const journal = await events(fixture.lease.dir);
    let removed = false;
    await rewriteEvents(fixture.lease.dir, journal.filter((event) => {
      if (!removed && event.type === "call_committed" && event.kind === "recurse") { removed = true; return false; }
      return true;
    }));
    await expect(inspectManagedRunPage(request(fixture.lease.name, "summary"), { root: fixture.root }))
      .rejects.toMatchObject({ code: "RECOVERY_SEMANTIC_CORRUPTION" });
  }, 15_000);

  test("rejects null, proxy, accessor, extra, and nonplain requests without invoking traps", async () => {
    const fixture = await managedRun("hostile", new MockController([{ reasoning: "done", code: "answer({ answer: 'ok' })" }]));
    const invalid: unknown[] = [null, { ...request(fixture.lease.name, "summary"), extra: true }, Object.create({})];
    let getterCalls = 0;
    invalid.push(Object.defineProperty({ version: 1, runName: fixture.lease.name }, "view", {
      enumerable: true, get() { getterCalls += 1; return "summary"; },
    }));
    const proxy = new Proxy(request(fixture.lease.name, "summary"), { get() { throw new Error("trap"); } });
    invalid.push(proxy);
    for (const value of invalid)
      await expectInspectionCode(inspectManagedRunPage(value, { root: fixture.root }), "RUN_INSPECTION_INVALID_REQUEST");
    expect(getterCalls).toBe(0);
  });

  test("rejects a semantically valid large projection at the aggregate cap", async () => {
    const fixture = await managedRun("large", new MockController([{
      reasoning: "failure", code: "throw new Error('failed')",
    }]), { profile: {
      ...DEFAULT_PROFILE,
      maxControllerTurns: MAX_RUN_INSPECTION_AGGREGATE_ITEMS + 1,
    } });
    expect(fixture.result.status).toBe("failed");
    const original = await events(fixture.lease.dir);
    const started = original.find((event) => event.type === "run_started");
    const opened = original.find((event) => event.type === "frame_opened");
    const closed = original.find((event) => event.type === "frame_closed");
    const terminal = original.find((event) => event.type === "run_failed");
    if (!started || !opened || !closed || !terminal) throw new Error("incomplete large fixture");
    const many: RlmEvent[] = [started, opened];
    for (let iteration = 1; iteration <= MAX_RUN_INSPECTION_AGGREGATE_ITEMS + 1; iteration++) many.push({
      type: "cell_committed", frameId: opened.frameId, iteration, reasoning: "", codeHash: "0".repeat(64),
      hasResult: false, outputPreview: "", error: { code: "CPU_LIMIT", message: "bounded" },
    });
    many.push(closed, terminal);
    await rewriteEvents(fixture.lease.dir, many);

    await expectInspectionCode(inspectManagedRunPage(request(fixture.lease.name, "cells"), { root: fixture.root }), "RUN_INSPECTION_LIMIT");
    expect((await readFile(join(fixture.lease.dir, "events.jsonl"))).length).toBeLessThan(32 * 1024 * 1024);
  });
});
