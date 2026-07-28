import { lstat, mkdtemp, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { RlmEvent } from "./src/core/journal.ts";
import type { Cell, ControllerDriver, FrameState } from "./src/runtime/controller.ts";
import {
  DEFAULT_PROFILE,
  ManagedRunStore,
  RUN_ACTIVE_FILE,
  RUN_INACTIVE_FILE_PREFIX,
  RUN_LIFECYCLE_FILE,
  type ManagedRunStoreOptions,
  type RunResult,
  type RunRetentionMetadataFileSystem,
} from "./src/runtime/index.ts";
import type { ManagedRunListing } from "./src/runtime/run-retention.ts";
import type { RunInspectionPage, RunInspectionRequest } from "./src/runtime/run-inspection-types.ts";
import type { CellEvalOptions, CellEvalOutcome, InterpreterBackend } from "./src/shell/interpreter/backend.ts";
import { sha256 } from "./src/shell/hash.ts";
import type { ModelClient, ModelResponse } from "./src/shell/model/client.ts";
import {
  createRunCoordinator,
  RUN_COORDINATOR_MAX_ACTIVE,
  type RunCoordinator,
} from "./src/extension/run-coordinator.ts";
import register, { createRlmExtension, LAUNCH_SNIPPET, type RlmRuntimeDependencies } from "./index.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: { status: string };
}

interface CapturedTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  renderCall?: (...args: unknown[]) => { render(width: number): string[] };
  renderResult?: (...args: unknown[]) => { render(width: number): string[] };
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}

interface CapturedCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface CustomComponent {
  handleInput?(data: string): void;
  dispose?(): void;
}
type CustomBehavior = (
  component: CustomComponent,
  done: (value: unknown) => void,
  reject: (error: unknown) => void,
  call: number,
) => void;

type EventHandler = (event: any, ctx: any) => unknown;

const failedRun = {
  status: "failed",
  error: { code: "TEST_FAILURE", message: "test run finished" },
} as unknown as RunResult;

const harness = (options: {
  ttl?: number;
  runtime?: RlmRuntimeDependencies;
  executeRun?: (request: unknown, signal: AbortSignal) => Promise<RunResult>;
  runCoordinator?: RunCoordinator;
  listManagedRuns?: () => Promise<ManagedRunListing>;
  inspectManagedRunPage?: (request: RunInspectionRequest) => Promise<RunInspectionPage>;
  setUiInterval?: RlmExtensionDependencies["setUiInterval"];
  clearUiInterval?: RlmExtensionDependencies["clearUiInterval"];
} = {}) => {
  const tools: CapturedTool[] = [];
  const commands = new Map<string, CapturedCommand>();
  const events = new Map<string, EventHandler[]>();
  const audits: Array<{ type: string; data: Record<string, unknown> }> = [];
  const resultEntries: Array<{ type: string; data: Record<string, unknown> }> = [];
  const resultMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const notifications: string[] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const widgets: Array<{ key: string; content: unknown; options?: unknown }> = [];
  const runs: unknown[] = [];
  const initializationAuditCounts: number[] = [];
  const runSignals: AbortSignal[] = [];
  const customComponents: CustomComponent[] = [];
  let customCalls = 0;
  let customBehavior: CustomBehavior = (component) => { component.handleInput?.("\u001b"); };
  let sessionId = "session-1";
  let clock = 100;
  let nextId = 0;
  let hasUI = true;
  let mode: "tui" | "rpc" | "print" | "json" = "tui";
  let widgetFault = false;
  let confirm: (title: string, message: string) => boolean | Promise<boolean> = () => true;
  let appendFaultType: string | undefined;

  const ctx = {
    get hasUI() {
      return hasUI;
    },
    get mode() { return mode; },
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      buildContextEntries: () => [],
    },
    ui: {
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return confirm(title, message);
      },
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      setWidget: (key: string, content: unknown, options?: unknown) => {
        if (widgetFault) throw new Error("widget fault");
        widgets.push({ key, content, options });
      },
      custom: <T>(factory: (
        tui: { requestRender(): void }, theme: unknown, keys: unknown, done: (value: T) => void,
      ) => CustomComponent) => new Promise<T>((resolve, reject) => {
        customCalls += 1;
        try {
          const component = factory({ requestRender() {} }, {}, {}, resolve);
          customComponents.push(component);
          customBehavior(component, resolve as (value: unknown) => void, reject, customCalls);
        } catch (error) { reject(error); }
      }),
    },
  };

  const pi = {
    registerTool: (definition: CapturedTool) => tools.push(definition),
    registerCommand: (name: string, definition: CapturedCommand) => commands.set(name, definition),
    on: (name: string, handler: EventHandler) => events.set(name, [...(events.get(name) ?? []), handler]),
    appendEntry: (type: string, data: Record<string, unknown>) => {
      if (type === appendFaultType) throw new Error("injected append failure with /private/host/path");
      (type === "pi-rlm-result" ? resultEntries : audits).push({ type, data });
      return `entry-${audits.length + resultEntries.length}`;
    },
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
      resultMessages.push({ message, options });
    },
  };

  createRlmExtension({
    ...(options.runtime
      ? { runtime: options.runtime }
      : {
          executeRun: async (request, signal) => {
            initializationAuditCounts.push(audits.length);
            runSignals.push(signal);
            runs.push(request);
            return options.executeRun ? options.executeRun(request, signal) : failedRun;
          },
        }),
    now: () => clock,
    createId: () => `host-${++nextId}`,
    grantTtlMs: options.ttl,
    runCoordinator: options.runCoordinator,
    ...(options.listManagedRuns ? { listManagedRuns: options.listManagedRuns } : {}),
    ...(options.inspectManagedRunPage ? { inspectManagedRunPage: options.inspectManagedRunPage } : {}),
    ...(options.setUiInterval ? { setUiInterval: options.setUiInterval } : {}),
    ...(options.clearUiInterval ? { clearUiInterval: options.clearUiInterval } : {}),
  })(pi as never);

  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of events.get(name) ?? []) await handler(event, ctx);
  };
  const startTurn = async (text: string, turnIndex = 1, timestamp = 1_000) => {
    await emit("input", { text, source: "interactive" });
    await emit("turn_start", { turnIndex, timestamp });
  };

  return {
    tools,
    commands,
    audits,
    resultEntries,
    resultMessages,
    notifications,
    confirmations,
    widgets,
    runs,
    initializationAuditCounts,
    runSignals,
    customComponents,
    get customCalls() { return customCalls; },
    ctx,
    emit,
    startTurn,
    setSessionId: (value: string) => {
      sessionId = value;
    },
    setClock: (value: number) => {
      clock = value;
    },
    setHasUI: (value: boolean) => {
      hasUI = value;
      mode = value ? "tui" : "print";
    },
    setMode: (value: typeof mode) => { mode = value; },
    setWidgetFault: (value: boolean) => { widgetFault = value; },
    setConfirm: (value: typeof confirm) => {
      confirm = value;
    },
    setCustomBehavior: (value: CustomBehavior) => { customBehavior = value; },
    setAppendFaultType: (value: string | undefined) => {
      appendFaultType = value;
    },
  };
};

