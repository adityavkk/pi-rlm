/** Top-level run orchestration and exactly-once durable finalization. */

import { createLedger, type Ledger } from "../core/budget.ts";
import type { FrameState, RlmEvent } from "../core/journal.ts";
import type { JsonValue } from "../core/json.ts";
import type { RlmProgram } from "../core/program.ts";
import {
  ContextBudgetError,
  type ContextDescriptor,
  type ContextOperationControl,
  ContextStore,
  type ContextStoreInstrumentation,
} from "../shell/context-store.ts";
import { type Clock, systemClock } from "../shell/clock.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalAppendError, JournalStore, type JournalFileSystem } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import { createAbortScope, throwIfAborted, waitForAbort, wasAborted, type AbortScope } from "./abort.ts";
import { persistAnswer } from "./answer-persistence.ts";
import {
  bindAgentDelegationRuntime,
  prepareAgentDelegation,
  type AgentDelegationConfig,
} from "./agent-delegation.ts";
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
} from "./extractor-evidence.ts";
import { runFrame } from "./frame.ts";
import { outputContractErrorMessage, validateOutputContract } from "./output-validation.ts";
import { createModelOperation, ModelInvocationError } from "./provider.ts";
import { contextStoreLimits, DEFAULT_PROFILE, type Profile, resolveLimits } from "./profile.ts";
import {
  createRunProgressTracker,
  type RunProgressObserver,
  type RunProgressPhase,
  type RunProgressSource,
} from "./run-progress.ts";
import { Semaphore } from "./semaphore.ts";
import type { FrameRef, InternalRunState } from "./state.ts";
import {
  buildRunManifest,
  claimRunDirectory,
  preflightRunComponents,
  RLM_DSL_VERSION,
  type LaunchAuthorizationMode,
  type RunDirectoryFileSystem,
} from "./run-manifest.ts";
import { remainingStoredBytes, reserveStoredBytes } from "./stored-bytes.ts";
import { resolveControllerTurnObserver } from "./testing/controller-turn-observer.ts";
import { MANAGED_RUN_PERSISTENCE, type ManagedRunPersistenceCarrier } from "./run-managed-lifecycle.ts";

export { RLM_DSL_VERSION } from "./run-manifest.ts";

export interface RunLifecycleHooks extends ManagedRunPersistenceCarrier {
  /** Pre-existing manager files allowed during the otherwise-exclusive manifest claim. */
  readonly claimEntries: readonly string[];
  /** Called after durable manifest publication and before journals or source snapshots. */
  readonly onManifest: (runId: string) => Promise<void>;
  /** Called only after the authoritative run_started record is known durable. */
  readonly onRunStarted?: (runId: string) => Promise<void>;
}

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
  readonly agentDelegation?: AgentDelegationConfig;
  /** Non-secret authorization path that admitted this launch. */
  readonly authorizationMode?: LaunchAuthorizationMode;
  /** Cryptographically random by default; injectable only for deterministic tests. */
  readonly createRunNonce?: () => string;
  /** Optional manifest persistence injection for fault testing. */
  readonly runDirectoryFileSystem?: RunDirectoryFileSystem;
  /** Optional journal filesystem injection. Managed runs compose it beneath their lease guard. */
  readonly journalFileSystem?: JournalFileSystem;
  /** Optional context filesystem instrumentation, composed beneath managed-run ownership. */
  readonly contextStoreInstrumentation?: ContextStoreInstrumentation;
  /** Host-managed lifecycle binding; custom run directories omit this. */
  readonly runLifecycle?: RunLifecycleHooks;
  /** Optional store injection for fault testing and embedded runtimes. */
  readonly journal?: JournalStore;
  /** Bounded live snapshots. Observer and source-capture failures are ignored. */
  readonly onProgress?: RunProgressObserver;
  readonly onProgressSource?: (source: RunProgressSource) => void;
}

export interface RunError {
  readonly code: string;
  readonly message: string;
  /** Non-secret classification of the original exception. */
  readonly cause?: { readonly name: string; readonly code?: string };
}

export interface RunWarning {
  readonly code:
    | "STATUS_CACHE_REFRESH_FAILED"
    | "JOURNAL_APPEND_CLEANUP_FAILED"
    | "RETENTION_METADATA_FAILED"
    | "RETENTION_CLEANUP_FAILED";
  readonly message: string;
  readonly cause?: RunError["cause"];
}

