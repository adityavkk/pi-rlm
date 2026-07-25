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

import { budgetView, openFrame, reserveControllerTurn } from "../core/budget.ts";
import { type CallError, callError, type InterpreterError } from "../core/errors.ts";
import { deriveCallId } from "../core/ids.ts";
import { isJsonObject, type JsonValue } from "../core/json.ts";
import { headTailPreview } from "../core/preview.ts";
import { validateAgainstSchema } from "../core/schema.ts";
import { appendEntry, projectTrajectory, type TrajectoryEntry } from "../core/trajectory.ts";
import { validateWorkspace } from "../core/workspace.ts";
import { ZERO_CALL_USAGE } from "../core/usage.ts";
import { transformCell } from "../core/cell.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";
import { dispatchCall } from "./broker.ts";
import { errResult, type GuestCallResult, okResult } from "./call-result.ts";
import type { ControllerDriver } from "./controller.ts";
import type { FrameRef, RunState } from "./state.ts";

export interface FrameResult {
  readonly answer?: JsonValue;
  readonly completionMode?: "answer";
  readonly exhausted: boolean;
  readonly terminal?: InterpreterError;
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
): Promise<FrameResult> => {
  let workspace: JsonValue = {};
  let entries: readonly TrajectoryEntry[] = [];
  let lastOutcome: { kind: string; preview?: string; message?: string } | undefined;
  let phaseOrdinal = 0;
  let emitOrdinal = 0;

  const recurseFn = (args: JsonValue, _signal: AbortSignal): Promise<GuestCallResult> => runChild(state, frame, controller, args);

  for (let iteration = 1; ; iteration++) {
    const turn = reserveControllerTurn(state.ledger.current, state.clock.now());
    if (!turn.ok) return { exhausted: true, workspace, entries };
    state.ledger.current = turn.value;

    const projection = projectTrajectory(entries, state.profile.trajectory);
    const cell = await controller.next({
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
    });

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
      lastOutcome = { kind: "parse_error", message: transformed.error.message };
      continue;
    }

    let answered = false;
    let candidate: JsonValue | undefined;
    const effect = (name: string, args: JsonValue): void => {
      if (name === "answer" && isJsonObject(args)) {
        answered = true;
        candidate = args["value"] as JsonValue;
      } else if (name === "phase" && isJsonObject(args)) {
        void state.journal.append({ type: "phase", frameId: frame.frameId, ordinal: phaseOrdinal++, name: String(args["name"]) });
      } else if (name === "emit" && isJsonObject(args)) {
        void state.journal.append({ type: "emit", frameId: frame.frameId, ordinal: emitOrdinal++, message: String(args["message"] ?? "") });
      }
    };

    const cellDeadline = Math.min(state.clock.now() + state.profile.cellWallMs, state.ledger.current.limits.deadlineMs);
    const outcome = await state.backend.evalCell({
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
      dispatch: (n, a, signal) => dispatchCall(state, frame, n, a, recurseFn, signal),
      effect,
    });

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
      } else if (answered && candidate !== undefined) {
        const answerErrors = validateAnswer(candidate, frame);
        if (answerErrors.length === 0) {
          const ref = await state.store.derive({ key: `answer:${frame.frameId}:${iteration}`, value: candidate });
          entries = appendEntry(entries, { iteration, reasoning: cell.reasoning, code: cell.code, hasResult: outcome.hasResult, outputPreview: preview, outputRef: ref.id });
          await state.journal.append({
            type: "cell_committed",
            frameId: frame.frameId,
            iteration,
            reasoning: cell.reasoning,
            codeHash: state.hasher(cell.code).slice(0, 16),
            hasResult: outcome.hasResult,
            outputPreview: preview,
            outputRef: ref.id,
          });
          await state.journal.append({ type: "answer_committed", frameId: frame.frameId, completionMode: "answer", outputRef: ref.id });
          return { answer: candidate, completionMode: "answer", exhausted: false };
        }
        error = callError("INVALID_RESULT", `answer did not satisfy the output contract: ${answerErrors.join("; ")}`);
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
    lastOutcome = error ? { kind: "error", message: error.message } : { kind: "value", preview };
  }
};

const runChild = async (
  state: RunState,
  parentFrame: FrameRef,
  parentController: ControllerDriver,
  args: JsonValue,
): Promise<GuestCallResult> => {
  if (!isJsonObject(args)) return errResult("call_recurse_invalid", callError("INVALID_REQUEST", "recurse spec must be an object"), ZERO_CALL_USAGE, false);
  const key = typeof args["key"] === "string" ? args["key"] : "recurse";
  const objective = typeof args["objective"] === "string" ? args["objective"] : "";
  const callId = deriveCallId(state.hasher, { runId: state.runId, kind: "recurse", key, identity: args });
  if (objective.length === 0) return errResult(callId, callError("INVALID_REQUEST", "recurse requires an objective"), ZERO_CALL_USAGE, false);

  const refs = Array.isArray(args["context"]) ? args["context"] : args["context"] !== undefined ? [args["context"]] : [];
  const inputs: Record<string, ContextDescriptor> = {};
  refs.forEach((ref, i) => {
    if (isJsonObject(ref) && typeof ref["id"] === "string") {
      const desc = state.store.get(ref["id"]);
      if (desc) inputs[i === 0 ? "context" : `context${i + 1}`] = desc;
    }
  });

  const opened = openFrame(state.ledger.current, parentFrame.depth + 1);
  if (!opened.ok) return errResult(callId, opened.error, ZERO_CALL_USAGE, false);
  state.ledger.current = opened.value;

  const childFrameId = `${state.runId}:f${state.frameSeq.current++}`;
  await state.journal.append({ type: "frame_opened", frameId: childFrameId, parentFrameId: parentFrame.frameId, depth: parentFrame.depth + 1, objective });

  const childFrame: FrameRef = { frameId: childFrameId, depth: parentFrame.depth + 1, objective, inputs, outputs: [] };
  const childController = parentController.fork(objective, childFrameId);
  const result = await runFrame(state, childFrame, childController);

  const finalState = result.answer !== undefined ? "answered" : result.terminal ? "failed" : "closed";
  await state.journal.append({ type: "frame_closed", frameId: childFrameId, state: finalState });

  if (result.terminal) return errResult(callId, callError("FAILED", result.terminal.message), ZERO_CALL_USAGE, false);
  if (result.answer !== undefined) return okResult(callId, result.answer, ZERO_CALL_USAGE, false);
  return errResult(callId, callError("FAILED", "child frame exhausted without an answer"), ZERO_CALL_USAGE, false);
};
