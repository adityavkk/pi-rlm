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
import { isJsonObject, type JsonValue } from "../core/json.ts";
import { headTailPreview } from "../core/preview.ts";
import { validateAgainstSchema } from "../core/schema.ts";
import { appendEntry, projectTrajectory, type TrajectoryEntry } from "../core/trajectory.ts";
import { validateWorkspace } from "../core/workspace.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import { transformCell } from "../core/cell.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";
import type { CellEvalOutcome } from "../shell/interpreter/backend.ts";
import { JournalAppendError } from "../shell/journal-store.ts";
import { waitForAbort, wasAborted } from "./abort.ts";
import { bindKeys, dispatchCall, resolveContextRefs, retainCallResult } from "./broker.ts";
import { persistAnswer } from "./answer-persistence.ts";
import { errResult, type GuestCallResult, okResult } from "./call-result.ts";
import type { Cell, ControllerDriver } from "./controller.ts";
import type { FrameRef, RunState } from "./state.ts";

export interface FrameResult {
  readonly answer?: JsonValue;
  readonly completionMode?: "answer";
  readonly exhausted: boolean;
  readonly terminal?: InterpreterError;
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

const validateAnswer = (candidate: JsonValue, frame: FrameRef): string[] => {
  if (frame.outputs.length === 0) return [];
  if (!isJsonObject(candidate)) return ["answer must be an object containing every declared output"];
  const errors: string[] = [];
  for (const field of frame.outputs) {
    if (!Object.prototype.hasOwnProperty.call(candidate, field.name)) {
      errors.push(`${field.name}: required output missing`);
      continue;
    }
    errors.push(...validateAgainstSchema(candidate[field.name] as JsonValue, field.schema, field.name));
  }
  return errors;
};

export const runFrame = async (
  state: RunState,
  frame: FrameRef,
  controller: ControllerDriver,
  signal: AbortSignal,
  ownerDeadlineMs = Number.POSITIVE_INFINITY,
): Promise<FrameResult> => {
  let workspace: JsonValue = {};
  let entries: readonly TrajectoryEntry[] = [];
  let lastOutcome: { kind: string; preview?: string; message?: string } | undefined;
  let phaseOrdinal = 0;
  let emitOrdinal = 0;

  const cancelled = (): FrameResult => ({ exhausted: false, cancelled: true, workspace, entries });
  const recurseFn = (args: JsonValue, cellSignal: AbortSignal, deadlineMs: number): Promise<GuestCallResult> =>
    runChild(state, frame, controller, args, cellSignal, deadlineMs);

  for (let iteration = 1; ; iteration++) {
    if (signal?.aborted) return cancelled();
    const turn = reserveControllerTurn(state.ledger.current, state.clock.now());
    if (!turn.ok)
      return turn.error.code === "DEADLINE"
        ? { exhausted: false, deadline: true, workspace, entries }
        : { exhausted: true, workspace, entries };
    state.ledger.current = turn.value;

    const projection = projectTrajectory(entries, state.profile.trajectory);
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
      }, signal), signal);
    } catch (error) {
      if (wasAborted(error, signal)) return cancelled();
      throw error;
    }
    if (signal?.aborted) return cancelled();

    const transformed = transformCell(cell.code);
    if (!transformed.ok) {
      entries = appendEntry(entries, {
        iteration,
        reasoning: cell.reasoning,
        code: cell.code,
        hasResult: false,
        outputPreview: "",
        error: transformed.error,
      });
      await state.journal.append({
        type: "cell_committed",
        frameId: frame.frameId,
        iteration,
        reasoning: cell.reasoning,
        codeHash: state.hasher(cell.code).slice(0, 16),
        hasResult: false,
        outputPreview: "",
        error: errorInfo(transformed.error),
      });
      if (signal?.aborted) return cancelled();
      lastOutcome = { kind: "parse_error", message: transformed.error.message };
      continue;
    }

    let answerEffectCount = 0;
    let capturedAnswer: CapturedAnswer | undefined;
    const effect = (name: string, args: JsonValue): void => {
      if (signal?.aborted) return;
      if (name === "answer") {
        answerEffectCount += 1;
        if (answerEffectCount === 1) capturedAnswer = captureAnswer(args);
      } else if (name === "phase" && isJsonObject(args)) {
        void state.journal.append({ type: "phase", frameId: frame.frameId, ordinal: phaseOrdinal++, name: String(args["name"]) }).catch(() => {});
      } else if (name === "emit" && isJsonObject(args)) {
        void state.journal.append({ type: "emit", frameId: frame.frameId, ordinal: emitOrdinal++, message: String(args["message"] ?? "") }).catch(() => {});
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
        codeHash: state.hasher(cell.code).slice(0, 16),
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

    let error: CallError | undefined;
    let preview = "";
    if (outcome.kind === "guest_error") {
      error = callError("FAILED", outcome.message);
    } else {
      preview = headTailPreview(safeStringify(outcome.result), {
        headBytes: state.profile.previewHeadBytes,
        tailBytes: state.profile.previewTailBytes,
      }).text;
      if (workspaceInvalid) {
        error = callError("FAILED", `workspace contains non-serializable values at: ${outcome.workspaceInvalidPaths.join(", ")}`);
      } else if (answerEffectCount > 1) {
        error = callError("INVALID_RESULT", `cell submitted ${answerEffectCount} answer effects; exactly one is allowed`);
      } else if (answerEffectCount === 1) {
        if (!capturedAnswer?.ok) {
          error = callError("INVALID_RESULT", "answer value must be strict JSON");
        } else {
          const candidate = capturedAnswer.value;
          const answerErrors = validateAnswer(candidate, frame);
          if (answerErrors.length > 0) {
            error = callError("INVALID_RESULT", `answer did not satisfy the output contract: ${answerErrors.join("; ")}`);
          } else {
            try {
              const ref = await persistAnswer(
                state,
                `answer:${frame.frameId}:${iteration}`,
                candidate,
                (outputRef) => [{
                  type: "cell_committed",
                  frameId: frame.frameId,
                  iteration,
                  reasoning: cell.reasoning,
                  codeHash: state.hasher(cell.code).slice(0, 16),
                  hasResult: outcome.hasResult,
                  outputPreview: preview,
                  outputRef,
                }, {
                  type: "answer_committed",
                  frameId: frame.frameId,
                  completionMode: "answer",
                  outputRef,
                }],
                cellDeadline,
                signal,
              );
              if (signal?.aborted) return cancelled();
              entries = appendEntry(entries, { iteration, reasoning: cell.reasoning, code: cell.code, hasResult: outcome.hasResult, outputPreview: preview, outputRef: ref.id });
              return { answer: candidate, completionMode: "answer", exhausted: false };
            } catch (persistenceError) {
              if (signal?.aborted) return cancelled();
              if (!hasErrorCode(persistenceError, "BUDGET_BYTES")) throw persistenceError;
              error = callError("BUDGET_BYTES", "answer output exceeds remaining stored-byte budget");
            }
          }
        }
      }
    }

    entries = appendEntry(entries, {
      iteration,
      reasoning: cell.reasoning,
      code: cell.code,
      hasResult: outcome.kind === "value" ? outcome.hasResult : false,
      outputPreview: preview,
      ...(error ? { error } : {}),
    });
    await state.journal.append({
      type: "cell_committed",
      frameId: frame.frameId,
      iteration,
      reasoning: cell.reasoning,
      codeHash: state.hasher(cell.code).slice(0, 16),
      hasResult: outcome.kind === "value" ? outcome.hasResult : false,
      outputPreview: preview,
      ...(error ? { error: errorInfo(error) } : {}),
    });
    if (signal?.aborted) return cancelled();
    lastOutcome = error ? { kind: "error", message: error.message } : { kind: "value", preview };
  }
};

