import { writeFile } from "node:fs/promises";
import { runPrintMode, runRpcMode } from "@earendil-works/pi-coding-agent";
import { createPublicRuntimeFixture, PUBLIC_FIXTURE_COMMAND } from "./public-runtime.ts";

const mode = process.argv[2];
const root = process.argv[3];
const statePath = process.argv[4];
if (!root || !["text", "json", "rpc"].includes(mode ?? ""))
  throw new Error("usage: public-mode-fixture <text|json|rpc> <root> [state-path]");

const fixture = await createPublicRuntimeFixture(root);
if (mode === "rpc") {
  await runRpcMode(fixture.runtime);
} else {
  const exitCode = await runPrintMode(fixture.runtime, {
    mode: mode as "text" | "json",
    initialMessage: PUBLIC_FIXTURE_COMMAND,
  });
  if (statePath)
    await writeFile(statePath, JSON.stringify(fixture.sessionManager.getEntries()), "utf8");
  process.exitCode = exitCode;
}
