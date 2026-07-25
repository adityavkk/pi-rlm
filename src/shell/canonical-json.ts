import { createHash } from "node:crypto";
import { MAX_JSON_DEPTH, isJsonObject, type JsonValue } from "../core/json.ts";

const encoder = new TextEncoder();
const MAX_FRAGMENT_CODE_UNITS = 8 * 1024;
const CHECKPOINT_INTERVAL_BYTES = 16 * 1024;

type Emit = (fragment: string) => void;
type PathPart = string | number;

const pathText = (parts: readonly PathPart[]): string => {
  let path = "$";
  for (const part of parts) {
    if (typeof part === "number") path += `[${part}]`;
    else path += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`;
  }
  return path;
};

const hexEscape = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

const emitString = (value: string, emit: Emit): void => {
  let fragment = '"';
  const append = (text: string): void => {
    if (fragment.length + text.length > MAX_FRAGMENT_CODE_UNITS) {
      emit(fragment);
      fragment = "";
    }
    fragment += text;
  };

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x08: append("\\b"); break;
      case 0x09: append("\\t"); break;
      case 0x0a: append("\\n"); break;
      case 0x0c: append("\\f"); break;
      case 0x0d: append("\\r"); break;
      case 0x22: append('\\"'); break;
      case 0x5c: append("\\\\"); break;
      default:
        if (code < 0x20) {
          append(hexEscape(code));
        } else if (code >= 0xd800 && code <= 0xdbff) {
          const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
          if (next >= 0xdc00 && next <= 0xdfff) {
            append(value.slice(i, i + 2));
            i++;
          } else {
            append(hexEscape(code));
          }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          append(hexEscape(code));
        } else {
          append(value[i] as string);
        }
    }
  }
  append('"');
  if (fragment.length > 0) emit(fragment);
};

const streamCanonicalJson = (
  value: JsonValue,
  emit: Emit,
  path: PathPart[] = [],
  depth = 0,
): void => {
  if (depth > MAX_JSON_DEPTH)
    throw new RangeError(`maximum JSON depth of ${MAX_JSON_DEPTH} exceeded at ${pathText(path)}`);
  if (value === null) {
    emit("null");
    return;
  }
  switch (typeof value) {
    case "string":
      emitString(value, emit);
      return;
    case "boolean":
      emit(value ? "true" : "false");
      return;
    case "number": {
      const number = JSON.stringify(value);
      if (number === undefined) throw new TypeError(`invalid number at ${pathText(path)}`);
      emit(number);
      return;
    }
    case "object":
      if (Array.isArray(value)) {
        emit("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) emit(",");
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor) throw new TypeError(`array hole is not canonical JSON at ${pathText([...path, i])}`);
          if (!("value" in descriptor))
            throw new TypeError(`accessor property is not canonical JSON at ${pathText([...path, i])}`);
          path.push(i);
          try {
            streamCanonicalJson(descriptor.value as JsonValue, emit, path, depth + 1);
          } finally {
            path.pop();
          }
        }
        emit("]");
        return;
      }
      if (isJsonObject(value)) {
        emit("{");
        const keys = Object.keys(value).sort();
        for (let i = 0; i < keys.length; i++) {
          if (i > 0) emit(",");
          const key = keys[i] as string;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor))
            throw new TypeError(`accessor property is not canonical JSON at ${pathText([...path, key])}`);
          emitString(key, emit);
          emit(":");
          path.push(key);
          try {
            streamCanonicalJson(descriptor.value as JsonValue, emit, path, depth + 1);
          } finally {
            path.pop();
          }
        }
        emit("}");
        return;
      }
      break;
  }
  throw new TypeError(`value is not canonical JSON at ${pathText(path)}`);
};

interface CanonicalJsonPreparation {
  readonly bytes: number;
  readonly sha256: string;
  readonly materialize: () => Uint8Array;
}

const checkpointingSink = (
  sink: Emit,
  checkpoint?: () => void,
): Emit => {
  let bytesSinceCheckpoint = 0;
  return (fragment) => {
    sink(fragment);
    bytesSinceCheckpoint += Buffer.byteLength(fragment, "utf8");
    if (bytesSinceCheckpoint >= CHECKPOINT_INTERVAL_BYTES) {
      checkpoint?.();
      bytesSinceCheckpoint %= CHECKPOINT_INTERVAL_BYTES;
    }
  };
};

/** Hash and measure canonical JSON with bounded fragments, then provide one exact-size materializer. */
export const prepareCanonicalJson = (
  value: JsonValue,
  checkpoint?: () => void,
): CanonicalJsonPreparation => {
  const hash = createHash("sha256");
  let bytes = 0;
  checkpoint?.();
  streamCanonicalJson(value, checkpointingSink((fragment) => {
    const added = Buffer.byteLength(fragment, "utf8");
    if (bytes > Number.MAX_SAFE_INTEGER - added) throw new RangeError("canonical JSON output is too large");
    bytes += added;
    hash.update(fragment, "utf8");
  }, checkpoint));
  checkpoint?.();

  return {
    bytes,
    sha256: hash.digest("hex"),
    materialize: () => {
      const output = new Uint8Array(bytes);
      let offset = 0;
      checkpoint?.();
      streamCanonicalJson(value, checkpointingSink((fragment) => {
        const encoded = encoder.encodeInto(fragment, output.subarray(offset));
        if (encoded.read !== fragment.length)
          throw new Error("canonical JSON changed while materializing");
        offset += encoded.written;
      }, checkpoint));
      if (offset !== bytes) throw new Error("canonical JSON changed while materializing");
      checkpoint?.();
      return output;
    },
  };
};
