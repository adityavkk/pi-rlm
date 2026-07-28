/** Managed checkpoint hydration and root-frame continuation without journal replay. */

import { join } from "node:path";
import { canonicalStringify, parseJsonValue, type JsonValue } from "../core/json.ts";
import { normalizeProgram } from "../core/program.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";
import { ContextStore } from "../shell/context-store.ts";
import { type Clock, systemClock } from "../shell/clock.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import { createAbortScope, throwIfAborted, waitForAbort, type AbortScope } from "./abort.ts";
import { persistAnswer } from "./answer-persistence.ts";
import {
  bindAgentDelegationRuntime,
  prepareAgentDelegation,
  type AgentDelegationConfig,
} from "./agent-delegation.ts";
import { recoverLatestRunCheckpoint } from "./checkpoint-recovery.ts";
import { RunCheckpointWriter } from "./checkpoint-persistence.ts";
import { RunCheckpointStore } from "./checkpoint-store.ts";
import {
  requireControllerResumeCapability,
  type ControllerDriver,
  type ControllerResumeCapabilityIdentityV1,
  type ControllerResumeCapabilityV1,
} from "./controller.ts";
import {
  buildExtractorModelRequest,
  normalizeExtractorResult,
  validateExtractorProvenance,
  type Extractor,
} from "./extractor.ts";
import { buildExtractorEvidence } from "./extractor-evidence.ts";
import { runFrame } from "./frame.ts";
import { MANAGED_RUN_PERSISTENCE, MANAGED_RUN_RESUME } from "./run-managed-lifecycle.ts";
import {
  assertRunComponentsCompatible,
  MAX_RUN_LOCK_BYTES,
  readBoundedRunDirectoryFile,
  readRunManifest,
  RUN_LOCK_FILE,
  RunDirectoryError,
  RunManifestCompatibilityError,
} from "./run-manifest.ts";
import { createRunOperationAuthority } from "./operation-authority.ts";
import { outputContractErrorMessage, validateOutputContract } from "./output-validation.ts";
import { createModelOperation, externalExtractorRequestIdentity, ModelInvocationError } from "./provider.ts";
import { contextStoreLimits, type Profile } from "./profile.ts";
import {
  createRunProgressTracker,
  type RunProgressObserver,
  type RunProgressPhase,
  type RunProgressSource,
} from "./run-progress.ts";
import { RunRecoveryError } from "./run-recovery-types.ts";
import {
  cancellation,
  exceptionResult,
  failure,
  finalize,
  type Phase,
  type PlannedResult,
  type RunLifecycleHooks,
  type RunResult,
} from "./run.ts";
import { Semaphore } from "./semaphore.ts";
import type { FrameRef, InternalRunState, KeyIdentityBinding } from "./state.ts";
import { resolveControllerTurnObserver } from "./testing/controller-turn-observer.ts";

