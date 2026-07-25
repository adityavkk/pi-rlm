import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createLedger } from "../core/budget.ts";
import { DEFAULT_PROFILE, resolveLimits, type RunResult } from "../runtime/index.ts";
import { createRlmExtension } from "../../index.ts";
import type { LaunchRequest } from "./source.ts";

const result: RunResult = {
  runId: `run_${"1".repeat(64)}`,
  status: "failed",
  error: { code: "OFFLINE_FIXTURE", message: "credential-free public Pi fixture completed" },
  ledger: createLedger(resolveLimits(DEFAULT_PROFILE, 0)),
};

const ui = {
  setStatus() {},
  notify() {},
  confirm: async () => true,
} as unknown as ExtensionUIContext;

/** Public AgentSession/ExtensionRunner acceptance, not a hand-built ExtensionContext. */
describe("public Pi SDK extension integration", () => {
  test.each(["tui", "rpc", "json", "print"] as const)(
    "%s recognizes /rlm, captures source, and appends one custom result message",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), `pi-rlm-public-${mode}-`));
      const settingsManager = SettingsManager.inMemory();
      const sessionManager = SessionManager.inMemory(root);
      const captured: LaunchRequest[] = [];
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: join(root, "agent"),
        settingsManager,
        extensionFactories: [{
          name: `pi-rlm-${mode}`,
          factory: createRlmExtension({
            executeRun: async (request) => {
              captured.push(request);
              return result;
            },
            createId: () => `public-${mode}`,
          }),
        }],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: root,
        agentDir: join(root, "agent"),
        resourceLoader: loader,
        sessionManager,
        settingsManager,
        noTools: "all",
      });
      try {
        await session.bindExtensions({ mode, uiContext: ui });
        await session.prompt('/rlm {"objective":"Public adapter","context":"exact public source"}', {
          source: mode === "rpc" ? "rpc" : "interactive",
        });
        for (let attempt = 0; attempt < 20 && sessionManager.getEntries()
          .filter((entry) => entry.type === "custom_message" && entry.customType === "pi-rlm-result").length === 0; attempt++)
          await Promise.resolve();

        expect(captured).toHaveLength(1);
        expect(captured[0]?.sources).toEqual({ context: "exact public source" });
        const messages = sessionManager.getEntries().filter((entry) =>
          entry.type === "custom_message" && entry.customType === "pi-rlm-result");
        expect(messages).toHaveLength(1);
        expect(messages[0]?.type === "custom_message" && messages[0].content).toContain("OFFLINE_FIXTURE");
      } finally {
        session.dispose();
      }
    },
  );
});
