/** Pure semantic validation for one parsed recovery journal snapshot. */

import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import { normalizeProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import type { RunManifestDocument } from "./run-manifest.ts";
import { RunRecoveryError } from "./run-recovery-types.ts";

type TerminalEvent = Extract<RlmEvent, { type: "run_completed" | "run_failed" | "run_cancelled" }>;
type AnswerEvent = Extract<RlmEvent, { type: "answer_committed" }>;
type CallEvent = Extract<RlmEvent, { type: "call_committed" }>;
export interface RecoveryContentReference {
  readonly role: "input" | "workspace" | "call" | "answer";
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly event?: CallEvent | AnswerEvent;
}

export interface RecoveryJournalModel {
  readonly rootFrameId: string;
  readonly terminal?: TerminalEvent;
  readonly rootAnswer?: AnswerEvent;
  readonly content: readonly RecoveryContentReference[];
  readonly committedCells: number;
  readonly committedCalls: number;
}

interface FrameRecord {
  readonly opened: Extract<RlmEvent, { type: "frame_opened" }>;
  readonly cells: Map<number, Extract<RlmEvent, { type: "cell_committed" }>>;
  readonly workspaces: Map<number, Extract<RlmEvent, { type: "workspace_committed" }>>;
  readonly progress: Map<string, Extract<RlmEvent, { type: "phase" | "emit" }>>;
  answer?: AnswerEvent;
  fallbackProjection?: Extract<RlmEvent, { type: "fallback_evidence_projected" }>;
  fallbackCitation?: Extract<RlmEvent, { type: "fallback_evidence_cited" }>;
  closed?: Extract<RlmEvent, { type: "frame_closed" }>;
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalStringify(left as JsonValue) === canonicalStringify(right as JsonValue);

const semanticError = (message: string): never => {
  throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", message);
};

const rememberExact = <K, T>(registry: Map<K, T>, key: K, event: T, label: string): boolean => {
  const existing = registry.get(key);
  if (!existing) {
    registry.set(key, event);
    return true;
  }
  if (!same(existing, event)) semanticError(`conflicting ${label} event`);
  return false;
};

const reference = (
  role: RecoveryContentReference["role"],
  id: string | undefined,
  digest: string | undefined,
  bytes: number | undefined,
  event?: CallEvent | AnswerEvent,
): RecoveryContentReference => {
  if (id === undefined || digest === undefined || bytes === undefined || id !== `ctx_${digest}`)
    throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", `${role} event lacks complete content identity`);
  return { role, id, sha256: digest, bytes, ...(event ? { event } : {}) };
};

/** Strict semantic fold. It does not trust the lossy status projection. */
export const validateRecoveryJournal = (
  document: RunManifestDocument,
  events: readonly RlmEvent[],
): RecoveryJournalModel => {
  const runId = document.manifest.run.id;
  const rootFrameId = `${runId}:f0`;
  if (events.length === 0 || events[0]?.type !== "run_started")
    semanticError("journal does not begin with run_started");
  const starts = events.filter((event) => event.type === "run_started");
  if (starts.length !== 1) semanticError("journal must contain exactly one run_started event");
  const start = starts[0]!;
  if (start.runId !== runId || start.manifestHash !== document.manifestHash)
    throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "journal start does not match the manifest");
  if (!same(start.limits, document.manifest.limits))
    throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "journal limits do not match the manifest");
  if (!start.inputRefs || start.inputRefs.length !== document.manifest.inputs.length)
    throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "journal inputs do not match the manifest");

  const content: RecoveryContentReference[] = [];
  start.inputRefs.forEach((item, index) => {
    const expected = document.manifest.inputs[index];
    if (!expected || item.name !== expected.name || item.sha256 !== expected.sha256 || item.bytes !== expected.bytes
      || item.id !== `ctx_${expected.sha256}`)
      throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "journal inputs do not match the manifest");
    content.push({ role: "input", id: item.id, sha256: item.sha256, bytes: item.bytes });
  });

  const normalized = normalizeProgram(document.manifest.program);
  if (!normalized.ok)
    throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", "manifest program cannot be normalized");
  const program = normalized.value;
  const frames = new Map<string, FrameRecord>();
  const cells = new Map<string, Extract<RlmEvent, { type: "cell_committed" }>>();
  const calls = new Map<string, CallEvent[]>();
  const keys = new Map<string, Extract<RlmEvent, { type: "key_bound" }>>();
  const approvals = new Map<string, Extract<RlmEvent, { type: "agent_approval" }>>();
  const attemptEvents = new Map<string, Extract<RlmEvent, { type: "provider_attempted" }>>();
  const operations = new Map<string, {
    readonly kind: Extract<RlmEvent, { type: "provider_attempted" }>["kind"];
    readonly key: string;
    lastAttempt: number;
  }>();
  let terminal: TerminalEvent | undefined;

  const requireFrame = (frameId: string): FrameRecord => {
    const frame = frames.get(frameId);
    if (!frame) throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", "event references an unopened frame");
    if (frame.closed) semanticError("event follows frame closure");
    return frame;
  };

  for (let index = 1; index < events.length; index++) {
    const event = events[index]!;
    if (terminal) semanticError("event follows the run terminal");
    if (event.type === "run_started") semanticError("duplicate run_started event");
    if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled") {
      if (event.runId !== runId)
        throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "run terminal does not match the manifest");
      terminal = event;
      continue;
    }
    if (event.type === "frame_opened") {
      if (!event.frameId.startsWith(`${runId}:`)) semanticError("frame identity is outside the run");
      const existing = frames.get(event.frameId);
      if (existing) {
        if (!same(existing.opened, event)) semanticError("conflicting frame_opened event");
        continue;
      }
      if (event.parentFrameId === null) {
        if (event.frameId !== rootFrameId || event.depth !== 0 || event.objective !== program.objective
          || frames.has(rootFrameId)) semanticError("invalid root frame");
      } else {
        const parent = requireFrame(event.parentFrameId);
        if (event.depth !== parent.opened.depth + 1) semanticError("invalid child frame depth");
      }
      frames.set(event.frameId, { opened: event, cells: new Map(), workspaces: new Map(), progress: new Map() });
      continue;
    }

    const frameId = "frameId" in event ? event.frameId : undefined;
    if (frameId === undefined)
      throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", "event has no frame identity");
    const frame = requireFrame(frameId);
    switch (event.type) {
      case "phase":
      case "emit": {
        const key = `${event.iteration}\0${event.ordinal}`;
        rememberExact(frame.progress, key, event, "progress");
        if (event.iteration !== frame.cells.size + 1) semanticError("progress iteration is not the next cell");
        break;
      }
      case "workspace_committed": {
        if (event.iteration !== frame.cells.size + 1) semanticError("workspace iteration is not the next cell");
        if (rememberExact(frame.workspaces, event.iteration, event, "workspace"))
          content.push(reference("workspace", event.workspaceRef, event.workspaceSha256, event.workspaceBytes));
        break;
      }
      case "cell_committed": {
        const key = `${event.frameId}\0${event.iteration}`;
        if (rememberExact(cells, key, event, "cell")) {
          if (event.iteration !== frame.cells.size + 1) semanticError("cell iterations are not contiguous");
          frame.cells.set(event.iteration, event);
          if (event.outputRef !== undefined)
            content.push(reference("answer", event.outputRef, event.outputRefSha256, event.outputRefBytes));
        }
        break;
      }
      case "key_bound":
        rememberExact(keys, `${event.frameId}\0${event.kind}\0${event.key}`, event, "key binding");
        break;
      case "agent_approval":
        rememberExact(approvals, `${event.frameId}\0${event.callId}`, event, "agent approval");
        break;
      case "provider_attempted": {
        const operationKey = `${event.frameId}\0${event.operationId}`;
        const operation = operations.get(operationKey);
        if (operation && (operation.kind !== event.kind || operation.key !== event.key))
          semanticError("provider operation identity changed between attempts");
        const attemptKey = `${operationKey}\0${event.attempt}`;
        const existingAttempt = attemptEvents.get(attemptKey);
        if (existingAttempt) {
          if (!same(existingAttempt, event)) semanticError("conflicting provider attempt event");
          break;
        }
        if (operation ? event.attempt !== operation.lastAttempt + 1 : event.attempt !== 1)
          semanticError("provider attempts are not contiguous");
        attemptEvents.set(attemptKey, event);
        operations.set(operationKey, {
          kind: event.kind, key: event.key, lastAttempt: event.attempt,
        });
        break;
      }
      case "call_committed": {
        const binding = keys.get(`${event.frameId}\0${event.kind}\0${event.key}`);
        if (!binding || event.cached) semanticError("committed call lacks one prior key binding");
        const executions = calls.get(event.callId) ?? [];
        const prior = executions.at(-1);
        if (prior && same(prior, event)) break;
        if (prior && (prior.frameId !== event.frameId || prior.kind !== event.kind || prior.key !== event.key
          || prior.ok)) semanticError("invalid repeated call execution");
        executions.push(event);
        calls.set(event.callId, executions);
        content.push(reference("call", event.outputRef, event.outputSha256, event.outputBytes, event));
        break;
      }
      case "answer_committed":
        if (frame.answer && !same(frame.answer, event)) semanticError("conflicting frame answer");
        if (!frame.answer) {
          if (event.completionMode === "answer") {
            const cell = frame.cells.get(frame.cells.size);
            if (!cell || cell.outputRef !== event.outputRef || cell.outputRefSha256 !== event.outputSha256
              || cell.outputRefBytes !== event.outputBytes) semanticError("answer does not match its committed cell");
          } else if (!frame.fallbackProjection || !frame.fallbackCitation) {
            semanticError("fallback answer lacks its projection and evidence citations");
          }
          frame.answer = event;
          content.push(reference("answer", event.outputRef, event.outputSha256, event.outputBytes, event));
        }
        break;
      case "frame_closed":
        if (event.state === "open") semanticError("frame_closed cannot retain open state");
        for (const child of frames.values()) {
          if (child.opened.parentFrameId === event.frameId && !child.closed)
            semanticError("parent frame closed before its child");
        }
        frame.closed = event;
        break;
      case "fallback_evidence_projected":
        if (event.frameId !== rootFrameId || frame.fallbackProjection || frame.answer
          || event.projectedBytes > event.maxBytes
          || event.truncated !== (event.omittedBytes > 0 || event.omittedItems > 0 || event.truncatedItems > 0))
          semanticError("invalid fallback evidence projection");
        frame.fallbackProjection = event;
        break;
      case "fallback_evidence_cited":
        if (event.frameId !== rootFrameId || !frame.fallbackProjection || frame.fallbackCitation
          || new Set(event.evidenceRefs).size !== event.evidenceRefs.length
          || event.evidenceRefs.length > frame.fallbackProjection.evidenceIdCount
          || event.evidenceRefsHash !== sha256(JSON.stringify(event.evidenceRefs)))
          semanticError("invalid fallback evidence citation");
        frame.fallbackCitation = event;
        break;
      case "run_started":
        semanticError("duplicate run_started event");
        break;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  }

  for (const frame of frames.values()) {
    for (const [iteration, cell] of frame.cells) {
      const interpreterFailure = cell.error !== undefined
        && ["CPU_LIMIT", "HEAP_LIMIT", "WORKER_EXIT", "JOURNAL_CORRUPT", "LATE_CALLBACK", "UNHANDLED_REJECTION", "PARSE_ERROR", "DISPOSED"].includes(cell.error.code);
      if (!interpreterFailure && !frame.workspaces.has(iteration))
        semanticError("evaluated cell lacks a committed workspace");
      if (cell.outputRef !== undefined && (!frame.answer || frame.answer.completionMode !== "answer"
        || frame.answer.outputRef !== cell.outputRef)) semanticError("output-bearing cell lacks its answer event");
    }
    for (const iteration of frame.workspaces.keys()) {
      if (!frame.cells.has(iteration) && (terminal || iteration !== frame.cells.size + 1))
        semanticError("workspace has no matching cell boundary");
    }
  }

  const root = frames.get(rootFrameId);
  if (terminal) {
    for (const frame of frames.values()) if (!frame.closed) semanticError("terminal run has an open frame");
    if (terminal.type === "run_completed") {
      const childExecutions = new Map<string, Array<{ ordinal: number; frame: FrameRecord }>>();
      for (const frame of frames.values()) {
        if (frame.opened.parentFrameId === null) continue;
        const prefix = `${runId}:frame:`;
        const suffix = frame.opened.frameId.startsWith(prefix) ? frame.opened.frameId.slice(prefix.length) : "";
        const match = /^(call_recurse_[a-f0-9]{64}):e([1-9][0-9]*)$/.exec(suffix);
        if (!match)
          throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", "completed child frame has an invalid execution identity");
        const grouped = childExecutions.get(match[1]!) ?? [];
        grouped.push({ ordinal: Number(match[2]), frame });
        childExecutions.set(match[1]!, grouped);
      }
      for (const [callId, executions] of calls) {
        const last = executions.at(-1)!;
        if (last.kind !== "recurse") continue;
        const children = (childExecutions.get(callId) ?? []).sort((left, right) => left.ordinal - right.ordinal);
        if (children.length !== executions.length) semanticError("recurse call executions do not match child frames");
        children.forEach((child, index) => {
          const call = executions[index]!;
          if (child.ordinal !== index + 1 || call.frameId !== child.frame.opened.parentFrameId
            || call.kind !== "recurse" || call.ok !== (child.frame.closed?.state === "answered"))
            semanticError("recurse call execution does not match its child frame");
        });
        childExecutions.delete(callId);
      }
      if (childExecutions.size > 0) semanticError("completed child frame lacks its recurse call execution");
      if (!root?.answer || root.closed?.state !== "answered" || root.answer.completionMode !== terminal.completionMode
        || terminal.outputRef === undefined || terminal.outputRef !== root.answer.outputRef)
        throw new RunRecoveryError("RECOVERY_TERMINAL_INCONSISTENT", "completed terminal lacks one matching root answer");
    } else if (terminal.type === "run_cancelled" && root && root.closed?.state !== "cancelled") {
      throw new RunRecoveryError("RECOVERY_TERMINAL_INCONSISTENT", "cancelled terminal has inconsistent root state");
    } else if (terminal.type === "run_failed" && root && root.closed?.state !== "failed") {
      throw new RunRecoveryError("RECOVERY_TERMINAL_INCONSISTENT", "failed terminal has inconsistent root state");
    }
  }

  return {
    rootFrameId,
    ...(terminal ? { terminal } : {}),
    ...(root?.answer ? { rootAnswer: root.answer } : {}),
    content,
    committedCells: cells.size,
    committedCalls: calls.size,
  };
};