export interface RunResult {
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly completionMode?: "answer" | "fallback_extract";
  readonly answer?: JsonValue;
  /** Content-addressed descriptor from the authoritative answer_committed event. */
  readonly output?: { readonly ref: string; readonly sha256: string; readonly bytes: number };
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

type TerminalEvent = Extract<RlmEvent, { type: "run_completed" | "run_failed" | "run_cancelled" }>;
type AnswerCommitted = Extract<RlmEvent, { type: "answer_committed" }>;

const isTerminalEvent = (event: RlmEvent): event is TerminalEvent =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled";

const fullAnswerOutput = (answer: AnswerCommitted): RunResult["output"] => {
  if (answer.outputSha256 === undefined || answer.outputBytes === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(answer.outputSha256)
    || answer.outputRef !== `ctx_${answer.outputSha256}`
    || !Number.isSafeInteger(answer.outputBytes) || answer.outputBytes < 0) return undefined;
  return { ref: answer.outputRef, sha256: answer.outputSha256, bytes: answer.outputBytes };
};

/** Current writers require one fully described root answer before completing. */
const completionOutput = (
  events: readonly RlmEvent[],
  rootFrameId: string,
  completionMode: NonNullable<PlannedResult["completionMode"]>,
): RunResult["output"] => {
  const rootAnswers = events.filter((event): event is AnswerCommitted =>
    event.type === "answer_committed" && event.frameId === rootFrameId);
  if (rootAnswers.length !== 1 || rootAnswers[0]?.completionMode !== completionMode) return undefined;
  return fullAnswerOutput(rootAnswers[0]);
};

const terminalEvent = (
  result: PlannedResult,
  events: readonly RlmEvent[],
  rootFrameId: string,
): RlmEvent => {
  if (result.status === "completed") {
    if (result.completionMode === undefined) throw new Error("completed run has no completion mode");
    const output = completionOutput(events, rootFrameId, result.completionMode);
    if (!output) throw new Error("completed run has no unique authoritative root answer");
    return {
      type: "run_completed",
      runId: result.runId,
      completionMode: result.completionMode,
      outputRef: output.ref,
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

const terminalsForRun = (events: readonly RlmEvent[], expectedRunId: string): TerminalEvent[] =>
  events.filter((event): event is TerminalEvent => isTerminalEvent(event) && event.runId === expectedRunId);

export const outputFromEvents = (
  events: readonly RlmEvent[],
  expectedRunId: string,
  rootFrameId: string,
  result: PlannedResult,
): RunResult["output"] => {
  if (result.status !== "completed" || result.completionMode === undefined) return undefined;
  const terminals = terminalsForRun(events, expectedRunId);
  if (terminals.length !== 1) return undefined;
  const terminal = terminals[0];
  if (terminal?.type !== "run_completed" || terminal.runId !== expectedRunId
    || terminal.completionMode !== result.completionMode || terminal.outputRef === undefined) return undefined;
  const output = completionOutput(events, rootFrameId, result.completionMode);
  if (!output || terminal.outputRef !== output.ref) return undefined;
  return output;
};

const resultFromTerminal = (event: TerminalEvent, initial: PlannedResult): PlannedResult => {
  if (event.type === "run_completed") {
    if (initial.status !== "completed" || initial.completionMode !== event.completionMode)
      return failure(initial.runId, "JOURNAL_FAILED", "run terminal does not match the planned completion");
    return {
      runId: initial.runId,
      status: "completed",
      completionMode: event.completionMode,
      ...(initial.answer !== undefined ? { answer: initial.answer } : {}),
    };
  }
  if (event.type === "run_cancelled") {
    return {
      runId: initial.runId,
      status: "cancelled",
      error: { code: event.code, message: event.message },
    };
  }
  const matchingCause = initial.status === "failed" &&
    initial.error?.code === event.code && initial.error.message === event.message
    ? initial.error.cause
    : undefined;
  return failure(initial.runId, event.code, event.message, matchingCause);
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
  const finish = (result: PlannedResult, events: readonly RlmEvent[] = []): RunResult => {
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
    const output = outputFromEvents(events, initial.runId, rootFrameId, result);
    const authoritative = result.status === "completed" && !output
      ? failure(initial.runId, "JOURNAL_FAILED", "completed run has no authoritative journal output")
      : result;
    return {
      ...authoritative,
      ...(output && authoritative.status === "completed" ? { output } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ledger: ledgerRef.current,
    };
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
      const existingTerminals = terminalsForRun(scanned.value, initial.runId);
      if (existingTerminals.length > 1)
        return finish(failure(initial.runId, "JOURNAL_FAILED", "run journal has multiple terminal events"), scanned.value);
      if (existingTerminals.length === 1)
        return finish(resultFromTerminal(existingTerminals[0]!, initial), scanned.value);
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
      const beforeTerminal = await journal.readEvents();
      if (!beforeTerminal.ok) throw beforeTerminal.error;
      const event = terminalEvent(planned, beforeTerminal.value, rootFrameId);
      await appendDurably(event);

      const finalized = await journal.readEvents();
      if (!finalized.ok) throw finalized.error;
      const committedTerminals = terminalsForRun(finalized.value, initial.runId);
      if (committedTerminals.length > 1)
        return finish(failure(initial.runId, "JOURNAL_FAILED", "run journal has multiple terminal events"), finalized.value);
      if (committedTerminals.length === 1)
        return finish(resultFromTerminal(committedTerminals[0]!, initial), finalized.value);
      throw new Error("terminal event was not committed");
    } catch (error) {
      try {
        const rescued = await journal.readEvents();
        const committedTerminals = rescued.ok ? terminalsForRun(rescued.value, initial.runId) : [];
        if (committedTerminals.length > 1)
          return finish(failure(initial.runId, "JOURNAL_FAILED", "run journal has multiple terminal events"), rescued.ok ? rescued.value : []);
        if (committedTerminals.length === 1)
          return finish(resultFromTerminal(committedTerminals[0]!, initial), rescued.ok ? rescued.value : []);
      } catch {
        // Preserve the original finalization failure classification.
      }
      planned = failure(initial.runId, "JOURNAL_FAILED", "failed to finalize run journal", error);
    }
  }
  return finish(planned);
};

const runProgramOwned = async (input: RunInput): Promise<RunResult> => {
  const preparedAgentDelegation = prepareAgentDelegation(input.agentDelegation);
  preflightRunComponents({
    backend: input.backend,
    model: input.model,
    controller: input.controller,
    ...(input.extractor ? { extractor: input.extractor } : {}),
    ...(preparedAgentDelegation ? { agentDelegation: preparedAgentDelegation } : {}),
  });
  const clock = input.clock ?? systemClock;
  const profile = input.profile ?? DEFAULT_PROFILE;
  const startMs = clock.now();
  const limits = resolveLimits(profile, startMs);
  const document = buildRunManifest({
    program: input.program,
    sources: input.sources,
    profile,
    limits,
    backend: input.backend,
    model: input.model,
    controller: input.controller,
    extractor: input.extractor,
    ...(preparedAgentDelegation ? { agentDelegation: preparedAgentDelegation } : {}),
    authorizationMode: input.authorizationMode,
    createRunNonce: input.createRunNonce,
    dslVersion: RLM_DSL_VERSION,
  });
  const ledgerRef = { current: createLedger(limits) };
  const progress = createRunProgressTracker({
    startMs,
    limits,
    ledger: () => ledgerRef.current,
    now: () => clock.now(),
    ...(input.onProgress ? { observer: input.onProgress } : {}),
  });
  const runId = document.manifest.run.id;
  const rootFrameId = `${runId}:f0`;
  let rootProgressActive = true;
  const closeRootProgress = (): void => {
    if (!rootProgressActive) return;
    rootProgressActive = false;
    progress.frameClosed();
  };
  progress.bindRunId(runId);
  progress.setPhase("manifest");
  try { input.onProgressSource?.(progress.source); } catch { /* Progress observers have no run authority. */ }
  try {
    try {
      if (input.runLifecycle?.[MANAGED_RUN_PERSISTENCE] && input.journal)
        throw new TypeError("managed runs cannot bypass lease ownership with a preconstructed journal");
      const runDirectoryFileSystem = input.runLifecycle?.[MANAGED_RUN_PERSISTENCE]
        ?.runDirectoryFileSystem(input.runDirectoryFileSystem);
      await claimRunDirectory(
        input.dir,
        document,
        runDirectoryFileSystem ?? input.runDirectoryFileSystem,
        input.runLifecycle?.claimEntries,
      );
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        closeRootProgress();
        progress.finish("failed");
        return { ...failure(runId, "JOURNAL_FAILED", "failed to persist run journal", error), ledger: ledgerRef.current };
      }
      throw error;
    }
    await input.runLifecycle?.onManifest(runId);
  const journalFileSystem = input.runLifecycle?.[MANAGED_RUN_PERSISTENCE]?.journalFileSystem(input.journalFileSystem)
    ?? input.journalFileSystem;
  const contextInstrumentation = input.runLifecycle?.[MANAGED_RUN_PERSISTENCE]
    ?.contextInstrumentation(input.contextStoreInstrumentation)
    ?? input.contextStoreInstrumentation;
  const journal = input.journal ?? new JournalStore(input.dir, journalFileSystem);
  const store = new ContextStore(input.dir, contextStoreLimits(profile), contextInstrumentation);
  const scope = createAbortScope(input.signal, limits.deadlineMs, () => clock.now());
  let phase: Phase = "journal";
  const setPhase = (value: Phase): void => {
    phase = value;
    progress.setPhase(value as RunProgressPhase);
  };
  let planned: PlannedResult | undefined;
  let runStartedDurable = false;

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
    const manifestHash = document.manifestHash;
    setPhase("source");
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
      setPhase("journal");
      let appendFailed = false;
      let appendFailure: unknown;
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
        appendFailed = true;
        appendFailure = error;
        sourceDurable = error instanceof JournalAppendError && error.eventDurable;
      }
      runStartedDurable = sourceDurable;
      if (runStartedDurable) await input.runLifecycle?.onRunStarted?.(runId);
      if (appendFailed) throw appendFailure;
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

    setPhase("journal");
    await journal.append({
      type: "frame_opened",
      frameId: rootFrameId,
      parentFrameId: null,
      depth: 0,
      objective: input.program.objective,
    });
    progress.publish();
    throwIfAborted(scope.signal);

    const controllerTurnObserver = resolveControllerTurnObserver(input.signal);
    const agentDelegationRuntime = bindAgentDelegationRuntime(preparedAgentDelegation, scope.signal);
    const state: InternalRunState = {
      runId,
      startMs,
      profile,
      clock,
      hasher: sha256,
      program: input.program,
      ledger: ledgerRef,
      ...(controllerTurnObserver ? { controllerTurnObserver } : {}),
      store,
      artifacts: new Map(),
      model: input.model,
      journal,
      backend: input.backend,
      callCache: new Map(),
      inflight: new Map(),
      keyIdentities: new Map(),
      scopeUsage: new Map(),
      operationAttempts: new Map(),
      semaphore: new Semaphore(profile.maxConcurrency),
      contextSemaphore: new Semaphore(1),
      ...(agentDelegationRuntime ? { agentDelegation: agentDelegationRuntime } : {}),
      agentAttempts: new Map(),
      recurseExecutions: new Map(),
      frameSeq: { current: 1 },
      progress,
    };
    progress.setRuntimeGetter(() => ({ activeCalls: state.inflight.size }));
    const rootFrame: FrameRef = {
      frameId: rootFrameId,
      lineage: rootFrameId,
      depth: 0,
      objective: input.program.objective,
      inputs,
      outputs: input.program.outputs,
    };

    setPhase("controller");
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
      setPhase("extractor");
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
            setPhase("context");
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

  const result = planned ?? failure(runId, "FAILED", "run failed");
  progress.setPhase("finalizing");
    if (!runStartedDurable) {
      closeRootProgress();
      progress.finish(result.status);
      return { ...result, ledger: ledgerRef.current };
    }
    const finalized = await finalize(journal, rootFrameId, result, ledgerRef);
    closeRootProgress();
    progress.finish(finalized.status);
    return finalized;
  } catch (error) {
    closeRootProgress();
    progress.finish(input.signal.aborted || wasAborted(error, input.signal) ? "cancelled" : "failed");
    throw error;
  }
};

/** Managed runs hold writer admission for the full runtime lifecycle. */
export const runProgram = (input: RunInput): Promise<RunResult> => {
  const persistence = input.runLifecycle?.[MANAGED_RUN_PERSISTENCE];
  return persistence ? persistence.runTransaction(() => runProgramOwned(input)) : runProgramOwned(input);
};
