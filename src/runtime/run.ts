/** Top-level run orchestration and exactly-once durable finalization. */

import { createLedger, type Ledger } from "../core/budget.ts";
import { identityHash } from "../core/ids.ts";
import type { FrameState, RlmEvent } from "../core/journal.ts";
import type { JsonValue } from "../core/json.ts";
import { programIdentity, type RlmProgram } from "../core/program.ts";
import {
  ContextBudgetError,
  type ContextDescriptor,
  type ContextOperationControl,
  ContextStore,
} from "../shell/context-store.ts";
import { type Clock, systemClock } from "../shell/clock.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalAppendError, JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import { createAbortScope, throwIfAborted, waitForAbort, wasAborted, type AbortScope } from "./abort.ts";
import { persistAnswer } from "./answer-persistence.ts";
import type { ControllerDriver } from "./controller.ts";
import {
  buildExtractorModelRequest,
  normalizeExtractorResult,
  validateExtractorProvenance,
  type Extractor,
} from "./extractor.ts";
import {
  buildExtractorEvidence,
  ExtractorEvidenceDeadlineError,
  extractorEvidenceIdentity,
} from "./extractor-evidence.ts";
import { runFrame } from "./frame.ts";
import { outputContractErrorMessage, validateOutputContract } from "./output-validation.ts";
import { createModelOperation, ModelInvocationError } from "./provider.ts";
import { contextStoreLimits, DEFAULT_PROFILE, type Profile, resolveLimits } from "./profile.ts";
import { Semaphore } from "./semaphore.ts";
import type { FrameRef, RunState } from "./state.ts";
import { remainingStoredBytes, reserveStoredBytes } from "./stored-bytes.ts";

export const RLM_DSL_VERSION = "0.1.0";

export interface RunInput {
  readonly program: RlmProgram;
  readonly sources: Readonly<Record<string, string>>;
  readonly controller: ControllerDriver;
  readonly model: ModelClient;
  readonly backend: InterpreterBackend;
  readonly dir: string;
  /** Required owner cancellation for this run only. */
  readonly signal: AbortSignal;
  readonly clock?: Clock;
  readonly profile?: Profile;
  readonly extractor?: Extractor;
  /** Optional store injection for fault testing and embedded runtimes. */
  readonly journal?: JournalStore;
}

export interface RunError {
  readonly code: string;
  readonly message: string;
  /** Non-secret classification of the original exception. */
  readonly cause?: { readonly name: string; readonly code?: string };
}

export interface RunWarning {
  readonly code: "STATUS_CACHE_REFRESH_FAILED" | "JOURNAL_APPEND_CLEANUP_FAILED";
  readonly message: string;
  readonly cause?: RunError["cause"];
}

export interface RunResult {
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly completionMode?: "answer" | "fallback_extract";
  readonly answer?: JsonValue;
  readonly error?: RunError;
  readonly warnings?: readonly RunWarning[];
  readonly ledger: Ledger;
}

type Phase = "journal" | "source" | "controller" | "extractor" | "context";
type PlannedResult = Omit<RunResult, "ledger">;

const safeCause = (error: unknown): RunError["cause"] => {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { name?: unknown; code?: unknown };
  const name = typeof candidate.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate.name)
    ? candidate.name
    : "Error";
  const code = typeof candidate.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(candidate.code)
    ? candidate.code
    : undefined;
  return { name, ...(code ? { code } : {}) };
};

const failure = (runId: string, code: string, message: string, cause?: unknown): PlannedResult => ({
  runId,
  status: "failed",
  error: {
    code,
    message,
    ...(() => { const classified = safeCause(cause); return classified ? { cause: classified } : {}; })(),
  },
});

const cancellation = (runId: string): PlannedResult => ({
  runId,
  status: "cancelled",
  error: { code: "CANCELLED", message: "run cancelled by owner" },
});

const exceptionResult = (
  runId: string,
  phase: Phase,
  error: unknown,
  scope: AbortScope,
): PlannedResult => {
  if (wasAborted(error, scope.signal)) {
    return scope.timedOut
      ? failure(runId, "BUDGET_DEADLINE", "run deadline reached")
      : cancellation(runId);
  }
  if (error instanceof ModelInvocationError)
    return failure(runId, error.callError.code, error.callError.message, error);
  if (error instanceof ExtractorEvidenceDeadlineError)
    return failure(runId, error.code, error.message, error);
  if (error instanceof ContextBudgetError)
    return failure(runId, "BUDGET_BYTES", "stored byte limit reached", error);
  if (error instanceof JournalAppendError)
    return failure(runId, "JOURNAL_FAILED", "failed to persist run journal", error);
  const code = phase === "journal"
    ? "JOURNAL_FAILED"
    : phase === "source"
      ? "SOURCE_FAILED"
      : phase === "extractor"
        ? "EXTRACTOR_FAILED"
        : phase === "context"
          ? "CONTEXT_FAILED"
          : "CONTROLLER_FAILED";
  const message = phase === "journal"
    ? "failed to persist run journal"
    : phase === "source"
      ? "failed to snapshot run inputs"
      : phase === "extractor"
        ? "fallback extraction failed"
        : phase === "context"
          ? "failed to commit run context"
          : "controller execution failed";
  return failure(runId, code, message, error);
};

