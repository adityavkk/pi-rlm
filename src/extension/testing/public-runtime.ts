import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { createRlmExtension } from "../../../index.ts";
import { createLedger } from "../../core/budget.ts";
import { DEFAULT_PROFILE, resolveLimits, type RunResult } from "../../runtime/index.ts";
import type { LaunchRequest } from "../source.ts";

export const PUBLIC_FIXTURE_RESULT: RunResult = {
  runId: `run_${"1".repeat(64)}`,
  status: "failed",
  error: { code: "OFFLINE_FIXTURE", message: "credential-free public Pi fixture completed" },
  ledger: createLedger(resolveLimits(DEFAULT_PROFILE, 0)),
};

export const PUBLIC_FIXTURE_COMMAND =
  '/rlm {"objective":"Public adapter","context":"exact public source"}';

export interface PublicRuntimeFixture {
  readonly runtime: AgentSessionRuntime;
  readonly sessionManager: SessionManager;
  readonly captured: LaunchRequest[];
}

/** Public Pi runtime factory with a public resource-loader extension injection. */
export const createPublicRuntimeFixture = async (root: string): Promise<PublicRuntimeFixture> => {
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(root);
  const captured: LaunchRequest[] = [];
  const extension = createRlmExtension({
    executeRun: async (request) => {
      captured.push(request);
      return PUBLIC_FIXTURE_RESULT;
    },
    createId: () => "public-runtime",
  });
  const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [{ name: "pi-rlm-public-runtime", factory: extension }],
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
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: root, agentDir, sessionManager });
  return { runtime, sessionManager, captured };
};
