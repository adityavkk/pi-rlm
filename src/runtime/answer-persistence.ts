/** Shared transaction path for direct and fallback answer snapshots. */

import type { RlmEvent } from "../core/journal.ts";
import type { JsonValue } from "../core/json.ts";
import type { ContextDescriptor, ContextStoreTransaction } from "../shell/context-store.ts";
import { JournalAppendError } from "../shell/journal-store.ts";
import { throwIfAborted } from "./abort.ts";
import { contextControl } from "./broker.ts";
import type { RunState } from "./state.ts";

/**
 * Reserve and stage the answer first, then make its journal reference
 * authoritative. A non-durable journal failure or cancellation rolls the
 * context file, entry, and ledger reservation back together.
 */
export const persistWorkspace = async (
  state: RunState,
  frameId: string,
  iteration: number,
  workspace: JsonValue,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<ContextDescriptor> => {
  throwIfAborted(signal);
  const release = await state.contextSemaphore.acquire(signal);
  if (!release) {
    throwIfAborted(signal);
    throw new Error("workspace persistence lock unavailable");
  }

  let transaction: ContextStoreTransaction<ContextDescriptor> | undefined;
  let referenced = false;
  try {
    transaction = await state.store.beginDerive(
      { key: `workspace:${frameId}:${iteration}`, value: workspace, label: `workspace:${frameId}:${iteration}` },
      contextControl(state, deadlineMs, signal, true),
    );
    throwIfAborted(signal);
    const descriptor = transaction.value;
    try {
      const outcome = await state.journal.append({
        type: "workspace_committed",
        frameId,
        iteration,
        workspaceRef: descriptor.id,
        workspaceSha256: descriptor.sha256,
        workspaceBytes: descriptor.bytes,
      });
      if (outcome.event !== "committed") throw new Error("workspace journal event ignored after terminal");
      referenced = true;
    } catch (error) {
      if (error instanceof JournalAppendError && error.eventDurable) referenced = true;
      throw error;
    }
    transaction.commit();
    transaction = undefined;
    return descriptor;
  } catch (error) {
    if (transaction) {
      if (referenced) transaction.commit();
      else await transaction.rollback();
    }
    throw error;
  } finally {
    release();
  }
};

export const persistAnswer = async (
  state: RunState,
  key: string,
  value: JsonValue,
  events: (outputRef: string, outputBytes: number, outputSha256: string) => readonly RlmEvent[],
  deadlineMs: number,
  signal: AbortSignal,
): Promise<ContextDescriptor> => {
  throwIfAborted(signal);
  const release = await state.contextSemaphore.acquire(signal);
  if (!release) {
    throwIfAborted(signal);
    throw new Error("answer persistence lock unavailable");
  }

  let transaction: ContextStoreTransaction<ContextDescriptor> | undefined;
  let referenced = false;
  try {
    transaction = await state.store.beginDerive(
      { key, value },
      contextControl(state, deadlineMs, signal, true),
    );
    throwIfAborted(signal);
    const descriptor = transaction.value;
    const journalEvents = events(descriptor.id, descriptor.bytes, descriptor.sha256);
    if (journalEvents.length === 0) throw new Error("answer persistence requires a journal reference");
    for (const event of journalEvents) {
      throwIfAborted(signal);
      try {
        const outcome = await state.journal.append(event);
        if (outcome.event === "ignored_after_terminal") throw new Error("answer journal event ignored after terminal");
        if (outcome.event === "committed" && "outputRef" in event && event.outputRef === descriptor.id) referenced = true;
      } catch (error) {
        if (error instanceof JournalAppendError && error.eventDurable && "outputRef" in event && event.outputRef === descriptor.id)
          referenced = true;
        throw error;
      }
    }
    transaction.commit();
    transaction = undefined;
    return descriptor;
  } catch (error) {
    if (transaction) {
      if (referenced) transaction.commit();
      else await transaction.rollback();
    }
    throw error;
  } finally {
    release();
  }
};
