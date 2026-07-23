/**
 * Durable event journal (imperative shell).
 *
 * `events.jsonl` is append-only and authoritative; each append is flushed with
 * fsync. `status.json` is a rebuildable cache written atomically via a temp file
 * and rename. A partially written final line (torn append on crash) is dropped
 * on read; a malformed interior line is treated as corruption.
 */

import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { interpreterError, type InterpreterError } from "../core/errors.ts";
import { reduceStatus, type RlmEvent, type RunStatus } from "../core/journal.ts";
import { err, ok, type Result } from "../core/result.ts";

const lineHash = (line: string): string => createHash("sha256").update(line).digest("hex").slice(0, 12);

export class JournalStore {
  private readonly eventsPath: string;
  private readonly statusPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.eventsPath = join(dir, "events.jsonl");
    this.statusPath = join(dir, "status.json");
  }

  /** Append one event durably, then refresh the status cache. Serialized. */
  append(event: RlmEvent): Promise<void> {
    const run = async (): Promise<void> => {
      const line = `${JSON.stringify(event)}\n`;
      const handle = await open(this.eventsPath, "a");
      try {
        await handle.appendFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const events = await this.readEventsInternal();
      if (events.ok) await this.writeStatus(reduceStatus(events.value));
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private async readEventsInternal(): Promise<Result<RlmEvent[], InterpreterError>> {
    let raw: string;
    try {
      raw = await readFile(this.eventsPath, "utf8");
    } catch {
      return ok([]);
    }
    if (raw.length === 0) return ok([]);
    const lines = raw.split("\n");
    // A trailing newline yields a final empty element; a torn append yields a
    // non-empty final element that may not parse. Both are tolerated.
    const trailingComplete = raw.endsWith("\n");
    const events: RlmEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.length === 0) continue;
      const isFinal = i === lines.length - 1;
      try {
        events.push(JSON.parse(line) as RlmEvent);
      } catch {
        if (isFinal && !trailingComplete) break; // torn last append: drop and recover
        return err(interpreterError("JOURNAL_CORRUPT", `corrupt journal line ${i} (${lineHash(line)})`));
      }
    }
    return ok(events);
  }

  async readEvents(): Promise<Result<RlmEvent[], InterpreterError>> {
    return this.readEventsInternal();
  }

  private async writeStatus(status: RunStatus): Promise<void> {
    const tmp = `${this.statusPath}.tmp`;
    await writeFile(tmp, JSON.stringify(status, null, 2), "utf8");
    await rename(tmp, this.statusPath);
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
