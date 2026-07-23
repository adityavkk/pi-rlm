import { describe, expect, test } from "bun:test";
import { canonicalize, canonicalStringify, isJsonObject, parseJsonValue } from "./json.ts";

describe("json canonicalization", () => {
  test("sorts keys recursively and is order-independent", () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(canonicalStringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("array order is preserved", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  test("isJsonObject discriminates", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  test("canonicalize leaves primitives", () => {
    expect(canonicalize("x")).toBe("x");
    expect(canonicalize(null)).toBe(null);
  });
});

describe("parseJsonValue", () => {
  test("accepts strict json", () => {
    const r = parseJsonValue({ a: [1, "two", true, null] });
    expect(r.ok).toBe(true);
  });

  test("rejects non-finite, undefined, bigint, function, symbol with path", () => {
    expect(parseJsonValue({ a: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, path: "$.a" });
    expect(parseJsonValue({ a: undefined })).toMatchObject({ ok: false, path: "$.a" });
    expect(parseJsonValue([1, 2n])).toMatchObject({ ok: false, path: "$[1]" });
    expect(parseJsonValue(() => 1)).toMatchObject({ ok: false, path: "$" });
    expect(parseJsonValue(Symbol("s"))).toMatchObject({ ok: false });
  });

  test("rejects cycles", () => {
    const o: Record<string, unknown> = {};
    o["self"] = o;
    expect(parseJsonValue(o)).toMatchObject({ ok: false, reason: "cyclic reference" });
  });
});
