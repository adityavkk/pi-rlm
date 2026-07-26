/** Host-neutral, read-only pages over one validated managed run journal. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { isProxy } from "node:util/types";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, parseJsonValue, type JsonValue } from "../core/json.ts";
import { sha256, sha256Bytes } from "../shell/hash.ts";
import { parseJournalSnapshotBytes } from "../shell/journal-store.ts";
import { validateRecoveryJournal, type RecoveryJournalModel } from "./run-recovery-journal.ts";
import { MAX_RECOVERY_JOURNAL_BYTES } from "./run-recovery.ts";
import { RunRecoveryError, type RunRecoveryErrorCode } from "./run-recovery-types.ts";
import {
  parseRunManifestDocument,
  RUN_LOCK_FILE,
  RUN_MANIFEST_FILE,
  RunManifestCompatibilityError,
  type RunManifestDocument,
} from "./run-manifest.ts";
import { ManagedRunStore, type ManagedRunStoreOptions } from "./run-retention.ts";
import {
  DEFAULT_RUN_INSPECTION_PAGE_SIZE,
  MAX_RUN_INSPECTION_AGGREGATE_ITEMS,
  MAX_RUN_INSPECTION_CURSOR_BYTES,
  MAX_RUN_INSPECTION_EVENTS,
  MAX_RUN_INSPECTION_PAGE_BYTES,
  MAX_RUN_INSPECTION_PAGE_SIZE,
  RUN_INSPECTION_VERSION,
  RunInspectionError,
  type RunInspectionErrorMetadata,
  type RunInspectionItem,
  type RunInspectionObservedUsage,
  type RunInspectionOptions,
  type RunInspectionPage,
  type RunInspectionRequest,
  type RunInspectionTextIdentity,
  type RunInspectionView,
} from "./run-inspection-types.ts";

export * from "./run-inspection-types.ts";

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 4096;
const MAX_IDENTITY_BYTES = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });
const processCursorKey = randomBytes(32);
const VIEWS = new Set<RunInspectionView>(["summary", "frames", "cells", "calls", "budget", "errors"]);
const TRUSTED_ERROR_CODES = new Set([
  "FAILED", "DENIED", "CANCELLED", "INTERRUPTED", "TIMED_OUT", "ACCEPTANCE_FAILED", "INVALID_REQUEST",
  "INVALID_RESULT", "UNAVAILABLE_CONTEXT", "SOURCE_CHANGED", "UNKNOWN_EFFECT", "BUDGET_DEPTH", "BUDGET_FRAMES",
  "BUDGET_CALLS", "BUDGET_ATTEMPTS", "BUDGET_TOKENS", "BUDGET_BYTES", "BUDGET_DEADLINE", "CPU_LIMIT",
  "HEAP_LIMIT", "WORKER_EXIT", "JOURNAL_CORRUPT", "LATE_CALLBACK", "UNHANDLED_REJECTION", "PARSE_ERROR",
  "DISPOSED", "NO_ANSWER", "ITERATION_BUDGET_EXHAUSTED", "SOURCE_FAILED", "CONTROLLER_FAILED", "EXTRACTOR_FAILED",
  "CONTEXT_FAILED", "JOURNAL_FAILED", "FALLBACK_EVIDENCE_TRUNCATED",
]);

type Terminal = Extract<RlmEvent, { type: "run_completed" | "run_failed" | "run_cancelled" }>;
type Cell = Extract<RlmEvent, { type: "cell_committed" }>;
type Call = Extract<RlmEvent, { type: "call_committed" }>;
type Provider = Extract<RlmEvent, { type: "provider_attempted" }>;
type MutableObservedUsage = { -readonly [Key in keyof RunInspectionObservedUsage]: RunInspectionObservedUsage[Key] };

export interface ManagedRunInspectionOptions extends ManagedRunStoreOptions, RunInspectionOptions {}

interface AuthoritySnapshot {
  readonly document: RunManifestDocument;
  readonly prefix: Buffer;
  readonly events: readonly RlmEvent[];
  readonly model: RecoveryJournalModel;
}

interface CursorV1 {
  readonly version: 1;
  readonly runId: string;
  readonly manifestHash: string;
  readonly journalPrefixSha256: string;
  readonly prefixBytes: number;
  readonly eventCount: number;
  readonly view: RunInspectionView;
  readonly filterHash: string;
  readonly offset: number;
}

interface CursorEnvelope { readonly payload: CursorV1; readonly mac: string }
const recoveryFailure = (code: RunRecoveryErrorCode, message: string, cause?: unknown): RunRecoveryError =>
  new RunRecoveryError(code, message, cause);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const readPrivateFile = async (
  dir: string,
  name: string,
  maxBytes: number,
  code: RunRecoveryErrorCode,
  prefixBytes?: number,
  allowGrowth = false,
): Promise<Buffer> => {
  let handle;
  try {
    handle = await open(join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    const bytesToRead = prefixBytes ?? before.size;
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0
      || before.size > maxBytes || bytesToRead > before.size || bytesToRead > maxBytes)
      throw recoveryFailure(code, `${name} is not a bounded private regular file`);
    const bytes = Buffer.alloc(bytesToRead);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const changed = before.dev !== after.dev || before.ino !== after.ino || offset !== bytesToRead
      || (allowGrowth ? after.size < bytesToRead : before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs);
    if (changed) throw recoveryFailure("RECOVERY_UNSTABLE", `${name} changed within the captured prefix`);
    return bytes;
  } catch (error) {
    if (error instanceof RunRecoveryError) throw error;
    throw recoveryFailure(code, `failed to read ${name}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const readAuthority = async (dir: string, cursor?: CursorV1): Promise<AuthoritySnapshot> => {
  const directory = await lstat(dir);
  if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o077) !== 0)
    throw recoveryFailure("RECOVERY_DIRECTORY_INVALID", "managed run directory is not a private real directory");
  let document: RunManifestDocument;
  try {
    const text = decoder.decode(await readPrivateFile(dir, RUN_MANIFEST_FILE, MAX_MANIFEST_BYTES, "RECOVERY_MANIFEST_INVALID"));
    const parsed = JSON.parse(text) as unknown;
    const json = parseJsonValue(parsed);
    if (!json.ok || `${canonicalStringify(json.value)}\n` !== text) throw new TypeError("manifest is not canonical strict JSON");
    document = parseRunManifestDocument(json.value);
  } catch (error) {
    if (error instanceof RunRecoveryError) throw error;
    if (error instanceof RunManifestCompatibilityError)
      throw recoveryFailure("RECOVERY_INCOMPATIBLE", "stored run manifest is incompatible", error);
    throw recoveryFailure("RECOVERY_MANIFEST_INVALID", "stored run manifest is invalid", error);
  }
  try {
    const text = decoder.decode(await readPrivateFile(dir, RUN_LOCK_FILE, MAX_LOCK_BYTES, "RECOVERY_LOCK_INVALID"));
    const parsed = parseJsonValue(JSON.parse(text) as unknown);
    const expected = { runId: document.manifest.run.id, manifestHash: document.manifestHash };
    if (!parsed.ok || canonicalStringify(parsed.value) !== text || canonicalStringify(parsed.value) !== canonicalStringify(expected))
      throw new TypeError("lock identity mismatch");
  } catch (error) {
    if (error instanceof RunRecoveryError) throw error;
    throw recoveryFailure("RECOVERY_LOCK_INVALID", "permanent run lock is invalid", error);
  }
  const raw = await readPrivateFile(
    dir, "events.jsonl", MAX_RECOVERY_JOURNAL_BYTES, "RECOVERY_JOURNAL_CORRUPT", cursor?.prefixBytes, true,
  );
  const parsed = parseJournalSnapshotBytes(raw);
  if (!parsed.ok) throw recoveryFailure("RECOVERY_JOURNAL_CORRUPT", "stored run journal prefix is corrupt", parsed.error);
  if (cursor && parsed.value.verifiedBytes !== raw.length)
    throw new RunInspectionError("RUN_INSPECTION_INVALID_CURSOR", "inspection cursor prefix is no longer authoritative");
  const prefix = raw.subarray(0, parsed.value.verifiedBytes);
  if (parsed.value.events.length === 0) throw recoveryFailure("RECOVERY_ORPHAN", "manifest has no authoritative run start");
  if (parsed.value.events.length > MAX_RUN_INSPECTION_EVENTS)
    throw new RunInspectionError("RUN_INSPECTION_LIMIT", "journal event aggregate exceeds the inspection limit");
  return {
    document,
    prefix,
    events: parsed.value.events,
    model: validateRecoveryJournal(document, parsed.value.events),
  };
};

const requestSnapshot = (input: unknown): RunInspectionRequest => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input) || isProxy(input)) throw new TypeError();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(input);
    const required = new Set(["version", "runName", "view"]);
    const allowed = new Set([...required, "frameId", "cursor", "pageSize"]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
      || [...required].some((key) => !keys.includes(key))) throw new TypeError();
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError();
      copy[key] = descriptor.value;
    }
    if (copy["version"] !== RUN_INSPECTION_VERSION || typeof copy["runName"] !== "string" || !RUN_NAME.test(copy["runName"])
      || typeof copy["view"] !== "string" || !VIEWS.has(copy["view"] as RunInspectionView)
      || (copy["frameId"] !== undefined && (typeof copy["frameId"] !== "string" || copy["frameId"].length === 0
        || Buffer.byteLength(copy["frameId"], "utf8") > MAX_IDENTITY_BYTES))
      || (copy["cursor"] !== undefined && (typeof copy["cursor"] !== "string"
        || Buffer.byteLength(copy["cursor"], "utf8") > MAX_RUN_INSPECTION_CURSOR_BYTES))
      || (copy["pageSize"] !== undefined && !integer(copy["pageSize"], 1, MAX_RUN_INSPECTION_PAGE_SIZE))) throw new TypeError();
    return copy as unknown as RunInspectionRequest;
  } catch (cause) {
    throw new RunInspectionError("RUN_INSPECTION_INVALID_REQUEST", "invalid managed run inspection request", cause);
  }
};

const cursorMac = (payload: CursorV1, key: Uint8Array): string =>
  createHmac("sha256", key).update(canonicalStringify(payload as unknown as JsonValue)).digest("hex");
const encodeCursor = (payload: CursorV1, key: Uint8Array): string =>
  Buffer.from(canonicalStringify({ payload, mac: cursorMac(payload, key) } as unknown as JsonValue)).toString("base64url");
const decodeCursor = (encoded: string, key: Uint8Array): CursorV1 => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new TypeError();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.length > MAX_RUN_INSPECTION_CURSOR_BYTES) throw new TypeError();
    const parsed = parseJsonValue(JSON.parse(decoder.decode(bytes)) as unknown);
    if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) throw new TypeError();
    const envelope = parsed.value as unknown as Record<string, unknown>;
    if (Object.keys(envelope).sort().join("\0") !== ["mac", "payload"].join("\0")
      || typeof envelope["mac"] !== "string" || !HASH.test(envelope["mac"])) throw new TypeError();
    const payload = envelope["payload"] as Record<string, unknown>;
    const payloadKeys = ["eventCount", "filterHash", "journalPrefixSha256", "manifestHash", "offset", "prefixBytes", "runId", "version", "view"];
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join("\0") !== payloadKeys.join("\0")
      || payload["version"] !== 1 || typeof payload["runId"] !== "string" || typeof payload["manifestHash"] !== "string"
      || !HASH.test(payload["journalPrefixSha256"] as string) || !HASH.test(payload["filterHash"] as string)
      || !integer(payload["prefixBytes"], 1, MAX_RECOVERY_JOURNAL_BYTES)
      || !integer(payload["eventCount"], 1, MAX_RUN_INSPECTION_EVENTS)
      || !integer(payload["offset"], 1, MAX_RUN_INSPECTION_AGGREGATE_ITEMS)
      || typeof payload["view"] !== "string" || !VIEWS.has(payload["view"] as RunInspectionView)) throw new TypeError();
    const expected = Buffer.from(cursorMac(payload as unknown as CursorV1, key), "hex");
    const actual = Buffer.from(envelope["mac"], "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new TypeError();
    return payload as unknown as CursorV1;
  } catch (cause) {
    throw new RunInspectionError("RUN_INSPECTION_INVALID_CURSOR", "inspection cursor is invalid or stale", cause);
  }
};

const textIdentity = (text: string): RunInspectionTextIdentity => ({ sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") });
const errorMetadata = (code: string, message?: string): RunInspectionErrorMetadata => ({
  ...(TRUSTED_ERROR_CODES.has(code) ? { trustedCode: code } : {}),
  code: textIdentity(code),
  ...(message !== undefined ? { message: textIdentity(message) } : {}),
});
const checkedAdd = (left: number, right: number): number => {
  if (!Number.isFinite(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right)
    throw new RunInspectionError("RUN_INSPECTION_LIMIT", "inspection usage aggregate overflowed");
  return left + right;
};
const boundedIdentity = (value: string, label: string): string => {
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTITY_BYTES)
    throw new RunInspectionError("RUN_INSPECTION_LIMIT", `${label} exceeds the inspection identity limit`);
  return value;
};

const project = (
  view: RunInspectionView,
  events: readonly RlmEvent[],
  model: RecoveryJournalModel,
  limits: RunManifestDocument["manifest"]["limits"],
  frameFilter?: string,
): RunInspectionItem[] => {
  const frames = new Map<string, Extract<RlmEvent, { type: "frame_opened" }>>();
  const frameStates = new Map<string, Extract<RlmEvent, { type: "frame_closed" }>["state"]>();
  const frameCells = new Map<string, Cell[]>();
  const frameCalls = new Map<string, Set<string>>();
  const phases = new Map<string, string>();
  const cells = new Map<string, Cell>();
  const calls = new Map<string, Call[]>();
  const callExecutionHashes = new Map<string, Set<string>>();
  const providers = new Map<string, Provider[]>();
  const providerAttempts = new Set<string>();
  let terminal: Terminal | undefined;
  let providerCount = 0;
  const guard = (size: number): void => {
    if (size > MAX_RUN_INSPECTION_AGGREGATE_ITEMS)
      throw new RunInspectionError("RUN_INSPECTION_LIMIT", "projected item aggregate exceeds the inspection limit");
  };
  for (const event of events) {
    if ("frameId" in event) boundedIdentity(event.frameId, "frame identity");
    if (event.type === "frame_opened" && !frames.has(event.frameId)) { frames.set(event.frameId, event); guard(frames.size); }
    else if (event.type === "frame_closed") frameStates.set(event.frameId, event.state);
    else if (event.type === "answer_committed") frameStates.set(event.frameId, "answered");
    else if (event.type === "phase") phases.set(event.frameId, event.name);
    else if (event.type === "cell_committed") {
      const identity = `${event.frameId}\0${event.iteration}`;
      if (!cells.has(identity)) {
        cells.set(identity, event);
        const entries = frameCells.get(event.frameId) ?? [];
        entries.push(event);
        frameCells.set(event.frameId, entries);
        guard(cells.size);
      }
    } else if (event.type === "call_committed") {
      boundedIdentity(event.callId, "call identity");
      const executions = calls.get(event.callId) ?? [];
      const hashes = callExecutionHashes.get(event.callId) ?? new Set<string>();
      const executionHash = sha256(canonicalStringify(event as unknown as JsonValue));
      if (!hashes.has(executionHash)) {
        hashes.add(executionHash);
        executions.push(event);
      }
      callExecutionHashes.set(event.callId, hashes);
      calls.set(event.callId, executions);
      const ids = frameCalls.get(event.frameId) ?? new Set<string>();
      ids.add(event.callId);
      frameCalls.set(event.frameId, ids);
      guard(calls.size);
    } else if (event.type === "provider_attempted") {
      boundedIdentity(event.operationId, "operation identity");
      const key = `${event.frameId}\0${event.operationId}`;
      const attemptIdentity = `${key}\0${event.attempt}`;
      if (!providerAttempts.has(attemptIdentity)) {
        providerAttempts.add(attemptIdentity);
        const attempts = providers.get(key) ?? [];
        attempts.push(event);
        providers.set(key, attempts);
        providerCount += 1;
        guard(providerCount);
      }
    } else if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled") terminal = event;
  }
  const providerEvents = [...providers.values()].flat();
  const selected = (frameId: string): boolean => frameFilter === undefined || frameId === frameFilter;
  let items: RunInspectionItem[];
  if (view === "summary") {
    items = [{
      kind: "summary", status: terminal?.type === "run_completed" ? "completed" : terminal?.type === "run_failed" ? "failed"
        : terminal?.type === "run_cancelled" ? "cancelled" : "nonterminal",
      rootFrameId: model.rootFrameId, eventCount: events.length, frames: frames.size, cells: cells.size,
      committedCalls: calls.size, observedProviderAttempts: providerEvents.length,
      ...(terminal?.type === "run_completed" ? { completionMode: terminal.completionMode } : {}),
      ...(terminal?.type === "run_failed" || terminal?.type === "run_cancelled"
        ? { error: errorMetadata(terminal.code, terminal.message) } : {}),
    }];
  } else if (view === "frames") {
    items = [...frames.values()].filter((event) => selected(event.frameId)).map((event) => ({
      kind: "frame", frameId: event.frameId, parentFrameId: event.parentFrameId, depth: event.depth,
      state: frameStates.get(event.frameId) ?? "open", cells: frameCells.get(event.frameId)?.length ?? 0,
      committedCalls: frameCalls.get(event.frameId)?.size ?? 0,
      ...(phases.has(event.frameId) ? { phase: textIdentity(phases.get(event.frameId)!) } : {}),
    }));
  } else if (view === "cells") {
    items = [...cells.values()].filter((cell) => selected(cell.frameId)).map((cell) => ({
      kind: "cell", frameId: cell.frameId, iteration: cell.iteration, codeHash: cell.codeHash, hasResult: cell.hasResult,
      ...(cell.outputBytes !== undefined ? { outputBytes: cell.outputBytes } : {}),
      ...(cell.outputOmittedBytes !== undefined ? { outputOmittedBytes: cell.outputOmittedBytes } : {}),
      ...(cell.outputRefBytes !== undefined ? { committedOutputBytes: cell.outputRefBytes } : {}),
      ...(cell.usage !== undefined ? { usage: cell.usage } : {}),
      ...(cell.error ? { error: errorMetadata(cell.error.code, cell.error.message) } : {}),
    }));
  } else if (view === "calls") {
    items = [...calls.values()].filter((executions) => selected(executions[0]!.frameId)).map((executions) => {
      const call = executions.at(-1)!;
      const attempts = providers.get(`${call.frameId}\0${call.callId}`) ?? [];
      const last = attempts.at(-1);
      return {
        kind: "call", frameId: call.frameId, callId: call.callId, callKind: call.kind, key: textIdentity(call.key),
        executions: executions.length, ok: call.ok, usage: call.usage,
        ...(call.outputSha256 !== undefined ? { outputSha256: call.outputSha256 } : {}),
        ...(call.outputBytes !== undefined ? { outputBytes: call.outputBytes } : {}),
        observedProviderAttempts: attempts.length, ...(last ? { lastOutcome: last.outcome } : {}),
        ...(last?.errorCode ? { errorCode: textIdentity(last.errorCode) } : {}),
      };
    });
  } else if (view === "budget") {
    const usage: MutableObservedUsage = {
      frames: frames.size, cells: cells.size, committedCalls: calls.size, observedProviderAttempts: providerEvents.length,
      observedControllerProviderAttempts: providerEvents.filter((event) => event.kind === "controller").length,
      reportedInputTokens: 0, reportedOutputTokens: 0, reportedTotalTokens: 0, reportedCostUsd: 0,
      providerDurationMs: 0, committedContentBytes: 0,
    };
    for (const event of providerEvents) {
      usage.reportedInputTokens = checkedAdd(usage.reportedInputTokens, event.usage.inputTokens ?? 0);
      usage.reportedOutputTokens = checkedAdd(usage.reportedOutputTokens, event.usage.outputTokens ?? 0);
      usage.reportedTotalTokens = checkedAdd(usage.reportedTotalTokens,
        event.usage.totalTokens ?? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0));
      usage.reportedCostUsd = checkedAdd(usage.reportedCostUsd, event.usage.costUsd ?? 0);
      usage.providerDurationMs = checkedAdd(usage.providerDurationMs, event.usage.durationMs);
    }
    const content = new Map<string, number>();
    for (const reference of model.content) content.set(reference.id, reference.bytes);
    for (const bytes of content.values()) usage.committedContentBytes = checkedAdd(usage.committedContentBytes, bytes);
    items = [{ kind: "budget", limits, observedLowerBounds: usage }];
  } else {
    items = [];
    for (const cell of cells.values()) if (selected(cell.frameId) && cell.error) {
      items.push({ kind: "error", source: "cell", frameId: cell.frameId, iteration: cell.iteration,
        error: errorMetadata(cell.error.code, cell.error.message) });
      guard(items.length);
    }
    for (const attempt of providerEvents) if (selected(attempt.frameId) && attempt.errorCode) {
      items.push({ kind: "error", source: "provider", frameId: attempt.frameId, operationId: attempt.operationId,
        error: errorMetadata(attempt.errorCode) });
      guard(items.length);
    }
    if (!frameFilter && (terminal?.type === "run_failed" || terminal?.type === "run_cancelled")) items.push({
      kind: "error", source: "run", error: errorMetadata(terminal.code, terminal.message),
    });
    guard(items.length);
  }
  guard(items.length);
  return items;
};

const measuredPage = (page: Omit<RunInspectionPage, "serializedBytes">): RunInspectionPage => {
  let serializedBytes = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = Buffer.byteLength(canonicalStringify({ ...page, serializedBytes } as unknown as JsonValue), "utf8");
    if (next === serializedBytes) return { ...page, serializedBytes };
    serializedBytes = next;
  }
  return { ...page, serializedBytes };
};

/** Inspect one host-managed run name. Caller-controlled filesystem paths are not accepted. */
export const inspectManagedRunPage = async (
  rawRequest: unknown,
  options: ManagedRunInspectionOptions = {},
): Promise<RunInspectionPage> => {
  const request = requestSnapshot(rawRequest);
  const pageSize = request.pageSize ?? DEFAULT_RUN_INSPECTION_PAGE_SIZE;
  const cursorKey = options.cursorKey ?? processCursorKey;
  if (!(cursorKey instanceof Uint8Array) || cursorKey.length < 32)
    throw new RunInspectionError("RUN_INSPECTION_INVALID_REQUEST", "inspection cursor key must contain at least 32 bytes");
  const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor, cursorKey);
  const { cursorKey: _cursorKey, ...storeOptions } = options;
  const listing = await new ManagedRunStore(storeOptions).list();
  const run = listing.runs.find((item) => item.name === request.runName);
  if (!run) throw new RunInspectionError("RUN_INSPECTION_RUN_NOT_FOUND", "managed run was not found or is not valid");
  const snapshot = await readAuthority(run.path, cursor);
  const prefixSha256 = sha256Bytes(snapshot.prefix);
  const filterHash = sha256(canonicalStringify({ frameId: request.frameId ?? null }));
  let offset = 0;
  if (cursor) {
    if (cursor.runId !== snapshot.document.manifest.run.id || cursor.manifestHash !== snapshot.document.manifestHash
      || cursor.view !== request.view || cursor.filterHash !== filterHash || cursor.prefixBytes !== snapshot.prefix.length
      || cursor.journalPrefixSha256 !== prefixSha256 || cursor.eventCount !== snapshot.events.length)
      throw new RunInspectionError("RUN_INSPECTION_INVALID_CURSOR", "inspection cursor is invalid or stale");
    offset = cursor.offset;
  }
  const items = project(request.view, snapshot.events, snapshot.model, snapshot.document.manifest.limits, request.frameId);
  if (offset >= items.length && items.length > 0)
    throw new RunInspectionError("RUN_INSPECTION_INVALID_CURSOR", "inspection cursor offset is stale");
  let count = Math.min(pageSize, items.length - offset);
  while (count > 0 || items.length === 0) {
    const pageItems = items.slice(offset, offset + count);
    const nextOffset = offset + pageItems.length;
    const nextCursor = nextOffset < items.length ? encodeCursor({
      version: 1, runId: snapshot.document.manifest.run.id, manifestHash: snapshot.document.manifestHash,
      journalPrefixSha256: prefixSha256, prefixBytes: snapshot.prefix.length, eventCount: snapshot.events.length,
      view: request.view, filterHash, offset: nextOffset,
    }, cursorKey) : undefined;
    const page = measuredPage({
      version: 1, runName: request.runName, runId: snapshot.document.manifest.run.id,
      manifestHash: snapshot.document.manifestHash, journalPrefixSha256: prefixSha256,
      eventCount: snapshot.events.length, view: request.view, items: pageItems,
      ...(nextCursor ? { nextCursor } : {}),
    });
    if (page.serializedBytes <= MAX_RUN_INSPECTION_PAGE_BYTES) return page;
    if (count === 0) break;
    count -= 1;
  }
  throw new RunInspectionError("RUN_INSPECTION_LIMIT", "one inspection item exceeds the serialized page byte limit");
};
