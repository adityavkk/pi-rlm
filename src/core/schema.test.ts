import { describe, expect, test } from "bun:test";
import { normalizeJsonSchema, validateAgainstSchema } from "./schema.ts";

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
    expect(validateAgainstSchema({ a: 1 }, { type: "object", additionalProperties: false })).toHaveLength(1);
  });

  test("required and properties use own keys", () => {
    const inherited = Object.create({ answer: "inherited" }) as Record<string, string>;
    expect(validateAgainstSchema(inherited, { type: "object", required: ["answer"] })).toEqual(["$.answer: required"]);

    const schema = JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}') as never;
    const value = JSON.parse('{"__proto__":"safe"}') as never;
    expect(validateAgainstSchema(value, schema)).toEqual([]);
    expect(validateAgainstSchema({}, schema)).toEqual(["$.__proto__: required"]);
  });

  test("enum comparison and uniqueness use canonical JSON identity", () => {
    expect(validateAgainstSchema({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] })).toEqual([]);
    const duplicate = normalizeJsonSchema({ enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error[0]?.message).toContain("canonically unique");
  });

  test("normalization rejects unsupported keywords, types, and forms", () => {
    const unsupported = [
      { minLength: 1 },
      { type: ["string", "null"] },
      { type: "date" },
      { items: [{ type: "string" }] },
      { properties: { value: true } },
      true,
    ];
    for (const schema of unsupported) expect(normalizeJsonSchema(schema).ok).toBe(false);
  });
});
