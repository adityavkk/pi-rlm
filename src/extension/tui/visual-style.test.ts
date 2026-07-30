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
    for (const width of [25, 40, 80, 120]) {
      const lines = renderPanel({ title: "RLM runs · 1 active", body: ["● #12345678 controller"], width, footer: "esc close" });
      expect(lines).toHaveLength(4);
      expect(lines.slice(0, -1).every((line) => visibleWidth(line) === width - 1)).toBe(true);
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

  test("keeps ANSI-styled dark and light theme output width safe", () => {
    for (const foreground of ["38;2;205;214;244", "38;2;76;79;105"]) {
      const theme = {
        fg: (_color: string, text: string) => `\u001b[${foreground}m${text}\u001b[0m`,
        bg: (_color: string, text: string) => `\u001b[48;2;30;30;46m${text}\u001b[0m`,
        bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
      };
      const lines = renderPanel({
        title: "RLM runs · 1 active",
        body: ["● #12345678 controller · 12k tok"],
        width: 60,
        style: visualStyleForTheme(theme as never),
        surface: true,
        footer: "esc close",
      });
      expect(lines.every((line) => visibleWidth(line) <= 59)).toBe(true);
      expect(lines.join("\n")).toContain("\u001b[");
    }
  });

  test("keeps long action footers out of the terminal autowrap column", () => {
    for (const width of [25, 40, 59, 60]) {
      const lines = renderPanel({
        title: "RLM runs",
        body: ["one row"],
        width,
        footer: "←→ view · ↑↓ item · n next · p previous · r refresh · esc back",
      });
      expect(lines.every((line) => visibleWidth(line) <= width - 1)).toBe(true);
    }
  });

  test("uses single-cell, non-color-only status markers", () => {
    for (const status of ["running", "cancelling", "approval", "completed", "failed", "cancelled", "inactive"] as const)
      expect(visibleWidth(statusGlyph(status))).toBe(1);
  });
});
