import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  fitStyledLine,
  renderPanel,
  statusGlyph,
  visualStyleForTheme,
} from "./visual-style.ts";

describe("workflow visual primitives", () => {
  test("renders one closed width-exact panel and an external footer", () => {
    for (const width of [24, 40, 80, 120]) {
      const lines = renderPanel({ title: "RLM runs · 1 active", body: ["● #12345678 controller"], width, footer: "esc close" });
      expect(lines).toHaveLength(4);
      expect(lines.slice(0, -1).every((line) => visibleWidth(line) === width)).toBe(true);
      expect(lines.at(0)?.startsWith("╭─ ")).toBe(true);
      expect(lines.at(-2)?.startsWith("╰")).toBe(true);
      expect(lines.at(-1)?.trim()).toBe("esc close");
    }
  });

  test("falls back safely for narrow widths and incomplete host themes", () => {
    const style = visualStyleForTheme({} as never);
    expect(style.strong("plain")).toBe("plain");
    for (const width of [1, 8, 23]) {
      const lines = renderPanel({ title: "RLM", body: ["long body value"], width, footer: "close", style });
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(visibleWidth(fitStyledLine("界界界", 5))).toBeLessThanOrEqual(5);
  });

  test("uses single-cell, non-color-only status markers", () => {
    for (const status of ["running", "cancelling", "approval", "completed", "failed", "cancelled", "inactive"] as const)
      expect(visibleWidth(statusGlyph(status))).toBe(1);
  });
});
