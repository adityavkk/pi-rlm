/**
 * Host-backed immutable context store (imperative shell).
 *
 * Sources are snapshotted by content; every handle is content-addressed so the
 * same bytes always yield the same id (which makes call identity and restart
 * replay stable). Reads are byte-accurate and never split a UTF-8 code point.
 * The store persists content under `<dir>/contexts/<sha>.bin` and can be rebuilt
 * from the same sources on resume.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../core/json.ts";
import { canonicalStringify } from "../core/json.ts";
import { headTailPreview } from "../core/preview.ts";
import { sha256 } from "./hash.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });
const TOKEN_ESTIMATOR = "utf8-bytes/4";
const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);

export interface ContextDescriptor {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly tokenEstimator: string;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface ContextRead {
  readonly text: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly truncated: boolean;
}

export interface ContextMatch {
  readonly text: string;
  readonly line: number;
  readonly startByte: number;
  readonly contextId: string;
}

export interface ContextStoreLimits {
  readonly maxReadBytes: number;
  readonly maxLines: number;
  readonly maxLineBytes: number;
  readonly maxMatches: number;
  readonly maxChunks: number;
  readonly maxPatternBytes: number;
}

export const DEFAULT_CONTEXT_STORE_LIMITS: ContextStoreLimits = {
  maxReadBytes: 1024 * 1024,
  maxLines: 10_000,
  maxLineBytes: 64 * 1024,
  maxMatches: 1_000,
  maxChunks: 256,
  maxPatternBytes: 4 * 1024,
};

/** Optional composition points for broker deadlines and storage preflights. */
export interface ContextOperationControl {
  readonly checkpoint?: () => void;
  readonly maxOutputBytes?: number;
}

interface Entry {
  readonly descriptor: ContextDescriptor;
  readonly bytesArray: Uint8Array;
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

// Start offsets move forward to the next code-point boundary (skip a partial
// leading code point); end offsets move backward (never split a code point).
const forwardBoundary = (bytes: Uint8Array, index: number): number => {
  let i = Math.min(Math.max(index, 0), bytes.length);
  while (i < bytes.length && isContinuation(bytes[i] as number)) i++;
  return i;
};

const backwardBoundary = (bytes: Uint8Array, index: number): number => {
  let i = Math.min(Math.max(index, 0), bytes.length);
  while (i > 0 && i < bytes.length && isContinuation(bytes[i] as number)) i--;
  return i;
};

const CHECKPOINT_INTERVAL_BYTES = 16 * 1024;

const boundedInteger = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ContextSpecError(`${name} must be an integer between ${min} and ${max}`);
  return value;
};

const validateLimits = (limits: ContextStoreLimits): ContextStoreLimits => {
  const validated = {
    maxReadBytes: boundedInteger(limits.maxReadBytes, "maxReadBytes", 4, Number.MAX_SAFE_INTEGER),
    maxLines: boundedInteger(limits.maxLines, "maxLines", 1, Number.MAX_SAFE_INTEGER),
    maxLineBytes: boundedInteger(limits.maxLineBytes, "maxLineBytes", 1, Number.MAX_SAFE_INTEGER),
    maxMatches: boundedInteger(limits.maxMatches, "maxMatches", 1, Number.MAX_SAFE_INTEGER),
    maxChunks: boundedInteger(limits.maxChunks, "maxChunks", 1, Number.MAX_SAFE_INTEGER),
    maxPatternBytes: boundedInteger(limits.maxPatternBytes, "maxPatternBytes", 1, Number.MAX_SAFE_INTEGER),
  };
  if (validated.maxLineBytes > validated.maxReadBytes)
    throw new ContextSpecError("maxLineBytes must not exceed maxReadBytes");
  if (validated.maxPatternBytes > validated.maxReadBytes)
    throw new ContextSpecError("maxPatternBytes must not exceed maxReadBytes");
  return validated;
};

const checkpoint = (control: ContextOperationControl | undefined, offset = 0): void => {
  if (offset % CHECKPOINT_INTERVAL_BYTES === 0) control?.checkpoint?.();
};

const findByte = (
  bytes: Uint8Array,
  value: number,
  start: number,
  end: number,
  control?: ContextOperationControl,
): number => {
  for (let i = start; i < end; i++) {
    checkpoint(control, i);
    if (bytes[i] === value) return i;
  }
  return -1;
};

