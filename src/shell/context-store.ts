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
import { byteLength, headTailPreview } from "../core/preview.ts";
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

export class ContextStore {
  private readonly entries = new Map<string, Entry>();
  private readonly contentDir: string;
  private uniqueBytes = 0;

  constructor(private readonly dir: string) {
    this.contentDir = join(dir, "contexts");
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

  read(id: string, options: { offsetBytes?: number; lengthBytes?: number } = {}): ContextRead {
    const { bytesArray } = this.entryOrThrow(id);
    const start = forwardBoundary(bytesArray, Math.max(0, options.offsetBytes ?? 0));
    const rawEnd = options.lengthBytes === undefined ? bytesArray.length : start + options.lengthBytes;
    const end = Math.max(start, backwardBoundary(bytesArray, Math.min(rawEnd, bytesArray.length)));
    return {
      text: decoder.decode(bytesArray.subarray(start, end)),
      startByte: start,
      endByte: end,
      truncated: end < bytesArray.length,
    };
  }

  lines(id: string, options: { startLine: number; count: number }): ContextRead {
    const { bytesArray } = this.entryOrThrow(id);
    const full = decoder.decode(bytesArray);
    const allLines = full.split("\n");
    const startIndex = Math.max(1, options.startLine) - 1;
    const slice = allLines.slice(startIndex, startIndex + Math.max(0, options.count));
    const text = slice.join("\n");
    const startByte = byteLength(allLines.slice(0, startIndex).join("\n"));
    return { text, startByte, endByte: startByte + byteLength(text), truncated: startIndex + options.count < allLines.length };
  }

  grep(
    id: string,
    options: { pattern: string; caseSensitive?: boolean; maxMatches: number; syntax?: "literal" | "re2" },
  ): ContextMatch[] {
    const { bytesArray } = this.entryOrThrow(id);
    const full = decoder.decode(bytesArray);
    const lines = full.split("\n");
    const matcher =
      options.syntax === "re2"
        ? new RegExp(options.pattern, options.caseSensitive ? "" : "i")
        : undefined;
    const needle = options.caseSensitive ? options.pattern : options.pattern.toLowerCase();
    const matches: ContextMatch[] = [];
    let byteCursor = 0;
    for (let i = 0; i < lines.length && matches.length < options.maxMatches; i++) {
      const line = lines[i] as string;
      const hit = matcher ? matcher.test(line) : (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
      if (hit) matches.push({ text: line, line: i + 1, startByte: byteCursor, contextId: id });
      byteCursor += byteLength(line) + 1;
    }
    return matches;
  }

  async chunks(
    id: string,
    options: { targetTokens: number; overlapTokens?: number; maxChunks: number; boundary?: "line" | "none" },
  ): Promise<ContextDescriptor[]> {
    const { bytesArray, descriptor } = this.entryOrThrow(id);
    const full = decoder.decode(bytesArray);
    const targetChars = Math.max(1, options.targetTokens * 4);
    const overlapChars = Math.max(0, (options.overlapTokens ?? 0) * 4);
    const step = Math.max(1, targetChars - overlapChars);
    const pieces: string[] = [];
    for (let start = 0; start < full.length; start += step) {
      let end = Math.min(full.length, start + targetChars);
      if (options.boundary === "line" && end < full.length) {
        const nextNewline = full.indexOf("\n", end);
        if (nextNewline !== -1 && nextNewline - end < targetChars) end = nextNewline + 1;
      }
      pieces.push(full.slice(start, end));
      if (end >= full.length) break;
    }
    if (pieces.length > options.maxChunks)
      throw new ContextChunkOverflowError(pieces.length, options.maxChunks);
    const out: ContextDescriptor[] = [];
    for (let i = 0; i < pieces.length; i++)
      out.push(await this.intern(`${descriptor.label}#chunk${i + 1}`, pieces[i] as string, descriptor.mimeType));
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

export class ContextChunkOverflowError extends Error {
  readonly code = "INVALID_SPEC";
  constructor(produced: number, max: number) {
    super(`chunking produced ${produced} chunks which exceeds maxChunks ${max}`);
    this.name = "ContextChunkOverflowError";
  }
}
