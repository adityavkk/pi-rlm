import { isProxy } from "node:util/types";
import type { JsonValue } from "../../core/json.ts";

export interface BoundedJsonLimits {
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
}

type ParseResult = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false };
const MISSING = Symbol("missing");

export const isPlainRecord = (input: unknown): input is Record<string, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input) || isProxy(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
};

export const isPlainArray = (input: unknown): input is unknown[] =>
  Array.isArray(input) && !isProxy(input) && Object.getPrototypeOf(input) === Array.prototype;

export const dataProperty = (value: object, key: string): unknown | typeof MISSING => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : MISSING;
};

export const isMissing = (value: unknown): value is typeof MISSING => value === MISSING;

interface CloneState {
  bytes: number;
  nodes: number;
  readonly limits: BoundedJsonLimits;
  readonly seen: WeakSet<object>;
}

const addBytes = (state: CloneState, amount: number): boolean => {
  state.bytes += amount;
  return Number.isSafeInteger(state.bytes) && state.bytes <= state.limits.maxBytes;
};

const encodedStringBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const cloneNode = (input: unknown, state: CloneState, depth: number): ParseResult => {
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes || depth > state.limits.maxDepth) return { ok: false };
  if (input === null) return addBytes(state, 4) ? { ok: true, value: null } : { ok: false };
  if (typeof input === "string")
    return addBytes(state, encodedStringBytes(input)) ? { ok: true, value: input } : { ok: false };
  if (typeof input === "boolean")
    return addBytes(state, input ? 4 : 5) ? { ok: true, value: input } : { ok: false };
  if (typeof input === "number" && Number.isFinite(input)) {
    const rendered = JSON.stringify(input);
    return rendered !== undefined && addBytes(state, Buffer.byteLength(rendered, "utf8"))
      ? { ok: true, value: input }
      : { ok: false };
  }
  if (typeof input !== "object" || input === null || isProxy(input)) return { ok: false };
  if (state.seen.has(input)) return { ok: false };
  state.seen.add(input);
  try {
    if (Array.isArray(input)) {
      if (!isPlainArray(input) || !addBytes(state, 2)) return { ok: false };
      let enumerableKeys = 0;
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        enumerableKeys += 1;
        if (enumerableKeys > state.limits.maxNodes
          || !/^(0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= input.length) return { ok: false };
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (index > 0 && !addBytes(state, 1)) return { ok: false };
        const item = dataProperty(input, String(index));
        if (isMissing(item)) return { ok: false };
        const cloned = cloneNode(item, state, depth + 1);
        if (!cloned.ok) return cloned;
        output.push(cloned.value);
      }
      return { ok: true, value: output };
    }
    if (!isPlainRecord(input) || !addBytes(state, 2)) return { ok: false };
    const output = Object.create(null) as Record<string, JsonValue>;
    let index = 0;
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      if (index >= state.limits.maxNodes
        || !addBytes(state, encodedStringBytes(key) + 1 + (index > 0 ? 1 : 0))) return { ok: false };
      const item = dataProperty(input, key);
      if (isMissing(item)) return { ok: false };
      const cloned = cloneNode(item, state, depth + 1);
      if (!cloned.ok) return cloned;
      output[key] = cloned.value;
      index += 1;
    }
    return { ok: true, value: output };
  } finally {
    state.seen.delete(input);
  }
};

export const cloneBoundedJson = (input: unknown, limits: BoundedJsonLimits): ParseResult => {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
    || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1
    || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0) return { ok: false };
  return cloneNode(input, { bytes: 0, nodes: 0, limits, seen: new WeakSet() }, 0);
};
