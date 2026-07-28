/**
 * Durable event journal (imperative shell).
 *
 * `events.jsonl` is append-only and authoritative. Logical batches are one
 * canonical, checksummed JSONL record, so no prefix of a cell commit can be
 * read as authoritative. Legacy single-event records remain readable.
 */

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { interpreterError, type InterpreterError } from "../core/errors.ts";
import { type JsonValue, canonicalStringify } from "../core/json.ts";
import { reduceStatus, type RlmEvent, type RunStatus } from "../core/journal.ts";
import { err, ok, type Result } from "../core/result.ts";
import { parseRlmEvent } from "./journal-event.ts";

export { parseRlmEvent } from "./journal-event.ts";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const sha256Raw = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const lineHash = (line: string): string => sha256(line).slice(0, 12);
const BATCH_RECORD_TYPE = "journal_batch";
const BATCH_RECORD_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_JOURNAL_AUTHORITY_BYTES = 32 * 1024 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;
const directoryFlag = constants.O_DIRECTORY ?? 0;

export interface JournalFileHandle {
  appendFile(data: string, encoding: BufferEncoding): Promise<void>;
  close(): Promise<void>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  readFile(): Promise<Buffer>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
}

export interface JournalFileSystem {
  /** Optional lease-owned boundary for one complete journal operation. */
  runTransaction?<T>(effect: () => Promise<T>): Promise<T>;
  open(path: string, flags: string | number, mode?: number): Promise<JournalFileHandle>;
  readFile(path: string): Promise<Buffer>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export const nodeJournalFileSystem: JournalFileSystem = {
  open: async (path, flags, mode) => open(path, flags, mode),
  readFile: async (path) => readFile(path),
  rename,
};

interface JournalBatchRecord {
  readonly type: typeof BATCH_RECORD_TYPE;
  readonly version: typeof BATCH_RECORD_VERSION;
  readonly batchId: string;
  readonly checksum: string;
  readonly events: readonly RlmEvent[];
}

const makeBatchRecord = (events: readonly RlmEvent[]): JournalBatchRecord => {
  const checksum = sha256(canonicalStringify(events as unknown as JsonValue));
  return { type: BATCH_RECORD_TYPE, version: BATCH_RECORD_VERSION, batchId: `batch_${checksum}`, checksum, events };
};

type CellCommitted = Extract<RlmEvent, { type: "cell_committed" }>;
type AnswerCommitted = Extract<RlmEvent, { type: "answer_committed" }>;

const hasFullCellOutput = (cell: CellCommitted): boolean =>
  typeof cell.outputRef === "string" && typeof cell.outputRefSha256 === "string"
  && SHA256.test(cell.outputRefSha256) && cell.outputRef === `ctx_${cell.outputRefSha256}`
  && Number.isSafeInteger(cell.outputRefBytes) && (cell.outputRefBytes as number) >= 0;

const hasFullAnswerOutput = (answer: AnswerCommitted): boolean =>
  SHA256.test(answer.outputSha256 ?? "") && answer.outputRef === `ctx_${answer.outputSha256}`
  && Number.isSafeInteger(answer.outputBytes) && (answer.outputBytes as number) >= 0;

const sameOutput = (cell: CellCommitted, answer: AnswerCommitted): boolean =>
  hasFullCellOutput(cell) && hasFullAnswerOutput(answer) && cell.outputRef === answer.outputRef
  && cell.outputRefSha256 === answer.outputSha256 && cell.outputRefBytes === answer.outputBytes;

/** Only the two exact transactions emitted by the runtime are valid version-1 batch payloads. */
const validBatchSemantics = (events: readonly RlmEvent[]): boolean => {
  const answers = events.filter((event): event is AnswerCommitted => event.type === "answer_committed");
  if (answers.length > 1) return false;

  // Fallback extraction is persisted separately from a controller cell as citation + fully identified answer.
  if (events.length === 2 && events[0]?.type === "fallback_evidence_cited" && events[1]?.type === "answer_committed") {
    return events[0].frameId === events[1].frameId && events[1].completionMode === "fallback_extract"
      && hasFullAnswerOutput(events[1]);
  }

  const cellIndexes = events.flatMap((event, index) => event.type === "cell_committed" ? [index] : []);
  if (cellIndexes.length !== 1) return false;
  const cellIndex = cellIndexes[0] as number;
  const cell = events[cellIndex] as CellCommitted;
  if (cellIndex !== events.length - 1 && cellIndex !== events.length - 2) return false;
  for (let index = 0; index < cellIndex; index++) {
    const progress = events[index];
    if (!progress || (progress.type !== "phase" && progress.type !== "emit") || progress.frameId !== cell.frameId
      || progress.iteration !== cell.iteration || progress.ordinal !== index) return false;
  }
  const answer = events[cellIndex + 1];
  if (!answer) return cell.outputRef === undefined && cell.outputRefSha256 === undefined && cell.outputRefBytes === undefined;
  return answer.type === "answer_committed" && answer.frameId === cell.frameId && answer.completionMode === "answer"
    && sameOutput(cell, answer);
};

const recordLine = (record: RlmEvent | JournalBatchRecord): string =>
  `${canonicalStringify(record as unknown as JsonValue)}\n`;

export interface JournalEventPosition {
  /** Zero-based semantic event index in the verified event stream. */
  readonly eventIndex: number;
  /** Complete JSONL bytes preceding the physical record containing this event. */
  readonly prefixBytes: number;
  /** Complete JSONL bytes through the physical record containing this event. */
  readonly endBytes: number;
}

interface JournalScan {
  readonly events: RlmEvent[];
  readonly eventPositions: JournalEventPosition[];
  readonly verifiedBytes: number;
  readonly batchIds: ReadonlySet<string>;
}

const corruptLine = (lineNumber: number, line: string): InterpreterError =>
  interpreterError("JOURNAL_CORRUPT", `corrupt journal line ${lineNumber} (${lineHash(line)})`);

const scanJournal = (
  raw: Uint8Array,
  control: JournalAuthorityControl = {},
): Result<JournalScan, InterpreterError> => {
  control.checkpoint?.();
  const verifiedBytes = raw.length === 0 || raw[raw.length - 1] === 0x0a
    ? raw.length
    : raw.lastIndexOf(0x0a) + 1;
  const events: RlmEvent[] = [];
  const eventPositions: JournalEventPosition[] = [];
  const batchIds = new Set<string>();
  let lineStart = 0;
  let lineNumber = 0;

  for (let i = 0; i < verifiedBytes; i++) {
    if (i % (64 * 1024) === 0) control.checkpoint?.();
    if (raw[i] !== 0x0a) continue;
    const line = Buffer.from(raw.subarray(lineStart, i)).toString("utf8");
    if (line.length === 0) return err(corruptLine(lineNumber, line));
    let parsed: unknown;
    try {
      control.checkpoint?.();
      parsed = JSON.parse(line);
      control.checkpoint?.();
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.getOwnPropertyDescriptor(parsed, "type")?.value === BATCH_RECORD_TYPE) {
        const envelope = parsed as Record<string, unknown>;
        const keys = Object.keys(envelope).sort();
        if (keys.join("\0") !== ["batchId", "checksum", "events", "type", "version"].join("\0")
          || envelope["version"] !== BATCH_RECORD_VERSION || typeof envelope["batchId"] !== "string"
          || !/^batch_[0-9a-f]{64}$/.test(envelope["batchId"]) || typeof envelope["checksum"] !== "string"
          || !SHA256.test(envelope["checksum"]) || !Array.isArray(envelope["events"]) || envelope["events"].length === 0)
          return err(corruptLine(lineNumber, line));
        const batchEvents: RlmEvent[] = [];
        for (const rawEvent of envelope["events"]) {
          const event = parseRlmEvent(rawEvent);
          if (!event.ok) return err(corruptLine(lineNumber, line));
          batchEvents.push(event.value);
        }
        if (!validBatchSemantics(batchEvents)) return err(corruptLine(lineNumber, line));
        const expected = makeBatchRecord(batchEvents);
        if (envelope["batchId"] !== expected.batchId || envelope["checksum"] !== expected.checksum
          || line !== recordLine(expected).slice(0, -1)) return err(corruptLine(lineNumber, line));
        if (!batchIds.has(expected.batchId)) {
          for (const event of expected.events) {
            eventPositions.push({ eventIndex: events.length, prefixBytes: lineStart, endBytes: i + 1 });
            events.push(event);
          }
        }
        batchIds.add(expected.batchId);
      } else {
        const event = parseRlmEvent(parsed);
        if (!event.ok) return err(corruptLine(lineNumber, line));
        eventPositions.push({ eventIndex: events.length, prefixBytes: lineStart, endBytes: i + 1 });
        events.push(event.value);
      }
    } catch {
      return err(corruptLine(lineNumber, line));
    }
    lineStart = i + 1;
    lineNumber++;
  }