export class ContextStore {
  private readonly entries = new Map<string, Entry>();
  private readonly contentDir: string;
  private readonly limits: ContextStoreLimits;
  private uniqueBytes = 0;

  constructor(private readonly dir: string, limits: ContextStoreLimits = DEFAULT_CONTEXT_STORE_LIMITS) {
    this.contentDir = join(dir, "contexts");
    this.limits = validateLimits(limits);
  }

  private makeId(sha: string): string {
    return `ctx_${sha.slice(0, 16)}`;
  }

  private async persist(sha: string, bytes: Uint8Array): Promise<void> {
    if (!existsSync(this.contentDir)) await mkdir(this.contentDir, { recursive: true });
    const path = join(this.contentDir, `${sha}.bin`);
    if (!existsSync(path)) await writeFile(path, bytes);
  }

  private async intern(label: string, text: string, mimeType: string): Promise<ContextDescriptor> {
    const bytesArray = encoder.encode(text);
    const sha = sha256(text);
    const id = this.makeId(sha);
    const existing = this.entries.get(id);
    if (existing) return existing.descriptor;
    const descriptor: ContextDescriptor = {
      id,
      label,
      bytes: bytesArray.length,
      estimatedTokens: estimateTokens(bytesArray.length),
      tokenEstimator: TOKEN_ESTIMATOR,
      mimeType,
      sha256: sha,
    };
    this.entries.set(id, { descriptor, bytesArray });
    this.uniqueBytes += bytesArray.length;
    await this.persist(sha, bytesArray);
    return descriptor;
  }

  async ingestText(label: string, text: string, mimeType = "text/plain"): Promise<ContextDescriptor> {
    return this.intern(label, text, mimeType);
  }

