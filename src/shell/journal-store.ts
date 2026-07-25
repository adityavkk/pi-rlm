/**
 * Durable event journal (imperative shell).
 *
 * `events.jsonl` is append-only and authoritative; each append is flushed with
 * fsync. Before appending, an unterminated tail is removed back to the last
 * verified newline and the repair is fsynced. `status.json` is a rebuildable
 * cache written atomically via a synced temp file, rename, and directory fsync.
 */

import { createHash } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { interpreterError, type InterpreterError } from "../core/errors.ts";
import { reduceStatus, type RlmEvent, type RunStatus } from "../core/journal.ts";
import { err, ok, type Result } from "../core/result.ts";

const lineHash = (line: string): string => createHash("sha256").update(line).digest("hex").slice(0, 12);

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

interface JournalScan {
  readonly events: RlmEvent[];
  readonly verifiedBytes: number;
}

const scanJournal = (raw: Uint8Array): Result<JournalScan, InterpreterError> => {
  const verifiedBytes = raw.length === 0 || raw[raw.length - 1] === 0x0a
    ? raw.length
    : raw.lastIndexOf(0x0a) + 1;
  const events: RlmEvent[] = [];
  let lineStart = 0;
  let lineNumber = 0;

  for (let i = 0; i < verifiedBytes; i++) {
    if (raw[i] !== 0x0a) continue;
    const line = Buffer.from(raw.subarray(lineStart, i)).toString("utf8");
    if (line.length > 0) {
      try {
        events.push(JSON.parse(line) as RlmEvent);
      } catch {
        return err(interpreterError("JOURNAL_CORRUPT", `corrupt journal line ${lineNumber} (${lineHash(line)})`));
      }
    }
    lineStart = i + 1;
    lineNumber++;
  }

  return ok({ events, verifiedBytes });
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isTerminal = (event: RlmEvent): boolean =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled";

export type JournalAppendPhase = "event" | "status_cache";

/** Distinguishes authoritative event failures from rebuildable cache failures. */
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

export interface JournalAppendOutcome {
  readonly event: "committed" | "ignored_after_terminal";
  readonly statusCache:
    | { readonly state: "refreshed" }
    | { readonly state: "skipped" }
    | { readonly state: "failed"; readonly error: JournalAppendError };
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

  /** Repair any torn tail, append one event durably, then refresh status. Serialized. */
  append(event: RlmEvent): Promise<JournalAppendOutcome> {
    const run = async (): Promise<JournalAppendOutcome> => {
      const line = `${JSON.stringify(event)}\n`;
      let eventDurable = false;
      let disposition: JournalAppendOutcome["event"] = "committed";
      let finalEvents: RlmEvent[] = [];
      let refreshStatus = true;
      let handle: JournalFileHandle | undefined;
      try {
        handle = await this.fileSystem.open(this.eventsPath, "a+");
        const raw = await handle.readFile();
        const scanned = scanJournal(raw);
        if (!scanned.ok) throw scanned.error;
        const events = scanned.value.events;
        if (scanned.value.verifiedBytes !== raw.length) {
          await handle.truncate(scanned.value.verifiedBytes);
          await handle.sync();
        }
        // The first run terminal is authoritative. This also drops callbacks
        // that were queued after finalization without creating late events.
        if (events.some(isTerminal)) {
          disposition = "ignored_after_terminal";
          finalEvents = events;
          refreshStatus = isTerminal(event);
        } else {
          await handle.appendFile(line, "utf8");
          await handle.sync();
          eventDurable = true;
          finalEvents = [...events, event];
        }
      } catch (error) {
        throw error instanceof JournalAppendError
          ? error
          : new JournalAppendError("event", eventDurable, error);
      } finally {
        if (handle) {
          try {
            await handle.close();
          } catch (error) {
            throw new JournalAppendError("event", eventDurable, error);
          }
        }
      }

      if (!refreshStatus) return { event: disposition, statusCache: { state: "skipped" } };
      try {
        await this.writeStatus(reduceStatus(finalEvents));
        return { event: disposition, statusCache: { state: "refreshed" } };
      } catch (cause) {
        const error = new JournalAppendError("status_cache", eventDurable, cause);
        this.cacheFailures.push(error);
        return { event: disposition, statusCache: { state: "failed", error } };
      }
    };
    const queued = this.queue.then(run, run);
    this.queue = queued;
    return queued;
  }

  /** Cache refresh failures observed by append callers and retained for run diagnostics. */
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

  /** Await all queued appends. */
  async drain(): Promise<void> {
    await this.queue;
  }
}
