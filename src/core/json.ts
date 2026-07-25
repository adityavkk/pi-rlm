/**
 * JSON value model plus canonical, deterministic serialization.
 *
 * Canonical form sorts object keys recursively and rejects any value that is
 * not representable as strict JSON (undefined, functions, symbols, bigint,
 * non-finite numbers, cycles). Canonical strings drive content-addressed
 * identity for calls, contexts, and prompts.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Maximum nesting accepted at an untrusted JSON boundary. */
export const MAX_JSON_DEPTH = 100;

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nullRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

/**
 * Validate that an unknown value is strict JSON with no cycles.
 * Returns a typed, prototype-free value or a human-readable path to the first
 * offending node.
 */
export const parseJsonValue = (
  input: unknown,
): { ok: true; value: JsonValue } | { ok: false; path: string; reason: string } => {
  const seen = new WeakSet<object>();
  const walk = (
    value: unknown,
    path: string,
    depth: number,
  ): { ok: true; value: JsonValue } | { ok: false; path: string; reason: string } => {
    if (depth > MAX_JSON_DEPTH)
      return { ok: false, path, reason: `maximum JSON depth of ${MAX_JSON_DEPTH} exceeded` };
    if (value === null) return { ok: true, value: null };
    switch (typeof value) {
      case "string":
      case "boolean":
        return { ok: true, value };
      case "number":
        return Number.isFinite(value)
          ? { ok: true, value }
          : { ok: false, path, reason: "non-finite number" };
      case "undefined":
        return { ok: false, path, reason: "undefined is not JSON" };
      case "bigint":
        return { ok: false, path, reason: "bigint is not JSON" };
      case "symbol":
        return { ok: false, path, reason: "symbol is not JSON" };
      case "function":
        return { ok: false, path, reason: "function is not JSON" };
      case "object": {
        const obj = value as object;
        if (seen.has(obj)) return { ok: false, path, reason: "cyclic reference" };
        seen.add(obj);
        try {
          if (Array.isArray(value)) {
            const out: JsonValue[] = [];
            for (let i = 0; i < value.length; i++) {
              const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
              if (!descriptor) return { ok: false, path: `${path}[${i}]`, reason: "array holes are not JSON" };
              if (!("value" in descriptor))
                return { ok: false, path: `${path}[${i}]`, reason: "accessor properties are not JSON" };
              const r = walk(descriptor.value, `${path}[${i}]`, depth + 1);
              if (!r.ok) return r;
              out.push(r.value);
            }
            return { ok: true, value: out };
          }
          const out = nullRecord<JsonValue>();
          for (const key of Object.keys(value as Record<string, unknown>)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor))
              return { ok: false, path: childPath(path, key), reason: "accessor properties are not JSON" };
            const r = walk(descriptor.value, childPath(path, key), depth + 1);
            if (!r.ok) return r;
            out[key] = r.value;
          }
          return { ok: true, value: out };
        } finally {
          seen.delete(obj);
        }
      }
      default:
        return { ok: false, path, reason: `unsupported type ${typeof value}` };
    }
  };
  return walk(input, "$", 0);
};

const canonicalizeAt = (value: JsonValue, path: string, depth: number): JsonValue => {
  if (depth > MAX_JSON_DEPTH) throw new RangeError(`maximum JSON depth of ${MAX_JSON_DEPTH} exceeded at ${path}`);
  if (Array.isArray(value)) return value.map((item, i) => canonicalizeAt(item, `${path}[${i}]`, depth + 1));
  if (isJsonObject(value)) {
    const sorted = nullRecord<JsonValue>();
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor))
        throw new TypeError(`accessor property is not canonical JSON at ${childPath(path, key)}`);
      sorted[key] = canonicalizeAt(descriptor.value as JsonValue, childPath(path, key), depth + 1);
    }
    return sorted;
  }
  return value;
};

/** Recursively sort own object keys, producing prototype-free canonical JSON. */
export const canonicalize = (value: JsonValue): JsonValue => canonicalizeAt(value, "$", 0);

/** Deterministic JSON string with sorted keys. Stable across insertion order. */
export const canonicalStringify = (value: JsonValue): string => JSON.stringify(canonicalize(value));
