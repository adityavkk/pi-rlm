import { describe, expect, test } from "bun:test";
import register, { LAUNCH_SNIPPET } from "./index.ts";

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

const capture = () => {
  const tools: CapturedTool[] = [];
  const commands: string[] = [];
  const pi = {
    registerTool: (def: CapturedTool) => tools.push(def),
    registerCommand: (name: string) => commands.push(name),
    on: () => {},
  };
  register(pi as never);
  return { tools, commands };
};

describe("pi-rlm extension wiring", () => {
  test("registers the /rlm command and rlm_run tool", () => {
    const { tools, commands } = capture();
    expect(commands).toContain("rlm");
    expect(tools.map((t) => t.name)).toContain("rlm_run");
    expect(LAUNCH_SNIPPET).toContain("pi-rlm");
  });

  test("rlm_run denies an unsolicited headless call before any spend", async () => {
    const { tools } = capture();
    const tool = tools.find((t) => t.name === "rlm_run")!;
    const ctx = { hasUI: false, ui: { confirm: async () => true, notify: () => {}, setStatus: () => {} }, cwd: process.cwd() };
    const result = await tool.execute("id", { objective: "do a thing" }, undefined, undefined, ctx);
    expect(result.content[0]!.text).toContain("RLM_OPT_IN_REQUIRED");
    expect((result.details as { status: string }).status).toBe("denied");
  });

  test("rlm_run rejects an approved-but-empty request without launching", async () => {
    const { tools } = capture();
    const tool = tools.find((t) => t.name === "rlm_run")!;
    const ctx = { hasUI: true, ui: { confirm: async () => true, notify: () => {}, setStatus: () => {} }, cwd: process.cwd() };
    const result = await tool.execute("id", {}, undefined, undefined, ctx);
    expect(result.content[0]!.text).toContain("Provide either");
  });
});
