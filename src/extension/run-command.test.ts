import { describe, expect, test } from "bun:test";
import { routeRlmCommand } from "./run-command.ts";

const name = `run-${"a".repeat(32)}`;

describe("strict /rlm management grammar", () => {
  test("routes every exact management form", () => {
    expect(routeRlmCommand("runs")).toEqual({ kind: "runs" });
    expect(routeRlmCommand(`inspect ${name}`)).toEqual({ kind: "inspect", target: name });
    expect(routeRlmCommand(`resume ${name}`)).toEqual({ kind: "resume", target: name });
    expect(routeRlmCommand("cleanup")).toEqual({ kind: "cleanup", mode: "apply" });
    expect(routeRlmCommand("cleanup --dry-run")).toEqual({ kind: "cleanup", mode: "dry-run" });
    expect(routeRlmCommand("cleanup --force")).toEqual({ kind: "cleanup", mode: "force" });
    expect(routeRlmCommand("cancel rlm_local")).toEqual({ kind: "cancel", target: "rlm_local" });
  });

  test.each([
    "runs/extra", "runs extra", "inspect", "inspect:bad", "inspect a b", "resume", "resume rlm_local",
    `resume ${name} extra`, "resume /tmp/run", "cleanup --dry-run extra", "cleanup --force=true",
    "cleanup\u200b--force", "cancel", "cancel\u200b rlm_local", "launch\u0000payload",
  ])("never routes malformed reserved input to launch: %s", (input) => {
    expect(routeRlmCommand(input)).toEqual({ kind: "invalid-management" });
  });

  test("leaves unrelated source forms for launch capture", () => {
    expect(routeRlmCommand('{"objective":"runs report"}')).toEqual({
      kind: "launch", args: '{"objective":"runs report"}',
    });
    expect(routeRlmCommand("runtime analysis")).toEqual({ kind: "launch", args: "runtime analysis" });
  });
});