const terminalEvent = (result: PlannedResult): RlmEvent => {
  if (result.status === "completed") {
    return {
      type: "run_completed",
      runId: result.runId,
      completionMode: result.completionMode!,
    };
  }
  if (result.status === "cancelled") {
    return { type: "run_cancelled", runId: result.runId, code: "CANCELLED", message: "run cancelled by owner" };
  }
  return {
    type: "run_failed",
    runId: result.runId,
    code: result.error?.code ?? "FAILED",
    message: result.error?.message ?? "run failed",
  };
};

type TerminalEvent = Extract<RlmEvent, { type: "run_completed" | "run_failed" | "run_cancelled" }>;

const isTerminalEvent = (event: RlmEvent): event is TerminalEvent =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled";

const resultFromTerminal = (event: TerminalEvent, initial: PlannedResult): PlannedResult => {
  if (event.type === "run_completed") {
    return {
      runId: event.runId,
      status: "completed",
      completionMode: event.completionMode,
      ...(initial.status === "completed" && initial.completionMode === event.completionMode && initial.answer !== undefined
        ? { answer: initial.answer }
        : {}),
    };
  }
  if (event.type === "run_cancelled") {
    return {
      runId: event.runId,
      status: "cancelled",
      error: { code: event.code, message: event.message },
    };
  }
  const matchingCause = initial.status === "failed" &&
    initial.error?.code === event.code && initial.error.message === event.message
    ? initial.error.cause
    : undefined;
  return failure(event.runId, event.code, event.message, matchingCause);
};

/** Close every successfully opened frame, then append the sole run terminal. */
const finalize = async (
  journal: JournalStore,
  rootFrameId: string,
  initial: PlannedResult,
  ledgerRef: { current: Ledger },
): Promise<RunResult> => {
  let planned = initial;
  const durableAppendFailures: JournalAppendError[] = [];
  const observeDurableFailure = (error: unknown): boolean => {
    if (!(error instanceof JournalAppendError) || !error.eventDurable) return false;
    if (!durableAppendFailures.includes(error)) durableAppendFailures.push(error);
    return true;
  };
  const appendDurably = async (event: RlmEvent): Promise<void> => {
    try {
      await journal.append(event);
    } catch (error) {
      if (!observeDurableFailure(error)) throw error;
    }
  };
  const finish = (result: PlannedResult): RunResult => {
    const warnings: RunWarning[] = [];
    if (journal.statusCacheFailures().length > 0) {
      const cause = safeCause(journal.statusCacheFailures()[0]?.cause);
      warnings.push({
        code: "STATUS_CACHE_REFRESH_FAILED",
        message: "journal status cache refresh failed; authoritative status remains available from events",
        ...(cause ? { cause } : {}),
      });
    }
    if (durableAppendFailures.length > 0) {
      const cause = safeCause(durableAppendFailures[0]?.cause);
      warnings.push({
        code: "JOURNAL_APPEND_CLEANUP_FAILED",
        message: "journal event was durable but append cleanup failed",
        ...(cause ? { cause } : {}),
      });
    }
    return { ...result, ...(warnings.length > 0 ? { warnings } : {}), ledger: ledgerRef.current };
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let drainFailure: unknown;
      try {
        await journal.drain();
      } catch (error) {
        drainFailure = error;
      }
      const scanned = await journal.readEvents();
      if (!scanned.ok) throw scanned.error;
      const existingTerminal = scanned.value.find(isTerminalEvent);
      if (existingTerminal) return finish(resultFromTerminal(existingTerminal, initial));
      if (drainFailure !== undefined && !observeDurableFailure(drainFailure)) {
        planned = failure(initial.runId, "JOURNAL_FAILED", "failed to finalize run journal", drainFailure);
      }

      const openOrder: string[] = [];
      const open = new Set<string>();
      for (const event of scanned.value) {
        if (event.type === "frame_opened" && !open.has(event.frameId)) {
          open.add(event.frameId);
          openOrder.push(event.frameId);
        } else if (event.type === "frame_closed") {
          open.delete(event.frameId);
        }
      }
      for (const frameId of openOrder.reverse()) {
        if (!open.has(frameId)) continue;
        const state: FrameState = planned.status === "cancelled"
          ? "cancelled"
          : planned.status === "failed"
            ? "failed"
            : frameId === rootFrameId
              ? "answered"
              : "closed";
        await appendDurably({ type: "frame_closed", frameId, state });
      }
      const event = terminalEvent(planned);
      if (event.type === "run_completed" && planned.completionMode === "fallback_extract") {
        const events = await journal.readEvents();
        if (events.ok) {
          const answer = [...events.value].reverse().find((candidate) => candidate.type === "answer_committed");
          await appendDurably(answer?.type === "answer_committed" ? { ...event, outputRef: answer.outputRef } : event);
        } else await appendDurably(event);
      } else await appendDurably(event);

      const finalized = await journal.readEvents();
      if (!finalized.ok) throw finalized.error;
      const committedTerminal = finalized.value.find(isTerminalEvent);
      if (committedTerminal) return finish(resultFromTerminal(committedTerminal, initial));
      throw new Error("terminal event was not committed");
    } catch (error) {
      try {
        const rescued = await journal.readEvents();
        const committedTerminal = rescued.ok ? rescued.value.find(isTerminalEvent) : undefined;
        if (committedTerminal) return finish(resultFromTerminal(committedTerminal, initial));
      } catch {
        // Preserve the original finalization failure classification.
      }
      planned = failure(initial.runId, "JOURNAL_FAILED", "failed to finalize run journal", error);
    }
  }
  return finish(planned);
};

