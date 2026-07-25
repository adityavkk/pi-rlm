/** Strict source capture at the public Pi extension boundary. */

import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compileShorthand, normalizeProgram, parseJsonValue, type RlmProgram } from "../core/index.ts";

export const INLINE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
export const SESSION_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
export const SESSION_SOURCE_MAX_ENTRIES = 10_000;

export type RlmSourceErrorCode =
  | "RLM_SOURCE_REQUIRED"
  | "RLM_SOURCE_INVALID"
  | "RLM_SOURCE_LIMIT"
  | "RLM_SOURCE_ENCODING";

export interface RlmSourceError {
  readonly code: RlmSourceErrorCode;
  readonly message: string;
}

export interface LaunchRequest {
  readonly program: RlmProgram;
  readonly sources: Readonly<Record<string, string>>;
}

export type SourceResult =
  | { readonly ok: true; readonly value: LaunchRequest }
  | { readonly ok: false; readonly error: RlmSourceError };

const failure = (code: RlmSourceErrorCode, message: string): SourceResult => ({
  ok: false,
  error: { code, message },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneStrictJson = (value: unknown): { ok: true; value: unknown } | { ok: false } => {
  try {
    const parsed = parseJsonValue(value);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
  } catch {
    return { ok: false };
  }
};

const sourceBytes = (sources: Readonly<Record<string, string>>, limit: number): boolean => {
  let total = 0;
  for (const value of Object.values(sources)) {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > limit - total) return false;
    total += bytes;
  }
  return true;
};

const validateTypedSources = (
  program: RlmProgram,
  rawSources: unknown,
  limit = INLINE_SOURCE_MAX_BYTES,
): SourceResult => {
  if (rawSources === undefined) {
    if (program.inputs.length === 0)
      return { ok: true, value: { program, sources: Object.freeze(Object.create(null) as Record<string, string>) } };
    return failure("RLM_SOURCE_REQUIRED", "Every declared program input requires a non-empty source.");
  }
  if (!isRecord(rawSources)) return failure("RLM_SOURCE_INVALID", "Sources must be a strict JSON object of strings.");
  const declared = new Set(program.inputs.map((input) => input.name));
  const sources = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(rawSources)) {
    if (!declared.has(name) || typeof value !== "string")
      return failure("RLM_SOURCE_INVALID", "Sources must contain only declared input names with string values.");
    sources[name] = value;
  }
  for (const input of program.inputs) {
    const value = sources[input.name];
    if (typeof value !== "string" || !value.trim())
      return failure("RLM_SOURCE_REQUIRED", "Every declared program input requires a non-empty source.");
  }
  if (!sourceBytes(sources, limit))
    return failure("RLM_SOURCE_LIMIT", "Aggregate inline source exceeds the 64 MiB UTF-8 limit.");
  return { ok: true, value: { program, sources: Object.freeze(sources) } };
};

/** Validate tool parameters or a parsed command JSON object without invoking effects. */
export const buildInlineRequest = (raw: unknown): SourceResult => {
  const cloned = cloneStrictJson(raw);
  if (!cloned.ok || !isRecord(cloned.value))
    return failure("RLM_SOURCE_INVALID", "Request must be a strict JSON object.");
  const params = cloned.value;
  const keys = Object.keys(params);
  if (Object.hasOwn(params, "objective") || Object.hasOwn(params, "context")) {
    if (keys.some((key) => key !== "objective" && key !== "context") || keys.length !== 2)
      return failure("RLM_SOURCE_INVALID", "Shorthand requires exactly objective and context.");
    if (typeof params["objective"] !== "string" || !params["objective"].trim())
      return failure("RLM_SOURCE_INVALID", "Objective must be a non-empty string.");
    if (typeof params["context"] !== "string" || !params["context"].trim())
      return failure("RLM_SOURCE_REQUIRED", "Shorthand requires non-empty context.");
    const compiled = compileShorthand({ objective: params["objective"] });
    if (!compiled.ok) return failure("RLM_SOURCE_INVALID", "Objective is not a valid shorthand objective.");
    const sources = Object.freeze({ context: params["context"] });
    if (!sourceBytes(sources, INLINE_SOURCE_MAX_BYTES))
      return failure("RLM_SOURCE_LIMIT", "Aggregate inline source exceeds the 64 MiB UTF-8 limit.");
    return { ok: true, value: { program: compiled.value, sources } };
  }
  if (Object.hasOwn(params, "program") || Object.hasOwn(params, "sources")) {
    if (keys.some((key) => key !== "program" && key !== "sources") || !Object.hasOwn(params, "program"))
      return failure("RLM_SOURCE_INVALID", "Typed form requires program and, when inputs are declared, sources.");
    const normalized = normalizeProgram(params["program"]);
    if (!normalized.ok) return failure("RLM_SOURCE_INVALID", "Program is invalid.");
    return validateTypedSources(normalized.value, params["sources"]);
  }
  return failure("RLM_SOURCE_REQUIRED", "Use an objective with context, a typed program with sources, --file, or --session.");
};