const rlmTool = (h: ReturnType<typeof harness>): CapturedTool => {
  const tool = h.tools.find((candidate) => candidate.name === "rlm_run")!;
  return {
    ...tool,
    execute: (id, params, signal, onUpdate, ctx) => {
      if (params && typeof params === "object" && !Array.isArray(params)
        && "objective" in params && !("context" in params) && !("program" in params))
        (params as Record<string, unknown>)["context"] = "index test source";
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  };
};

const pendingOfflineRuntime = (dir: string): {
  readonly dependencies: RlmRuntimeDependencies;
  readonly started: Promise<void>;
  readonly resolveLate: (cell: Cell) => void;
} => {
  let markStarted!: () => void;
  let resolveLate!: (cell: Cell) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const lateCell = new Promise<Cell>((resolve) => { resolveLate = resolve; });
  const controller: ControllerDriver = {
    identity: { id: "test/controller", version: "1", configuration: { fixture: "index.test.ts:143" } },
    async next(_state: FrameState): Promise<Cell> {
      markStarted();
      return lateCell;
    },
    fork() { return this; },
  };
  const backend: InterpreterBackend = {
    id: "offline-extension-test",
    version: "1",
    async evalCell(_options: CellEvalOptions): Promise<CellEvalOutcome> {
      throw new Error("late controller cell reached interpreter");
    },
    async dispose() {},
  };
  const model: ModelClient = {
    identity: { id: "test/model-client", version: "1", configuration: { fixture: "index.test.ts:158" } },
    id: "offline-extension-test",
    async complete(): Promise<ModelResponse> {
      throw new Error("offline extension test made a provider call");
    },
  };
  return {
    started,
    resolveLate,
    dependencies: {
      resolveProfile: () => ({ ...DEFAULT_PROFILE, wallMs: 10_000 }),
      createBackend: () => backend,
      createModel: () => model,
      createController: () => controller,
      createRunDirectory: async () => dir,
    },
  };
};

type MetadataFault =
  | "temp-open"
  | "temp-write"
  | "temp-sync"
  | "temp-close"
  | "rename"
  | "directory-open"
  | "directory-sync"
  | "directory-close"
  | "write+cleanup-unlink"
  | "rename+cleanup-unlink"
  | "directory-sync+close";
type ResultStatus = RunResult["status"];

const injectedIo = (stage: string): Error & { code: string } =>
  Object.assign(new Error(`injected ${stage} failure`), { code: "EIO" });

const metadataFaultFileSystem = (fault: MetadataFault): RunRetentionMetadataFileSystem => {
  let lifecycleOpens = 0;
  let terminalPending = false;
  let terminalDirectoryFaulted = false;
  return {
    async open(path, flags, mode) {
      const lifecycleTemp = path.includes(RUN_LIFECYCLE_FILE) && path.endsWith(".tmp");
      if (lifecycleTemp) lifecycleOpens++;
      const terminalOpen = lifecycleTemp && lifecycleOpens === 2;
      if (terminalOpen && fault === "temp-open") throw injectedIo("terminal metadata temp open");
      if (flags === "r" && terminalPending && fault === "directory-open" && !terminalDirectoryFaulted) {
        terminalDirectoryFaulted = true;
        throw injectedIo("terminal metadata directory open");
      }
      const handle = await open(path, flags, mode);
      let terminalHandle = terminalOpen;
      return {
        async writeFile(data, encoding) {
          terminalHandle ||= lifecycleTemp && /\"status\":\"(?:completed|failed|cancelled)\"/.test(data);
          if (terminalHandle) {
            terminalPending = true;
            if (fault === "temp-write" || fault === "write+cleanup-unlink")
              throw injectedIo("terminal metadata temp write");
          }
          await handle.writeFile(data, encoding);
        },
        async sync() {
          if (terminalHandle && fault === "temp-sync") throw injectedIo("terminal metadata temp sync");
          if (flags === "r" && terminalPending && !terminalDirectoryFaulted
            && (fault === "directory-sync" || fault === "directory-sync+close")) {
            terminalDirectoryFaulted = true;
            throw injectedIo("terminal metadata directory sync");
          }
          await handle.sync();
        },
        async close() {
          await handle.close();
          if (terminalHandle && fault === "temp-close") throw injectedIo("terminal metadata temp close");
          if (flags === "r" && terminalPending && !terminalDirectoryFaulted
            && (fault === "directory-close" || fault === "directory-sync+close")) {
            terminalDirectoryFaulted = true;
            throw injectedIo("terminal metadata directory close");
          }
        },
      };
    },
    async rename(from, to) {
      if (terminalPending && to.endsWith(RUN_LIFECYCLE_FILE)
        && (fault === "rename" || fault === "rename+cleanup-unlink"))
        throw injectedIo("terminal metadata rename");
      await rename(from, to);
    },
    async unlink(path) {
      if (terminalPending && path.endsWith(".tmp")
        && (fault === "write+cleanup-unlink" || fault === "rename+cleanup-unlink"))
        throw injectedIo("terminal metadata temp cleanup unlink");
      await unlink(path);
    },
  };
};

type ReleaseFault =
  | "unlink"
  | "rename"
  | "directory-open"
  | "directory-sync"
  | "directory-close"
  | "directory-sync+close";
const releaseFaultFileSystem = (fault: ReleaseFault): RunRetentionMetadataFileSystem => {
  let tombstoneMoved = false;
  let faultAttempts = 0;
  return {
    async open(path, flags, mode) {
      if (fault === "directory-open" && tombstoneMoved && flags === "r" && ++faultAttempts <= 2)
        throw injectedIo("inactive tombstone directory open");
      const handle = await open(path, flags, mode);
      const faultThisDirectoryHandle = flags === "r" && tombstoneMoved
        && fault !== "directory-open" && ++faultAttempts <= 2;
      return {
        writeFile: (data, encoding) => handle.writeFile(data, encoding),
        async sync() {
          if ((fault === "directory-sync" || fault === "directory-sync+close") && faultThisDirectoryHandle)
            throw injectedIo("inactive tombstone directory sync");
          await handle.sync();
        },
        async close() {
          await handle.close();
          if ((fault === "directory-close" || fault === "directory-sync+close") && faultThisDirectoryHandle)
            throw injectedIo("inactive tombstone directory close");
        },
      };
    },
    async rename(from, to) {
      if (from.endsWith(RUN_ACTIVE_FILE)) {
        if (fault === "rename" && ++faultAttempts <= 2) throw injectedIo("inactive tombstone rename");
        await rename(from, to);
        tombstoneMoved = true;
        return;
      }
      await rename(from, to);
    },
    async unlink(path) {
      if (path.endsWith(RUN_ACTIVE_FILE)) throw injectedIo("active marker unlink");
      await unlink(path);
    },
  };
};

const managedStatusRun = async (
  status: ResultStatus,
  runRetention: ManagedRunStoreOptions,
  createRunNonce?: () => string,
): Promise<{ readonly result: ToolResult; readonly harness: ReturnType<typeof harness>; readonly journalRunId?: string }> => {
  let started!: () => void;
  const controllerStarted = new Promise<void>((resolve) => { started = resolve; });
  const never = new Promise<Cell>(() => {});
  const controller: ControllerDriver = {
    identity: { id: "test/retention-result-controller", version: "1", configuration: { status } },
    async next() {
      if (status === "failed") throw new Error("expected controller failure");
      if (status === "cancelled") { started(); return never; }
      return { reasoning: "done", code: "answer({ answer: 'done' })" };
    },
    fork() { return this; },
  };
  const backend: InterpreterBackend = {
    id: "retention-result-backend", version: "1",
    async evalCell(options) {
      options.effect("answer", { value: { answer: "done" } });
      return { kind: "value", result: undefined, hasResult: false, workspace: {}, workspaceInvalidPaths: [] };
    },
    async dispose() {},
  };
  const model: ModelClient = {
    id: "retention-result-model",
    identity: { id: "test/retention-result-model", version: "1", configuration: {} },
    async complete() { throw new Error("unexpected provider call"); },
  };
  const h = harness({ runtime: {
    resolveProfile: () => ({ ...DEFAULT_PROFILE, wallMs: 10_000 }),
    createBackend: () => backend,
    createModel: () => model,
    createController: () => controller,
    createRunNonce,
    runRetention,
  } });
  await h.startTurn(`Run managed ${status} fixture`);
  const owner = new AbortController();
  const pending = rlmTool(h).execute(`retention-${status}`, { objective: `Managed ${status}` }, owner.signal, undefined, h.ctx);
  if (status === "cancelled") { await controllerStarted; owner.abort(); }
  const result = await pending;
  const entries = await readdir(runRetention.root!);
  const retained = entries.find((entry) => entry.startsWith("run-") || entry.startsWith(".pi-rlm-quarantine-"));
  let journalRunId: string | undefined;
  if (retained) {
    try {
      const raw = await readFile(join(runRetention.root!, retained, "events.jsonl"), "utf8");
      const events = raw.trim().split("\n").flatMap((line) => {
        const parsed = JSON.parse(line) as RlmEvent | { events: RlmEvent[] };
        return "events" in parsed ? parsed.events : [parsed];
      });
      journalRunId = events.find((event) =>
        event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled")?.runId;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return { result, harness: h, journalRunId };
};

const assertCancelledJournal = async (dir: string): Promise<string> => {
  const raw = await readFile(join(dir, "events.jsonl"), "utf8");
  const events = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RlmEvent);
  expect(events.filter((event) =>
    event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled")).toEqual([
    expect.objectContaining({ type: "run_cancelled" }),
  ]);
  expect(events.filter((event) => event.type === "frame_closed")).toEqual([
    expect.objectContaining({ type: "frame_closed", state: "cancelled" }),
  ]);
  return raw;
};

const oldAmbientBypass = process.env["PI_RLM_ALLOW_UNSOLICITED"];
afterEach(() => {
  if (oldAmbientBypass === undefined) delete process.env["PI_RLM_ALLOW_UNSOLICITED"];
  else process.env["PI_RLM_ALLOW_UNSOLICITED"] = oldAmbientBypass;
});

const MANAGED_NAME = `run-${"a".repeat(32)}`;
const MANAGED_ID = `run_${"b".repeat(64)}`;
const MANAGED_HASH = "c".repeat(64);
const managementListing = (runName = MANAGED_NAME): ManagedRunListing => ({
  root: "/private/root",
  runs: [{
    name: runName, path: "/private/run", bytes: 10, activity: "inactive",
    metadata: {
      schemaVersion: 1, status: "completed", owner: "d".repeat(32), createdAtMs: 1, updatedAtMs: 2,
      runId: MANAGED_ID, terminalAtMs: 2,
    },
  }],
  issues: [], scannedBytes: 10, scannedEntries: 1,
}) as ManagedRunListing;
const managementPage = (request: RunInspectionRequest): RunInspectionPage => ({
  version: 1,
  runName: request.runName,
  runId: MANAGED_ID,
  manifestHash: MANAGED_HASH,
  journalPrefixSha256: "e".repeat(64),
  eventCount: 1,
  view: request.view,
  items: request.view === "summary" ? [{
    kind: "summary", status: "completed", rootFrameId: `${MANAGED_ID}:f0`, eventCount: 1,
    frames: 1, cells: 0, committedCalls: 0, observedProviderAttempts: 0, completionMode: "answer",
  }] : [],
  serializedBytes: 1,
});

describe("pi-rlm extension wiring", () => {
  test("registers separated launcher guidance and launch surfaces", () => {
    const tools: CapturedTool[] = [];
    const commands: string[] = [];
    register({
      registerTool: (definition: CapturedTool) => tools.push(definition),
      registerCommand: (name: string) => commands.push(name),
      on: () => {},
      appendEntry: () => "entry",
    } as never);
    const tool = tools.find((candidate) => candidate.name === "rlm_run")!;
    expect(commands).toContain("rlm");
    expect(LAUNCH_SNIPPET).toContain("always requires exact-request host confirmation");
    expect(tool.promptSnippet).toContain("explicitly requested");
    expect(tool.promptGuidelines?.every((guideline) => guideline.includes("rlm_run"))).toBe(true);
  });

  test("tool render adapters never expose raw content when details are hostile", () => {
    const h = harness();
    const tool = rlmTool(h);
    expect(tool.renderCall!({}, {}, {}).render(40)).toEqual(["RLM run"]);
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("raw answer"); } });
    const result = new Proxy({ content: [{ type: "text", text: "RAW SECRET" }] }, {
      getOwnPropertyDescriptor: () => { throw new Error("raw result"); },
    });
    expect(() => tool.renderResult!(result, {}, {}, {}).render(80)).not.toThrow();
    expect(tool.renderResult!(result, {}, {}, {}).render(80)).toEqual(["RLM failed · RLM_RESULT_INVALID"]);
    expect(tool.renderResult!({ details: hostile }, {}, {}, {}).render(80).join("\n")).not.toContain("RAW");
  });

  test("widget installs only in TUI mode and disposes on session replacement", async () => {
    const rpc = harness();
    rpc.setMode("rpc");
    await rpc.emit("session_start", { reason: "startup" });
    expect(rpc.widgets).toHaveLength(0);

    const coordinator = createRunCoordinator();
    const tui = harness({ runCoordinator: coordinator });
    await tui.emit("session_start", { reason: "startup" });
    expect(tui.widgets).toHaveLength(1);
    let renders = 0;
    const factory = tui.widgets[0]?.content as (tui: { requestRender(): void }) => { render(width: number): string[] };
    const widget = factory({ requestRender: () => { renders += 1; } });
    coordinator.setSession("session-1", 1);
    coordinator.create({ sessionId: "session-1", authorizationGeneration: 1, objective: "active" });
    expect(renders).toBe(1);
    expect(widget.render(80)[0]).toContain("RLM running");
    await tui.emit("session_before_switch");
    expect(widget.render(80)).toEqual([]);
    expect(tui.widgets.at(-1)?.content).toBeUndefined();
    expect(renders).toBe(3);

    tui.setWidgetFault(true);
    await expect(tui.emit("session_start", { reason: "resume" })).resolves.toBeUndefined();
  });

  test("one unrefed refresh timer exists only for a live TUI widget and cleans every boundary", async () => {
    const coordinator = createRunCoordinator();
    let callback: (() => void) | undefined;
    let starts = 0;
    let clears = 0;
    let unrefs = 0;
    const timer = { unref: () => { unrefs += 1; } } as unknown as ReturnType<typeof setInterval>;
    const h = harness({
      runCoordinator: coordinator,
      setUiInterval: (value, intervalMs) => {
        starts += 1; callback = value; expect(intervalMs).toBe(1_000); return timer;
      },
      clearUiInterval: (value) => { expect(value).toBe(timer); clears += 1; callback = undefined; },
    });
    await h.emit("session_start", { reason: "startup" });
    let renders = 0;
    const factory = h.widgets[0]?.content as (tui: { requestRender(): void }) => {
      dispose?(): void; render(width: number): string[];
    };
    const widget = factory({ requestRender: () => { renders += 1; } });
    coordinator.setSession("session-1", 0);
    const first = coordinator.create({ sessionId: "session-1", authorizationGeneration: 0, objective: "active" });
    expect({ starts, unrefs }).toEqual({ starts: 1, unrefs: 1 });
    callback?.();
    expect(renders).toBeGreaterThan(1);
    first.fail();
    expect(clears).toBe(1);

    coordinator.create({ sessionId: "session-1", authorizationGeneration: 0, objective: "again" });
    expect(starts).toBe(2);
    widget.dispose?.();
    expect(clears).toBe(2);
    expect(factory({ requestRender() {} }).render(80)).toEqual([]);
    expect(starts).toBe(2);

    for (const mode of ["rpc", "print", "json"] as const) {
      let nonTuiStarts = 0;
      const isolated = harness({ setUiInterval: () => { nonTuiStarts += 1; return timer; } });
      isolated.setMode(mode);
      await isolated.emit("session_start", { reason: "startup" });
      expect(isolated.widgets).toHaveLength(0);
      expect(nonTuiStarts).toBe(0);
    }

    for (const [event, payload] of [
      ["session_before_fork", { entryId: "entry", position: "at" }],
      ["session_start", { reason: "resume" }],
      ["session_shutdown", {}],
    ] as const) {
      const boundaryCoordinator = createRunCoordinator();
      boundaryCoordinator.setSession("session-1", 0);
      boundaryCoordinator.create({ sessionId: "session-1", authorizationGeneration: 0, objective: event });
      let boundaryClears = 0;
      const boundary = harness({
        runCoordinator: boundaryCoordinator,
        setUiInterval: () => timer,
        clearUiInterval: () => { boundaryClears += 1; },
      });
      await boundary.emit("session_start", { reason: "startup" });
      const boundaryFactory = boundary.widgets[0]?.content as (tui: { requestRender(): void }) => unknown;
      boundaryFactory({ requestRender() {} });
      await boundary.emit(event, payload);
      expect(boundaryClears).toBe(1);
    }
  });

  test("refresh publication, throwing renders, and stale factories cannot orphan timers", async () => {
    const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;

    const reentrantCoordinator = createRunCoordinator();
    reentrantCoordinator.setSession("session-1", 0);
    const reentrantRun = reentrantCoordinator.create({
      sessionId: "session-1", authorizationGeneration: 0, objective: "race",
    });
    let reentrantClears = 0;
    const reentrant = harness({
      runCoordinator: reentrantCoordinator,
      setUiInterval: () => { reentrantRun.fail(); return timer; },
      clearUiInterval: () => { reentrantClears += 1; },
    });
    await reentrant.emit("session_start", { reason: "startup" });
    const reentrantFactory = reentrant.widgets[0]?.content as (tui: { requestRender(): void }) => unknown;
    reentrantFactory({ requestRender() {} });
    expect(reentrantClears).toBe(1);

    const throwingCoordinator = createRunCoordinator();
    let throwingClears = 0;
    const throwing = harness({
      runCoordinator: throwingCoordinator,
      setUiInterval: () => timer,
      clearUiInterval: () => { throwingClears += 1; },
    });
    await throwing.emit("session_start", { reason: "startup" });
    const throwingFactory = throwing.widgets[0]?.content as
      (tui: { requestRender(): void }) => { dispose(): void };
    const throwingWidget = throwingFactory({ requestRender: () => { throw new Error("render failed"); } });
    throwingCoordinator.setSession("session-1", 0);
    expect(() => throwingCoordinator.create({
      sessionId: "session-1", authorizationGeneration: 0, objective: "active",
    })).not.toThrow();
    expect(() => throwingWidget.dispose()).toThrow("render failed");
    expect(throwingClears).toBe(1);

    const stale = harness({ setUiInterval: () => { throw new Error("stale timer"); } });
    await stale.emit("session_start", { reason: "startup" });
    const staleFactory = stale.widgets[0]?.content as
      (tui: { requestRender(): void }) => { render(width: number): string[] };
    await stale.emit("session_before_switch");
    expect(staleFactory({ requestRender() {} }).render(80)).toEqual([]);

    const unrefCoordinator = createRunCoordinator();
    let unrefClears = 0;
    const unrefFailure = harness({
      runCoordinator: unrefCoordinator,
      setUiInterval: () => ({ unref: () => { throw new Error("unref failed"); } }),
      clearUiInterval: () => { unrefClears += 1; },
    });
    await unrefFailure.emit("session_start", { reason: "startup" });
    const unrefFactory = unrefFailure.widgets[0]?.content as (tui: { requestRender(): void }) => unknown;
    unrefFactory({ requestRender() {} });
    unrefCoordinator.setSession("session-1", 0);
    unrefCoordinator.create({ sessionId: "session-1", authorizationGeneration: 0, objective: "active" });
    expect(unrefClears).toBe(1);
  });

  test("management handlers integrate runs, inspect, and exact current local cancellation authority", async () => {
    const coordinator = createRunCoordinator({ createLocalId: () => "rlm_local", createControlToken: () => "t".repeat(32) });
    coordinator.setSession("session-1", 0);
    const owned = coordinator.create({ sessionId: "session-1", authorizationGeneration: 0, objective: "current" });
    owned.bindRunName(MANAGED_NAME);
    owned.bindRunId(MANAGED_ID);
    let listings = 0;
    const requests: RunInspectionRequest[] = [];
    const h = harness({
      runCoordinator: coordinator,
      listManagedRuns: async () => { listings += 1; return managementListing(); },
      inspectManagedRunPage: async (request) => { requests.push(request); return managementPage(request); },
    });
    h.setCustomBehavior((component, _done, _reject, call) => {
      component.handleInput?.(call === 1 ? "\r" : "\u001b");
    });
    await h.commands.get("rlm")!.handler("runs", h.ctx);
    expect(listings).toBe(2);
    expect(requests).toEqual([{ version: 1, runName: MANAGED_NAME, view: "summary", pageSize: 50 }]);
    expect(h.customCalls).toBe(3);
    expect(h.runs).toHaveLength(0);

    await h.commands.get("rlm")!.handler(`cancel ${MANAGED_NAME}`, h.ctx);
    await h.commands.get("rlm")!.handler(`cancel ${MANAGED_ID}`, h.ctx);
    expect(owned.signal.aborted).toBe(false);
    await h.commands.get("rlm")!.handler("cancel rlm_local", h.ctx);
    expect(owned.signal.aborted).toBe(true);

    await h.emit("session_before_switch", { reason: "resume" });
    const before = requests.length;
    await h.commands.get("rlm")!.handler("inspect rlm_local", h.ctx);
    expect(requests).toHaveLength(before);
    expect(h.notifications.at(-1)).toContain("exact managed name or bound local alias");
  });

  test("navigator refresh authorizes selection against the refreshed bounded snapshot", async () => {
    const refreshedName = `run-${"f".repeat(32)}`;
    let listings = 0;
    const requests: RunInspectionRequest[] = [];
    const h = harness({
      listManagedRuns: async () => managementListing(++listings === 1 ? MANAGED_NAME : refreshedName),
      inspectManagedRunPage: async (request) => { requests.push(request); return managementPage(request); },
    });
    h.setCustomBehavior((component, _done, _reject, call) => {
      if (call !== 1) { component.handleInput?.("\u001b"); return; }
      component.handleInput?.("r");
      void (async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
        component.handleInput?.("\r");
      })();
    });
    await h.commands.get("rlm")!.handler("runs", h.ctx);
    expect(requests[0]?.runName).toBe(refreshedName);
    expect(h.customCalls).toBe(3);
  });

  test("management mode, routing, hostile custom results, and UI failures fail closed without launch fallback", async () => {
    let listings = 0;
    let inspections = 0;
    const h = harness({
      listManagedRuns: async () => { listings += 1; return managementListing(); },
      inspectManagedRunPage: async (request) => { inspections += 1; return managementPage(request); },
    });
    h.setMode("print");
    await h.commands.get("rlm")!.handler("runs", h.ctx);
    await h.commands.get("rlm")!.handler(`inspect ${MANAGED_NAME}`, h.ctx);
    expect(listings).toBe(0);
    expect(inspections).toBe(0);
    expect(h.customCalls).toBe(0);

    h.setMode("tui");
    for (const malformed of ["runs/extra", "inspect:bad", "cancel\u200b rlm_local", "launch\u0000payload"])
      await h.commands.get("rlm")!.handler(malformed, h.ctx);
    expect(h.runs).toHaveLength(0);

    h.setCustomBehavior((_component, done) => { done(undefined); });
    await expect(h.commands.get("rlm")!.handler("runs", h.ctx)).resolves.toBeUndefined();
    h.setCustomBehavior((_component, done) => {
      done(new Proxy({ type: "inspect", runName: MANAGED_NAME }, { get() { throw new Error("trap"); } }));
    });
    await expect(h.commands.get("rlm")!.handler("runs", h.ctx)).resolves.toBeUndefined();
    h.setCustomBehavior((_component, _done, reject) => { reject(new Error("custom rejected")); });
    await expect(h.commands.get("rlm")!.handler("runs", h.ctx)).resolves.toBeUndefined();
    expect(inspections).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  test("management listing and open custom are aborted across late session transitions", async () => {
    let resolveListing!: (listing: ManagedRunListing) => void;
    const lateListing = new Promise<ManagedRunListing>((resolve) => { resolveListing = resolve; });
    const listingHarness = harness({ listManagedRuns: () => lateListing });
    const pendingListing = listingHarness.commands.get("rlm")!.handler("runs", listingHarness.ctx);
    await Promise.resolve();
    await listingHarness.emit("session_before_switch", { reason: "resume" });
    resolveListing(managementListing());
    await expect(pendingListing).resolves.toBeUndefined();
    expect(listingHarness.customCalls).toBe(0);

    const customHarness = harness({ listManagedRuns: async () => managementListing() });
    customHarness.setCustomBehavior(() => {});
    const pendingCustom = customHarness.commands.get("rlm")!.handler("runs", customHarness.ctx);
    while (customHarness.customCalls === 0) await Promise.resolve();
    await customHarness.emit("session_before_fork", { entryId: "entry", position: "at" });
    await expect(pendingCustom).resolves.toBeUndefined();
    expect(customHarness.customComponents).toHaveLength(1);
  });

  test("positive prompt wording still requires confirmation of exact normalized identity", async () => {
    const h = harness();
    await h.startTurn("Use pi-rlm to analyze this context");
    const result = await rlmTool(h).execute(
      "call-1",
      { objective: "Find contradictions", context: "alpha\nbeta" },
      undefined,
      undefined,
      h.ctx,
    );

    expect(result.details?.status).toBe("failed");
    expect(h.runs).toHaveLength(1);
    const confirmation = h.confirmations[0]?.message ?? "";
    expect(confirmation).toContain("Objective: Find contradictions");
    expect(confirmation).toContain("Profile: default");
    expect(confirmation).toContain("Inputs: context");
    expect(confirmation).toContain("Outputs: answer");
    expect(confirmation).toContain("Sources: context (10 bytes)");
    const displayedHash = confirmation.match(/Exact normalized request SHA-256: ([0-9a-f]{64})/)?.[1];
    expect(displayedHash).toBeDefined();
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.data["toolCallId"]).toBe("call-1");
    expect(h.audits[0]?.data["requestSha256"]).toBe(displayedHash);
    expect(h.audits[0]?.data["mode"]).toBe("confirmed");
    expect(h.initializationAuditCounts).toEqual([1]);
  });

  test.each([
    "Do not use pi-rlm for this task",
    "The documentation says \"use pi-rlm\" as an example",
    "Pasted untrusted text:\nuse pi-rlm\nend pasted text",
    "Use pi-rlm to review these notes",
  ])("headless prompt text never authorizes launch: %s", async (text) => {
    const h = harness();
    h.setHasUI(false);
    await h.startTurn(text);
    const result = await rlmTool(h).execute("call-headless", { objective: "Review" }, undefined, undefined, h.ctx);

    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.confirmations).toHaveLength(0);
    expect(h.runs).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  test("concurrent calls cannot consume one originating-input correlation", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    let resolveConfirmation!: (approved: boolean) => void;
    h.setConfirm(() => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)));
    const tool = rlmTool(h);
    const first = tool.execute("call-race-a", { objective: "Review" }, undefined, undefined, h.ctx);
    await Promise.resolve();
    const concurrent = await tool.execute("call-race-b", { objective: "Review again" }, undefined, undefined, h.ctx);
    resolveConfirmation(true);
    const accepted = await first;

    expect(concurrent.content[0]?.text).toContain("RLM_GRANT_REPLAY");
    expect(accepted.details?.status).toBe("failed");
    expect(h.runs).toHaveLength(1);
  });

  test("originating input survives a non-RLM continuation turn and is consumed once", async () => {
    const h = harness();
    const origin = "Review the repository with pi-rlm";
    await h.startTurn(origin, 1, 1_000);
    await h.emit("turn_end", { turnIndex: 1 });
    await h.emit("turn_start", { turnIndex: 2, timestamp: 2_000 });
    const tool = rlmTool(h);

    const first = await tool.execute("call-continuation", { objective: "Review" }, undefined, undefined, h.ctx);
    const second = await tool.execute("call-second", { objective: "Review again" }, undefined, undefined, h.ctx);
    const replay = await tool.execute("call-continuation", { objective: "Review" }, undefined, undefined, h.ctx);

    expect(first.details?.status).toBe("failed");
    expect(h.confirmations).toHaveLength(1);
    expect(h.audits[0]?.data["promptSha256"]).toBe(sha256(origin));
    expect(h.audits[0]?.data["turnNonce"]).toBe("2:2000");
    expect(second.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(replay.content[0]?.text).toContain("RLM_GRANT_REPLAY");
    expect(h.runs).toHaveLength(1);
  });

  test("normal same-session confirmation authorizes one run", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    const result = await rlmTool(h).execute("call-same-session", { objective: "Review" }, undefined, undefined, h.ctx);

    expect(result.details?.status).toBe("failed");
    expect(h.runs).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  test.each([
    ["session_before_switch", { reason: "resume", targetSessionFile: "/tmp/session-2.jsonl" }],
    ["session_before_fork", { entryId: "entry-1", position: "at" }],
  ])("%s invalidates pending confirmation even when the original session ID is restored", async (eventName, event) => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    let resolveConfirmation!: (approved: boolean) => void;
    h.setConfirm(() => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)));
    const pending = rlmTool(h).execute("call-transition", { objective: "Review" }, undefined, undefined, h.ctx);
    await Promise.resolve();

    await h.emit(eventName, event);
    h.setSessionId("session-2");
    h.setSessionId("session-1");
    resolveConfirmation(true);
    const result = await pending;

    expect(result.content[0]?.text).toContain("RLM_GRANT_GENERATION_MISMATCH");
    expect(h.runs).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  test.each(["new", "resume", "fork"])(
    "session_start reason %s invalidates pending confirmation even when the original session ID is restored",
    async (reason) => {
      const h = harness();
      await h.startTurn("Analyze this normally");
      let resolveConfirmation!: (approved: boolean) => void;
      h.setConfirm(() => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)));
      const pending = rlmTool(h).execute("call-session-start", { objective: "Review" }, undefined, undefined, h.ctx);
      await Promise.resolve();

      h.setSessionId("session-2");
      await h.emit("session_start", { reason, previousSessionFile: "/tmp/session-1.jsonl" });
      h.setSessionId("session-1");
      resolveConfirmation(true);
      const result = await pending;

      expect(result.content[0]?.text).toContain("RLM_GRANT_GENERATION_MISMATCH");
      expect(h.runs).toHaveLength(0);
      expect(h.audits).toHaveLength(0);
    },
  );

  test("session mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    h.setConfirm(() => {
      h.setSessionId("session-2");
      return true;
    });
    const result = await rlmTool(h).execute("call-session", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_SESSION_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("turn mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally", 1, 1_000);
    h.setConfirm(async () => {
      await h.emit("turn_start", { turnIndex: 2, timestamp: 2_000 });
      return true;
    });
    const result = await rlmTool(h).execute("call-turn", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_TURN_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("prompt mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Original prompt", 1, 1_000);
    h.setConfirm(async () => {
      await h.emit("input", { text: "Changed prompt", source: "interactive" });
      await h.emit("turn_start", { turnIndex: 1, timestamp: 1_000 });
      return true;
    });
    const result = await rlmTool(h).execute("call-prompt", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_PROMPT_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("request mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    const params = { objective: "Approved objective", context: "source" };
    h.setConfirm(() => {
      params.objective = "Mutated objective";
      return true;
    });
    const result = await rlmTool(h).execute("call-request", params, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_REQUEST_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("post-confirm nested source mutation cannot change the approved program", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    const params = {
      program: {
        objective: "Review routes",
        inputs: [{ name: "routes", adapter: "text", description: "Routes" }],
        outputs: [{ name: "answer", schema: { type: "string" } }],
        profile: "default",
      },
      sources: { routes: "before" },
    };
    h.setConfirm(() => {
      params.sources.routes = "after";
      return true;
    });
    const result = await rlmTool(h).execute("call-mutation", params, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_REQUEST_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("confirmation denial consumes no authority and starts no run", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    h.setConfirm(() => false);
    const result = await rlmTool(h).execute("call-denied", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.runs).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  test("expired input correlation fails closed before initialization", async () => {
    const h = harness({ ttl: 10 });
    await h.startTurn("Analyze this normally", 1, 1_000);
    await h.emit("turn_end", { turnIndex: 1 });
    h.setClock(111);
    await h.emit("turn_start", { turnIndex: 2, timestamp: 2_000 });
    const result = await rlmTool(h).execute("call-expired", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.runs).toHaveLength(0);
  });

  test("/rlm mints, consumes, and audits its own one-shot command grant", async () => {
    const h = harness();
    await h.commands.get("rlm")!.handler('{"objective":"Summarize the notes","context":"fixture notes"}', h.ctx);
    expect(h.runs).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.data["mode"]).toBe("slash_command");
    expect(h.audits[0]?.data["toolCallId"]).toMatch(/^command:host-/);
  });

  test("a command transition during capture launches and delivers nothing into the replacement", async () => {
    const h = harness();
    const pending = h.commands.get("rlm")!.handler('{"objective":"Review","context":"source"}', h.ctx);
    await h.emit("session_before_switch", { reason: "resume" });
    h.setSessionId("session-2");
    await pending;
    expect(h.runs).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(h.resultEntries).toHaveLength(0);
    expect(h.resultMessages).toHaveLength(0);
  });

  test("a command transition locally settles an abort-ignoring seam before its late result", async () => {
    let resolveRun!: (result: RunResult) => void;
    const pendingRun = new Promise<RunResult>((resolve) => { resolveRun = resolve; });
    const coordinator = createRunCoordinator();
    const h = harness({ executeRun: async () => pendingRun, runCoordinator: coordinator });
    const pending = h.commands.get("rlm")!.handler('{"objective":"Review","context":"source"}', h.ctx);
    while (h.runs.length === 0) await Promise.resolve();
    await h.emit("session_before_fork", { entryId: "entry-1", position: "at" });
    h.setSessionId("session-2");
    await pending;
    const cancelled = coordinator.list()[0];
    expect(cancelled?.terminal).toMatchObject({ status: "cancelled", errorCode: "CANCELLED" });
    resolveRun({ ...failedRun, runId: `run_${"a".repeat(64)}` });
    await Promise.resolve();
    expect(coordinator.list()[0]).toEqual(cancelled);
    expect(h.runs).toHaveLength(1);
    expect(h.resultEntries).toHaveLength(0);
    expect(h.resultMessages).toHaveLength(0);
  });

  test("command active-run limit returns one bounded structured result", async () => {
    const coordinator = createRunCoordinator();
    coordinator.setSession("session-1", 0);
    for (let index = 0; index < RUN_COORDINATOR_MAX_ACTIVE; index++) {
      coordinator.create({ sessionId: "session-1", authorizationGeneration: 0, objective: `active ${index}` });
    }
    const h = harness({ runCoordinator: coordinator });
    await h.commands.get("rlm")!.handler('{"objective":"Review","context":"source"}', h.ctx);
    expect(h.runs).toHaveLength(0);
    expect(h.resultEntries).toHaveLength(1);
    expect(h.resultMessages).toHaveLength(1);
    expect(h.resultMessages[0]?.message["content"]).toContain("RLM_RUN_LIMIT");
  });

  test("launch audit failure is bounded, launches no run, and does not expose raw errors", async () => {
    const coordinator = createRunCoordinator();
    const h = harness({ runCoordinator: coordinator });
    h.setAppendFaultType("pi-rlm-launch-grant");
    await h.commands.get("rlm")!.handler('{"objective":"Review","context":"source"}', h.ctx);
    expect(h.runs).toHaveLength(0);
    expect(h.resultMessages).toHaveLength(1);
    expect(h.resultMessages[0]?.message["content"]).toContain("RLM_AUDIT_FAILED");
    expect(JSON.stringify(h.resultMessages)).not.toContain("/private/host/path");
    expect(coordinator.list()[0]?.terminal?.errorCode).toBe("RLM_AUDIT_FAILED");
  });

  test("command source failure retains its exact early phase and terminal code", async () => {
    const coordinator = createRunCoordinator();
    const phases: string[] = [];
    coordinator.subscribe((runs) => {
      const phase = runs[0]?.progress?.phase;
      if (phase) phases.push(phase);
    });
    const h = harness({ runCoordinator: coordinator });
    await h.commands.get("rlm")!.handler("--file /definitely/missing -- Review", h.ctx);
    expect(phases).toContain("source_capture");
    expect(coordinator.list()[0]?.terminal?.errorCode).toBe("RLM_SOURCE_INVALID");
  });

  test("confirmation and tool audit exceptions return structured results without launch", async () => {
    const confirmation = harness();
    await confirmation.startTurn("Use pi-rlm");
    confirmation.setConfirm(() => Promise.reject(new Error("/private/confirm/path")));
    const confirmationResult = await rlmTool(confirmation).execute("confirm-fault", { objective: "Review" }, undefined, undefined, confirmation.ctx);
    expect(confirmationResult.content[0]?.text).toContain("RLM_CONFIRMATION_FAILED");
    expect(confirmation.runs).toHaveLength(0);
    expect(confirmationResult.content[0]?.text).not.toContain("/private/confirm/path");

    const audited = harness();
    await audited.startTurn("Use pi-rlm");
    audited.setAppendFaultType("pi-rlm-launch-grant");
    const auditResult = await rlmTool(audited).execute("audit-fault", { objective: "Review" }, undefined, undefined, audited.ctx);
    expect(auditResult.content[0]?.text).toContain("RLM_AUDIT_FAILED");
    expect(audited.runs).toHaveLength(0);
  });

  test("removed ambient bypass cannot authorize a headless call", async () => {
    process.env["PI_RLM_ALLOW_UNSOLICITED"] = "1";
    const h = harness();
    h.setHasUI(false);
    await h.startTurn("Use pi-rlm to review");
    const result = await rlmTool(h).execute("call-ambient", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.runs).toHaveLength(0);
  });

  test("tool cancellation during confirmation mints no grant and starts no runtime", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    let resolveConfirmation!: (approved: boolean) => void;
    h.setConfirm(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }));
    const owner = new AbortController();
    const pending = rlmTool(h).execute("call-cancel-confirm", { objective: "Review" }, owner.signal, undefined, h.ctx);
    await Promise.resolve();
    owner.abort();
    const result = await pending;
    resolveConfirmation(true);
    await Promise.resolve();

    expect(result.content[0]?.text).toContain("RLM_CANCELLED");
    expect(h.runs).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  test("tool execute signal owns the authorized run and consumed calls cannot replay", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    const owner = new AbortController();
    const tool = rlmTool(h);
    const first = await tool.execute("call-owned", { objective: "Review" }, owner.signal, undefined, h.ctx);
    owner.abort();
    const replay = await tool.execute("call-owned", { objective: "Review" }, new AbortController().signal, undefined, h.ctx);

    expect(first.details?.status).toBe("failed");
    expect(h.runSignals).toEqual([owner.signal]);
    expect(replay.content[0]?.text).toContain("RLM_GRANT_REPLAY");
    expect(h.runs).toHaveLength(1);
  });

  test("opaque runtime identity fails before extension-owned directory creation", async () => {
    let directoryCalls = 0;
    const backend: InterpreterBackend = {
      id: "preflight-backend", version: "1",
      async evalCell() { throw new Error("unused"); },
      async dispose() {},
    };
    const opaqueModel = { id: "opaque", async complete() { throw new Error("unused"); } } as unknown as ModelClient;
    const controller: ControllerDriver = {
      identity: { id: "test/preflight-controller", version: "1", configuration: {} },
      async next() { throw new Error("unused"); },
      fork() { return this; },
    };
    const h = harness({ runtime: {
      createBackend: () => backend,
      createModel: () => opaqueModel,
      createController: () => controller,
      createRunDirectory: async () => { directoryCalls++; return mkdtemp(join(tmpdir(), "must-not-create-")); },
    } });
    await h.startTurn("Use pi-rlm for this preflight run");
    const result = await rlmTool(h).execute("call-preflight", { objective: "Preflight" }, undefined, undefined, h.ctx);
    expect(result.details?.status).toBe("failed");
    expect(directoryCalls).toBe(0);
  });

  test("tool signal cancels the production executeRun path with one closed terminal and no late commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-extension-tool-"));
    const offline = pendingOfflineRuntime(dir);
    const coordinator = createRunCoordinator();
    const phases: string[] = [];
    coordinator.subscribe((runs) => {
      const phase = runs[0]?.progress?.phase;
      if (phase) phases.push(phase);
    });
    const h = harness({ runtime: offline.dependencies, runCoordinator: coordinator });
    await h.startTurn("Use pi-rlm for this offline run");
    const owner = new AbortController();
    const pending = rlmTool(h).execute("call-real-cancel", { objective: "Wait offline" }, owner.signal, undefined, h.ctx);
    await offline.started;
    owner.abort();
    const result = await pending;

    expect(result.details?.status).toBe("cancelled");
    expect(phases).toEqual(expect.arrayContaining(["initializing", "allocating", "manifest"]));
    await expect(readFile(join(dir, "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    offline.resolveLate({ reasoning: "late", code: "answer({ answer: 'late' })" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(readFile(join(dir, "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["session_before_switch", { reason: "resume", targetSessionFile: "/tmp/next.jsonl" }],
    ["session_before_fork", { entryId: "entry-1", position: "at" }],
    ["session_start", { reason: "new", previousSessionFile: "/tmp/previous.jsonl" }],
    ["session_shutdown", {}],
  ])("%s cancels a real pending /rlm run without late commits", async (eventName, event) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-extension-command-"));
    const offline = pendingOfflineRuntime(dir);
    const h = harness({ runtime: offline.dependencies });
    const pending = h.commands.get("rlm")!.handler('{"objective":"Wait offline","context":"fixture"}', h.ctx);
    await offline.started;
    await h.emit(eventName, event);
    await pending;

    expect(h.resultMessages).toHaveLength(0);
    await expect(readFile(join(dir, "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    offline.resolveLate({ reasoning: "late", code: "answer({ answer: 'late' })" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(readFile(join(dir, "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  const RETENTION_FAULT_TEST_TIMEOUT_MS = 15_000;
  const metadataFaultCases = (["completed", "failed", "cancelled"] as const)
    .flatMap((status) => ([
      "temp-open",
      "temp-write",
      "temp-sync",
      "temp-close",
      "rename",
      "directory-open",
      "directory-sync",
      "directory-close",
      "write+cleanup-unlink",
      "rename+cleanup-unlink",
      "directory-sync+close",
    ] as const).map((fault) => [status, fault] as const));
  test.each(metadataFaultCases)(
    "authoritative %s result survives terminal metadata %s failure with one warning",
    async (status, fault) => {
      const stateRoot = await mkdtemp(join(tmpdir(), "pi-rlm-retention-result-"));
      const { result, harness: h, journalRunId } = await managedStatusRun(status, {
        root: stateRoot,
        metadataFileSystem: metadataFaultFileSystem(fault),
      });
      expect(result.details?.status).toBe(status);
      expect(journalRunId).toMatch(/^run_[a-f0-9]{64}$/);
      const text = result.content[0]?.text ?? "";
      expect(text.match(/RETENTION_METADATA_FAILED/g)).toHaveLength(1);
      expect(text).toContain('"warningCodes":["RETENTION_METADATA_FAILED"]');
      expect(text).not.toContain("failed before producing a result");
      const warningAudit = h.audits.find((entry) => entry.type === "pi-rlm-run-warnings");
      expect(warningAudit?.data["runId"]).toBe(journalRunId);
      expect(warningAudit?.data["status"]).toBe(status);
      expect((warningAudit?.data["codes"] as string[]).filter((code) => code === "RETENTION_METADATA_FAILED")).toHaveLength(1);
      const listing = await new ManagedRunStore({ root: stateRoot }).list();
      expect(listing.runs).toHaveLength(1);
      expect(listing.runs[0]?.activity).not.toBe("owned");
      await expect(readFile(join(listing.runs[0]!.path, RUN_ACTIVE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await new ManagedRunStore({
        root: stateRoot,
        policy: { abandonedGraceMs: 0 },
      }).cleanup({ force: true })).deleted).toEqual([listing.runs[0]!.name]);
    },
    RETENTION_FAULT_TEST_TIMEOUT_MS,
  );

  const releaseFaultCases = (["completed", "failed", "cancelled"] as const)
    .flatMap((status) => ([
      "unlink",
      "rename",
      "directory-open",
      "directory-sync",
      "directory-close",
      "directory-sync+close",
    ] as const).map((fault) => [status, fault] as const));
  test.each(releaseFaultCases)(
    "authoritative %s result survives active-marker release %s fault",
    async (status, fault) => {
      const stateRoot = await mkdtemp(join(tmpdir(), "pi-rlm-retention-release-"));
      const { result, harness: h, journalRunId } = await managedStatusRun(status, {
        root: stateRoot,
        metadataFileSystem: releaseFaultFileSystem(fault),
      });
      expect(result.details?.status).toBe(status);
      expect(journalRunId).toMatch(/^run_[a-f0-9]{64}$/);
      const text = result.content[0]?.text ?? "";
      const warnings = text.match(/RETENTION_METADATA_FAILED/g) ?? [];
      expect(warnings).toHaveLength(fault === "unlink" ? 0 : 1);
      const expectedCodes = fault === "unlink" ? []
        : fault === "rename" ? ["RETENTION_METADATA_FAILED"]
          : ["RETENTION_METADATA_FAILED", "RETENTION_CLEANUP_FAILED"];
      expect(text).toContain(`"warningCodes":${JSON.stringify(expectedCodes)}`);
      const warningAudit = h.audits.find((entry) => entry.type === "pi-rlm-run-warnings");
      expect(warningAudit?.data["codes"] ?? []).toEqual(expectedCodes);
      const listing = await new ManagedRunStore({ root: stateRoot }).list();
      expect(listing.runs).toHaveLength(1);
      const entries = await readdir(listing.runs[0]!.path);
      if (fault === "unlink") {
        expect(listing.runs[0]?.activity).toBe("inactive");
      } else if (fault === "rename") {
        expect(listing.runs[0]?.activity).toBe("inactive");
        expect(entries).toContain(`${RUN_INACTIVE_FILE_PREFIX}${listing.runs[0]!.metadata.owner}.json`);
      } else {
        expect(["owned", "inactive"]).toContain(listing.runs[0]?.activity);
        expect(entries).not.toContain(RUN_ACTIVE_FILE);
        expect(entries).toContain(`${RUN_INACTIVE_FILE_PREFIX}${listing.runs[0]!.metadata.owner}.json`);
      }
    },
    RETENTION_FAULT_TEST_TIMEOUT_MS,
  );

  const cleanupFaultCases = (["completed", "failed", "cancelled"] as const)
    .flatMap((status) => (["scan", "delete"] as const).map((fault) => [status, fault] as const));
  test.each(cleanupFaultCases)(
    "authoritative %s result survives post-run cleanup %s failure with one warning",
    async (status, fault) => {
      const stateRoot = await mkdtemp(join(tmpdir(), "pi-rlm-retention-result-"));
      const retention: ManagedRunStoreOptions = fault === "scan"
        ? { root: stateRoot, policy: { maxScanEntries: 1 } }
        : {
            root: stateRoot,
            policy: { terminalMaxAgeMs: 0 },
            removeDirectory: async () => { throw Object.assign(new Error("injected delete failure"), { code: "EIO" }); },
          };
      const { result, harness: h, journalRunId } = await managedStatusRun(status, retention);
      expect(result.details?.status).toBe(status);
      expect(journalRunId).toMatch(/^run_[a-f0-9]{64}$/);
      const text = result.content[0]?.text ?? "";
      expect(text.match(/RETENTION_CLEANUP_FAILED/g)).toHaveLength(1);
      expect(text).not.toContain("failed before producing a result");
      const warningAudit = h.audits.find((entry) => entry.type === "pi-rlm-run-warnings");
      expect(warningAudit?.data["runId"]).toBe(journalRunId);
      expect(warningAudit?.data["status"]).toBe(status);
      expect((warningAudit?.data["codes"] as string[]).filter((code) => code === "RETENTION_CLEANUP_FAILED")).toHaveLength(1);
    },
    RETENTION_FAULT_TEST_TIMEOUT_MS,
  );

  test("invalid pre-manifest nonce quarantines its unexposed writer genesis", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-rlm-invalid-nonce-"));
    const { result } = await managedStatusRun("failed", { root: stateRoot }, () => " invalid nonce ");
    expect(result.details?.status).toBe("failed");
    expect((await new ManagedRunStore({ root: stateRoot }).list()).runs).toEqual([]);
  });

  test.each([
    "unlink",
    "rename",
    "directory-open",
    "directory-sync",
    "directory-close",
    "directory-sync+close",
  ] as const)("pre-manifest abandonment bypasses irrelevant marker %s faults", async (fault) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-rlm-invalid-nonce-release-"));
    const { result } = await managedStatusRun("failed", {
      root: stateRoot,
      metadataFileSystem: releaseFaultFileSystem(fault),
    }, () => " invalid nonce ");
    expect(result.details?.status).toBe("failed");
    expect(result.content[0]?.text ?? "").not.toContain("RETENTION_METADATA_FAILED");
    expect((await new ManagedRunStore({ root: stateRoot }).list()).runs).toEqual([]);
  });

  test("default runtime uses retained managed state while injected directories keep legacy ownership", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-rlm-extension-state-"));
    const backend: InterpreterBackend = {
      id: "managed-test-backend", version: "1",
      async evalCell() { throw new Error("unused"); },
      async dispose() {},
    };
    const model: ModelClient = {
      id: "managed-test-model",
      identity: { id: "test/managed-model", version: "1", configuration: {} },
      async complete() { throw new Error("unused"); },
    };
    const controller: ControllerDriver = {
      identity: { id: "test/managed-controller", version: "1", configuration: {} },
      async next() { throw new Error("unused"); },
      fork() { return this; },
    };
    const h = harness({ runtime: {
      resolveProfile: () => ({ ...DEFAULT_PROFILE, maxControllerTurns: 0 }),
      createBackend: () => backend,
      createModel: () => model,
      createController: () => controller,
      runRetention: { root: stateRoot },
    } });
    await h.startTurn("Use pi-rlm with managed retention");
    const result = await rlmTool(h).execute("call-managed", { objective: "Retain this run" }, undefined, undefined, h.ctx);
    expect(result.details?.status).toBe("failed");
    const listing = await new ManagedRunStore({ root: stateRoot }).list();
    expect(listing.issues).toEqual([]);
    expect(listing.runs).toHaveLength(1);
    expect(listing.runs[0]?.metadata).toMatchObject({ status: "failed", runId: expect.stringMatching(/^run_[a-f0-9]{64}$/) });
    expect((await lstat(join(listing.runs[0]!.path, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(listing.runs[0]!.path, "events.jsonl"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(listing.runs[0]!.path, "contexts"))).mode & 0o777).toBe(0o700);
  });

  test("runtime initialization is not called when no consumable turn grant exists", async () => {
    const h = harness();
    const result = await rlmTool(h).execute("call-no-turn", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.runs).toHaveLength(0);
  });
});
