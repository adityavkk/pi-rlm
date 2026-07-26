/** Read-only authoritative recovery inspection for an existing run directory. */

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, isJsonObject, parseJsonValue, type JsonValue } from "../core/json.ts";
import { normalizeProgram } from "../core/program.ts";
import { ContextStore } from "../shell/context-store.ts";
import { sha256Bytes } from "../shell/hash.ts";
import { parseJournalBytes } from "../shell/journal-store.ts";
import { validateOutputContract } from "./output-validation.ts";
import {
  parseRunManifestDocument,
  RUN_LOCK_FILE,
  RUN_MANIFEST_FILE,
  RunManifestCompatibilityError,
  type RunManifestDocument,
} from "./run-manifest.ts";
import { validateWorkspace } from "../core/workspace.ts";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 4096;
export const MAX_RECOVERY_JOURNAL_BYTES = 32 * 1024 * 1024;
export const MAX_RECOVERY_CONTENT_BYTES = 256 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });


import { validateRecoveryJournal } from "./run-recovery-journal.ts";
import {
  RunRecoveryError,
  type RecoveredTerminal,
  type RunRecoveryErrorCode,
  type RunRecoveryInspection,
} from "./run-recovery-types.ts";
export {
  RunRecoveryError,
  type RecoveredTerminal,
  type RunRecoveryErrorCode,
  type RunRecoveryInspection,
} from "./run-recovery-types.ts";

type AnswerEvent = Extract<RlmEvent, { type: "answer_committed" }>;
type CallEvent = Extract<RlmEvent, { type: "call_committed" }>;

const same = (left: unknown, right: unknown): boolean =>
  canonicalStringify(left as JsonValue) === canonicalStringify(right as JsonValue);

const validatePrivateRunDirectory = async (dir: string): Promise<void> => {
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new RunRecoveryError("RECOVERY_DIRECTORY_INVALID", "run directory is not a private real directory");
  } catch (error) {
    if (error instanceof RunRecoveryError) throw error;
    throw new RunRecoveryError("RECOVERY_DIRECTORY_INVALID", "run directory is unavailable", error);
  }
};

