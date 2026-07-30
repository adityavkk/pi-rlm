import { join } from "node:path";
import {
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { VISUAL_FIXTURE_EXTENSIONS } from "./visual-fixture-extension.ts";

const USAGE = `Usage: bun src/extension/testing/interactive-tui-fixture.ts

Offline InteractiveMode visual acceptance fixture.
Starts /rlm automatically; exit with Ctrl+D after completing the checklist.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (process.argv.length > 2) throw new Error(USAGE);

const INITIAL_COMMAND =
  '/rlm {"objective":"Interactive visual fixture","context":"offline deterministic visual context"}';

const root = process.cwd();
const agentDir = join(root, ".pi-rlm-visual-agent");
const settingsManager = SettingsManager.inMemory();
const sessionManager = SessionManager.inMemory(root);
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsStore: new InMemoryModelsStore(),
  modelsPath: null,
  allowModelNetwork: false,
});
const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      extensionFactories: [...VISUAL_FIXTURE_EXTENSIONS],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
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
try {
  await new InteractiveMode(runtime, { initialMessage: INITIAL_COMMAND, verbose: true }).run();
} finally {
  await runtime.dispose();
}