  control.checkpoint?.();
  return ok({ events, eventPositions, verifiedBytes, batchIds });
};

export interface JournalAuthorityControl {
  readonly checkpoint?: () => void;
}

const stableJournalStat = (before: Stats, after: Stats): boolean =>
  before.dev === after.dev && before.ino === after.ino && before.size === after.size
  && before.mode === after.mode && before.nlink === after.nlink
  && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

const readBoundedJournalHandle = async (
  handle: JournalFileHandle,
  control: JournalAuthorityControl = {},
  requirePrivate = false,
): Promise<Buffer> => {
  control.checkpoint?.();
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || (requirePrivate && (before.mode & 0o077) !== 0)
    || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_JOURNAL_AUTHORITY_BYTES)
    throw interpreterError("JOURNAL_CORRUPT", "journal is not one bounded private regular file");
  control.checkpoint?.();
  const raw = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < raw.length) {
    control.checkpoint?.();
    const result = await handle.read(raw, offset, Math.min(64 * 1024, raw.length - offset), offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  if (offset !== before.size || !stableJournalStat(before, after))
    throw interpreterError("JOURNAL_CORRUPT", "journal changed during its bounded read");
  control.checkpoint?.();
  return raw;
};

export interface ParsedJournalSnapshot {
  readonly events: readonly RlmEvent[];
  readonly eventPositions: readonly JournalEventPosition[];
  /** Complete, checksummed JSONL prefix. A torn final record is excluded. */
  readonly verifiedBytes: number;
}

/** Parse one bounded journal snapshot without repairing or writing it. */
export const parseJournalSnapshotBytes = (raw: Uint8Array): Result<ParsedJournalSnapshot, InterpreterError> => {
  const scanned = scanJournal(raw);
  return scanned.ok ? ok({
    events: scanned.value.events,
    eventPositions: scanned.value.eventPositions,
    verifiedBytes: scanned.value.verifiedBytes,
  }) : scanned;
};

/** Compatibility projection for callers which only need committed events. */
export const parseJournalBytes = (raw: Uint8Array): Result<readonly RlmEvent[], InterpreterError> => {
  const parsed = parseJournalSnapshotBytes(raw);
  return parsed.ok ? ok(parsed.value.events) : parsed;
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isTerminal = (event: RlmEvent): boolean =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled";

const isProgress = (event: RlmEvent): event is Extract<RlmEvent, { type: "phase" | "emit" }> =>
  event.type === "phase" || event.type === "emit";

const sameProgressIdentity = (
  left: Extract<RlmEvent, { type: "phase" | "emit" }>,
  right: Extract<RlmEvent, { type: "phase" | "emit" }>,
): boolean => left.frameId === right.frameId && left.iteration === right.iteration && left.ordinal === right.ordinal;

export type JournalAppendPhase = "event" | "status_cache";

export class JournalAppendError extends Error {
  override readonly name = "JournalAppendError";

  constructor(
    readonly phase: JournalAppendPhase,
    readonly eventDurable: boolean,
    override readonly cause: unknown,
  ) {
    super(phase === "event" ? "failed to append journal event" : "failed to refresh journal status cache");
  }
}

export type JournalAppendDisposition = "committed" | "deduplicated" | "ignored_after_terminal";

interface JournalStatusCacheOutcome {
  readonly statusCache:
    | { readonly state: "refreshed" }
    | { readonly state: "skipped" }
    | { readonly state: "failed"; readonly error: JournalAppendError };
}

export interface JournalAppendOutcome extends JournalStatusCacheOutcome {
  readonly event: JournalAppendDisposition;
}

export interface JournalBatchAppendOutcome extends JournalStatusCacheOutcome {
  readonly events: readonly JournalAppendDisposition[];
}

export interface JournalAuthoritySnapshot extends ParsedJournalSnapshot {
  readonly prefixSha256: string;
  /** Exact verified JSONL bytes. Returned as an owned copy for prefix binding. */
  readonly verifiedPrefix: Uint8Array;
}

export interface JournalTailInspection extends JournalAuthoritySnapshot {
  readonly incompleteTailBytes: number;
}

export interface JournalTailRepairOutcome extends JournalAuthoritySnapshot {
  readonly removedBytes: number;
}

export class JournalStore {
  private readonly eventsPath: string;
  private readonly statusPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cacheFailures: JournalAppendError[] = [];

  constructor(
    private readonly dir: string,
    private readonly fileSystem: JournalFileSystem = nodeJournalFileSystem,
  ) {
    this.eventsPath = join(dir, "events.jsonl");
    this.statusPath = join(dir, "status.json");
  }

  append(event: RlmEvent): Promise<JournalAppendOutcome> {
    const parsed = parseRlmEvent(event);
    if (!parsed.ok) return Promise.reject(new JournalAppendError("event", false, parsed.error));
    return this.enqueue([parsed.value], false).then((outcome) => ({
      event: outcome.events[0] as JournalAppendDisposition,
      statusCache: outcome.statusCache,
    }));
  }

  /** Append one logical batch as exactly one canonical, checksummed JSONL record. */
  appendBatch(batch: readonly RlmEvent[]): Promise<JournalBatchAppendOutcome> {
    const parsed: RlmEvent[] = [];
    for (const rawEvent of batch) {
      const event = parseRlmEvent(rawEvent);
      if (!event.ok) return Promise.reject(new JournalAppendError("event", false, event.error));
      parsed.push(event.value);
    }
    if (!validBatchSemantics(parsed))
      return Promise.reject(new JournalAppendError("event", false, interpreterError("JOURNAL_CORRUPT", "invalid journal batch")));
    return this.enqueue(parsed, true);
  }

  /** Read one verified prefix without repairing its incomplete final record. */
  inspectTail(control: JournalAuthorityControl = {}): Promise<JournalTailInspection> {
    return this.enqueueControl(async () => {
      const handle = await this.fileSystem.open(this.eventsPath, constants.O_RDONLY | noFollow);
      let raw: Buffer;
      try { raw = await readBoundedJournalHandle(handle, control, true); }
      finally { await handle.close(); }
      const scanned = scanJournal(raw, control);
      if (!scanned.ok) throw scanned.error;
      const prefix = raw.subarray(0, scanned.value.verifiedBytes);
      return {
        events: scanned.value.events,
        eventPositions: scanned.value.eventPositions,
        verifiedBytes: scanned.value.verifiedBytes,
        prefixSha256: sha256Raw(prefix),
        verifiedPrefix: Buffer.from(prefix),
        incompleteTailBytes: raw.length - scanned.value.verifiedBytes,
      };
    });
  }

  /** Stable complete prefix used to bind a content checkpoint before its commit event. */
  authoritySnapshot(control: JournalAuthorityControl = {}): Promise<JournalAuthoritySnapshot> {
    return this.enqueueControl(async () => {
      const handle = await this.fileSystem.open(this.eventsPath, constants.O_RDONLY | noFollow);
      let raw: Buffer;
      try { raw = await readBoundedJournalHandle(handle, control, true); }
      finally { await handle.close(); }
      const scanned = scanJournal(raw, control);
      if (!scanned.ok) throw scanned.error;
      if (scanned.value.verifiedBytes !== raw.length)
        throw interpreterError("JOURNAL_CORRUPT", "journal has an incomplete tail at checkpoint boundary");
      return {
        events: scanned.value.events,
        eventPositions: scanned.value.eventPositions,
        verifiedBytes: scanned.value.verifiedBytes,
        prefixSha256: sha256Raw(raw),
        verifiedPrefix: Buffer.from(raw),
      };
    });
  }

  /** Truncate only a parser-proven incomplete final record. Callers must own the writer lease. */
  repairIncompleteTail(control: JournalAuthorityControl = {}): Promise<JournalTailRepairOutcome> {
    return this.enqueueControl(async () => {
      let handle: JournalFileHandle | undefined;
      let primary: unknown;
      try {
        handle = await this.fileSystem.open(this.eventsPath, constants.O_RDWR | noFollow);
        const raw = await readBoundedJournalHandle(handle, control, true);
        const scanned = scanJournal(raw, control);
        if (!scanned.ok) throw scanned.error;
        const removedBytes = raw.length - scanned.value.verifiedBytes;
        if (removedBytes > 0) {
          control.checkpoint?.();
          await handle.truncate(scanned.value.verifiedBytes);
          control.checkpoint?.();
          await handle.sync();
          control.checkpoint?.();
        }
        const prefix = raw.subarray(0, scanned.value.verifiedBytes);
        return {
          events: scanned.value.events,
          eventPositions: scanned.value.eventPositions,
          verifiedBytes: scanned.value.verifiedBytes,
          prefixSha256: sha256Raw(prefix),
          verifiedPrefix: Buffer.from(prefix),
          removedBytes,
        };
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        if (handle) {
          try { await handle.close(); }
          catch (cleanup) {
            if (primary !== undefined)
              throw new AggregateError([primary, cleanup], "journal repair and handle close both failed");
            throw cleanup;
          }
        }
      }
    });
  }

  private enqueueControl<T>(effect: () => Promise<T>): Promise<T> {
    const owned = (): Promise<T> => this.fileSystem.runTransaction?.(effect) ?? effect();
    const queued = this.queue.then(owned, owned);
    this.queue = queued;
    return queued;
  }

  private enqueue(batch: readonly RlmEvent[], batched: boolean): Promise<JournalBatchAppendOutcome> {
    const run = async (): Promise<JournalBatchAppendOutcome> => {
      let eventDurable = false;
      let finalEvents: RlmEvent[] = [];
      let refreshStatus = true;
      let dispositions: JournalAppendDisposition[] = [];
      let handle: JournalFileHandle | undefined;
      let failure: JournalAppendError | undefined;

      try {
        handle = await this.fileSystem.open(
          this.eventsPath,
          constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | noFollow,
          0o600,
        );
        let raw = await readBoundedJournalHandle(handle);
        let scanned = scanJournal(raw);
        if (!scanned.ok) throw scanned.error;
        if (scanned.value.verifiedBytes !== raw.length) {
          await handle.truncate(scanned.value.verifiedBytes);
          await handle.sync();
          raw = raw.subarray(0, scanned.value.verifiedBytes);
          scanned = scanJournal(raw);
          if (!scanned.ok) throw scanned.error;
        }
        const baseBytes = scanned.value.verifiedBytes;
        const existingEvents = scanned.value.events;
        finalEvents = existingEvents;

        let terminalSeen = existingEvents.some(isTerminal);
        const progressIdentities = existingEvents.filter(isProgress);
        const accepted: RlmEvent[] = [];
        const acceptedIndexes: number[] = [];
        dispositions = batch.map(() => "ignored_after_terminal");
        let exactReplay = false;

        if (!terminalSeen && batched) {
          const terminalIndex = batch.findIndex(isTerminal);
          const candidate = terminalIndex < 0 ? batch : batch.slice(0, terminalIndex + 1);
          const candidateId = makeBatchRecord(candidate).batchId;
          if (scanned.value.batchIds.has(candidateId)) {
            dispositions = batch.map((_event, index) =>
              terminalIndex >= 0 && index > terminalIndex ? "ignored_after_terminal" : "deduplicated");
            refreshStatus = false;
            exactReplay = true;
          }
        }

        if (exactReplay) {
          // Exact batch replay: no physical append and no cache-derived inference.
        } else if (terminalSeen) {
          refreshStatus = batch.some(isTerminal);
        } else {
          for (let index = 0; index < batch.length; index++) {
            const event = batch[index] as RlmEvent;
            if (terminalSeen) continue;
            if (isProgress(event) && progressIdentities.some((existing) => sameProgressIdentity(existing, event))) {
              dispositions[index] = "deduplicated";
              continue;
            }
            dispositions[index] = "committed";
            accepted.push(event);
            acceptedIndexes.push(index);
            if (isProgress(event)) progressIdentities.push(event);
            if (isTerminal(event)) terminalSeen = true;
          }

          refreshStatus = accepted.length > 0 || batch.some(isTerminal);
          if (accepted.length > 0) {
            if (batched && !validBatchSemantics(accepted))
              throw new JournalAppendError("event", false, interpreterError("JOURNAL_CORRUPT", "invalid deduplicated journal batch"));
            const record = batched ? makeBatchRecord(accepted) : accepted[0] as RlmEvent;
            if (batched && scanned.value.batchIds.has((record as JournalBatchRecord).batchId)) {
              for (const index of acceptedIndexes) dispositions[index] = "deduplicated";
              refreshStatus = false;
            } else {
              const line = recordLine(record);
              if (Buffer.byteLength(line, "utf8") > MAX_JOURNAL_AUTHORITY_BYTES - baseBytes)
                throw interpreterError("JOURNAL_CORRUPT", "journal append exceeds the authority byte limit");
              try {
                await handle.appendFile(line, "utf8");
              } catch (cause) {
                eventDurable = await this.reconcileRejectedAppend(handle, baseBytes, line, batched
                  ? (record as JournalBatchRecord).batchId
                  : undefined);
                throw new JournalAppendError("event", eventDurable, cause);
              }
              try {
                await handle.sync();
                eventDurable = true;
              } catch (cause) {
                eventDurable = await this.reconcileRejectedAppend(handle, baseBytes, line, batched
                  ? (record as JournalBatchRecord).batchId
                  : undefined);
                throw new JournalAppendError("event", eventDurable, cause);
              }
              finalEvents = [...existingEvents, ...accepted];
            }
          }
        }
      } catch (cause) {
        failure = cause instanceof JournalAppendError
          ? cause
          : new JournalAppendError("event", eventDurable, cause);
      }

      if (handle) {
        try {
          await handle.close();
        } catch (cause) {
          failure ??= new JournalAppendError("event", eventDurable, cause);
        }
      }
      if (failure) throw failure;

      if (!refreshStatus) return { events: dispositions, statusCache: { state: "skipped" } };
      try {
        await this.writeStatus(reduceStatus(finalEvents));
        return { events: dispositions, statusCache: { state: "refreshed" } };
      } catch (cause) {
        const error = new JournalAppendError("status_cache", eventDurable, cause);
        this.cacheFailures.push(error);
        return { events: dispositions, statusCache: { state: "failed", error } };
      }
    };
    const ownedRun = (): Promise<JournalBatchAppendOutcome> =>
      this.fileSystem.runTransaction?.(run) ?? run();
    const queued = this.queue.then(ownedRun, ownedRun);
    this.queue = queued;
    return queued;
  }

  private async reconcileRejectedAppend(
    handle: JournalFileHandle,
    baseBytes: number,
    line: string,
    expectedBatchId?: string,
  ): Promise<boolean> {
    const raw = await readBoundedJournalHandle(handle);
    if (raw.length > MAX_JOURNAL_AUTHORITY_BYTES)
      throw interpreterError("JOURNAL_CORRUPT", "journal exceeds its authority byte limit");
    const expected = Buffer.from(line, "utf8");
    const suffix = raw.subarray(baseBytes);
    const exactBytes = suffix.length === expected.length && suffix.equals(expected);
    const scanned = exactBytes ? scanJournal(raw) : undefined;
    const exactRecord = exactBytes && scanned?.ok === true && scanned.value.verifiedBytes === raw.length
      && (expectedBatchId === undefined || scanned.value.batchIds.has(expectedBatchId));
    if (exactRecord) {
      await handle.sync();
      return true;
    }
    await handle.truncate(baseBytes);
    await handle.sync();
    return false;
  }

  statusCacheFailures(): readonly JournalAppendError[] {
    return this.cacheFailures;
  }

  private async readEventsInternal(): Promise<Result<RlmEvent[], InterpreterError>> {
    const read = async (): Promise<Result<RlmEvent[], InterpreterError>> => {
      let handle: JournalFileHandle;
      try { handle = await this.fileSystem.open(this.eventsPath, constants.O_RDONLY | noFollow); }
      catch (error) {
        if (isMissing(error)) return ok([]);
        throw error;
      }
      let raw: Buffer;
      try { raw = await readBoundedJournalHandle(handle); }
      finally { await handle.close(); }
      const scanned = scanJournal(raw);
      return scanned.ok ? ok(scanned.value.events) : scanned;
    };
    return this.fileSystem.runTransaction?.(read) ?? read();
  }

  async readEvents(): Promise<Result<RlmEvent[], InterpreterError>> {
    return this.readEventsInternal();
  }

  private async writeStatus(status: RunStatus): Promise<void> {
    const tmp = `${this.statusPath}.tmp`;
    const handle = await this.fileSystem.open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(status, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.fileSystem.rename(tmp, this.statusPath);

    const directory = await this.fileSystem.open(this.dir, constants.O_RDONLY | directoryFlag | noFollow);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async status(): Promise<Result<RunStatus, InterpreterError>> {
    const events = await this.readEventsInternal();
    return events.ok ? ok(reduceStatus(events.value)) : events;
  }

  async drain(): Promise<void> {
    await this.queue;
  }
}
