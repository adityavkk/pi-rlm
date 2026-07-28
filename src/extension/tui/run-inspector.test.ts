import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeProgram } from "../../core/program.ts";
import { inspectManagedRunPage } from "../../runtime/run-inspection.ts";
import type { RunInspectionPage, RunInspectionRequest, RunInspectionView } from "../../runtime/run-inspection-types.ts";
import { ManagedRunStore } from "../../runtime/run-retention.ts";
import { MockController } from "../../runtime/mock-controller.ts";
import { runProgram } from "../../runtime/run.ts";
import { QuickJsBackend } from "../../shell/interpreter/quickjs.ts";
import { MockModelClient } from "../../shell/model/mock.ts";
import {
  openRunInspector,
  projectRunInspectionItem,
  projectRunInspectionPage,
  renderRunInspector,
  RunInspector,
  RUN_INSPECTOR_PAGE_SIZE,
  type RunInspectionProjection,
} from "./run-inspector.ts";

const RUN_NAME = `run-${"a".repeat(32)}`;
const RUN_ID = `run_${"b".repeat(64)}`;
const FRAME_ID = `${RUN_ID}:f0`;
const CALL_ID = `call_llm_${"f".repeat(64)}`;
const HASH = "d".repeat(64);
const CURSOR = "authenticated_cursor_1";

const rawPage = (
  view: RunInspectionView = "summary",
  items: unknown[] = [{
    kind: "summary",
    status: "completed",
    rootFrameId: FRAME_ID,
    eventCount: 7,
    frames: 2,
    cells: 3,
    committedCalls: 4,
    observedProviderAttempts: 5,
    completionMode: "answer",
    prompt: "SECRET_PROMPT",
    source: "/private/SECRET_PATH",
  }],
  nextCursor?: string,
): RunInspectionPage => ({
  version: 1,
  runName: RUN_NAME,
  runId: RUN_ID,
  manifestHash: HASH,
  journalPrefixSha256: "e".repeat(64),
  eventCount: 7,
  view,
  items,
  serializedBytes: 1,
  ...(nextCursor ? { nextCursor } : {}),
}) as RunInspectionPage;

