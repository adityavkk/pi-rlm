import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "./schema.ts";

describe("validateAgainstSchema", () => {
  test("validates object with required and typed properties", () => {
    const schema = {
      type: "object",
      required: ["counts", "name"],
      properties: { counts: { type: "object" }, name: { type: "string" } },
    };
    expect(validateAgainstSchema({ counts: {}, name: "x" }, schema)).toEqual([]);
    const errs = validateAgainstSchema({ counts: {} }, schema);
    expect(errs.some((e) => e.includes("name: required"))).toBe(true);
  });

  test("integer vs number and enum", () => {
    expect(validateAgainstSchema(3.5, { type: "integer" })).toHaveLength(1);
    expect(validateAgainstSchema(3, { type: "integer" })).toEqual([]);
    expect(validateAgainstSchema("b", { enum: ["a", "c"] })).toHaveLength(1);
    expect(validateAgainstSchema("a", { enum: ["a", "c"] })).toEqual([]);
  });

  test("array items and additionalProperties:false", () => {
    expect(validateAgainstSchema([1, "x"], { type: "array", items: { type: "integer" } })).toHaveLength(1);
    const schema = { type: "object", properties: { a: { type: "number" } }, additionalProperties: false };
    expect(validateAgainstSchema({ a: 1, b: 2 }, schema).some((e) => e.includes("not allowed"))).toBe(true);
  });
});