export interface ResumeInput {
  readonly controller: ControllerDriver;
  readonly model: ModelClient;
  readonly backend: InterpreterBackend;
  readonly extractor?: Extractor;
  readonly agentDelegation?: AgentDelegationConfig;
  readonly dir: string;
  readonly signal: AbortSignal;
  readonly clock?: Clock;
  /** Must come from ManagedRunStore.openForResume for this exact directory name. */
  readonly runLifecycle: RunLifecycleHooks;
  readonly onProgress?: RunProgressObserver;
  readonly onProgressSource?: (source: RunProgressSource) => void;
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalStringify(left as JsonValue) === canonicalStringify(right as JsonValue);

const validatePermanentClaim = async (
  input: ResumeInput,
  runId: string,
  manifestHash: string,
  checkpoint: () => void,
): Promise<void> => {
  const persistence = input.runLifecycle[MANAGED_RUN_PERSISTENCE]!;
  try {
    const fileSystem = persistence.runDirectoryFileSystem();
    const raw = await readBoundedRunDirectoryFile(
      join(input.dir, RUN_LOCK_FILE), MAX_RUN_LOCK_BYTES, fileSystem, checkpoint,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const parsed = parseJsonValue(JSON.parse(text) as unknown);
    const expected = { runId, manifestHash };
    if (!parsed.ok || canonicalStringify(parsed.value) !== text || !same(parsed.value, expected))
      throw new TypeError("run lock identity is invalid");
  } catch (cause) {
    throw new RunRecoveryError("RECOVERY_LOCK_INVALID", "permanent run claim is invalid", cause);
  }
};

const readCompatibleManifest = async (input: ResumeInput, checkpoint: () => void) => {
  const persistence = input.runLifecycle[MANAGED_RUN_PERSISTENCE]!;
  let document;
  try { document = await readRunManifest(input.dir, persistence.runDirectoryFileSystem(), checkpoint); }
  catch (cause) {
    if (cause instanceof RunDirectoryError && cause.code === "MANIFEST_INCOMPATIBLE")
      throw new RunRecoveryError("RECOVERY_INCOMPATIBLE", "stored run manifest is incompatible", cause);
    throw new RunRecoveryError("RECOVERY_MANIFEST_INVALID", "stored run manifest is invalid", cause);
  }
  try {
    const preparedAgentDelegation = prepareAgentDelegation(input.agentDelegation);
    assertRunComponentsCompatible(document, {
      backend: input.backend,
      model: input.model,
      controller: input.controller,
      ...(input.extractor ? { extractor: input.extractor } : {}),
      ...(preparedAgentDelegation ? { agentDelegation: preparedAgentDelegation } : {}),
    });
    return { document, preparedAgentDelegation };
  } catch (cause) {
    if (cause instanceof RunManifestCompatibilityError)
      throw new RunRecoveryError("RECOVERY_COMPONENT_MISMATCH", cause.message, cause);
    throw cause;
  }
};

const recoveredBinding = (input: ResumeInput): NonNullable<RunLifecycleHooks[typeof MANAGED_RUN_RESUME]> => {
  const persistence = input.runLifecycle[MANAGED_RUN_PERSISTENCE];
  const binding = input.runLifecycle[MANAGED_RUN_RESUME];
  if (!persistence || !binding || input.dir !== persistence.runPath || binding.runName !== persistence.runName)
    throw new RunRecoveryError("RECOVERY_DIRECTORY_INVALID", "resume requires an exact managed openForResume lifecycle");
  return binding;
};

const hydratedKeyBindings = (
  entries: readonly { readonly registryId: string; readonly identityHash: string }[],
): Map<string, KeyIdentityBinding> => new Map(entries.map(({ registryId, identityHash }) => [registryId, {
  identityHash,
  ready: Promise.resolve(),
  state: "durable" as const,
}]));

const executeContinuation = async (
  input: ResumeInput,
  state: InternalRunState,
  rootFrame: FrameRef,
  manifestHash: string,
  scope: AbortScope,
  setPhase: (phase: Phase) => void,
  continuation: Parameters<typeof runFrame>[5],
): Promise<PlannedResult> => {
  const runId = state.runId;
  setPhase("controller");
  const result = await runFrame(
    state,
    rootFrame,
    input.controller,
    scope.signal,
    state.ledger.current.limits.deadlineMs,
    continuation,
  );
  throwIfAborted(scope.signal);
  if (result.deadline) return failure(runId, "BUDGET_DEADLINE", "run deadline reached");
  if (result.cancelled) return cancellation(runId);
  if (result.providerError) return failure(runId, result.providerError.code, result.providerError.message);
  if (result.terminal) return failure(runId, result.terminal.code, result.terminal.message);
  if (result.answer !== undefined) {
    return { runId, status: "completed", completionMode: "answer", answer: result.answer };
  }
  if (!input.extractor) return failure(runId, "NO_ANSWER", "controller exhausted without answer");

  setPhase("extractor");
  const built = await buildExtractorEvidence({
    program: state.program,
    variables: rootFrame.inputs,
    workspace: result.workspace ?? {},
    entries: result.entries ?? [],
    store: state.store,
    artifacts: state.artifacts,
    profile: state.profile,
    signal: scope.signal,
    deadlineMs: state.ledger.current.limits.deadlineMs,
    now: () => state.clock.now(),
  });
  if (!built.ok) return failure(runId, built.code, built.message);
  await state.journal.append({ type: "fallback_evidence_projected", frameId: rootFrame.frameId, ...built.metadata });
  const operation = createModelOperation(state, rootFrame, {
    operationId: `${runId}:extractor`,
    kind: "extractor",
    key: built.metadata.projectionHash,
    signal: scope.signal,
    deadlineMs: state.ledger.current.limits.deadlineMs,
  });
  const raw = input.extractor.accountingMode === "provider"
    ? await waitForAbort(input.extractor.extract(built.projection, scope.signal, {
        complete: (request) => operation.complete(state.model, buildExtractorModelRequest(built.projection, request)),
      }), scope.signal)
    : await operation.runExternal(
        () => input.extractor!.extract(built.projection, scope.signal),
        externalExtractorRequestIdentity(manifestHash, built.metadata.projectionVersion, built.metadata.projectionHash),
      );
  if (input.extractor.accountingMode === "provider" && operation.attemptCount === 0)
    throw new ModelInvocationError(
      { code: "INVALID_REQUEST", message: "provider extractor returned without using the accounting boundary", retryable: false },
      operation.usage,
    );
  throwIfAborted(scope.signal);
  const extracted = validateExtractorProvenance(normalizeExtractorResult(raw), built.projection);
  if (!extracted.ok) return failure(runId, extracted.code, extracted.message);
  const outputErrors = validateOutputContract(extracted.value, rootFrame.outputs);
  if (outputErrors.length > 0) return failure(runId, "INVALID_RESULT", outputContractErrorMessage(outputErrors));

  setPhase("context");
  await persistAnswer(
    state,
    `fallback:${rootFrame.frameId}`,
    extracted.value,
    (outputRef, outputBytes, outputSha256) => [{
      type: "fallback_evidence_cited",
      frameId: rootFrame.frameId,
      evidenceRefs: extracted.evidenceRefs,
      evidenceRefsHash: sha256(JSON.stringify(extracted.evidenceRefs)),
    }, {
      type: "answer_committed",
      frameId: rootFrame.frameId,
      completionMode: "fallback_extract",
      outputRef,
      outputSha256,
      outputBytes,
    }],
    state.ledger.current.limits.deadlineMs,
    scope.signal,
  );
  throwIfAborted(scope.signal);
  return { runId, status: "completed", completionMode: "fallback_extract", answer: extracted.value };
};

const resumeProgramOwned = async (
  input: ResumeInput,
  controllerResume: { readonly identity: ControllerResumeCapabilityIdentityV1; readonly capability: ControllerResumeCapabilityV1 },
): Promise<RunResult> => {
  throwIfAborted(input.signal);
  const binding = recoveredBinding(input);
  const clock = input.clock ?? systemClock;
  const { document, preparedAgentDelegation } = await readCompatibleManifest(input, () => throwIfAborted(input.signal));
  if (document.manifest.run.id !== binding.runId)
    throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "managed lifecycle and manifest run identities differ");
  const scope = createAbortScope(input.signal, document.manifest.limits.deadlineMs, () => clock.now());
  try {
  throwIfAborted(scope.signal);
  await validatePermanentClaim(input, document.manifest.run.id, document.manifestHash, () => throwIfAborted(scope.signal));
  const normalized = normalizeProgram(document.manifest.program);
  if (!normalized.ok) throw new RunRecoveryError("RECOVERY_MANIFEST_INVALID", "manifest program cannot be normalized");
  const program = normalized.value;
  const profile = document.manifest.profile as unknown as Profile;
  const persistence = input.runLifecycle[MANAGED_RUN_PERSISTENCE]!;
  const journalFileSystem = persistence.journalFileSystem();
  const contextInstrumentation = persistence.contextInstrumentation();
  const journal = new JournalStore(input.dir, journalFileSystem);
  const store = new ContextStore(input.dir, contextStoreLimits(profile), contextInstrumentation);
  const checkpointStore = new RunCheckpointStore(input.dir, profile.storedByteLimit, contextInstrumentation);
  const recovered = await recoverLatestRunCheckpoint(document, journal, store, checkpointStore, {
    checkpoint: () => throwIfAborted(scope.signal),
  });
  const payload = recovered.payload;

  const ledgerRef = { current: payload.ledger };
  const progress = createRunProgressTracker({
    startMs: payload.run.startMs,
    limits: document.manifest.limits,
    ledger: () => ledgerRef.current,
    now: () => clock.now(),
    initialFramesTotal: payload.ordinals.frameSequence,
    ...(input.onProgress ? { observer: input.onProgress } : {}),
  });
  const runId = document.manifest.run.id;
  progress.bindRunId(runId);
  progress.setPhase("journal");
  try { input.onProgressSource?.(progress.source); } catch { /* Progress observers have no run authority. */ }
  const operationAuthority = createRunOperationAuthority();
  const agentDelegationRuntime = bindAgentDelegationRuntime(preparedAgentDelegation, scope.signal);
  let checkpointWriter: RunCheckpointWriter | undefined;
  const state: InternalRunState = {
    runId,
    startMs: payload.run.startMs,
    profile,
    clock,
    hasher: sha256,
    program,
    ledger: ledgerRef,
    ...(resolveControllerTurnObserver(input.signal) ? { controllerTurnObserver: resolveControllerTurnObserver(input.signal) } : {}),
    store,
    artifacts: new Map(payload.artifacts.map((artifact) => [artifact.descriptor.id, artifact])),
    model: input.model,
    journal,
    backend: input.backend,
    callCache: new Map(payload.callCache.map((entry) => [entry.callId, entry.result])),
    inflight: new Map(),
    keyIdentities: hydratedKeyBindings(payload.keyBindings),
    scopeUsage: new Map(payload.scopeUsage.map((entry) => [entry.scope, entry.usage])),
    operationAttempts: new Map(payload.ordinals.operationAttempts.map((entry) => [entry.key, entry.value])),
    operationAuthority,
    semaphore: new Semaphore(profile.maxConcurrency),
    contextSemaphore: new Semaphore(1),
    ...(agentDelegationRuntime ? { agentDelegation: agentDelegationRuntime } : {}),
    agentAttempts: new Map(payload.ordinals.agentAttempts.map((entry) => [entry.key, entry.value])),
    recurseExecutions: new Map(payload.ordinals.recurseExecutions.map((entry) => [entry.key, entry.value])),
    frameSeq: { current: payload.ordinals.frameSequence },
    checkpoint: { commit: (continuation) => checkpointWriter!.commit(continuation) },
    progress,
  };
  checkpointWriter = new RunCheckpointWriter({
    state, document, checkpointStore, controllerResume, signal: scope.signal,
  });
  progress.setRuntimeGetter(() => ({ activeCalls: state.inflight.size }));
  const rootFrame: FrameRef = {
    frameId: payload.root.frame.frameId,
    lineage: payload.root.frame.lineage,
    depth: 0,
    objective: payload.root.frame.objective,
    inputs: payload.root.frame.inputs as Readonly<Record<string, ContextDescriptor>>,
    outputs: payload.root.frame.outputs,
  };
  const continuation = {
    frame: rootFrame,
    nextIteration: payload.root.nextIteration,
    workspace: payload.root.workspace,
    entries: payload.root.trajectory,
    ...(payload.root.lastOutcome ? { lastOutcome: payload.root.lastOutcome } : {}),
  };
  try {
    controllerResume.capability.restore(payload.controller.state, {
      frameId: rootFrame.frameId,
      nextIteration: payload.root.nextIteration,
      trajectoryLength: payload.root.trajectory.length,
    });
  } catch (cause) {
    scope.dispose();
    throw new RunRecoveryError("RECOVERY_CONTROLLER_STATE_INVALID", "controller checkpoint state is invalid", cause);
  }

  let phase: Phase = "controller";
  const setPhase = (value: Phase): void => { phase = value; progress.setPhase(value as RunProgressPhase); };
  let planned: PlannedResult;
  try {
    planned = await executeContinuation(input, state, rootFrame, document.manifestHash, scope, setPhase, continuation);
  } catch (error) {
    planned = exceptionResult(runId, phase, error, scope);
  } finally {
    scope.dispose();
    operationAuthority.close();
  }

  progress.setPhase("finalizing");
  const finalized = await finalize(journal, rootFrame.frameId, planned, ledgerRef);
  progress.frameClosed();
  progress.finish(finalized.status);
  return finalized;
  } finally {
    scope.dispose();
  }
};

export interface ResumableManagedRunInspection {
  readonly runId: string;
  readonly manifestHash: string;
  readonly checkpointSequence: number;
  readonly nextIteration: number;
  readonly nextControllerTurn: number;
  readonly incompleteTailBytes: number;
}

const inspectResumableManagedRunOwned = async (input: ResumeInput): Promise<ResumableManagedRunInspection> => {
  throwIfAborted(input.signal);
  requireControllerResumeCapability(input.controller);
  const binding = recoveredBinding(input);
  const clock = input.clock ?? systemClock;
  const { document } = await readCompatibleManifest(input, () => throwIfAborted(input.signal));
  if (document.manifest.run.id !== binding.runId)
    throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "managed lifecycle and manifest run identities differ");
  const scope = createAbortScope(input.signal, document.manifest.limits.deadlineMs, () => clock.now());
  try {
    throwIfAborted(scope.signal);
    await validatePermanentClaim(input, document.manifest.run.id, document.manifestHash, () => throwIfAborted(scope.signal));
    const profile = document.manifest.profile as unknown as Profile;
    const persistence = input.runLifecycle[MANAGED_RUN_PERSISTENCE]!;
    const instrumentation = persistence.contextInstrumentation();
    const recovered = await recoverLatestRunCheckpoint(
      document,
      new JournalStore(input.dir, persistence.journalFileSystem()),
      new ContextStore(input.dir, contextStoreLimits(profile), instrumentation),
      new RunCheckpointStore(input.dir, profile.storedByteLimit, instrumentation),
      { repair: false, checkpoint: () => throwIfAborted(scope.signal) },
    );
    return {
      runId: document.manifest.run.id,
      manifestHash: document.manifestHash,
      checkpointSequence: recovered.event.checkpointSequence,
      nextIteration: recovered.event.nextIteration,
      nextControllerTurn: recovered.event.nextControllerTurn,
      incompleteTailBytes: recovered.incompleteTailBytes,
    };
  } finally { scope.dispose(); }
};

