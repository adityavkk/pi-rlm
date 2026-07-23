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

export const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate that an unknown value is strict JSON with no cycles.
 * Returns a typed value or a human-readable path to the first offending node.
 */
export const parseJsonValue = (
  input: unknown,
): { ok: true; value: JsonValue } | { ok: false; path: string; reason: string } => {
  const seen = new WeakSet<object>();
  const walk = (
    value: unknown,
    path: string,
  ): { ok: true; value: JsonValue } | { ok: false; path: string; reason: string } => {
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
              const r = walk(value[i], `${path}[${i}]`);
              if (!r.ok) return r;
              out.push(r.value);
            }
            return { ok: true, value: out };
          }
          const out: Record<string, JsonValue> = {};
          for (const key of Object.keys(value as Record<string, unknown>)) {
            const r = walk((value as Record<string, unknown>)[key], `${path}.${key}`);
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
  return walk(input, "$");
};

/** Recursively sort object keys, producing a canonical JsonValue. */
export const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isJsonObject(value)) {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key] as JsonValue);
    return sorted;
  }
  return value;
};

/** Deterministic JSON string with sorted keys. Stable across insertion order. */
export const canonicalStringify = (value: JsonValue): string => JSON.stringify(canonicalize(value));
