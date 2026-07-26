import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createRlmExtension } from "../../../index.ts";
import type { RlmEvent } from "../../core/journal.ts";
import { DEFAULT_PROFILE, type Profile } from "../../runtime/profile.ts";
import { JournalStore } from "../../shell/journal-store.ts";
import { PiModelClient } from "../../shell/model/pi-model.ts";

export const OFFLINE_PROVIDER_ID = "pi-rlm-offline";
export const OFFLINE_API = "pi-rlm-offline-api";
export const OFFLINE_CONTROLLER_MODEL = `${OFFLINE_PROVIDER_ID}/controller`;
export const OFFLINE_HOST_MODEL = `${OFFLINE_PROVIDER_ID}/host`;
export const OFFLINE_COMMAND =
  '/rlm {"objective":"Offline provider E2E","context":"exact offline source"}';
export const OFFLINE_ANSWER = "offline provider answer";

export type OfflineProviderMode = "success" | "error" | "pending";

export interface OfflineProviderCall {
  readonly model: { readonly provider: string; readonly id: string; readonly api: string };
  readonly context: Context;
  readonly options: {
    readonly maxRetries?: number;
    readonly maxTokens?: number;
    readonly reasoning?: string;
    readonly hasSignal: boolean;
    readonly envKeys: readonly string[];
  };
  readonly signal?: AbortSignal;
}

export interface OfflineProviderState {
  readonly calls: OfflineProviderCall[];
  readonly started: Promise<void>;
  fetchCalls: number;
  aborts: number;
  lateEmissionAttempts: number;
  lateEmissionAccepted: number;
  emitLate(): void;
}

export interface OfflineProviderRuntimeFixture {
  readonly runtime: AgentSessionRuntime;
  readonly sessionManager: SessionManager;
  readonly modelRuntime: ModelRuntime;
  readonly state: OfflineProviderState;
  readonly runRoot: string;
  readEvents(): Promise<RlmEvent[]>;
  readJournalBytes(): Promise<Buffer>;
  restoreFetchTripwire(): void;
  dispose(): Promise<void>;
}

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const message = (
  model: Model<Api>,
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
  errorMessage?: string,
): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: stopReason === "stop" ? usage(11, 7) : usage(11, 0),
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: Date.now(),
});

const controllerCell = JSON.stringify({
  reasoning: "deterministic offline controller",
  code: `answer({ answer: ${JSON.stringify(OFFLINE_ANSWER)} })`,
});

const profile = (): Profile => ({
  ...DEFAULT_PROFILE,
  name: "offline-provider-e2e",
  maxLogicalCalls: 1,
  maxAttempts: 1,
  maxControllerTurns: 1,
  maxConcurrency: 1,
  wallMs: 5_000,
  cellWallMs: 2_000,
  models: {
    small: OFFLINE_HOST_MODEL,
    medium: OFFLINE_CONTROLLER_MODEL,
    large: OFFLINE_CONTROLLER_MODEL,
  },
});

const findRunDirectory = async (root: string): Promise<string> => {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"));
  if (entries.length !== 1) throw new Error(`expected one offline run directory, found ${entries.length}`);
  return join(root, entries[0]!.name);
};

/**
 * Credential-independent Pi 0.80.10 fixture.
 *
 * The pinned ModelRuntime exposes registerProvider(), not a native Provider
 * installation API. Its extension-provider shape requires an auth marker, so
 * this fixture supplies a fixed non-secret in-memory marker. No user credential,
 * environment key, fetch implementation, socket, or HTTP server is consulted.
 */