interface StableStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

const stableStat = (stat: BigIntStats): StableStat => ({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  nlink: stat.nlink,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
});

const sameStat = (a: StableStat, b: StableStat): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

const validRelativePath = (path: string): boolean => {
  if (!path || path.includes("\0") || isAbsolute(path) || path.startsWith("~") || /[$*?\[\]{}!]/.test(path)) return false;
  if (path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
};

const parentPaths = (root: string, candidate: string): string[] => {
  const paths = [root];
  const relParent = relative(root, dirname(candidate));
  if (!relParent) return paths;
  let current = root;
  for (const component of relParent.split(sep)) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
};

const snapshotParents = async (paths: readonly string[]): Promise<StableStat[]> => {
  const snapshots: StableStat[] = [];
  for (const path of paths) {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe parent");
    snapshots.push(stableStat(stat));
  }
  return snapshots;
};

const readTrustedProjectFile = async (cwd: string, requestedPath: string): Promise<SourceResult> => {
  if (!validRelativePath(requestedPath))
    return failure("RLM_SOURCE_INVALID", "File source must be a safe relative path under the real project directory.");
  try {
    const root = await realpath(cwd);
    const candidate = resolve(root, requestedPath);
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
      return failure("RLM_SOURCE_INVALID", "File source must remain under the real project directory.");
    const parents = parentPaths(root, candidate);
    const beforeParents = await snapshotParents(parents);
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(candidate, flags);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n)
        return failure("RLM_SOURCE_INVALID", "File source must be a regular, singly linked file.");
      if (before.size > BigInt(INLINE_SOURCE_MAX_BYTES))
        return failure("RLM_SOURCE_LIMIT", "File source exceeds the 64 MiB limit.");
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const afterParents = await snapshotParents(parents);
      if (!sameStat(stableStat(before), stableStat(after))
        || beforeParents.some((stat, index) => !sameStat(stat, afterParents[index]!)))
        return failure("RLM_SOURCE_INVALID", "File source changed while it was being captured.");
      if (bytes.byteLength > INLINE_SOURCE_MAX_BYTES)
        return failure("RLM_SOURCE_LIMIT", "File source exceeds the 64 MiB limit.");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return failure("RLM_SOURCE_ENCODING", "File source is not valid UTF-8.");
      }
      if (!text.trim()) return failure("RLM_SOURCE_REQUIRED", "File source must contain non-whitespace text.");
      const compiled = compileShorthand({ objective: "placeholder" });
      if (!compiled.ok) throw new Error("shorthand invariant");
      return { ok: true, value: { program: compiled.value, sources: Object.freeze({ context: text }) } };
    } finally {
      await handle.close();
    }
  } catch {
    return failure("RLM_SOURCE_INVALID", "File source could not be captured safely.");
  }
};

const own = (value: unknown, key: PropertyKey): unknown => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) throw new Error("not an object");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("missing or accessor property");
  return descriptor.value;
};

const safeArray = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value)) throw new Error("not an array");
  const length = own(value, "length");
  if (!Number.isSafeInteger(length) || (length as number) < 0) throw new Error("invalid array length");
  if ((length as number) > max) throw new RangeError("array limit");
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index++) result.push(own(value, index));
  return result;
};

const textualContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  const blocks = safeArray(content, SESSION_SOURCE_MAX_ENTRIES);
  const text: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = own(block, "type");
    if (type !== "text") continue;
    const value = own(block, "text");
    if (typeof value === "string") text.push(value);
  }
  return text.join("\n");
};

