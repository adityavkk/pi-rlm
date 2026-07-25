import { describe, expect, test } from "bun:test";
import { canonicalStringify } from "./json.ts";
import { compileShorthand, normalizeProgram, programIdentity } from "./program.ts";

const valid = {
  objective: "Count categories",
  profile: "default",
  inputs: [{ name: "context", adapter: "text", description: "the corpus" }],
  outputs: [{ name: "answer", schema: { type: "string" } }],
};

describe("normalizeProgram", () => {
  test("accepts a valid program and trims", () => {
    const r = normalizeProgram({ ...valid, objective: "  Count categories  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.objective).toBe("Count categories");
  });

  test("requires at least one output", () => {
    const r = normalizeProgram({ ...valid, outputs: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.path === "outputs")).toBe(true);
  });

  test("rejects reserved and invalid input names", () => {
    const r = normalizeProgram({ ...valid, inputs: [{ name: "answer", adapter: "text", description: "" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]?.message).toContain("reserved");

    const r2 = normalizeProgram({ ...valid, inputs: [{ name: "9bad", adapter: "text", description: "" }] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error[0]?.message).toContain("not a valid identifier");
  });

  test("validates output names while preserving the conventional answer field", () => {
    expect(normalizeProgram(valid).ok).toBe(true);
    for (const name of ["9bad", "__proto__", "constructor"]) {
      const result = normalizeProgram({ ...valid, outputs: [{ name, schema: { type: "string" } }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.some((error) => error.path === "outputs[0].name")).toBe(true);
    }
  });

  test("rejects schemas outside the supported subset", () => {
    const schemas = [
      { type: "string", minLength: 1 },
      { type: ["string", "null"] },
      { type: "date" },
      { type: "array", items: [{ type: "string" }] },
      { type: "object", properties: { value: true } },
    ];
    for (const schema of schemas) expect(normalizeProgram({ ...valid, outputs: [{ name: "answer", schema }] }).ok).toBe(false);
  });

  test("rejects duplicate names", () => {
    const r = normalizeProgram({
      ...valid,
      inputs: [
        { name: "context", adapter: "text", description: "" },
        { name: "context", adapter: "json", description: "" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.message.includes("duplicate"))).toBe(true);
  });

  test("collects multiple errors at once", () => {
    const r = normalizeProgram({ objective: "", inputs: "nope", outputs: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThanOrEqual(3);
  });
});

describe("shorthand + identity", () => {
  test("shorthand compiles to one input and one answer output", () => {
    const r = compileShorthand({ objective: "Summarize" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.inputs).toHaveLength(1);
      expect(r.value.outputs[0]?.name).toBe("answer");
    }
  });

  test("identity ignores descriptions but includes schema and adapter", () => {
    const a = normalizeProgram(valid);
    const b = normalizeProgram({
      ...valid,
      inputs: [{ name: "context", adapter: "text", description: "different description" }],
    });
    if (a.ok && b.ok) expect(JSON.stringify(programIdentity(a.value))).toBe(JSON.stringify(programIdentity(b.value)));
  });

  test("schema insertion order does not change canonical program identity", () => {
    const a = normalizeProgram({ ...valid, outputs: [{ name: "answer", schema: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } } }] });
    const b = normalizeProgram({ ...valid, outputs: [{ name: "answer", schema: { properties: { a: { type: "string" }, b: { type: "number" } }, type: "object" } }] });
    if (a.ok && b.ok) expect(canonicalStringify(programIdentity(a.value))).toBe(canonicalStringify(programIdentity(b.value)));
  });
});
