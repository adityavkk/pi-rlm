import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { normalizeProgram, type JsonValue } from "pi-rlm/core";
import { ManagedRunStore, MockController, runProgram, type RunResult } from "pi-rlm/runtime";
import { createRlmExtension } from "../../index.ts";

const modes: Array<"tui" | "rpc" | "print" | "json"> = ["tui", "rpc", "print", "json"];
const resumeCells = [
  { reasoning: "checkpoint", code: "workspace.count = 1; 'first'" },
  { reasoning: "continue", code: "answer({ answer: 'continued' })" },
] as const;
const resumeModelIdentity = { id: "test/public-resume-model", version: "1", configuration: {} } as const;
const program = (() => {
  const normalized = normalizeProgram({
    objective: "public managed command fixture",
    profile: "default",
    inputs: [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid public managed fixture program");
  return normalized.value;
})();

const seedTerminal = async (root: string): Promise<string> => {
  const store = new ManagedRunStore({ root, policy: { terminalMaxAgeMs: 0 } });
  const lease = await store.create();
  const controller = new MockController([{ reasoning: "terminal fixture", code: "answer({ answer: 'fixture' })" }]);
  const backend = {
    id: "public-managed-fixture-backend",
    version: "1",
    async evalCell(options: { effect(name: string, payload: unknown): unknown }) {
      options.effect("answer", { value: { answer: "PUBLIC_RAW_ANSWER" } });
      return { kind: "value" as const, result: undefined, hasResult: false, workspace: {}, workspaceInvalidPaths: [] };
    },
    async dispose() {},
  };
  const model = {
    id: "public-managed-fixture-model",
    identity: { id: "test/public-managed-model", version: "1", configuration: {} },
    async complete(): Promise<never> { throw new Error("public managed fixture attempted provider spend"); },
  };
  const result = await runProgram({
    program, sources: {}, controller, backend, model,
    dir: lease.dir, signal: new AbortController().signal, runLifecycle: lease.lifecycle,
  });
  await lease.finish(result.status, result.runId);
  expect(result.status).toBe("completed");
  return lease.name;
};

const crashAtCheckpoint = async (root: string): Promise<string> => {
  const ready = join(root, "resume-ready.json");
  const script = `
    import { writeFileSync } from "node:fs";
    import { normalizeProgram } from "pi-rlm/core";
    import { ManagedRunStore, MockController, runProgram } from "pi-rlm/runtime";
    const normalized = normalizeProgram(${JSON.stringify(program)});
    if (!normalized.ok) throw new Error("invalid child program");
    const store = new ManagedRunStore({ root: ${JSON.stringify(root)} });
    const lease = await store.create();
    const controller = new MockController(${JSON.stringify(resumeCells)});
    const original = controller.next.bind(controller);
    let calls = 0;
    controller.next = async (...args) => {
      if (++calls === 2) {
        writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ name: lease.name }), { mode: 0o600 });
        return new Promise(() => {});
      }
      return original(...args);
    };
    const backend = {
      id: "public-resume-backend", version: "1",
      async evalCell(options) {
        return { kind: "value", result: "first", hasResult: true,
          workspace: { count: 1 }, workspaceInvalidPaths: [] };
      },
      async dispose() {},
    };
    const model = {
      id: "public-resume-model", identity: ${JSON.stringify(resumeModelIdentity)},
      async complete() { throw new Error("checkpoint producer attempted provider spend"); },
    };
    await runProgram({ program: normalized.value, sources: {}, controller, backend, model,
      dir: lease.dir, signal: new AbortController().signal, runLifecycle: lease.lifecycle });
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null) {
        const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
        throw new Error(`checkpoint producer exited: ${stderr}`);
      }
      if (Date.now() >= deadline) throw new Error("checkpoint producer timed out");
      await Bun.sleep(20);
    }
    const name = (JSON.parse(await readFile(ready, "utf8")) as { name: string }).name;
    child.kill("SIGKILL");
    await child.exited;
    return name;
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
};

const createUi = (
  observed: { confirms: number; customs: number; widgets: number },
  approve = false,
): ExtensionUIContext => ({
  notify() {},
  setStatus() {},
  setWidget() { observed.widgets++; },
  setToolsExpanded() {},
  async confirm() { observed.confirms++; return approve; },
  custom(factory: any) {
    observed.customs++;
    return new Promise((resolve, reject) => {
      try {
        const component = factory({ requestRender() {} }, {}, {}, resolve);
        component.handleInput?.("\u001b");
      } catch (error) { reject(error); }
    });
  },
}) as unknown as ExtensionUIContext;

const runContentionChild = async (
  root: string,
  managedName: string,
  gate: string,
  kind: "resume" | "cleanup",
): Promise<string> => {
  const script = `
    import { existsSync } from "node:fs";
    import { ManagedRunStore } from "pi-rlm/runtime";
    while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
    try {
      const store = new ManagedRunStore({ root: ${JSON.stringify(root)}, policy: { abandonedGraceMs: 0 } });
      if (${JSON.stringify(kind)} === "resume") {
        const candidate = await store.openResumeCandidate(${JSON.stringify(managedName)});
        console.log("resume-won");
        await Bun.sleep(750);
        await candidate.release();
      } else {
        const result = await store.cleanup({ force: true });
        console.log(result.deleted.includes(${JSON.stringify(managedName)}) ? "cleanup-won" : "cleanup-lost");
      }
    } catch {
      console.log(${JSON.stringify(kind)} + "-lost");
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  if (status !== 0) throw new Error(`contention child failed: ${stderr}`);
  return stdout.trim();
};

const managementContents = (events: readonly AgentSessionEvent[]): string[] => events.flatMap((event) => {
  if (event.type !== "message_end") return [];
  const message = event.message as unknown as { customType?: unknown; content?: unknown };
  return message.customType === "pi-rlm-management-result" && typeof message.content === "string"
    ? [message.content] : [];
});

/** Public AgentSession/ExtensionRunner boundary; packed smoke runs this file under OS network denial. */
describe("public managed host commands", () => {
  test.each(modes)("%s lists, inspects, rejects terminal resume, and cleans without provider access", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), `pi-rlm-public-managed-${mode}-`));
    const runsRoot = join(root, "state", "runs");
    const events: AgentSessionEvent[] = [];
    const observed = { confirms: 0, customs: 0, widgets: 0 };
    let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let factories = 0;
    try {
      const managedName = await seedTerminal(runsRoot);
      const settingsManager = SettingsManager.inMemory();
      const sessionManager = SessionManager.inMemory(root);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        allowModelNetwork: false,
      });
      const extension = createRlmExtension({
        runtime: {
          runRetention: { root: runsRoot, policy: { terminalMaxAgeMs: 0 } },
          createBackend: () => { factories++; throw new Error("terminal resume constructed backend"); },
          createModel: () => { factories++; throw new Error("terminal resume constructed model"); },
        },
      });
      runtime = await createAgentSessionRuntime(async (options) => {
        const services = await createAgentSessionServices({
          cwd: options.cwd,
          agentDir: options.agentDir,
          settingsManager,
          modelRuntime,
          resourceLoaderOptions: {
            extensionFactories: [{ name: "pi-rlm-public-managed", factory: extension }],
          },
        });
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: options.sessionManager,
          sessionStartEvent: options.sessionStartEvent,
          noTools: "all",
        });
        return { ...created, services, diagnostics: services.diagnostics };
      }, { cwd: root, agentDir: join(root, "agent"), sessionManager });
      unsubscribe = runtime.session.subscribe((event) => events.push(event));
      await runtime.session.bindExtensions({ mode, uiContext: createUi(observed) });
      for (const command of [
        "/rlm runs",
        `/rlm inspect ${managedName}`,
        `/rlm resume ${managedName}`,
        "/rlm cleanup --dry-run",
        "/rlm cleanup --force",
      ]) await runtime.session.prompt(command, { source: "interactive" });

      const contents = managementContents(events);
      expect(contents).toHaveLength(5);
      expect(contents[0]).toContain("RLM_RUNS_LISTED");
      expect(contents[1]).toContain("RLM_RUN_INSPECTED");
      expect(contents[2]).toContain("RLM_RESUME_TERMINAL");
      expect(contents[3]).toContain("RLM_CLEANUP_DRY_RUN");
      expect(contents[4]).toContain("RLM_CLEANUP_COMPLETED");
      expect(contents.join("\n")).not.toContain(root);
      expect(contents.join("\n")).not.toContain("PUBLIC_RAW_ANSWER");
      expect(factories).toBe(0);
      expect(observed.confirms).toBe(0);
      expect(observed.customs).toBe(mode === "tui" ? 2 : 0);
      expect(observed.widgets > 0).toBe(mode === "tui");
      expect((await new ManagedRunStore({ root: runsRoot }).list()).runs).toHaveLength(0);
    } finally {
      unsubscribe?.();
      await runtime?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("two genuine child-process resume contenders elect one exact writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-public-resume-contention-"));
    const gate = join(tmpdir(), `pi-rlm-resume-contenders-${crypto.randomUUID()}.go`);
    try {
      const managedName = await crashAtCheckpoint(root);
      const contenders = [
        runContentionChild(root, managedName, gate, "resume"),
        runContentionChild(root, managedName, gate, "resume"),
      ];
      await writeFile(gate, "go", { mode: 0o600 });
      const outcomes = await Promise.all(contenders);
      expect(outcomes.filter((outcome) => outcome === "resume-won")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "resume-lost")).toHaveLength(1);
    } finally {
      await rm(gate, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("genuine child-process resume and cleanup contenders share one writer election", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rlm-public-resume-cleanup-contention-"));
    const gate = join(tmpdir(), `pi-rlm-resume-cleanup-${crypto.randomUUID()}.go`);
    try {
      const managedName = await crashAtCheckpoint(root);
      const contenders = [
        runContentionChild(root, managedName, gate, "resume"),
        runContentionChild(root, managedName, gate, "cleanup"),
      ];
      await writeFile(gate, "go", { mode: 0o600 });
      const outcomes = await Promise.all(contenders);
      if (outcomes.filter((outcome) => outcome.endsWith("-won")).length !== 1)
        throw new Error(`unexpected resume-cleanup outcomes: ${JSON.stringify(outcomes)}`);
      expect(outcomes.filter((outcome) => outcome.endsWith("-lost"))).toHaveLength(1);
    } finally {
      await rm(gate, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test.each(modes)("%s offline host authorization continues a crashed checkpoint without replay or network", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), `pi-rlm-public-resume-success-${mode}-`));
    const runsRoot = join(root, "state", "runs");
    const events: AgentSessionEvent[] = [];
    let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let modelCalls = 0;
    let policyCalls = 0;
    const observed = { confirms: 0, customs: 0, widgets: 0 };
    try {
      const managedName = await crashAtCheckpoint(runsRoot);
      const settingsManager = SettingsManager.inMemory();
      const sessionManager = SessionManager.inMemory(root);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
        modelsPath: null, allowModelNetwork: false,
      });
      const backend = {
        id: "public-resume-backend", version: "1",
        async evalCell(options: { globals: { workspace: JsonValue }; effect(name: string, payload: JsonValue): void }) {
          options.effect("answer", { value: { answer: "PUBLIC_CONTINUED_RAW_ANSWER" } });
          return { kind: "value" as const, result: undefined, hasResult: false,
            workspace: options.globals.workspace, workspaceInvalidPaths: [] };
        },
        async dispose() {},
      };
      const model = {
        id: "public-resume-model", identity: resumeModelIdentity,
        async complete(): Promise<never> { modelCalls++; throw new Error("resume attempted provider spend"); },
      };
      const extension = createRlmExtension({
        runtime: {
          runRetention: { root: runsRoot },
          createBackend: () => backend,
          createModel: () => model,
          createController: () => new MockController(resumeCells),
        },
        authorizeResume: async (request) => {
          policyCalls++;
          expect(Object.isFrozen(request)).toBe(true);
          return true;
        },
      });
      runtime = await createAgentSessionRuntime(async (options) => {
        const services = await createAgentSessionServices({
          cwd: options.cwd, agentDir: options.agentDir, settingsManager, modelRuntime,
          resourceLoaderOptions: { extensionFactories: [{ name: "pi-rlm-public-resume", factory: extension }] },
        });
        const created = await createAgentSessionFromServices({
          services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, noTools: "all",
        });
        return { ...created, services, diagnostics: services.diagnostics };
      }, { cwd: root, agentDir: join(root, "agent"), sessionManager });
      unsubscribe = runtime.session.subscribe((event) => events.push(event));
      await runtime.session.bindExtensions({ mode, uiContext: createUi(observed, true) });
      await runtime.session.prompt(`/rlm resume ${managedName}`, { source: "interactive" });

      const contents = managementContents(events);
      expect(contents).toHaveLength(1);
      expect(contents[0]).toContain("RLM_RESUME_COMPLETED");
      expect(contents[0]).not.toContain("PUBLIC_CONTINUED_RAW_ANSWER");
      expect(modelCalls).toBe(0);
      expect(policyCalls).toBe(mode === "tui" ? 0 : 1);
      expect(observed.confirms).toBe(mode === "tui" ? 1 : 0);
      expect(observed.customs).toBe(0);
      expect(observed.widgets > 0).toBe(mode === "tui");
      const retained = (await new ManagedRunStore({ root: runsRoot }).list()).runs;
      expect(retained).toHaveLength(1);
      expect(retained[0]?.metadata).toMatchObject({ status: "completed" });
    } finally {
      unsubscribe?.();
      await runtime?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
