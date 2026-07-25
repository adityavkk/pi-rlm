import { writeFile } from "node:fs/promises";
import { runPrintMode, runRpcMode } from "@earendil-works/pi-coding-agent";
import {
  createOfflineProviderRuntimeFixture,
  OFFLINE_COMMAND,
  type OfflineProviderMode,
} from "./offline-provider-runtime.ts";
import { createPublicRuntimeFixture, PUBLIC_FIXTURE_COMMAND } from "./public-runtime.ts";

const mode = process.argv[2];
const root = process.argv[3];
const statePath = process.argv[4];
const providerMode = process.argv[5] as OfflineProviderMode | undefined;
if (!root || !["text", "json", "rpc"].includes(mode ?? "")
  || (providerMode !== undefined && !["success", "error", "pending"].includes(providerMode)))
  throw new Error("usage: public-mode-fixture <text|json|rpc> <root> [state-path] [success|error|pending]");

const fixture = providerMode
  ? await createOfflineProviderRuntimeFixture(root, providerMode)
  : await createPublicRuntimeFixture(root);
const command = providerMode ? OFFLINE_COMMAND : PUBLIC_FIXTURE_COMMAND;
try {
  if (mode === "rpc") {
    await runRpcMode(fixture.runtime);
  } else {
    const exitCode = await runPrintMode(fixture.runtime, {
      mode: mode as "text" | "json",
      initialMessage: command,
    });
    if (statePath)
      await writeFile(statePath, JSON.stringify(fixture.sessionManager.getEntries()), "utf8");
    process.exitCode = exitCode;
  }
} finally {
  if ("restoreFetchTripwire" in fixture) fixture.restoreFetchTripwire();
}
