import { describe, expect, test } from "bun:test";
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
});
