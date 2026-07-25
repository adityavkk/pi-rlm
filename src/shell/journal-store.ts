/**
 * Durable event journal (imperative shell).
 *
 * `events.jsonl` is append-only and authoritative. Logical batches are one
 * canonical, checksummed JSONL record, so no prefix of a cell commit can be
 * read as authoritative. Legacy single-event records remain readable.
 */

import { createHash } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { interpreterError, type InterpreterError } from "../core/errors.ts";
import { type JsonValue, canonicalStringify, isJsonObject } from "../core/json.ts";
import { reduceStatus, type RlmEvent, type RunStatus } from "../core/journal.ts";
import { err, ok, type Result } from "../core/result.ts";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const lineHash = (line: string): string => sha256(line).slice(0, 12);
const BATCH_RECORD_TYPE = "journal_batch";

export interface JournalFileHandle {
  appendFile(data: string, encoding: BufferEncoding): Promise<void>;
  close(): Promise<void>;
  readFile(): Promise<Buffer>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
}

export interface JournalFileSystem {
  open(path: string, flags: string): Promise<JournalFileHandle>;
  readFile(path: string): Promise<Buffer>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

const nodeFileSystem: JournalFileSystem = {
  open: async (path, flags) => open(path, flags),
  readFile: async (path) => readFile(path),
  rename,
};

interface JournalBatchRecord {
  readonly type: typeof BATCH_RECORD_TYPE;
  readonly batchId: string;
  readonly checksum: string;
  readonly events: readonly RlmEvent[];
}

const makeBatchRecord = (events: readonly RlmEvent[]): JournalBatchRecord => {
  const checksum = sha256(canonicalStringify(events as unknown as JsonValue));
  return { type: BATCH_RECORD_TYPE, batchId: `batch_${checksum}`, checksum, events };
};

const recordLine = (record: RlmEvent | JournalBatchRecord): string =>
  `${canonicalStringify(record as unknown as JsonValue)}\n`;

interface JournalScan {
  readonly events: RlmEvent[];
  readonly verifiedBytes: number;
  readonly batchIds: ReadonlySet<string>;
}

const corruptLine = (lineNumber: number, line: string): InterpreterError =>
  interpreterError("JOURNAL_CORRUPT", `corrupt journal line ${lineNumber} (${lineHash(line)})`);

const scanJournal = (raw: Uint8Array): Result<JournalScan, InterpreterError> => {
  const verifiedBytes = raw.length === 0 || raw[raw.length - 1] === 0x0a
    ? raw.length
    : raw.lastIndexOf(0x0a) + 1;
  const events: RlmEvent[] = [];
  const batchIds = new Set<string>();
  let lineStart = 0;
  let lineNumber = 0;

  for (let i = 0; i < verifiedBytes; i++) {
    if (raw[i] !== 0x0a) continue;
    const line = Buffer.from(raw.subarray(lineStart, i)).toString("utf8");
    if (line.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return err(corruptLine(lineNumber, line));
      }
      if (isJsonObject(parsed) && parsed["type"] === BATCH_RECORD_TYPE) {
        const batchEvents = parsed["events"];
        if (!Array.isArray(batchEvents)) return err(corruptLine(lineNumber, line));
        const expected = makeBatchRecord(batchEvents as RlmEvent[]);
        if (parsed["batchId"] !== expected.batchId || parsed["checksum"] !== expected.checksum)
          return err(corruptLine(lineNumber, line));
        if (!batchIds.has(expected.batchId)) events.push(...expected.events);
        batchIds.add(expected.batchId);
      } else {
        events.push(parsed as RlmEvent);
      }
    }
    lineStart = i + 1;
    lineNumber++;
  }

  return ok({ events, verifiedBytes, batchIds });
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

export class JournalStore {
  private readonly eventsPath: string;
  private readonly statusPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cacheFailures: JournalAppendError[] = [];

  constructor(
    private readonly dir: string,
    private readonly fileSystem: JournalFileSystem = nodeFileSystem,
  ) {
    this.eventsPath = join(dir, "events.jsonl");
    this.statusPath = join(dir, "status.json");
  }

  append(event: RlmEvent): Promise<JournalAppendOutcome> {
    return this.enqueue([event], false).then((outcome) => ({
      event: outcome.events[0] as JournalAppendDisposition,
      statusCache: outcome.statusCache,
    }));
  }

  /** Append one logical batch as exactly one canonical, checksummed JSONL record. */
  appendBatch(batch: readonly RlmEvent[]): Promise<JournalBatchAppendOutcome> {
    if (batch.length === 0) throw new RangeError("journal batch must contain at least one event");
    return this.enqueue(batch, true);
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
        handle = await this.fileSystem.open(this.eventsPath, "a+");
        let raw = await handle.readFile();
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
            const record = batched ? makeBatchRecord(accepted) : accepted[0] as RlmEvent;
            if (batched && scanned.value.batchIds.has((record as JournalBatchRecord).batchId)) {
              for (const index of acceptedIndexes) dispositions[index] = "deduplicated";
              refreshStatus = false;
            } else {
              const line = recordLine(record);
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
    const queued = this.queue.then(run, run);
    this.queue = queued;
    return queued;
  }

  private async reconcileRejectedAppend(
    handle: JournalFileHandle,
    baseBytes: number,
    line: string,
    expectedBatchId?: string,
  ): Promise<boolean> {
    const raw = await this.fileSystem.readFile(this.eventsPath);
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
    let raw: Buffer;
    try {
      raw = await this.fileSystem.readFile(this.eventsPath);
    } catch (error) {
      if (isMissing(error)) return ok([]);
      throw error;
    }
    const scanned = scanJournal(raw);
    return scanned.ok ? ok(scanned.value.events) : scanned;
  }

  async readEvents(): Promise<Result<RlmEvent[], InterpreterError>> {
    return this.readEventsInternal();
  }

  private async writeStatus(status: RunStatus): Promise<void> {
    const tmp = `${this.statusPath}.tmp`;
    const handle = await this.fileSystem.open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(status, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.fileSystem.rename(tmp, this.statusPath);

    const directory = await this.fileSystem.open(this.dir, "r");
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
