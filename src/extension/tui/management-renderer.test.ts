import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderRlmManagementResult,
  renderRlmManagementResultComponent,
} from "./management-renderer.ts";

const metadata = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  operation: "cancel",
  status: "completed",
  code: "RLM_CANCEL_REQUESTED",
  message: "Cancellation requested.",
  runId: `run_${"a".repeat(64)}`,
  counts: { requested: 1, pending: 0 },
  rows: ["raw row intentionally omitted"],
  warningCodes: [],
  ...patch,
});

describe("RLM management result renderer", () => {
  test("renders one compact hierarchy without verbose row payloads", () => {
    const lines = renderRlmManagementResult(metadata(), 100);
    expect(lines).toEqual([
      "✓  RLM cancellation  #aaaaaaaa  RLM_CANCEL_REQUESTED",
      "  Cancellation requested.",
      "  requested 1 · pending 0",
    ]);
    expect(lines.join("\n")).not.toContain("raw row");
  });

  test("distinguishes failure and warnings while remaining width bounded", () => {
    const value = metadata({
      operation: "cleanup",
      status: "failed",
      code: "RLM_CLEANUP_PARTIAL",
      warningCodes: ["RLM_CLEANUP_PARTIAL"],
    });
    for (const width of [20, 40, 80, 120]) {
      const lines = renderRlmManagementResult(value, width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    const output = renderRlmManagementResult(value, 120).join("\n");
    expect(output).toContain("×  RLM cleanup");
    expect(output).toContain("1 warnings");
  });

  test("hostile metadata fails to a constant summary without getters or raw fallback", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "version", {
      enumerable: true,
      get() { getterCalls += 1; return 1; },
    });
    expect(renderRlmManagementResult(accessor, 100)).toEqual([
      "×  RLM management  RLM_MANAGEMENT_INVALID",
      "  Management result metadata is unavailable.",
    ]);
    expect(getterCalls).toBe(0);
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("RAW SECRET"); } });
    expect(() => renderRlmManagementResultComponent(throwing).render(80)).not.toThrow();
    expect(renderRlmManagementResultComponent(throwing).render(80).join("\n")).not.toContain("RAW SECRET");
  });
});
