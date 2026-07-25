import { describe, expect, test } from "bun:test";
import { canonicalize, canonicalStringify, isJsonObject, MAX_JSON_DEPTH, parseJsonValue, type JsonValue } from "./json.ts";

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

  test("preserves special own keys without changing prototypes", () => {
    const hostile = JSON.parse('{"constructor":{"b":2},"__proto__":{"a":1}}') as JsonValue;
    const canonical = canonicalize(hostile) as Record<string, JsonValue>;
    expect(Object.getPrototypeOf(canonical)).toBeNull();
    expect(Object.hasOwn(canonical, "__proto__")).toBe(true);
    expect(canonicalStringify(hostile)).toBe('{"__proto__":{"a":1},"constructor":{"b":2}}');
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

  test("copies only own values into prototype-free records", () => {
    const input = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, { own: 1 });
    const parsed = parseJsonValue(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && isJsonObject(parsed.value)) {
      expect(Object.getPrototypeOf(parsed.value)).toBeNull();
      expect(Object.hasOwn(parsed.value, "inherited")).toBe(false);
      expect(parsed.value["own"]).toBe(1);
    }
  });

  test("rejects accessors without invoking them", () => {
    let invoked = false;
    const input = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 1;
      },
    });
    expect(parseJsonValue(input)).toMatchObject({ ok: false, reason: "accessor properties are not JSON" });
    expect(invoked).toBe(false);
  });

  test("bounds deeply nested input and canonicalization", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = 0;
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };
    expect(parseJsonValue(nested(MAX_JSON_DEPTH)).ok).toBe(true);
    expect(parseJsonValue(nested(MAX_JSON_DEPTH + 1))).toMatchObject({ ok: false, reason: expect.stringContaining("maximum JSON depth") });
    expect(() => canonicalize(nested(MAX_JSON_DEPTH + 1) as JsonValue)).toThrow("maximum JSON depth");
  });
});