const projected = (view: RunInspectionView = "summary", nextCursor?: string): RunInspectionProjection =>
  projectRunInspectionPage(rawPage(view, undefined, nextCursor), RUN_NAME, view);

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("run inspector", () => {
  test("projects six metadata views and drops hostile guest/provider text", () => {
    const hostile = "SECRET_\u001b]8;;file:///private/path\u0007PROMPT";
    const items: unknown[] = [
      { kind: "cell", frameId: FRAME_ID, iteration: 1, codeHash: HASH, hasResult: true,
        outputBytes: 10, code: hostile, reasoning: hostile, answer: hostile },
      { kind: "call", frameId: FRAME_ID, callId: CALL_ID, callKind: "llm",
        key: { sha256: HASH, bytes: 12 }, executions: 1, ok: false, usage: {},
        observedProviderAttempts: 1, providerText: hostile },
      { kind: "error", source: "run", error: {
        trustedCode: "RUN_FAILED", code: { sha256: HASH, bytes: 3 }, message: { sha256: HASH, bytes: 99 },
        messageText: hostile,
      }, rawError: hostile },
      { kind: "not-a-view", source: hostile },
    ];
    const page = projectRunInspectionPage(rawPage("cells", items), RUN_NAME, "cells");
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("reasoning");
    expect(page.rows).toHaveLength(4);
    expect(page.rows.at(-1)).toBe("invalid metadata item");

    for (const width of [50, 80, 120, 180]) {
      const lines = renderRunInspector({ page, pageNumber: 1 }, width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("SECRET");
    }
  });

  test("accepts at most 50 items and rejects unauthenticated cursor shapes", () => {
    const items = Array.from({ length: RUN_INSPECTOR_PAGE_SIZE }, (_, iteration) => ({
      kind: "cell", frameId: FRAME_ID, iteration, codeHash: HASH, hasResult: false,
    }));
    expect(projectRunInspectionPage(rawPage("cells", items, CURSOR), RUN_NAME, "cells").rows)
      .toHaveLength(RUN_INSPECTOR_PAGE_SIZE);
    expect(() => projectRunInspectionPage(rawPage("cells", [...items, items[0]], CURSOR), RUN_NAME, "cells")).toThrow();
    expect(() => projectRunInspectionPage(rawPage("cells", items, "bad+cursor"), RUN_NAME, "cells")).toThrow();
    expect(() => projectRunInspectionPage(rawPage("cells", items), `../${RUN_NAME}`, "cells")).toThrow();
  });

  test("supports tab, authenticated next/previous page, back, and cleanup actions", async () => {
    const loads: Array<{ view: RunInspectionView; cursor?: string }> = [];
    let closed = 0;
    let renders = 0;
    const loader = async (view: RunInspectionView, cursor?: string): Promise<RunInspectionProjection> => {
      loads.push({ view, ...(cursor ? { cursor } : {}) });
      return projected(view, cursor ? undefined : CURSOR);
    };
    const component = new RunInspector(projected("summary", CURSOR), loader, () => { closed += 1; }, () => { renders += 1; });
    component.handleInput("\u001b[C");
    await flush();
    expect(loads.at(-1)).toEqual({ view: "frames" });
    component.handleInput("n");
    await flush();
    expect(loads.at(-1)).toEqual({ view: "frames", cursor: CURSOR });
    expect(component.render(80).join("\n")).toContain("page 2");
    component.handleInput("p");
    await flush();
    expect(loads.at(-1)).toEqual({ view: "frames" });
    component.handleInput("r");
    await flush();
    expect(loads.at(-1)).toEqual({ view: "frames" });
    component.handleInput("\u007f");
    expect(closed).toBe(1);
    expect(renders).toBeGreaterThan(0);
    component.dispose();
    component.dispose();
    expect(component.render(80)).toEqual([]);
  });

  test("imperative shell enforces TUI mode and fixed page size without timers", async () => {
    const requests: RunInspectionRequest[] = [];
    const notifications: string[] = [];
    let customCalls = 0;
    const ctx = (mode: "tui" | "print") => ({
      mode,
      hasUI: mode === "tui",
      ui: {
        notify: (message: string) => { notifications.push(message); },
        custom: <T>(factory: (tui: { requestRender(): void }, theme: unknown, keys: unknown, done: (value: T) => void) => {
          handleInput?(data: string): void;
        }) => new Promise<T>((resolve) => {
          customCalls += 1;
          const component = factory({ requestRender() {} }, {}, {}, resolve);
          component.handleInput?.("\u001b");
        }),
      },
    });
    const inspect = async (request: RunInspectionRequest): Promise<RunInspectionPage> => {
      requests.push(request);
      return rawPage(request.view);
    };

    await openRunInspector(ctx("print") as never, RUN_NAME, inspect);
    expect(requests).toHaveLength(0);
    expect(customCalls).toBe(0);
    await openRunInspector(ctx("tui") as never, RUN_NAME, inspect);
    expect(requests).toEqual([{ version: 1, runName: RUN_NAME, view: "summary", pageSize: 50 }]);
    expect(customCalls).toBe(1);
    expect(notifications).toEqual(["RLM run inspector requires TUI mode."]);
  });

  test("keeps a rolling 32-cursor back window while absolute forward pages continue", async () => {
    const loads: Array<{ view: RunInspectionView; cursor?: string }> = [];
    const loader = async (view: RunInspectionView, cursor?: string): Promise<RunInspectionProjection> => {
      loads.push({ view, ...(cursor ? { cursor } : {}) });
      const number = cursor ? Number(cursor.slice("cursor_".length)) : 1;
      return projected(view, number < 40 ? `cursor_${number + 1}` : undefined);
    };
    const component = new RunInspector(projected("summary", "cursor_2"), loader, () => {});
    for (let page = 2; page <= 40; page += 1) { component.handleInput("n"); await flush(); }
    expect(component.render(100).join("\n")).toContain("page 40 · previous available");
    for (let page = 0; page < 32; page += 1) { component.handleInput("p"); await flush(); }
    expect(component.render(100).join("\n")).toContain("page 8");
    expect(component.render(100).join("\n")).not.toContain("previous available");
    const before = loads.length;
    component.handleInput("p");
    await flush();
    expect(loads).toHaveLength(before);
    component.handleInput("n");
    await flush();
    expect(component.render(100).join("\n")).toContain("page 9");
  });

  test("pure item projection rejects proxies and accessors, uses actual unions, and bounds identities", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({ kind: "frame" }, "frameId", {
      enumerable: true, get() { getterCalls += 1; return FRAME_ID; },
    });
    expect(projectRunInspectionItem(accessor)).toBe("invalid metadata item");
    expect(projectRunInspectionItem(new Proxy({ kind: "frame" }, { get() { throw new Error("trap"); } })))
      .toBe("invalid metadata item");
    expect(getterCalls).toBe(0);

    const usage = projectRunInspectionItem({
      kind: "call", frameId: FRAME_ID, callId: CALL_ID, callKind: "llm", key: { sha256: HASH, bytes: 2 },
      executions: 1, ok: true, usage: { attempts: 1, durationMs: 7 }, observedProviderAttempts: 1,
    });
    expect(usage).toContain("llm#ffffffffffff");
    expect(usage).toContain("attempts 1");
    expect(usage).toContain("duration 7");
    expect(usage).not.toContain(CALL_ID);
    expect(projectRunInspectionItem({ kind: "frame", frameId: FRAME_ID, parentFrameId: null, state: "running" }))
      .not.toContain("running");
    expect(projectRunInspectionItem({ kind: "error", source: "run", error: {
      trustedCode: "HOSTILE_CODE", code: { sha256: HASH, bytes: 1 },
    } })).not.toContain("HOSTILE_CODE");
    expect(projectRunInspectionItem({ kind: "error", source: "run", error: {
      trustedCode: "CPU_LIMIT", code: { sha256: HASH, bytes: 1 },
    } })).toContain("CPU_LIMIT");
    const oversized = rawPage("cells", Array.from({ length: RUN_INSPECTOR_PAGE_SIZE + 1 }, () => ({ kind: "cell" })));
    expect(() => projectRunInspectionPage(oversized, RUN_NAME, "cells"))
      .toThrow("invalid managed inspection page projection");
  });

  test("projects pages produced by an actual retained nested runtime", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-rlm-tui-inspector-"));
    const backend = await QuickJsBackend.create();
    try {
      const normalized = normalizeProgram({
        objective: "nested projection",
        profile: "default",
        inputs: [{ name: "context", adapter: "text", description: "context" }],
        outputs: [{ name: "answer", schema: { type: "string" } }],
      });
      if (!normalized.ok) throw new Error("invalid integration program");
      const store = new ManagedRunStore({ root: stateRoot });
      const lease = await store.create();
      const result = await runProgram({
        program: normalized.value,
        sources: { context: "integration source" },
        controller: new MockController([{
          reasoning: "nested", code: "const child = await recurse({ key: 'child', objective: 'child' }); answer({ answer: child.value.answer })",
        }]),
        model: new MockModelClient(() => "model answer", {
          id: "test/tui-inspector", version: "1", configuration: { fixture: "managed-runtime" },
        }),
        backend,
        dir: lease.dir,
        signal: new AbortController().signal,
        runLifecycle: lease.lifecycle,
      });
      await lease.finish(result.status, result.runId);
      expect(result.status).toBe("completed");

      const projectedViews: Record<string, RunInspectionProjection> = {};
      for (const view of ["frames", "calls", "budget"] as const) {
        const raw = await inspectManagedRunPage({ version: 1, runName: lease.name, view, pageSize: 50 }, { root: stateRoot });
        projectedViews[view] = projectRunInspectionPage(raw, lease.name, view);
        expect(projectedViews[view]!.rows).not.toContain("invalid metadata item");
      }
      expect(projectedViews["frames"]!.rows.join("\n")).toMatch(/answered|closed/);
      expect(projectedViews["frames"]!.rows.join("\n")).not.toContain(result.runId);
      expect(projectedViews["calls"]!.rows.join("\n")).toContain("recurse#");
      expect(projectedViews["calls"]!.rows.join("\n")).toContain("attempts 0");
      const budget = projectedViews["budget"]!.rows.join("\n");
      for (const label of ["max-depth", "max-frames", "max-calls", "max-attempts", "max-controller-turns",
        "max-concurrency", "stored-byte-limit", "deadline"]) expect(budget).toContain(label);
    } finally {
      await backend.dispose();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