const readPrivateFile = async (dir: string, name: string, maxBytes: number, code: RunRecoveryErrorCode): Promise<Buffer> => {
  let handle;
  try {
    handle = await open(join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size > maxBytes)
      throw new RunRecoveryError(code, `${name} is not a bounded private regular file`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || offset !== before.size)
      throw new RunRecoveryError("RECOVERY_UNSTABLE", `${name} changed during recovery inspection`);
    return bytes;
  } catch (error) {
    if (error instanceof RunRecoveryError) throw error;
    throw new RunRecoveryError(code, `failed to read ${name}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const parseCanonicalJson = (bytes: Uint8Array, label: string): JsonValue => {
  try {
    const text = decoder.decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    const json = parseJsonValue(parsed);
    if (!json.ok || canonicalStringify(json.value) !== text)
      throw new Error(`${label} is not canonical strict JSON`);
    return json.value;
  } catch (error) {
    throw new RunRecoveryError("RECOVERY_CONTENT_INVALID", `${label} content is invalid`, error);
  }
};

const validateCallContent = (value: JsonValue, event: CallEvent): void => {
  if (!isJsonObject(value))
    throw new RunRecoveryError("RECOVERY_CONTENT_INVALID", "committed call content is not an object");
  const expectedKeys = event.ok
    ? ["cached", "callId", "ok", "usage", "value"]
    : ["cached", "callId", "error", "ok", "usage"];
  const keys = Object.keys(value).sort();
  const error = value["error"];
  const errorKeys = isJsonObject(error) ? Object.keys(error).sort() : [];
  const validError = !event.ok && isJsonObject(error)
    && (errorKeys.join("\0") === ["code", "message", "retryable"].join("\0")
      || errorKeys.join("\0") === ["code", "details", "message", "retryable"].join("\0"))
    && typeof error["code"] === "string" && typeof error["message"] === "string"
    && typeof error["retryable"] === "boolean";
  if (keys.join("\0") !== expectedKeys.join("\0") || value["callId"] !== event.callId
    || value["ok"] !== event.ok || value["cached"] !== event.cached || !same(value["usage"], event.usage)
    || (!event.ok && !validError))
    throw new RunRecoveryError("RECOVERY_CONTENT_INVALID", "committed call content does not match its event");
};

/** Inspect an existing run without repairing, appending, or consulting status.json. */
export const inspectRecoveredRun = async (dir: string): Promise<RunRecoveryInspection> => {
  await validatePrivateRunDirectory(dir);
  let document: RunManifestDocument;
  try {
    const raw = await readPrivateFile(dir, RUN_MANIFEST_FILE, MAX_MANIFEST_BYTES, "RECOVERY_MANIFEST_INVALID");
    const text = decoder.decode(raw);
    const parsed = JSON.parse(text) as unknown;
    const snapshot = parseJsonValue(parsed);
    if (!snapshot.ok || `${canonicalStringify(snapshot.value)}\n` !== text)
      throw new Error("manifest is not canonical strict JSON");
    document = parseRunManifestDocument(snapshot.value);
  } catch (error) {
    if (error instanceof RunRecoveryError) throw error;
    if (error instanceof RunManifestCompatibilityError)
      throw new RunRecoveryError("RECOVERY_INCOMPATIBLE", "stored run manifest is incompatible", error);
    throw new RunRecoveryError("RECOVERY_MANIFEST_INVALID", "stored run manifest is invalid", error);
  }

  const lockRaw = await readPrivateFile(dir, RUN_LOCK_FILE, MAX_LOCK_BYTES, "RECOVERY_LOCK_INVALID");
  try {
    const text = decoder.decode(lockRaw);
    const parsed = JSON.parse(text) as unknown;
    const json = parseJsonValue(parsed);
    const expected = { runId: document.manifest.run.id, manifestHash: document.manifestHash };
    if (!json.ok || canonicalStringify(json.value) !== text || !same(json.value, expected))
      throw new Error("lock identity mismatch");
  } catch (error) {
    throw new RunRecoveryError("RECOVERY_LOCK_INVALID", "permanent run lock is invalid", error);
  }

  let journalRaw: Buffer;
  try {
    journalRaw = await readPrivateFile(dir, "events.jsonl", MAX_RECOVERY_JOURNAL_BYTES, "RECOVERY_JOURNAL_CORRUPT");
  } catch (error) {
    const cause = error instanceof RunRecoveryError && error.cause && typeof error.cause === "object"
      ? Object.getOwnPropertyDescriptor(error.cause, "code")?.value
      : undefined;
    if (cause === "ENOENT") throw new RunRecoveryError("RECOVERY_ORPHAN", "manifest has no authoritative run start");
    throw error;
  }
  const parsed = parseJournalBytes(journalRaw);
  if (!parsed.ok) throw new RunRecoveryError("RECOVERY_JOURNAL_CORRUPT", "stored run journal is corrupt", parsed.error);
  if (parsed.value.length === 0)
    throw new RunRecoveryError("RECOVERY_ORPHAN", "manifest has no authoritative run start");
  const model = validateRecoveryJournal(document, parsed.value);
  const contentSizes = new Map<string, number>();
  let recoveryBytes = 0;
  const contentLimit = Math.min(document.manifest.limits.storedByteLimit, MAX_RECOVERY_CONTENT_BYTES);
  for (const item of model.content) {
    const prior = contentSizes.get(item.id);
    if (prior !== undefined) {
      if (prior !== item.bytes)
        throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", "one content identity has conflicting sizes");
      continue;
    }
    if (item.bytes > contentLimit || recoveryBytes > contentLimit - item.bytes)
      throw new RunRecoveryError("RECOVERY_CONTENT_INVALID", "committed content exceeds the recovery byte limit");
    contentSizes.set(item.id, item.bytes);
    recoveryBytes += item.bytes;
  }

  const store = new ContextStore(dir);
  const verifiedBytes = new Map<string, Uint8Array>();
  const verifiedJson = new Map<string, JsonValue>();
  for (const item of model.content) {
    let bytes = verifiedBytes.get(item.id);
    if (bytes === undefined) {
      try {
        bytes = await store.loadFromDisk(item);
      } catch (error) {
        throw new RunRecoveryError("RECOVERY_CONTENT_INVALID", "committed content is missing or invalid", error);
      }
      verifiedBytes.set(item.id, bytes);
    }
    if (item.role === "input") continue;
    let value = verifiedJson.get(item.id);
    if (value === undefined) {
      value = parseCanonicalJson(bytes, item.role);
      verifiedJson.set(item.id, value);
    }
    if (item.role === "workspace" && (!isJsonObject(value) || !validateWorkspace(value).ok))
      throw new RunRecoveryError("RECOVERY_CONTENT_INVALID", "committed workspace is invalid");
    if (item.role === "call" && item.event) validateCallContent(value, item.event as CallEvent);
  }

  const journalAgain = await readPrivateFile(dir, "events.jsonl", MAX_RECOVERY_JOURNAL_BYTES, "RECOVERY_JOURNAL_CORRUPT");
  if (journalRaw.length !== journalAgain.length || sha256Bytes(journalRaw) !== sha256Bytes(journalAgain))
    throw new RunRecoveryError("RECOVERY_UNSTABLE", "run journal changed during recovery inspection");

  let recoveredTerminal: RecoveredTerminal | undefined;
  if (model.terminal?.type === "run_completed") {
    const answer = model.rootAnswer ? verifiedJson.get(model.rootAnswer.outputRef) : undefined;
    if (answer === undefined || validateOutputContract(answer, (() => {
      const normalized = normalizeProgram(document.manifest.program);
      if (!normalized.ok) throw new RunRecoveryError("RECOVERY_MANIFEST_INVALID", "manifest program cannot be normalized");
      return normalized.value.outputs;
    })()).length > 0)
      throw new RunRecoveryError("RECOVERY_TERMINAL_INCONSISTENT", "completed answer does not satisfy the manifest output contract");
    recoveredTerminal = {
      status: "completed",
      completionMode: model.terminal.completionMode,
      answer,
      output: {
        ref: model.rootAnswer!.outputRef,
        sha256: model.rootAnswer!.outputSha256!,
        bytes: model.rootAnswer!.outputBytes!,
      },
    };
  } else if (model.terminal?.type === "run_failed") {
    recoveredTerminal = { status: "failed", error: { code: model.terminal.code, message: model.terminal.message } };
  } else if (model.terminal?.type === "run_cancelled") {
    recoveredTerminal = { status: "cancelled", error: { code: model.terminal.code, message: model.terminal.message } };
  }

  return {
    runId: document.manifest.run.id,
    manifestHash: document.manifestHash,
    status: recoveredTerminal?.status ?? "nonterminal",
    rootFrameId: model.rootFrameId,
    eventCount: parsed.value.length,
    committedCells: model.committedCells,
    committedCalls: model.committedCalls,
    ...(recoveredTerminal ? { terminal: recoveredTerminal } : {}),
  };
};
