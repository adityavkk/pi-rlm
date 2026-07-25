import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLedger } from "../core/budget.ts";
import { DEFAULT_PROFILE, resolveLimits, type RunResult } from "../runtime/index.ts";
import {
  buildInlineRequest,
  captureCommandRequest,
  INLINE_SOURCE_MAX_BYTES,
  SESSION_SOURCE_MAX_BYTES,
  SESSION_SOURCE_MAX_ENTRIES,
  SESSION_SOURCE_MAX_NODES,
} from "./source.ts";
import { FULL_ANSWER_MAX_BYTES, projectRunResult, resultContent, resultMetadata } from "./result.ts";

const commandContext = (
  cwd: string,
  entries: unknown[] = [],
  trusted = true,
): Parameters<typeof captureCommandRequest>[1] => ({
  cwd,
  isProjectTrusted: () => trusted,
  sessionManager: { buildContextEntries: () => entries },
} as never);

const program = (inputs: string[]) => ({
  objective: "Review",
  inputs: inputs.map((name) => ({ name, adapter: "text", description: name })),
  outputs: [{ name: "answer", schema: { type: "string" } }],
  profile: "default",
});

const completed = (answer: unknown): RunResult => ({
  runId: `run_${"1".repeat(64)}`,
  status: "completed",
  completionMode: "answer",
  answer: answer as never,
  output: { ref: `ctx_${"2".repeat(64)}`, sha256: "2".repeat(64), bytes: 5 },
  ledger: createLedger(resolveLimits(DEFAULT_PROFILE, 0)),
});

