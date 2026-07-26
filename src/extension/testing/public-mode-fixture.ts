import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { runPrintMode, runRpcMode, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createOfflineProviderRuntimeFixture,
  OFFLINE_COMMAND,
  type OfflineProviderMode,
  type OfflineProviderRuntimeFixture,
} from "./offline-provider-runtime.ts";
import { createPublicRuntimeFixture, PUBLIC_FIXTURE_COMMAND, type PublicRuntimeFixture } from "./public-runtime.ts";

const mode = process.argv[2];
const root = process.argv[3];
const statePath = process.argv[4];
const providerMode = process.argv[5] as OfflineProviderMode | undefined;
if (!root || !["text", "json", "rpc"].includes(mode ?? "")
  || (providerMode !== undefined && !["success", "error", "pending"].includes(providerMode)))
  throw new Error("usage: public-mode-fixture <text|json|rpc> <root> [state-path] [success|error|pending]");

let fixture: OfflineProviderRuntimeFixture | PublicRuntimeFixture | undefined;
let unsubscribe: (() => void) | undefined;
const fixtureResult = (): unknown => {
  if (!fixture) throw new Error("fixture not initialized");
  const entries = fixture.sessionManager.getEntries();
  return providerMode && "state" in fixture
    ? {
        schemaVersion: 1,
        entries,
        provider: {
          fetchAttempts: fixture.state.fetchCalls,
          calls: fixture.state.calls.map((call) => ({ model: call.model, options: call.options })),
        },
      }
    : entries;
};
const isResultEnd = (event: AgentSessionEvent): boolean =>
  event.type === "message_end" && (event.message as { customType?: string }).customType === "pi-rlm-result";
const persistFixtureResult = (): void => {
  if (fixture && statePath) writeFileSync(statePath, JSON.stringify(fixtureResult()), "utf8");
};

try {
  fixture = providerMode
    ? await createOfflineProviderRuntimeFixture(root, providerMode)
    : await createPublicRuntimeFixture(root);
  const command = providerMode ? OFFLINE_COMMAND : PUBLIC_FIXTURE_COMMAND;
  if (mode === "rpc") {
    // runRpcMode owns process shutdown and may call process.exit(). Persist at
    // both the durable result event and Node's synchronous exit boundary.
    if (statePath) {
      process.once("exit", persistFixtureResult);
      unsubscribe = fixture.runtime.session.subscribe((event) => {
        if (isResultEnd(event)) persistFixtureResult();
      });
    }
    await runRpcMode(fixture.runtime);
  } else {
    const exitCode = await runPrintMode(fixture.runtime, {
      mode: mode as "text" | "json",
      initialMessage: command,
    });
    process.exitCode = exitCode;
  }
} finally {
  unsubscribe?.();
  try {
    if (fixture && statePath) {
      if (mode === "rpc") persistFixtureResult();
      else await writeFile(statePath, JSON.stringify(fixtureResult()), "utf8");
    }
  } finally {
    process.off("exit", persistFixtureResult);
    if (fixture && "restoreFetchTripwire" in fixture) fixture.restoreFetchTripwire();
  }
}
