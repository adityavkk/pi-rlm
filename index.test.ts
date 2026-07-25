import { afterEach, describe, expect, test } from "bun:test";
import type { RunResult } from "./src/runtime/index.ts";
import register, { createRlmExtension, LAUNCH_SNIPPET } from "./index.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: { status: string };
}

interface CapturedTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}

interface CapturedCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

type EventHandler = (event: any, ctx: any) => unknown;

const failedRun = {
  status: "failed",
  error: { code: "TEST_FAILURE", message: "test run finished" },
} as unknown as RunResult;

const harness = (options: { ttl?: number } = {}) => {
  const tools: CapturedTool[] = [];
  const commands = new Map<string, CapturedCommand>();
  const events = new Map<string, EventHandler[]>();
  const audits: Array<{ type: string; data: Record<string, unknown> }> = [];
  const notifications: string[] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const runs: unknown[] = [];
  let sessionId = "session-1";
  let clock = 100;
  let nextId = 0;
  let hasUI = true;
  let confirm: (title: string, message: string) => boolean | Promise<boolean> = () => true;

  const ctx = {
    get hasUI() {
      return hasUI;
    },
    mode: "tui",
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return confirm(title, message);
      },
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  };

  const pi = {
    registerTool: (definition: CapturedTool) => tools.push(definition),
    registerCommand: (name: string, definition: CapturedCommand) => commands.set(name, definition),
    on: (name: string, handler: EventHandler) => events.set(name, [...(events.get(name) ?? []), handler]),
    appendEntry: (type: string, data: Record<string, unknown>) => {
      audits.push({ type, data });
      return `entry-${audits.length}`;
    },
  };

  createRlmExtension({
    executeRun: async (request) => {
      runs.push(request);
      return failedRun;
    },
    now: () => clock,
    createId: () => `host-${++nextId}`,
    grantTtlMs: options.ttl,
  })(pi as never);

  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of events.get(name) ?? []) await handler(event, ctx);
  };
  const startTurn = async (text: string, turnIndex = 1, timestamp = 1_000) => {
    await emit("input", { text, source: "interactive" });
    await emit("turn_start", { turnIndex, timestamp });
  };

  return {
    tools,
    commands,
    audits,
    notifications,
    confirmations,
    runs,
    ctx,
    emit,
    startTurn,
    setSessionId: (value: string) => {
      sessionId = value;
    },
    setClock: (value: number) => {
      clock = value;
    },
    setHasUI: (value: boolean) => {
      hasUI = value;
      ctx.mode = value ? "tui" : "print";
    },
    setConfirm: (value: typeof confirm) => {
      confirm = value;
    },
  };
};

const rlmTool = (h: ReturnType<typeof harness>): CapturedTool => h.tools.find((tool) => tool.name === "rlm_run")!;

const oldAmbientBypass = process.env["PI_RLM_ALLOW_UNSOLICITED"];
afterEach(() => {
  if (oldAmbientBypass === undefined) delete process.env["PI_RLM_ALLOW_UNSOLICITED"];
  else process.env["PI_RLM_ALLOW_UNSOLICITED"] = oldAmbientBypass;
});

