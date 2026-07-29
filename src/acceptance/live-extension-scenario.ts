import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionRuntime,
  createAgentSessionServices, type AgentSessionEvent, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createRlmExtension } from "../../index.ts";
import type { RlmEvent } from "../core/journal.ts";
import { JournalStore } from "../shell/journal-store.ts";
import { DEFAULT_PROFILE, type Profile } from "../runtime/profile.ts";
import type { RuntimeScenarioContext } from "./live-runtime-scenarios.ts";
import { caseReport, runWall } from "./live-scenario-support.ts";
import type { LiveCaseReport } from "./live-contract.ts";

const ui = { setStatus() {}, notify() {}, confirm: async () => true } as unknown as ExtensionUIContext;
const expected = "PI_RLM_EXTENSION_246810";

const findRun = async (root: string): Promise<string> => {
  const entries = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory() && item.name.startsWith("run-"));
  if (entries.length !== 1) throw new Error("extension run count invalid");
  return join(root, entries[0]!.name);
};
const customContent = (events: readonly AgentSessionEvent[]): string | undefined => {
  for (const event of events) {
    if (event.type !== "message_end") continue;
    const message = event.message as unknown as { role?: unknown; customType?: unknown; content?: unknown };
    if (message.role === "custom" && message.customType === "pi-rlm-result" && typeof message.content === "string") return message.content;
  }
  return undefined;
};
const usageTotal = (events: readonly RlmEvent[], key: "inputTokens" | "outputTokens" | "totalTokens" | "durationMs"): number =>
  events.reduce((sum, event) => event.type === "operation_settled"
    ? sum + (key === "totalTokens"
      ? event.usage.totalTokens ?? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0)
      : event.usage[key] ?? 0)
    : sum, 0);

export const extensionScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const caseRoot = join(context.root, "extension-session");
  const runRoot = join(caseRoot, "private-runs");
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const model = context.runtime.getModel(context.route.slice(0, context.route.indexOf("/")), context.route.slice(context.route.indexOf("/") + 1));
  if (!model) return caseReport("extension", context.budget, { code: "EXTENSION_FAILED" });
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(caseRoot);
  const observed: AgentSessionEvent[] = [];
  interface Projection {
    readonly status?: string;
    readonly answer?: { readonly answer?: unknown };
    readonly output?: { readonly bytes?: number };
    readonly usage?: {
      readonly attempts?: number; readonly tokensReserved?: number; readonly activeLeafCalls?: number;
      readonly inputTokensUsed?: number; readonly outputTokensUsed?: number; readonly tokensUsed?: number;
      readonly providerDurationMs?: number;
    };
  }
  const selectedProfile: Profile = {
    ...DEFAULT_PROFILE, name: "live-extension", maxDepth: 1, maxFrames: 1, maxLogicalCalls: 1,
    maxAttempts: 2, maxControllerTurns: 1, maxConcurrency: 1, tokenLimit: 20_000,
    wallMs: 90_000, cellWallMs: 15_000,
    models: { small: context.route, medium: context.route, large: context.route },
  };
  const extension = createRlmExtension({
    runtime: {
      resolveProfile: () => selectedProfile,
      createBackend: () => context.backend,
      createModel: () => context.budget.client(context.runtime, context.route, "extension"),
      createExtractor: () => undefined,
      runRetention: { root: runRoot },
    },
    createId: () => "live-extension-fixed-id",
  });
  const runtime = await createAgentSessionRuntime(async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd, agentDir: options.agentDir, settingsManager, modelRuntime: context.runtime,
      resourceLoaderOptions: { extensionFactories: [{ name: "pi-rlm-live-extension", factory: extension }] },
    });
    const created = await createAgentSessionFromServices({
      services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent,
      model, tools: ["rlm_run"],
    });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd: caseRoot, agentDir: join(caseRoot, "agent"), sessionManager });
  const unsubscribe = runtime.session.subscribe((event) => observed.push(event));
  try {
    await runtime.session.bindExtensions({ mode: "print", uiContext: ui });
    const command = `/rlm ${JSON.stringify({
      objective: `In the first cell call answer(${JSON.stringify(expected)}). Return no other final value.`,
      context: "fixed public AgentSession extension source",
    })}`;
    const measured = await runWall(() => runtime.session.prompt(command, { source: "interactive" }));
    const content = customContent(observed);
    let projection: Projection | undefined;
    try { projection = content ? JSON.parse(content) as Projection : undefined; } catch { /* fixed failure below */ }
    const dir = await findRun(runRoot);
    const read = await new JournalStore(dir).readEvents();
    const journal = read.ok ? read.value : [];
    const observer = context.budget.accounting("extension");
    const intents = journal.filter((event) => event.type === "operation_intended").length;
    const settlements = journal.filter((event) => event.type === "operation_settled").length;
    const attempts = Number(projection?.usage?.attempts ?? -1);
    const input = usageTotal(journal, "inputTokens");
    const output = usageTotal(journal, "outputTokens");
    const total = usageTotal(journal, "totalTokens");
    const duration = usageTotal(journal, "durationMs");
    const cost = journal.reduce((sum, event) => event.type === "operation_settled" ? sum + (event.usage.costUsd ?? 0) : sum, 0);
    const accounting = observer.invocations === intents && intents === settlements && settlements === attempts
      && observer.inputTokens === input && observer.outputTokens === output && observer.aggregateTokens === total
      && observer.providerDurationMs === duration && Math.abs(observer.piCatalogEstimateUsd - cost) <= 1e-9
      && Number(projection?.usage?.tokensReserved) === 0 && Number(projection?.usage?.activeLeafCalls) === 0
      && Number(projection?.usage?.inputTokensUsed) === input && Number(projection?.usage?.outputTokensUsed) === output
      && Number(projection?.usage?.tokensUsed) === total && Number(projection?.usage?.providerDurationMs) === duration;
    const exact = projection?.status === "completed" && projection?.answer?.answer === expected;
    return caseReport("extension", context.budget, {
      code: !accounting ? "ACCOUNTING_MISMATCH" : exact ? "PASS" : "EXTENSION_FAILED",
      wallDurationMs: measured.wallDurationMs, outputBytes: Number(projection?.output?.bytes ?? 0),
      intents, settlements, attempts: Math.max(0, attempts),
    });
  } finally { unsubscribe(); await runtime.dispose(); }
};