describe("strict source forms", () => {
  test.each([
    ["", "RLM_SOURCE_REQUIRED"],
    ["bare objective", "RLM_SOURCE_REQUIRED"],
    ['{"objective":"x","context":"y"} trailing', "RLM_SOURCE_INVALID"],
    ["--file x -- objective", "RLM_SOURCE_INVALID"],
    ["--session objective", "RLM_SOURCE_INVALID"],
  ])("classifies %s", async (args, code) => {
    const result = await captureCommandRequest(args, commandContext(process.cwd()));
    expect(result.ok ? undefined : result.error.code).toBe(code as "RLM_SOURCE_REQUIRED" | "RLM_SOURCE_INVALID");
  });

  test("accepts only complete inline shorthand and typed sources", () => {
    expect(buildInlineRequest({ objective: "Review", context: "source" })).toMatchObject({ ok: true });
    expect(buildInlineRequest({ objective: "Review", context: " " })).toMatchObject({
      ok: false, error: { code: "RLM_SOURCE_REQUIRED" },
    });
    expect(buildInlineRequest({ program: program([]) })).toMatchObject({ ok: true, value: { sources: {} } });
    expect(buildInlineRequest({ program: program(["a", "b"]), sources: { a: "one" } })).toMatchObject({
      ok: false, error: { code: "RLM_SOURCE_REQUIRED" },
    });
    expect(buildInlineRequest({ program: program(["a"]), sources: { a: "one", extra: "two" } })).toMatchObject({
      ok: false, error: { code: "RLM_SOURCE_INVALID" },
    });
  });

  test("enforces the aggregate inline UTF-8 byte limit", () => {
    expect(buildInlineRequest({ objective: "Review", context: "x".repeat(INLINE_SOURCE_MAX_BYTES + 1) }))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_LIMIT" } });
  });

  test("captures trusted regular UTF-8 files without disclosing paths in failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rlm-source-"));
    await mkdir(join(cwd, "notes"));
    await writeFile(join(cwd, "notes", "ok.md"), "alpha\nβeta", "utf8");
    const accepted = await captureCommandRequest('--file "notes/ok.md" -- Summarize', commandContext(cwd));
    expect(accepted).toMatchObject({ ok: true, value: { sources: { context: "alpha\nβeta" } } });

    const untrusted = await captureCommandRequest('--file "notes/ok.md" -- Summarize', commandContext(cwd, [], false));
    expect(untrusted).toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });
    expect(JSON.stringify(untrusted)).not.toContain("ok.md");

    await writeFile(join(cwd, "notes", "bad.bin"), Uint8Array.from([0xc3, 0x28]));
    expect(await captureCommandRequest('--file "notes/bad.bin" -- Summarize', commandContext(cwd)))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_ENCODING" } });

    await symlink("ok.md", join(cwd, "notes", "link.md"));
    expect(await captureCommandRequest('--file "notes/link.md" -- Summarize', commandContext(cwd)))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });

    await link(join(cwd, "notes", "ok.md"), join(cwd, "notes", "hard.md"));
    expect(await captureCommandRequest('--file "notes/hard.md" -- Summarize', commandContext(cwd)))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });
    expect(await captureCommandRequest('--file "notes" -- Summarize', commandContext(cwd)))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });
    expect(await captureCommandRequest('--file "../outside" -- Summarize', commandContext(cwd)))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });
  });

  test("projects only eligible active-session text with deterministic labels", async () => {
    const entries = [
      { type: "message", message: { role: "system", content: "secret" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "question" }, { type: "image", data: "raw" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "answer" }, { type: "toolCall", arguments: "hidden" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
      { type: "compaction", summary: "older summary", details: { raw: "hidden" } },
      { type: "branch_summary", summary: "branch summary" },
      { type: "custom_message", customType: "note", content: [{ type: "text", text: "custom text" }, { type: "image", data: "hidden" }], details: { hidden: true } },
      { type: "custom", customType: "settings", data: "hidden" },
    ];
    const result = await captureCommandRequest("--session -- Review", commandContext(process.cwd(), entries));
    expect(result.ok && result.value.sources["context"]).toBe([
      "[user]\nquestion",
      "[assistant]\nanswer",
      "[compaction]\nolder summary",
      "[branch-summary]\nbranch summary",
      "[custom:note]\ncustom text",
    ].join("\n\n"));
    expect(JSON.stringify(result)).not.toMatch(/secret|tool output|thinking|settings/);
  });

  test("bounds session entry traversal and rejects accessors without invoking them", async () => {
    const tooMany = Array.from({ length: SESSION_SOURCE_MAX_ENTRIES + 1 }, () => ({
      type: "message", message: { role: "user", content: "x" },
    }));
    expect(await captureCommandRequest("--session -- Review", commandContext(process.cwd(), tooMany)))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_LIMIT" } });
    let invoked = false;
    const entry = { type: "message", message: { role: "user" } } as Record<string, unknown>;
    Object.defineProperty(entry["message"] as object, "content", { get() { invoked = true; return "x"; } });
    expect(await captureCommandRequest("--session -- Review", commandContext(process.cwd(), [entry])))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });
    expect(invoked).toBe(false);
  });

  test("rejects root and recursively nested Proxies before invoking any trap", async () => {
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() { traps++; throw new Error("get trap"); },
      getOwnPropertyDescriptor() { traps++; throw new Error("descriptor trap"); },
      getPrototypeOf() { traps++; throw new Error("prototype trap"); },
      ownKeys() { traps++; throw new Error("keys trap"); },
    };
    const root = new Proxy([], handler);
    expect(await captureCommandRequest("--session -- Review", commandContext(process.cwd(), root as never)))
      .toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });
    expect(traps).toBe(0);

    const nested = new Proxy({ role: "user", content: "hidden" }, handler);
    expect(await captureCommandRequest("--session -- Review", commandContext(process.cwd(), [
      { type: "message", message: nested },
    ]))).toMatchObject({ ok: false, error: { code: "RLM_SOURCE_INVALID" } });
    expect(traps).toBe(0);
  });

  test("uses one global traversal budget for a 10k-by-10k excluded-block adversary", async () => {
    const excludedBlocks = Array.from({ length: SESSION_SOURCE_MAX_ENTRIES }, () => ({ type: "image", data: "excluded" }));
    const entries = Array.from({ length: SESSION_SOURCE_MAX_ENTRIES }, () => ({
      type: "message", message: { role: "user", content: excludedBlocks },
    }));
    const result = await captureCommandRequest("--session -- Review", commandContext(process.cwd(), entries));
    expect(result).toMatchObject({ ok: false, error: { code: "RLM_SOURCE_LIMIT" } });
    expect(SESSION_SOURCE_MAX_NODES).toBe(50_000);
  });

  test("rejects the first of 10k repeated huge included blocks before visiting the second", async () => {
    const huge = "x".repeat(SESSION_SOURCE_MAX_BYTES + 1);
    const block = { type: "text", text: huge };
    const blocks = Array(SESSION_SOURCE_MAX_ENTRIES).fill(block);
    let secondVisited = false;
    Object.defineProperty(blocks, 1, { get() { secondVisited = true; return block; } });
    const result = await captureCommandRequest("--session -- Review", commandContext(process.cwd(), [
      { type: "message", message: { role: "user", content: blocks } },
    ]));
    expect(result).toMatchObject({ ok: false, error: { code: "RLM_SOURCE_LIMIT" } });
    expect(secondVisited).toBe(false);
  });

  test("enforces the shared UTF-8 budget at a multibyte boundary", async () => {
    const labelBytes = Buffer.byteLength("[user]\n", "utf8");
    const exact = `${"x".repeat(SESSION_SOURCE_MAX_BYTES - labelBytes - 2)}é`;
    const accepted = await captureCommandRequest("--session -- Review", commandContext(process.cwd(), [
      { type: "message", message: { role: "user", content: exact } },
    ]));
    expect(accepted.ok && Buffer.byteLength(accepted.value.sources["context"]!, "utf8"))
      .toBe(SESSION_SOURCE_MAX_BYTES);

    const over = `${"x".repeat(SESSION_SOURCE_MAX_BYTES - labelBytes - 1)}é`;
    expect(await captureCommandRequest("--session -- Review", commandContext(process.cwd(), [
      { type: "message", message: { role: "user", content: over } },
    ]))).toMatchObject({ ok: false, error: { code: "RLM_SOURCE_LIMIT" } });
  });
});

describe("bounded shared result projection", () => {
  test("keeps canonical small answers and metadata", () => {
    const projection = projectRunResult(completed({ answer: "done" }));
    expect(projection).toMatchObject({
      status: "completed",
      mode: "answer",
      answer: { answer: "done" },
      output: { ref: `ctx_${"2".repeat(64)}`, sha256: "2".repeat(64), bytes: 5 },
      truncation: { truncated: false },
    });
    expect(resultMetadata(projection)).not.toHaveProperty("answer");
    expect(JSON.parse(resultContent(projection))).toEqual(projection);
  });

  test("uses a deterministic bounded head-tail preview for large answers", () => {
    const answer = { answer: "z".repeat(FULL_ANSWER_MAX_BYTES + 1) };
    const first = projectRunResult(completed(answer));
    const second = projectRunResult(completed(answer));
    expect(first).toEqual(second);
    expect(first).not.toHaveProperty("answer");
    expect(first).toMatchObject({ truncation: { truncated: true }, answerPreview: expect.any(String) });
    expect(Buffer.byteLength(resultContent(first), "utf8")).toBeLessThan(FULL_ANSWER_MAX_BYTES);
  });
});