describe("pi-rlm extension wiring", () => {
  test("registers separated launcher guidance and launch surfaces", () => {
    const tools: CapturedTool[] = [];
    const commands: string[] = [];
    register({
      registerTool: (definition: CapturedTool) => tools.push(definition),
      registerCommand: (name: string) => commands.push(name),
      on: () => {},
      appendEntry: () => "entry",
    } as never);
    const tool = tools.find((candidate) => candidate.name === "rlm_run")!;
    expect(commands).toContain("rlm");
    expect(LAUNCH_SNIPPET).toContain("pi-rlm");
    expect(tool.promptSnippet).toContain("explicitly requested");
    expect(tool.promptGuidelines?.every((guideline) => guideline.includes("rlm_run"))).toBe(true);
  });

  test("confirmed happy path displays and audits exact normalized identity", async () => {
    const h = harness();
    await h.startTurn("Please analyze this context");
    const result = await rlmTool(h).execute(
      "call-1",
      { objective: "Find contradictions", context: "alpha\nbeta" },
      undefined,
      undefined,
      h.ctx,
    );

    expect(result.details?.status).toBe("failed");
    expect(h.runs).toHaveLength(1);
    expect(h.confirmations[0]?.message).toContain("Objective: Find contradictions");
    expect(h.confirmations[0]?.message).toContain("Exact normalized request SHA-256:");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.data["toolCallId"]).toBe("call-1");
    expect(h.audits[0]?.data["requestSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h.audits[0]?.data["mode"]).toBe("confirmed");
  });

  test("explicit current-turn grant is one-shot and rejects replay", async () => {
    const h = harness();
    h.setHasUI(false);
    await h.startTurn("Use pi-rlm to review these notes");
    const tool = rlmTool(h);
    const first = await tool.execute("call-explicit", { objective: "Review" }, undefined, undefined, h.ctx);
    const replay = await tool.execute("call-explicit", { objective: "Review" }, undefined, undefined, h.ctx);

    expect(first.details?.status).toBe("failed");
    expect(replay.content[0]?.text).toContain("RLM_GRANT_REPLAY");
    expect(h.runs).toHaveLength(1);
    expect(h.audits[0]?.data["mode"]).toBe("explicit_prompt");
  });

  test("concurrent consumption of one tool call starts only one run", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    let resolveConfirmation!: (approved: boolean) => void;
    h.setConfirm(() => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)));
    const tool = rlmTool(h);
    const first = tool.execute("call-race", { objective: "Review" }, undefined, undefined, h.ctx);
    await Promise.resolve();
    const concurrent = await tool.execute("call-race", { objective: "Review" }, undefined, undefined, h.ctx);
    resolveConfirmation(true);
    const accepted = await first;

    expect(concurrent.content[0]?.text).toContain("RLM_GRANT_REPLAY");
    expect(accepted.details?.status).toBe("failed");
    expect(h.runs).toHaveLength(1);
  });

  test("session mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    h.setConfirm(() => {
      h.setSessionId("session-2");
      return true;
    });
    const result = await rlmTool(h).execute("call-session", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_SESSION_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("turn mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally", 1, 1_000);
    h.setConfirm(async () => {
      await h.emit("turn_start", { turnIndex: 2, timestamp: 2_000 });
      return true;
    });
    const result = await rlmTool(h).execute("call-turn", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_TURN_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("prompt mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Original prompt", 1, 1_000);
    h.setConfirm(async () => {
      await h.emit("input", { text: "Changed prompt", source: "interactive" });
      await h.emit("turn_start", { turnIndex: 1, timestamp: 1_000 });
      return true;
    });
    const result = await rlmTool(h).execute("call-prompt", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_PROMPT_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("request mismatch after confirmation fails before initialization", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    const params = { objective: "Approved objective", context: "source" };
    h.setConfirm(() => {
      params.objective = "Mutated objective";
      return true;
    });
    const result = await rlmTool(h).execute("call-request", params, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_REQUEST_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("post-confirm nested source mutation cannot change the approved program", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    const params = {
      program: {
        objective: "Review routes",
        inputs: [{ name: "routes", adapter: "text", description: "Routes" }],
        outputs: [{ name: "answer", schema: { type: "string" } }],
        profile: "default",
      },
      sources: { routes: "before" },
    };
    h.setConfirm(() => {
      params.sources.routes = "after";
      return true;
    });
    const result = await rlmTool(h).execute("call-mutation", params, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_REQUEST_MISMATCH");
    expect(h.runs).toHaveLength(0);
  });

  test("confirmation denial consumes no authority and starts no run", async () => {
    const h = harness();
    await h.startTurn("Analyze this normally");
    h.setConfirm(() => false);
    const result = await rlmTool(h).execute("call-denied", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.runs).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  test("expired grant fails closed before initialization", async () => {
    const h = harness({ ttl: 0 });
    await h.startTurn("Analyze this normally");
    const result = await rlmTool(h).execute("call-expired", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_GRANT_EXPIRED");
    expect(h.runs).toHaveLength(0);
  });

  test("/rlm mints, consumes, and audits its own one-shot command grant", async () => {
    const h = harness();
    await h.commands.get("rlm")!.handler("Summarize the notes", h.ctx);
    expect(h.runs).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.data["mode"]).toBe("slash_command");
    expect(h.audits[0]?.data["toolCallId"]).toMatch(/^command:host-/);
  });

  test("headless unsolicited call denies even with removed ambient bypass set", async () => {
    process.env["PI_RLM_ALLOW_UNSOLICITED"] = "1";
    const h = harness();
    h.setHasUI(false);
    await h.startTurn("Just summarize this without pi-rlm");
    const result = await rlmTool(h).execute("call-headless", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.runs).toHaveLength(0);
  });

  test("runtime initialization is not called when no consumable turn grant exists", async () => {
    const h = harness();
    const result = await rlmTool(h).execute("call-no-turn", { objective: "Review" }, undefined, undefined, h.ctx);
    expect(result.content[0]?.text).toContain("RLM_OPT_IN_REQUIRED");
    expect(h.runs).toHaveLength(0);
  });
});
