import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { BudgetUsage } from "../../core/index.ts";
import type { RlmResultMetadata } from "../result.ts";
import {
  renderRlmMessageResultComponent,
  renderRlmRunCall,
  renderRlmRunCallComponent,
  renderRlmRunResult,
  renderRlmRunResultComponent,
  renderRlmToolResultComponent,
  RlmRunResultComponent,
} from "./result-renderer.ts";

const usage: BudgetUsage = {
  framesOpened: 7,
  logicalCalls: 12,
  attempts: 13,
  controllerTurns: 4,
  activeLeafCalls: 0,
  tokensReserved: 0,
  tokensUsed: 123_456,
  inputTokensUsed: 100_000,
  outputTokensUsed: 23_456,
  costUsd: 1.2345,
  providerDurationMs: 12_345,
  storedBytes: 9_000,
};

const base = (patch: Partial<RlmResultMetadata> = {}): RlmResultMetadata => ({
  runId: `run_${"a".repeat(64)}`,
  status: "completed",
  mode: "answer",
  output: { ref: "/private/answer.json", sha256: "secret-sha", bytes: 999 },
  usage,
  warningCodes: [],
  truncation: { truncated: false, originalBytes: 123, omittedBytes: 0 },
  ...patch,
});

describe("rlm result renderer", () => {
  test("distinguishes every terminal state from bounded metadata", () => {
    const states = {
      answer: renderRlmRunResult(base(), 180),
      fallback: renderRlmRunResult(base({ mode: "fallback_extract" }), 180),
      failed: renderRlmRunResult(base({ status: "failed", mode: null, errorCode: "BUDGET_CALLS" }), 180),
      cancelled: renderRlmRunResult(base({ status: "cancelled", mode: null, errorCode: "CANCELLED" }), 180),
    };
    expect(states).toMatchInlineSnapshot(`
      {
        "answer": [
          "✓  RLM completed  #aaaaaaaa  answer",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
        ],
        "cancelled": [
          "-  RLM cancelled  #aaaaaaaa",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
        ],
        "failed": [
          "×  RLM failed  #aaaaaaaa  BUDGET_CALLS",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
        ],
        "fallback": [
          "✓  RLM completed  #aaaaaaaa  fallback extract",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
        ],
      }
    `);
    expect(states.answer[0]).toContain("answer");
    expect(states.fallback[0]).toContain("fallback extract");
    expect(states.failed[0]).toContain("BUDGET_CALLS");
    expect(states.cancelled[0]).toContain("cancelled");
  });

  test("renders warning count/codes, usage, and truncation at bounded widths", () => {
    const metadata = base({
      warningCodes: ["RETENTION_METADATA_FAILED", "RETENTION_CLEANUP_FAILED"],
      truncation: { truncated: true, originalBytes: 100_000, omittedBytes: 34_464 },
    });
    const snapshots = Object.fromEntries([50, 60, 80, 100, 120, 180]
      .map((width) => [width, renderRlmRunResult(metadata, width)]));
    expect(snapshots).toMatchInlineSnapshot(`
      {
        "100": [
          "✓  RLM completed  #aaaaaaaa  answer",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
          "  ! 2 warnings  RETENTION_METADATA_FAILED, RETENTION_CLEANUP_FAILED",
          "  ! Result truncated  100k bytes · 34k omitted",
        ],
        "120": [
          "✓  RLM completed  #aaaaaaaa  answer",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
          "  ! 2 warnings  RETENTION_METADATA_FAILED, RETENTION_CLEANUP_FAILED",
          "  ! Result truncated  100k bytes · 34k omitted",
        ],
        "180": [
          "✓  RLM completed  #aaaaaaaa  answer",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
          "  ! 2 warnings  RETENTION_METADATA_FAILED, RETENTION_CLEANUP_FAILED",
          "  ! Result truncated  100k bytes · 34k omitted",
        ],
        "50": [
          "✓  RLM completed  #aaaaaaaa  answer",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · prov\x1B[0m…\x1B[0m",
          "  ! 2 warnings  RETENTION_METADATA_FAILED, RETENT\x1B[0m…\x1B[0m",
          "  ! Result truncated  100k bytes · 34k omitted",
        ],
        "60": [
          "✓  RLM completed  #aaaaaaaa  answer",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
          "  ! 2 warnings  RETENTION_METADATA_FAILED, RETENTION_CLEANU\x1B[0m…\x1B[0m",
          "  ! Result truncated  100k bytes · 34k omitted",
        ],
        "80": [
          "✓  RLM completed  #aaaaaaaa  answer",
          "  calls 12 · frames 7 · 123k tok · $1.2345 · provider 12.3s",
          "  ! 2 warnings  RETENTION_METADATA_FAILED, RETENTION_CLEANUP_FAILED",
          "  ! Result truncated  100k bytes · 34k omitted",
        ],
      }
    `);
    for (const [width, lines] of Object.entries(snapshots))
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Number(width));
    expect(snapshots[180]!.join("\n")).toMatch(/2 warnings.*RETENTION_METADATA_FAILED/u);
    expect(snapshots[180]!.join("\n")).toContain("calls 12");
    expect(snapshots[180]!.join("\n")).toContain("100k bytes · 34k omitted");
  });

  test("custom messages render identity-bound bounded answers and errors without raw metadata", () => {
    const completedContent = JSON.stringify({
      ...base(),
      answer: { answer: "Useful final answer\nwith one more line" },
      internal: "/private/raw-metadata",
    });
    const completed = renderRlmMessageResultComponent({ details: base(), content: completedContent }, false)
      .render(80).join("\n");
    expect(completed).toContain("Answer");
    expect(completed).toContain("Useful final answer");
    expect(completed).toContain("with one more line");
    expect(completed).not.toContain("raw-metadata");
    expect(completed).not.toContain("answer.json");

    const failedMetadata = base({ status: "failed", mode: null, errorCode: "BUDGET_CALLS" });
    const failedContent = JSON.stringify({
      ...failedMetadata,
      error: { code: "BUDGET_CALLS", message: "Call budget exhausted." },
    });
    const failed = renderRlmMessageResultComponent({ details: failedMetadata, content: failedContent }, false)
      .render(80).join("\n");
    expect(failed).toContain("Error");
    expect(failed).toContain("Call budget exhausted.");

    const cancelledMetadata = base({ status: "cancelled", mode: null, errorCode: "CANCELLED" });
    const cancelledContent = JSON.stringify({
      ...cancelledMetadata,
      error: { code: "CANCELLED", message: "Interrupted by the current process." },
    });
    const cancelled = renderRlmMessageResultComponent({
      details: cancelledMetadata,
      content: cancelledContent,
    }, false).render(80).join("\n");
    expect(cancelled).toContain("RLM cancelled");
    expect(cancelled).toContain("Interrupted by the current process.");

    const truncatedMetadata = base({
      truncation: { truncated: true, originalBytes: 4096, omittedBytes: 3072 },
    });
    const truncatedContent = JSON.stringify({ ...truncatedMetadata, answerPreview: "Bounded answer preview." });
    const truncated = renderRlmMessageResultComponent({
      details: truncatedMetadata,
      content: truncatedContent,
    }, false).render(80).join("\n");
    expect(truncated).toContain("Bounded answer preview.");
    expect(truncated).toContain("Result truncated");

    const mismatched = JSON.stringify({ ...base(), runId: `run_${"b".repeat(64)}`, answer: "MUST NOT RENDER" });
    expect(renderRlmMessageResultComponent({ details: base(), content: mismatched }, true).render(80).join("\n"))
      .not.toContain("MUST NOT RENDER");
  });

  test("expanded message and tool adapters reveal more bounded answer lines", () => {
    const answer = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const content = JSON.stringify({ ...base(), answer });
    const collapsed = renderRlmMessageResultComponent({ details: base(), content }, false).render(80);
    const expanded = renderRlmMessageResultComponent({ details: base(), content }, true).render(80);
    expect(collapsed.join("\n")).toContain("expand to view more");
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(expanded.join("\n")).toContain("line 20");
    const tool = renderRlmToolResultComponent({
      details: base(),
      content: [{ type: "text", text: content }],
    }, undefined, false).render(80).join("\n");
    expect(tool).toContain("line 1");
    expect(tool).not.toContain("line 20");
  });

  test("metadata-only rendering never exposes answer, error message, output ref, path, or invalid identity text", () => {
    const hostile = {
      ...base({
        runId: "/private/session/provider-secret" as RlmResultMetadata["runId"],
        status: "failed",
        mode: null,
        errorCode: "BAD\u001b]0;osc\u0007_CODE",
        warningCodes: ["\u202eWARN", "OK_WARNING"],
      }),
      answer: "RAW ANSWER MUST NOT RENDER",
      error: { message: "RAW PROVIDER ERROR MUST NOT RENDER" },
    } as unknown as RlmResultMetadata;
    const output = renderRlmRunResult(hostile, 180).join("\n");
    expect(output).not.toMatch(/RAW|ANSWER|PROVIDER ERROR|private|session|provider-secret|osc|\u001b|\u202e/u);
    expect(output).toContain("RLM_RUN_FAILED");
    expect(output).toContain("RLM_WARNING, OK_WARNING");
    expect(output).not.toContain("answer.json");
  });

  test("hostile details and usage cannot throw into Pi raw-content fallback", () => {
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("raw secret"); } });
    expect(() => renderRlmRunResult(throwing, 80)).not.toThrow();
    expect(renderRlmRunResult(throwing, 80)).toEqual(["×  RLM failed  RLM_RESULT_INVALID"]);
    expect(() => renderRlmToolResultComponent(throwing).render(80)).not.toThrow();
    expect(renderRlmToolResultComponent(throwing).render(80)).toEqual(["×  RLM failed  RLM_RESULT_INVALID"]);
    const invalidContent = JSON.stringify({
      status: "failed",
      runId: null,
      error: { code: "RLM_RESULT_INVALID", message: "MUST NOT RENDER" },
    });
    expect(renderRlmMessageResultComponent({ details: throwing, content: invalidContent }, true)
      .render(80).join("\n")).not.toContain("MUST NOT RENDER");
    expect(renderRlmToolResultComponent({
      details: throwing,
      content: [{ type: "text", text: invalidContent }],
    }, undefined, true).render(80).join("\n")).not.toContain("MUST NOT RENDER");
    const accessorDetails = {
      runId: `run_${"a".repeat(64)}`,
      mode: null,
      errorCode: "RLM_RESULT_INVALID",
    };
    Object.defineProperty(accessorDetails, "status", { get: () => "failed" });
    const accessorContent = JSON.stringify({
      status: "failed",
      runId: `run_${"a".repeat(64)}`,
      error: { code: "RLM_RESULT_INVALID", message: "MUST NOT RENDER" },
    });
    expect(renderRlmMessageResultComponent({ details: accessorDetails, content: accessorContent }, true)
      .render(80).join("\n")).not.toContain("MUST NOT RENDER");

    const getter = Object.defineProperty({}, "details", { get: () => { throw new Error("raw answer"); } });
    expect(renderRlmToolResultComponent(getter).render(80)).toEqual(["×  RLM failed  RLM_RESULT_INVALID"]);
    const hostileUsage = Object.defineProperty({}, "tokensUsed", { get: () => { throw new Error("raw path"); } });
    const withUsage = { ...base(), usage: hostileUsage };
    expect(renderRlmRunResult(withUsage, 80).join("\n")).not.toMatch(/raw|path/u);
    expect(renderRlmRunResult({ ...base(), mode: null }, 80)[0]).toBe("×  RLM failed  #aaaaaaaa  RLM_RESULT_INVALID");
  });

  test("public-root components and adapters are pure width-aware renderers", () => {
    const result = new RlmRunResultComponent(base({ mode: "fallback_extract" }));
    expect(result.render(60)).toEqual(renderRlmRunResult(base({ mode: "fallback_extract" }), 60));
    result.invalidate();
    expect(renderRlmRunResultComponent(base()).render(80)[0]).toContain("completed");
    expect(renderRlmRunCallComponent().render(80)).toEqual(["RLM run"]);
    expect(renderRlmRunCall(3)).toEqual(["RL…"]);
  });
});