const projectSession = (ctx: ExtensionContext): SourceResult => {
  try {
    const entries = safeArray(ctx.sessionManager.buildContextEntries(), SESSION_SOURCE_MAX_ENTRIES);
    const parts: string[] = [];
    let bytes = 0;
    const add = (label: string, text: string): void => {
      if (!text.trim()) return;
      const part = `${label}\n${text}`;
      const separatorBytes = parts.length === 0 ? 0 : 2;
      const partBytes = Buffer.byteLength(part, "utf8");
      if (partBytes > SESSION_SOURCE_MAX_BYTES - bytes - separatorBytes) throw new RangeError("session byte limit");
      parts.push(part);
      bytes += separatorBytes + partBytes;
    };
    for (const entry of entries) {
      const type = own(entry, "type");
      if (type === "message") {
        const message = own(entry, "message");
        const role = own(message, "role");
        if (role !== "user" && role !== "assistant") continue;
        add(`[${role}]`, textualContent(own(message, "content")));
      } else if (type === "compaction") {
        const summary = own(entry, "summary");
        if (typeof summary === "string") add("[compaction]", summary);
      } else if (type === "branch_summary") {
        const summary = own(entry, "summary");
        if (typeof summary === "string") add("[branch-summary]", summary);
      } else if (type === "custom_message") {
        const customType = own(entry, "customType");
        if (typeof customType !== "string") throw new Error("invalid custom type");
        add(`[custom:${customType}]`, textualContent(own(entry, "content")));
      }
    }
    const context = parts.join("\n\n");
    if (!context.trim()) return failure("RLM_SOURCE_REQUIRED", "The active session branch has no eligible text source.");
    const compiled = compileShorthand({ objective: "placeholder" });
    if (!compiled.ok) throw new Error("shorthand invariant");
    return { ok: true, value: { program: compiled.value, sources: Object.freeze({ context }) } };
  } catch (error) {
    return error instanceof RangeError
      ? failure("RLM_SOURCE_LIMIT", "Session source exceeds 16 MiB or 10,000 active entries.")
      : failure("RLM_SOURCE_INVALID", "Session source could not be traversed safely.");
  }
};

const withObjective = (captured: SourceResult, objective: string): SourceResult => {
  if (!captured.ok) return captured;
  const compiled = compileShorthand({ objective });
  if (!compiled.ok) return failure("RLM_SOURCE_INVALID", "Objective is not a valid shorthand objective.");
  return { ok: true, value: { program: compiled.value, sources: captured.value.sources } };
};

/** Parse and capture one of the four normative /rlm command forms. */
export const captureCommandRequest = async (args: string, ctx: ExtensionContext): Promise<SourceResult> => {
  const input = args.trim();
  if (!input) return failure("RLM_SOURCE_REQUIRED", "A normative /rlm source form is required.");
  if (input.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(input); }
    catch { return failure("RLM_SOURCE_INVALID", "Command JSON must be strict and contain no trailing content."); }
    return buildInlineRequest(parsed);
  }
  if (input.startsWith("--file")) {
    const matched = /^--file "([^"\r\n]+)" -- ([\s\S]+)$/.exec(input);
    if (!matched || !matched[2]!.trim()) return failure("RLM_SOURCE_INVALID", "Malformed --file command form.");
    let trusted = false;
    try { trusted = ctx.isProjectTrusted(); } catch { /* fail closed */ }
    if (!trusted) return failure("RLM_SOURCE_INVALID", "File source requires a trusted project.");
    return withObjective(await readTrustedProjectFile(ctx.cwd, matched[1]!), matched[2]!);
  }
  if (input.startsWith("--session")) {
    const matched = /^--session -- ([\s\S]+)$/.exec(input);
    if (!matched || !matched[1]!.trim()) return failure("RLM_SOURCE_INVALID", "Malformed --session command form.");
    return withObjective(projectSession(ctx), matched[1]!);
  }
  if (input.startsWith("--")) return failure("RLM_SOURCE_INVALID", "Malformed /rlm command form.");
  return failure("RLM_SOURCE_REQUIRED", "Bare objectives are not accepted; provide an explicit source.");
};