  get(id: string): ContextDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }

  totalBytes(): number {
    return this.uniqueBytes;
  }

  private entryOrThrow(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new ContextUnavailableError(id);
    return entry;
  }

  read(
    id: string,
    options: { offsetBytes?: number; lengthBytes?: number } = {},
    control?: ContextOperationControl,
  ): ContextRead {
    const { bytesArray } = this.entryOrThrow(id);
    const offset = options.offsetBytes === undefined
      ? 0
      : boundedInteger(options.offsetBytes, "offsetBytes", 0, Number.MAX_SAFE_INTEGER);
    const length = options.lengthBytes === undefined
      ? this.limits.maxReadBytes
      : boundedInteger(options.lengthBytes, "lengthBytes", 0, this.limits.maxReadBytes);
    control?.checkpoint?.();
    const start = forwardBoundary(bytesArray, offset);
    const end = Math.max(start, backwardBoundary(bytesArray, Math.min(bytesArray.length, start + length)));
    const text = decoder.decode(bytesArray.subarray(start, end));
    control?.checkpoint?.();
    return { text, startByte: start, endByte: end, truncated: end < bytesArray.length };
  }

  /**
   * Return a 1-based line window with half-open UTF-8 byte offsets. LF and CRLF
   * delimiters are excluded from the last selected line; delimiters between
   * selected lines retain their original bytes. A trailing delimiter creates a
   * final empty line. Invalid bounds are rejected; requests past the last line
   * return an empty slice at EOF.
   */
  lines(
    id: string,
    options: { startLine: number; count: number },
    control?: ContextOperationControl,
  ): ContextRead {
    const { bytesArray } = this.entryOrThrow(id);
    const startLine = boundedInteger(options.startLine, "startLine", 1, Number.MAX_SAFE_INTEGER);
    const count = boundedInteger(options.count, "count", 1, this.limits.maxLines);

    let currentLine = 1;
    let startByte = 0;
    while (currentLine < startLine) {
      const newline = findByte(bytesArray, 0x0a, startByte, bytesArray.length, control);
      if (newline === -1)
        return { text: "", startByte: bytesArray.length, endByte: bytesArray.length, truncated: false };
      startByte = newline + 1;
      currentLine++;
    }

    let lineStart = startByte;
    let endByte = startByte;
    for (let selected = 0; selected < count; selected++) {
      const newline = findByte(bytesArray, 0x0a, lineStart, bytesArray.length, control);
      const rawEnd = newline === -1 ? bytesArray.length : newline;
      const lineEnd = rawEnd > lineStart && bytesArray[rawEnd - 1] === 0x0d ? rawEnd - 1 : rawEnd;
      const lineBytes = lineEnd - lineStart;
      if (lineBytes > this.limits.maxLineBytes)
        throw new ContextSpecError(`line ${currentLine + selected} exceeds maxLineBytes ${this.limits.maxLineBytes}`);
      endByte = lineEnd;
      if (endByte - startByte > this.limits.maxReadBytes)
        throw new ContextSpecError(`line window exceeds maxReadBytes ${this.limits.maxReadBytes}`);
      if (newline === -1 || selected + 1 === count) {
        const text = decoder.decode(bytesArray.subarray(startByte, endByte));
        control?.checkpoint?.();
        return { text, startByte, endByte, truncated: newline !== -1 };
      }
      lineStart = newline + 1;
    }

    throw new ContextSpecError("invalid line window");
  }

  grep(
    id: string,
    options: { pattern: string; caseSensitive?: boolean; maxMatches: number; syntax?: "literal" },
    control?: ContextOperationControl,
  ): ContextMatch[] {
    const { bytesArray } = this.entryOrThrow(id);
    if (typeof options.pattern !== "string") throw new ContextSpecError("pattern must be a string");
    const patternBytes = encoder.encode(options.pattern).length;
    if (patternBytes > this.limits.maxPatternBytes)
      throw new ContextSpecError(`pattern exceeds maxPatternBytes ${this.limits.maxPatternBytes}`);
    if (options.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean")
      throw new ContextSpecError("caseSensitive must be a boolean");
    if (options.syntax !== undefined && options.syntax !== "literal")
      throw new ContextSpecError(`grep syntax ${JSON.stringify(options.syntax)} is unsupported in v1; use literal syntax`);
    const maxMatches = boundedInteger(options.maxMatches, "maxMatches", 1, this.limits.maxMatches);
    const caseSensitive = options.caseSensitive === true;
    const needle = caseSensitive ? options.pattern : options.pattern.toLowerCase();
    const matches: ContextMatch[] = [];
    let returnedBytes = 0;
    let lineStart = 0;
    let lineNumber = 1;

    while (lineStart <= bytesArray.length && matches.length < maxMatches) {
      const newline = findByte(bytesArray, 0x0a, lineStart, bytesArray.length, control);
      const lineEnd = newline === -1 ? bytesArray.length : newline;
      const lineBytes = lineEnd - lineStart;
      if (lineBytes > this.limits.maxLineBytes)
        throw new ContextSpecError(`line ${lineNumber} exceeds maxLineBytes ${this.limits.maxLineBytes}`);
      const text = decoder.decode(bytesArray.subarray(lineStart, lineEnd));
      const hit = (caseSensitive ? text : text.toLowerCase()).includes(needle);
      if (hit) {
        returnedBytes += lineBytes;
        if (returnedBytes > this.limits.maxReadBytes)
          throw new ContextSpecError(`grep results exceed maxReadBytes ${this.limits.maxReadBytes}`);
        matches.push({ text, line: lineNumber, startByte: lineStart, contextId: id });
      }
      if (newline === -1) break;
      lineStart = newline + 1;
      lineNumber++;
    }
    control?.checkpoint?.();
    return matches;
  }

  async chunks(
    id: string,
    options: { targetTokens: number; overlapTokens?: number; maxChunks: number; boundary?: "line" | "none" },
    control?: ContextOperationControl,
  ): Promise<ContextDescriptor[]> {
    const { bytesArray, descriptor } = this.entryOrThrow(id);
    const maxTargetTokens = Math.floor(this.limits.maxReadBytes / 4);
    const targetTokens = boundedInteger(options.targetTokens, "targetTokens", 1, maxTargetTokens);
    const overlapTokens = options.overlapTokens === undefined
      ? 0
      : boundedInteger(options.overlapTokens, "overlapTokens", 1, targetTokens - 1);
    const maxChunks = boundedInteger(options.maxChunks, "maxChunks", 1, this.limits.maxChunks);
    if (options.boundary !== undefined && options.boundary !== "line" && options.boundary !== "none")
      throw new ContextSpecError('boundary must be "line" or "none"');
    const maxOutputBytes = control?.maxOutputBytes === undefined
      ? Number.MAX_SAFE_INTEGER
      : boundedInteger(control.maxOutputBytes, "maxOutputBytes", 0, Number.MAX_SAFE_INTEGER);
    const targetBytes = targetTokens * 4;
    const stepBytes = targetBytes - overlapTokens * 4;
    const ranges: Array<{ start: number; end: number }> = [];
    let outputBytes = 0;

    // Preflight count and output bytes without decoding or materializing chunks.
    for (let rawStart = 0; rawStart < bytesArray.length; rawStart += stepBytes) {
      if (ranges.length >= maxChunks) throw new ContextChunkOverflowError(maxChunks + 1, maxChunks);
      const start = forwardBoundary(bytesArray, rawStart);
      let end = backwardBoundary(bytesArray, Math.min(bytesArray.length, rawStart + targetBytes));
      if (options.boundary === "line" && end < bytesArray.length) {
        const newline = findByte(
          bytesArray,
          0x0a,
          end,
          Math.min(bytesArray.length, end + targetBytes),
          control,
        );
        if (newline !== -1) end = newline + 1;
      }
      if (end <= start) throw new ContextSpecError("chunk options do not make forward progress");
      const pieceBytes = end - start;
      if (pieceBytes > this.limits.maxReadBytes)
        throw new ContextSpecError(`chunk exceeds maxReadBytes ${this.limits.maxReadBytes}`);
      if (outputBytes > maxOutputBytes - pieceBytes)
        throw new ContextSpecError(`chunk output exceeds available stored bytes ${maxOutputBytes}`);
      outputBytes += pieceBytes;
      ranges.push({ start, end });
      if (end >= bytesArray.length) break;
      control?.checkpoint?.();
    }

    const out: ContextDescriptor[] = [];
    for (let i = 0; i < ranges.length; i++) {
      control?.checkpoint?.();
      const range = ranges[i] as { start: number; end: number };
      const piece = decoder.decode(bytesArray.subarray(range.start, range.end));
      out.push(await this.intern(`${descriptor.label}#chunk${i + 1}`, piece, descriptor.mimeType));
    }
    control?.checkpoint?.();
    return out;
  }

  async derive(spec: { key: string; value: string | JsonValue; label?: string }): Promise<ContextDescriptor> {
    const text = typeof spec.value === "string" ? spec.value : canonicalStringify(spec.value);
    const mime = typeof spec.value === "string" ? "text/plain" : "application/json";
    return this.intern(spec.label ?? `derived:${spec.key}`, text, mime);
  }

  async concat(spec: { key: string; refs: Array<{ id: string }>; separator?: string; label?: string }): Promise<ContextDescriptor> {
    const separator = spec.separator ?? "\n";
    const parts = spec.refs.map((ref) => decoder.decode(this.entryOrThrow(ref.id).bytesArray));
    return this.intern(spec.label ?? `concat:${spec.key}`, parts.join(separator), "text/plain");
  }

  preview(id: string, headBytes = 512, tailBytes = 256): string {
    const entry = this.entries.get(id);
    if (!entry) return "";
    return headTailPreview(decoder.decode(entry.bytesArray), { headBytes, tailBytes }).text;
  }

  async load(id: string): Promise<string> {
    const entry = this.entries.get(id);
    if (entry) return decoder.decode(entry.bytesArray);
    throw new ContextUnavailableError(id);
  }

  async loadFromDisk(sha: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(join(this.contentDir, `${sha}.bin`)));
  }
}

export class ContextUnavailableError extends Error {
  readonly code = "UNAVAILABLE_CONTEXT";
  constructor(id: string) {
    super(`context ${id} is unavailable`);
    this.name = "ContextUnavailableError";
  }
}

export class ContextSpecError extends Error {
  readonly code = "INVALID_SPEC";
  constructor(message: string) {
    super(message);
    this.name = "ContextSpecError";
  }
}

export class ContextChunkOverflowError extends ContextSpecError {
  constructor(produced: number, max: number) {
    super(`chunking requires at least ${produced} chunks which exceeds maxChunks ${max}`);
    this.name = "ContextChunkOverflowError";
  }
}