export const runProgram = async (input: RunInput): Promise<RunResult> => {
  const clock = input.clock ?? systemClock;
  const profile = input.profile ?? DEFAULT_PROFILE;
  const startMs = clock.now();
  const limits = resolveLimits(profile, startMs);
  const ledgerRef = { current: createLedger(limits) };
  const runId = `run_${sha256(`${startMs}:${input.program.objective}:${identityHash(sha256, programIdentity(input.program))}`).slice(0, 16)}`;
  const rootFrameId = `${runId}:f0`;
  const journal = input.journal ?? new JournalStore(input.dir);
  const store = new ContextStore(input.dir, contextStoreLimits(profile));
  const scope = createAbortScope(input.signal, limits.deadlineMs, () => clock.now());
  let phase: Phase = "journal";
  let planned: PlannedResult | undefined;

  const sourceControl = (): ContextOperationControl => ({
    checkpoint: () => {
      throwIfAborted(scope.signal);
      if (clock.now() >= limits.deadlineMs) throw new Error("run deadline reached");
    },
    maxOutputBytes: remainingStoredBytes(ledgerRef.current),
    reserveBytes: (bytes) => {
      throwIfAborted(scope.signal);
      const reserved = reserveStoredBytes(ledgerRef, bytes);
      if (!reserved.ok) throw new ContextBudgetError(reserved.error.message);
      return reserved.value;
    },
  });

  try {
    const manifestHash = sha256(JSON.stringify({
      program: programIdentity(input.program),
      profile: profile.name,
      dsl: RLM_DSL_VERSION,
      backend: input.backend.id,
      extractorEvidence: extractorEvidenceIdentity(profile),
    }));
    phase = "source";
    const sourceTransaction = await store.beginIngestTexts(
      input.program.inputs.map((declared) => ({
        label: declared.name,
        text: input.sources[declared.name] ?? "",
        mimeType: "text/plain",
      })),
      sourceControl(),
    );
    let sourceDurable = false;
    try {
      throwIfAborted(scope.signal);
      phase = "journal";
      try {
        const outcome = await journal.append({
          type: "run_started",
          runId,
          manifestHash,
          limits,
          inputRefs: sourceTransaction.value.map((descriptor) => ({
            name: descriptor.label,
            id: descriptor.id,
            sha256: descriptor.sha256,
            bytes: descriptor.bytes,
          })),
        });
        sourceDurable = outcome.event === "committed";
      } catch (error) {
        sourceDurable = error instanceof JournalAppendError && error.eventDurable;
        throw error;
      }
      if (!sourceDurable) throw new Error("run start ignored after terminal");
      sourceTransaction.commit();
    } catch (error) {
      if (sourceDurable) sourceTransaction.commit();
      else await sourceTransaction.rollback();
      throw error;
    }
    throwIfAborted(scope.signal);

    const inputs: Record<string, ContextDescriptor> = {};
    input.program.inputs.forEach((declared, index) => {
      inputs[declared.name] = sourceTransaction.value[index] as ContextDescriptor;
    });

    phase = "journal";
    await journal.append({
      type: "frame_opened",
      frameId: rootFrameId,
      parentFrameId: null,
      depth: 0,
      objective: input.program.objective,
    });
    throwIfAborted(scope.signal);

    const state: RunState = {
      runId,
      startMs,
      profile,
      clock,
      hasher: sha256,
      program: input.program,
      ledger: ledgerRef,
      store,
      artifacts: new Map(),
      model: input.model,
      journal,
      backend: input.backend,
      callCache: new Map(),
      inflight: new Map(),
      keyIdentities: new Map(),
      scopeUsage: new Map(),
      semaphore: new Semaphore(profile.maxConcurrency),
      contextSemaphore: new Semaphore(1),
      frameSeq: { current: 1 },
    };
    const rootFrame: FrameRef = {
      frameId: rootFrameId,
      lineage: rootFrameId,
      depth: 0,
      objective: input.program.objective,
      inputs,
      outputs: input.program.outputs,
    };

    phase = "controller";
    const result = await runFrame(state, rootFrame, input.controller, scope.signal, limits.deadlineMs);
    throwIfAborted(scope.signal);
    if (result.deadline) {
      planned = failure(runId, "BUDGET_DEADLINE", "run deadline reached");
    } else if (result.cancelled) {
      planned = cancellation(runId);
    } else if (result.providerError) {
      planned = failure(runId, result.providerError.code, result.providerError.message);
    } else if (result.terminal) {
      planned = failure(runId, result.terminal.code, result.terminal.message);
    } else if (result.answer !== undefined) {
      planned = {
        runId,
        status: "completed",
        completionMode: "answer",
        answer: result.answer,
      };
    } else if (input.extractor) {
      phase = "extractor";
      const built = await buildExtractorEvidence({
        program: input.program,
        variables: inputs,
        workspace: result.workspace ?? {},
        entries: result.entries ?? [],
        store,
        artifacts: state.artifacts,
        profile,
        signal: scope.signal,
        deadlineMs: limits.deadlineMs,
        now: () => clock.now(),
      });
      if (!built.ok) {
        planned = failure(runId, built.code, built.message);
      } else {
        await journal.append({
          type: "fallback_evidence_projected",
          frameId: rootFrameId,
          ...built.metadata,
        });
        const operation = createModelOperation(state, rootFrame, {
          operationId: `${runId}:extractor`,
          kind: "extractor",
          key: built.metadata.projectionHash,
          signal: scope.signal,
          deadlineMs: limits.deadlineMs,
        });
        const raw = input.extractor.accountingMode === "provider"
          ? await waitForAbort(input.extractor.extract(built.projection, scope.signal, {
              complete: (request) => operation.complete(
                state.model,
                buildExtractorModelRequest(built.projection, request),
              ),
            }), scope.signal)
          : await operation.runExternal(() => input.extractor!.extract(built.projection, scope.signal));
        if (input.extractor.accountingMode === "provider" && operation.attemptCount === 0)
          throw new ModelInvocationError(
            { code: "INVALID_REQUEST", message: "provider extractor returned without using the accounting boundary", retryable: false },
            operation.usage,
          );
        throwIfAborted(scope.signal);
        const extracted = validateExtractorProvenance(
          normalizeExtractorResult(raw),
          built.projection,
        );
        if (extracted.ok) {
          const outputErrors = validateOutputContract(extracted.value, rootFrame.outputs);
          if (outputErrors.length > 0) {
            planned = failure(runId, "INVALID_RESULT", outputContractErrorMessage(outputErrors));
          } else {
            phase = "context";
            await persistAnswer(
              state,
              `fallback:${rootFrameId}`,
              extracted.value,
              (outputRef, outputBytes, outputSha256) => [{
                type: "fallback_evidence_cited",
                frameId: rootFrameId,
                evidenceRefs: extracted.evidenceRefs,
                evidenceRefsHash: sha256(JSON.stringify(extracted.evidenceRefs)),
              }, {
                type: "answer_committed",
                frameId: rootFrameId,
                completionMode: "fallback_extract",
                outputRef,
                outputSha256,
                outputBytes,
              }],
              limits.deadlineMs,
              scope.signal,
            );
            throwIfAborted(scope.signal);
            planned = {
              runId,
              status: "completed",
              completionMode: "fallback_extract",
              answer: extracted.value,
            };
          }
        } else {
          planned = failure(runId, extracted.code, extracted.message);
        }
      }
    } else {
      planned = failure(runId, "NO_ANSWER", "controller exhausted without answer");
    }
  } catch (error) {
    planned = exceptionResult(runId, phase, error, scope);
  } finally {
    scope.dispose();
  }

  return finalize(journal, rootFrameId, planned ?? failure(runId, "FAILED", "run failed"), ledgerRef);
};