const runChild = async (
  state: RunState,
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
  const identity: JsonValue = {
    objective,
    contexts: contexts.map((context) => context.sha256),
    profile: typeof args["profile"] === "string" ? args["profile"] : state.profile.name,
  };
  const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "recurse", key, identity });
  const cancelled = (): GuestCallResult => errResult(callId, callError("CANCELLED", "cell epoch closed"), ZERO_CALL_USAGE, false);
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

      const childFrameId = `${state.runId}:f${state.frameSeq.current++}`;
      await state.journal.append({ type: "frame_opened", frameId: childFrameId, parentFrameId: parentFrame.frameId, depth: parentFrame.depth + 1, objective });
      if (signal.aborted) return cancelled();

      const childFrame: FrameRef = { frameId: childFrameId, depth: parentFrame.depth + 1, objective, inputs, outputs: [] };
      const childController = parentController.fork(objective, childFrameId);
      const result = await runFrame(state, childFrame, childController, signal, deadlineMs);
      if (signal.aborted || result.cancelled) return cancelled();

      const finalState = result.answer !== undefined ? "answered" : result.terminal ? "failed" : "closed";
      await state.journal.append({ type: "frame_closed", frameId: childFrameId, state: finalState });
      if (signal.aborted) return cancelled();

      const callResult = result.terminal
        ? errResult(callId, callError("FAILED", result.terminal.message), ZERO_CALL_USAGE, false)
        : result.answer !== undefined
          ? okResult(callId, result.answer, ZERO_CALL_USAGE, false)
          : errResult(callId, callError("FAILED", "child frame exhausted without an answer"), ZERO_CALL_USAGE, false);
      const retained = await retainCallResult(state, callResult, {
        type: "call_committed",
        frameId: parentFrame.frameId,
        callId,
        kind: "recurse",
        key,
        cached: false,
        ok: callResult.ok,
        usage: ZERO_CALL_USAGE,
      }, signal, deadlineMs);
      logicalReserved = false;
      return retained;
    } catch (error) {
      if (wasAborted(error, signal)) return cancelled();
      logicalReserved = false;
      if (error instanceof JournalAppendError) throw error;
      return errResult(callId, callError("FAILED", "child frame failed"), ZERO_CALL_USAGE, false);
    } finally {
      if (logicalReserved && signal.aborted) state.ledger.current = releaseLogicalCall(state.ledger.current);
    }
  })();

  state.inflight.set(callId, task);
  try {
    return await task;
  } finally {
    if (state.inflight.get(callId) === task) state.inflight.delete(callId);
  }
};
