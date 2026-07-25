/**
 * Frame runner (imperative shell): drives one RLM frame's controller loop.
 *
 * Each iteration reserves a controller turn, asks the driver for one cell,
 * transforms and executes it, then records an immutable trajectory entry and a
 * journal event. Terminal interpreter faults fail the frame; parse errors,
 * guest exceptions, invalid workspace, and invalid answers are recoverable and
 * fed back to the controller. `recurse()` opens a child frame sharing the
 * tree-wide ledger.
 */

import { budgetView, openFrame, releaseLogicalCall, reserveControllerTurn, reserveLogicalCall } from "../core/budget.ts";
import { type CallError, callError, type InterpreterError, interpreterError } from "../core/errors.ts";
import { deriveCallId } from "../core/ids.ts";
import type { RlmEvent } from "../core/journal.ts";
import { isJsonObject, type JsonValue } from "../core/json.ts";
import { headTailPreview } from "../core/preview.ts";
import { appendEntry, projectTrajectory, type TrajectoryEntry } from "../core/trajectory.ts";
import { validateWorkspace } from "../core/workspace.ts";
import { type CallUsage, ZERO_CALL_USAGE } from "../core/usage.ts";
import { transformCell } from "../core/cell.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";
import type { CellEvalOutcome } from "../shell/interpreter/backend.ts";
import { JournalAppendError } from "../shell/journal-store.ts";
import { waitForAbort, wasAborted } from "./abort.ts";
import { bindKeys, dispatchCall, resolveContextRefs, retainCallResult } from "./broker.ts";
import { createModelOperation, hasAttemptCapacity, ModelInvocationError } from "./provider.ts";
import { persistAnswer, persistWorkspace } from "./answer-persistence.ts";
import { errResult, type GuestCallResult, okResult } from "./call-result.ts";
import { outputContractErrorMessage, validateOutputContract } from "./output-validation.ts";
import type { Cell, ControllerDriver } from "./controller.ts";
import type { FrameRef, InternalRunState } from "./state.ts";
import { notifyControllerTurnReserved } from "./testing/controller-turn-observer.ts";

export interface FrameResult {
  readonly answer?: JsonValue;
  readonly completionMode?: "answer";
  readonly exhausted: boolean;
  readonly terminal?: InterpreterError;
  readonly providerError?: CallError;
  readonly cancelled?: true;
  readonly deadline?: true;
  readonly workspace?: JsonValue;
  readonly entries?: readonly TrajectoryEntry[];
}

const safeStringify = (value: JsonValue | undefined): string => {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return "<unserializable>";
  }
};

const errorInfo = (error: CallError | InterpreterError): { code: string; message: string } => ({
  code: error.code,
  message: error.message,
});

type CapturedAnswer =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false };

