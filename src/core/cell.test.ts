import { describe, expect, test } from "bun:test";
import { transformCell } from "./cell.ts";

describe("transformCell", () => {
  test("rewrites a trailing expression into an implicit return", () => {
    const r = transformCell("const x = 40;\nx + 2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.hasResultExpression).toBe(true);
      expect(r.value.source).toContain("return (");
      expect(r.value.source).toContain("x + 2");
    }
  });

  test("no implicit return when last statement is a declaration", () => {
    const r = transformCell("const x = 1;");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hasResultExpression).toBe(false);
  });

  test("supports trailing await expression", () => {
    const r = transformCell("await hostThing();\nawait llm({ key: 'k', prompt: 'p' })");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hasResultExpression).toBe(true);
  });

  test.each([
    ["import fs from 'fs'", "import statements"],
    ["export const x = 1", "export statements"],
    ["const m = await import('x')", "dynamic import"],
    ["eval('1+1')", "direct eval"],
    ["const u = import.meta.url", "import.meta"],
  ])("rejects forbidden construct: %s", (code, needle) => {
    const r = transformCell(code);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PARSE_ERROR");
      expect(r.error.message).toContain(needle);
    }
  });

  test("with statement is rejected (strict mode)", () => {
    const r = transformCell("with (obj) { x }");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PARSE_ERROR");
  });

  test("top-level return is a parse error", () => {
    const r = transformCell("return 5");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PARSE_ERROR");
  });

  test("syntax error surfaces as PARSE_ERROR", () => {
    const r = transformCell("const = = =");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PARSE_ERROR");
  });
});