/** Read-only resumability preflight. It never repairs, restores a controller, or invokes a provider/backend. */
export const inspectResumableManagedRun = (input: ResumeInput): Promise<ResumableManagedRunInspection> => {
  try { requireControllerResumeCapability(input.controller); }
  catch (cause) {
    return Promise.reject(new RunRecoveryError(
      "RECOVERY_CONTROLLER_UNSUPPORTED", "controller does not support managed checkpoint resume", cause,
    ));
  }
  const persistence = input.runLifecycle?.[MANAGED_RUN_PERSISTENCE];
  if (!persistence)
    return Promise.reject(new RunRecoveryError("RECOVERY_DIRECTORY_INVALID", "custom run directories are not resumable"));
  return persistence.runTransaction(() => inspectResumableManagedRunOwned(input));
};

/** Continue one lease-owned managed run from its exact checkpoint boundary. */
export const resumeProgram = (input: ResumeInput): Promise<RunResult> => {
  let controllerResume;
  try { controllerResume = requireControllerResumeCapability(input.controller); }
  catch (cause) {
    return Promise.reject(new RunRecoveryError(
      "RECOVERY_CONTROLLER_UNSUPPORTED", "controller does not support managed checkpoint resume", cause,
    ));
  }
  const persistence = input.runLifecycle?.[MANAGED_RUN_PERSISTENCE];
  if (!persistence)
    return Promise.reject(new RunRecoveryError("RECOVERY_DIRECTORY_INVALID", "custom run directories are not resumable"));
  return persistence.runTransaction(() => resumeProgramOwned(input, controllerResume));
};