export const createOfflineProviderRuntimeFixture = async (
  root: string,
  mode: OfflineProviderMode = "success",
  options: { readonly setupFault?: "after-model-runtime" | "after-agent-runtime" } = {},
): Promise<OfflineProviderRuntimeFixture> => {
  const originalFetch = globalThis.fetch;
  let installedFetch: typeof fetch;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let late: (() => void) | undefined;
  const state: OfflineProviderState = {
    calls: [],
    started,
    fetchCalls: 0,
    aborts: 0,
    lateEmissionAttempts: 0,
    lateEmissionAccepted: 0,
    emitLate() { late?.(); },
  };
  installedFetch = (async () => {
    state.fetchCalls += 1;
    throw new Error("offline provider fixture blocked fetch");
  }) as unknown as typeof fetch;
  globalThis.fetch = installedFetch;
  const restoreFetchTripwire = (): void => {
    if (globalThis.fetch === installedFetch) globalThis.fetch = originalFetch;
  };
  let runtime: AgentSessionRuntime | undefined;

  try {
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  if (options.setupFault === "after-model-runtime") throw new Error("injected offline fixture setup fault");

  const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    state.calls.push({
      model: { provider: model.provider, id: model.id, api: model.api },
      context: structuredClone(context),
      options: {
        ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
        hasSignal: options?.signal !== undefined,
        envKeys: Object.keys(options?.env ?? {}).sort(),
      },
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    resolveStarted();

    let settled = false;
    const finish = (final: AssistantMessage): boolean => {
      if (settled) return false;
      settled = true;
      if (final.stopReason === "error" || final.stopReason === "aborted") {
        stream.push({ type: "error", reason: final.stopReason, error: final });
      } else {
        stream.push({ type: "start", partial: { ...final, content: [] } });
        stream.push({ type: "done", reason: final.stopReason, message: final });
      }
      stream.end(final);
      return true;
    };

    if (mode === "success") {
      queueMicrotask(() => finish(message(model, "stop", [{ type: "text", text: controllerCell }])));
      return stream;
    }
    if (mode === "error") {
      queueMicrotask(() => finish(message(model, "error", [], "OFFLINE_PROVIDER_TYPED_ERROR")));
      return stream;
    }

    const abort = (): void => {
      state.aborts += 1;
      finish(message(model, "aborted", [], "offline provider observed AbortSignal"));
    };
    if (options?.signal?.aborted) queueMicrotask(abort);
    else options?.signal?.addEventListener("abort", abort, { once: true });
    late = () => {
      state.lateEmissionAttempts += 1;
      if (finish(message(model, "stop", [{ type: "text", text: controllerCell }])))
        state.lateEmissionAccepted += 1;
    };
    return stream;
  };

  // Public Pi 0.80.10 API. The fixed value is an inert registration marker,
  // never a credential read from the host and never passed to a network client.
  modelRuntime.registerProvider(OFFLINE_PROVIDER_ID, {
    name: "pi-rlm offline fixture",
    // Pi validates a syntactic base URL for custom model metadata. The custom
    // stream owns dispatch, and the fetch tripwire proves this URL is never used.
    baseUrl: "https://offline.invalid",
    api: OFFLINE_API,
    apiKey: "offline-fixture-not-a-secret",
    streamSimple,
    models: ["controller", "host"].map((id) => ({
      id,
      name: `Offline ${id}`,
      api: OFFLINE_API,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    })),
  });
  await modelRuntime.refresh({ allowNetwork: false });

  const agentDir = join(root, "agent");
  const runRoot = join(root, "private-runs");
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(root);
  let id = 0;
  const extension = createRlmExtension({
    runtime: {
      resolveProfile: profile,
      createModel: () => new PiModelClient(modelRuntime, OFFLINE_CONTROLLER_MODEL),
      runRetention: { root: runRoot },
    },
    createId: () => `offline-fixture-${++id}`,
  });
  const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [{ name: "pi-rlm-offline-provider", factory: extension }],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      noTools: "all",
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(createRuntime, { cwd: root, agentDir, sessionManager });
  if (options.setupFault === "after-agent-runtime") throw new Error("injected offline fixture setup fault");
  const readyRuntime = runtime;
  return {
    runtime: readyRuntime,
    sessionManager,
    modelRuntime,
    state,
    runRoot,
    async readEvents() {
      return new JournalStore(await findRunDirectory(runRoot)).readEvents().then((result) => {
        if (!result.ok) throw result.error;
        return result.value;
      });
    },
    async readJournalBytes() {
      return readFile(join(await findRunDirectory(runRoot), "events.jsonl"));
    },
    restoreFetchTripwire,
    async dispose() {
      try { await readyRuntime.dispose(); }
      finally { restoreFetchTripwire(); }
    },
  };
  } catch (error) {
    try { await runtime?.dispose(); }
    finally { restoreFetchTripwire(); }
    throw error;
  }
};