/** Snapshot the first submission at effect time, before guest code can mutate it. */
const captureAnswer = (args: JsonValue): CapturedAnswer => {
  try {
    if (!isJsonObject(args) || !Object.prototype.hasOwnProperty.call(args, "value")) return { ok: false };
    const value = args["value"] as JsonValue | undefined;
    if (value === undefined) return { ok: false };
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { ok: false };
    return { ok: true, value: JSON.parse(serialized) as JsonValue };
  } catch {
    return { ok: false };
  }
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;

type ProgressEvent = Extract<RlmEvent, { type: "phase" | "emit" }>;

const appendProgressEvents = async (state: RunState, events: readonly ProgressEvent[]): Promise<void> => {
  for (const event of events) {
    const outcome = await state.journal.append(event);
    if (outcome.event === "ignored_after_terminal") throw new Error("progress journal event ignored after terminal");
  }
};

export const runFrame = async (
  state: InternalRunState,
  frame: FrameRef,
  controller: ControllerDriver,
  signal: AbortSignal,
  ownerDeadlineMs = Number.POSITIVE_INFINITY,
): Promise<FrameResult> => {
  let workspace: JsonValue = {};
  let entries: readonly TrajectoryEntry[] = [];
  let lastOutcome: { kind: string; preview?: string; message?: string } | undefined;

  const cancelled = (): FrameResult => ({ exhausted: false, cancelled: true, workspace, entries });
  const recurseFn = (args: JsonValue, cellSignal: AbortSignal, deadlineMs: number): Promise<GuestCallResult> =>
    runChild(state, frame, controller, args, cellSignal, deadlineMs);

  for (let iteration = 1; ; iteration++) {
    if (signal?.aborted) return cancelled();
    if (state.clock.now() >= state.ledger.current.limits.deadlineMs)
      return { exhausted: false, deadline: true, workspace, entries };
    if (state.ledger.current.usage.controllerTurns >= state.ledger.current.limits.maxControllerTurns)
      return { exhausted: true, workspace, entries };
    if (!hasAttemptCapacity(state))
      return { exhausted: false, providerError: callError("BUDGET_ATTEMPTS", `attempt limit ${state.ledger.current.limits.maxAttempts} reached`), workspace, entries };
    const turn = reserveControllerTurn(state.ledger.current, state.clock.now());
    if (!turn.ok)
      return turn.error.code === "DEADLINE"
        ? { exhausted: false, deadline: true, workspace, entries }
        : { exhausted: true, workspace, entries };
    state.ledger.current = turn.value;
    notifyControllerTurnReserved(state.controllerTurnObserver, turn.value.usage.controllerTurns);

    const projection = projectTrajectory(entries, state.profile.trajectory);
    const controllerOperation = createModelOperation(state, frame, {
      operationId: `${frame.frameId}:controller:${iteration}`,
      kind: "controller",
      key: String(iteration),
      signal,
      deadlineMs: Math.min(ownerDeadlineMs, state.ledger.current.limits.deadlineMs),
    });
    let cell: Cell;
    try {
      cell = await waitForAbort(controller.next({
        frameId: frame.frameId,
        depth: frame.depth,
        objective: frame.objective,
        inputs: frame.inputs,
        variables: frame.inputs as unknown as JsonValue,
        budget: budgetView(state.ledger.current, frame.depth),
        workspace,
        outputs: frame.outputs,
        trajectory: projection,
        ...(lastOutcome ? { lastOutcome } : {}),
      }, signal, controllerOperation), signal);
    } catch (error) {
      if (error instanceof ModelInvocationError)
        return { exhausted: false, providerError: error.callError, workspace, entries };
      if (wasAborted(error, signal)) return cancelled();
      throw error;
    }
    if (signal?.aborted) return cancelled();
    const controllerUsage = controllerOperation.usage;

    const transformed = transformCell(cell.code);
    if (!transformed.ok) {
      entries = appendEntry(entries, {
        iteration,
        reasoning: cell.reasoning,
        code: cell.code,
        hasResult: false,
        outputPreview: "",
        usage: controllerUsage,
        error: transformed.error,
      });
      await state.journal.append({
        type: "cell_committed",
        frameId: frame.frameId,
        iteration,
        reasoning: cell.reasoning,
        codeHash: state.hasher(cell.code),
        hasResult: false,
        outputPreview: "",
        usage: controllerUsage,
        error: errorInfo(transformed.error),
      });
      if (signal?.aborted) return cancelled();
      lastOutcome = { kind: "parse_error", message: transformed.error.message };
      continue;
    }

    let answerEffectCount = 0;
    let capturedAnswer: CapturedAnswer | undefined;
    const progressEffects: ProgressEvent[] = [];
    const effect = (name: string, args: JsonValue): void => {
      if (signal?.aborted) return;
      if (name === "answer") {
        answerEffectCount += 1;
        if (answerEffectCount === 1) capturedAnswer = captureAnswer(args);
      } else if (name === "phase" && isJsonObject(args)) {
        progressEffects.push({
          type: "phase",
          frameId: frame.frameId,
          iteration,
          ordinal: progressEffects.length,
          name: String(args["name"]),
        });
      } else if (name === "emit" && isJsonObject(args)) {
        progressEffects.push({
          type: "emit",
          frameId: frame.frameId,
          iteration,
          ordinal: progressEffects.length,
          message: String(args["message"] ?? ""),
        });
      }
    };

    const cellDeadline = Math.min(
      state.clock.now() + state.profile.cellWallMs,
      state.ledger.current.limits.deadlineMs,
      ownerDeadlineMs,
    );
    let outcome: CellEvalOutcome;
    try {
      outcome = await waitForAbort(state.backend.evalCell({
        source: transformed.value.source,
        deadlineMs: cellDeadline,
        memoryBytes: state.profile.memoryBytes,
        globals: {
          objective: frame.objective,
          inputs: frame.inputs as unknown as JsonValue,
          variables: frame.inputs as unknown as JsonValue,
          budget: budgetView(state.ledger.current, frame.depth) as unknown as JsonValue,
          workspace,
        },
        signal,
        dispatch: (n, a, cellSignal, deadlineMs) => dispatchCall(state, frame, n, a, recurseFn, cellSignal, deadlineMs),
        effect,
      }), signal);
    } catch (error) {
      if (wasAborted(error, signal)) return cancelled();
      return { exhausted: false, terminal: interpreterError("WORKER_EXIT", "interpreter backend failed") };
    }
    if (signal.aborted) return cancelled();

    if (outcome.kind === "terminal") {
      await state.journal.append({
        type: "cell_committed",
        frameId: frame.frameId,
        iteration,
        reasoning: cell.reasoning,
        codeHash: state.hasher(cell.code),
        hasResult: false,
        outputPreview: "",
        error: errorInfo(outcome.error),
      });
      if (signal?.aborted) return cancelled();
      return { exhausted: false, terminal: outcome.error };
    }

    const workspaceInvalid = outcome.workspaceInvalidPaths.length > 0;
    if (!workspaceInvalid) {
      const validated = validateWorkspace(isJsonObject(outcome.workspace) ? outcome.workspace : {});
      if (validated.ok) workspace = validated.value as unknown as JsonValue;
    }
    await persistWorkspace(state, frame.frameId, iteration, workspace, cellDeadline, signal);
    if (signal.aborted) return cancelled();

    let error: CallError | undefined;
    let preview = "";
    let outputBytes = 0;
    let outputOmittedBytes = 0;
    let answerCandidate: TrajectoryEntry["answerCandidate"];
    if (outcome.kind === "guest_error") {
      error = callError("FAILED", outcome.message);
    } else {
      const outputProjection = headTailPreview(safeStringify(outcome.result), {
        headBytes: state.profile.previewHeadBytes,
        tailBytes: state.profile.previewTailBytes,
      });
      preview = outputProjection.text;
      outputBytes = outputProjection.originalBytes;
      outputOmittedBytes = outputProjection.omittedBytes;
      if (workspaceInvalid) {
        error = callError("FAILED", `workspace contains non-serializable values at: ${outcome.workspaceInvalidPaths.join(", ")}`);
      } else if (answerEffectCount > 1) {
        error = callError("INVALID_RESULT", `cell submitted ${answerEffectCount} answer effects; exactly one is allowed`);
      } else if (answerEffectCount === 1) {
        if (!capturedAnswer?.ok) {
          error = callError("INVALID_RESULT", "answer value must be strict JSON");
        } else {
          const candidate = capturedAnswer.value;
          const answerErrors = validateOutputContract(candidate, frame.outputs);
          if (answerErrors.length > 0) {
            answerCandidate = { value: candidate, validationErrors: answerErrors };
            error = callError("INVALID_RESULT", outputContractErrorMessage(answerErrors));
          } else {
            try {
              const ref = await persistAnswer(
                state,
                `answer:${frame.frameId}:${iteration}`,
                candidate,
                (outputRef, outputRefBytes, outputRefSha256) => [...progressEffects, {
                  type: "cell_committed",
                  frameId: frame.frameId,
                  iteration,
                  reasoning: cell.reasoning,
                  codeHash: state.hasher(cell.code),
                  hasResult: outcome.hasResult,
                  outputPreview: preview,
                  outputBytes,
                  outputOmittedBytes,
                  usage: controllerUsage,
                  outputRef,
                  outputRefSha256,
                  outputRefBytes,
                }, {
                  type: "answer_committed",
                  frameId: frame.frameId,
                  completionMode: "answer",
                  outputRef,
                  outputSha256: outputRefSha256,
                  outputBytes: outputRefBytes,
                }],
                cellDeadline,
                signal,
              );
              if (signal?.aborted) return cancelled();
              entries = appendEntry(entries, { iteration, reasoning: cell.reasoning, code: cell.code, hasResult: outcome.hasResult, outputPreview: preview, outputBytes, outputOmittedBytes, outputRef: ref.id });
              return { answer: candidate, completionMode: "answer", exhausted: false };
            } catch (persistenceError) {
              if (signal?.aborted) return cancelled();
              if (!hasErrorCode(persistenceError, "BUDGET_BYTES")) throw persistenceError;
              answerCandidate = { value: candidate, validationErrors: [] };
              error = callError("BUDGET_BYTES", "answer output exceeds remaining stored-byte budget");
            }
          }
        }
      }
    }

    if (!error) await appendProgressEvents(state, progressEffects);

    entries = appendEntry(entries, {
      iteration,
      reasoning: cell.reasoning,
      code: cell.code,
      hasResult: outcome.kind === "value" ? outcome.hasResult : false,
      outputPreview: preview,
      outputBytes,
      outputOmittedBytes,
      usage: controllerUsage,
      ...(error ? { error } : {}),
      ...(answerCandidate ? { answerCandidate } : {}),
    });
    await state.journal.append({
      type: "cell_committed",
      frameId: frame.frameId,
      iteration,
      reasoning: cell.reasoning,
      codeHash: state.hasher(cell.code),
      hasResult: outcome.kind === "value" ? outcome.hasResult : false,
      outputPreview: preview,
      outputBytes,
      outputOmittedBytes,
      usage: controllerUsage,
      ...(error ? { error: errorInfo(error) } : {}),
    });
    if (signal?.aborted) return cancelled();
    lastOutcome = error ? { kind: "error", message: error.message } : { kind: "value", preview };
  }
};

const runChild = async (
  state: InternalRunState,
  parentFrame: FrameRef,
  parentController: ControllerDriver,
  args: JsonValue,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<GuestCallResult> => {
  if (!isJsonObject(args)) return errResult("call_recurse_invalid", callError("INVALID_REQUEST", "recurse spec must be an object"), ZERO_CALL_USAGE, false);
  const key = typeof args["key"] === "string" ? args["key"] : "recurse";
  const objective = typeof args["objective"] === "string" ? args["objective"] : "";
  const contexts = resolveContextRefs(state, args["context"], "context");
  const parentLineage = parentFrame.lineage ?? parentFrame.frameId;
  const identity: JsonValue = {
    parentLineage,
    objective,
    contexts: contexts.map((context) => context.sha256),
    profile: typeof args["profile"] === "string" ? args["profile"] : state.profile.name,
  };
  const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "recurse", key, identity });
  const recurseUsage = (): CallUsage => state.scopeUsage.get(callId) ?? ZERO_CALL_USAGE;
  const cancelled = (): GuestCallResult => errResult(callId, callError("CANCELLED", "cell epoch closed"), recurseUsage(), false);
  if (signal.aborted) return cancelled();
  if (objective.length === 0) return errResult(callId, callError("INVALID_REQUEST", "recurse requires an objective"), ZERO_CALL_USAGE, false);
  await bindKeys(state, [{ frame: parentFrame, kind: "recurse", key, identity }]);
  if (signal.aborted) return cancelled();

  const cached = state.callCache.get(callId);
  if (cached) return { ...cached, cached: true };
  const pending = state.inflight.get(callId);
  if (pending) {
    try {
      return { ...(await waitForAbort(pending, signal)), cached: true };
    } catch (error) {
      if (wasAborted(error, signal)) return cancelled();
      throw error;
    }
  }

  const inputs: Record<string, ContextDescriptor> = {};
  contexts.forEach((context, i) => {
    inputs[i === 0 ? "context" : `context${i + 1}`] = context;
  });

  let task!: Promise<GuestCallResult>;
  task = (async (): Promise<GuestCallResult> => {
    let logicalReserved = false;
    try {
      const reserved = reserveLogicalCall(state.ledger.current, state.clock.now());
      if (!reserved.ok) return errResult(callId, reserved.error, ZERO_CALL_USAGE, false);
      const opened = openFrame(reserved.value, parentFrame.depth + 1);
      if (!opened.ok) return errResult(callId, opened.error, ZERO_CALL_USAGE, false);
      state.ledger.current = opened.value;
      logicalReserved = true;

      state.scopeUsage.set(callId, ZERO_CALL_USAGE);
      const childFrameId = `${state.runId}:frame:${callId}`;
      await state.journal.append({ type: "frame_opened", frameId: childFrameId, parentFrameId: parentFrame.frameId, depth: parentFrame.depth + 1, objective });
      if (signal.aborted) return cancelled();

      const childFrame: FrameRef = {
        frameId: childFrameId,
        lineage: callId,
        depth: parentFrame.depth + 1,
        objective,
        inputs,
        outputs: [],
        usageScopes: [...(parentFrame.usageScopes ?? []), callId],
      };
      const childController = parentController.fork(objective, childFrameId);
      const result = await runFrame(state, childFrame, childController, signal, deadlineMs);
      if (signal.aborted || result.cancelled) return cancelled();

      const finalState = result.answer !== undefined ? "answered" : result.terminal ? "failed" : "closed";
      await state.journal.append({ type: "frame_closed", frameId: childFrameId, state: finalState });
      if (signal.aborted) return cancelled();

      const usage = recurseUsage();
      const childError = result.providerError
        ? result.providerError
        : result.terminal
          ? callError("FAILED", result.terminal.message)
          : undefined;
      const callResult = childError
        ? errResult(callId, childError, usage, false)
        : result.answer !== undefined
          ? okResult(callId, result.answer, usage, false)
          : errResult(callId, callError("FAILED", "child frame exhausted without an answer"), usage, false);
      const retained = await retainCallResult(state, callResult, {
        type: "call_committed",
        frameId: parentFrame.frameId,
        callId,
        kind: "recurse",
        key,
        cached: false,
        ok: callResult.ok,
        usage,
      }, signal, deadlineMs, callResult.ok);
      logicalReserved = false;
      return retained;
    } catch (error) {
      if (wasAborted(error, signal)) return cancelled();
      logicalReserved = false;
      if (error instanceof JournalAppendError) throw error;
      return errResult(callId, callError("FAILED", "child frame failed"), recurseUsage(), false);
    } finally {
      if (logicalReserved && signal.aborted) state.ledger.current = releaseLogicalCall(state.ledger.current);
      state.scopeUsage.delete(callId);
    }
  })();

  state.inflight.set(callId, task);
  try {
    return await task;
  } finally {
    if (state.inflight.get(callId) === task) state.inflight.delete(callId);
  }
};
