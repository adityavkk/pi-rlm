/** Pure semantic validation for one parsed recovery journal snapshot. */

import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  AGENT_REQUEST_IDENTITY_VERSION,
  EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION,
  PROVIDER_REQUEST_IDENTITY_VERSION,
} from "../core/operation.ts";
import { addUsage, normalizeCallUsage, type CallUsage, ZERO_CALL_USAGE } from "../core/usage.ts";
import { normalizeProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import type { RunManifestDocument } from "./run-manifest.ts";
import { RunRecoveryError } from "./run-recovery-types.ts";

type TerminalEvent = Extract<RlmEvent, { type: "run_completed" | "run_failed" | "run_cancelled" }>;
type AnswerEvent = Extract<RlmEvent, { type: "answer_committed" }>;
type CallEvent = Extract<RlmEvent, { type: "call_committed" }>;
type CheckpointEvent = Extract<RlmEvent, { type: "checkpoint_committed" }>;
export interface RecoveryContentReference {
  readonly role: "input" | "workspace" | "call" | "answer" | "checkpoint";
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly event?: CallEvent | AnswerEvent | CheckpointEvent;
}

export interface RecoveryJournalModel {
  readonly rootFrameId: string;
  readonly terminal?: TerminalEvent;
  readonly rootAnswer?: AnswerEvent;
  readonly content: readonly RecoveryContentReference[];
  readonly committedCells: number;
  readonly committedCalls: number;
}

type OperationIntent = Extract<RlmEvent, { type: "operation_intended" }>;
type OperationSettlement = Extract<RlmEvent, { type: "operation_settled" }>;

interface OperationSegment {
  readonly intents: OperationIntent[];
  readonly outcomes: OperationSettlement[];
  usage: CallUsage;
  settlements: number;
}

interface OperationRecord {
  readonly kind: OperationIntent["kind"];
  readonly key: string;
  readonly segments: OperationSegment[];
  lastAttempt: number;
  lastIntentId: string;
}

interface OperationAttemptRecord {
  readonly operation: OperationRecord;
  readonly segment: OperationSegment;
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

const recoveryKeyRegistryId = (runId: string, event: Extract<RlmEvent, { type: "key_bound" }>): string => {
  if (event.kind !== "recurse") return `${event.kind}\0${event.key}`;
  if (event.frameId === `${runId}:f0`) return `${event.kind}\0${event.frameId}\0${event.key}`;
  const prefix = `${runId}:frame:`;
  const match = event.frameId.startsWith(prefix)
    ? /^(call_recurse_[a-f0-9]{64}):e[1-9][0-9]*$/.exec(event.frameId.slice(prefix.length))
    : null;
  if (!match?.[1]) return semanticError("recurse key binding has an invalid frame lineage");
  return `${event.kind}\0${match[1]}\0${event.key}`;
};

const operationKeyRegistryId = (kind: "llm" | "agent", key: string): string => `${kind}\0${key}`;

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
  event?: CallEvent | AnswerEvent | CheckpointEvent,
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
  const intents = new Map<string, OperationIntent>();
  const settlements = new Map<string, OperationSettlement>();
  const attemptIntents = new Map<string, OperationIntent>();
  const attemptRecords = new Map<string, OperationAttemptRecord>();
  const operations = new Map<string, OperationRecord>();
  const controllerOperations = new Set<string>();
  let committedControllerTurns = 0;
  let logicalCalls = 0;
  let attempts = 0;
  let tokensReserved = 0;
  let tokensUsed = 0;
  let childFrames = 0;
  let checkpointSequence = 0;
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
        if (event.depth !== parent.opened.depth + 1 || event.depth > document.manifest.limits.maxDepth)
          semanticError("invalid child frame depth");
        childFrames += 1;
        logicalCalls += 1;
        if (childFrames > document.manifest.limits.maxFrames
          || logicalCalls > document.manifest.limits.maxLogicalCalls)
          semanticError("frame reservations exceed manifest limits");
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
        if (event.iteration > document.manifest.limits.maxControllerTurns)
          semanticError("committed cells exceed the manifest turn limit");
        const key = `${event.frameId}\0${event.iteration}`;
        if (rememberExact(cells, key, event, "cell")) {
          committedControllerTurns += 1;
          if (committedControllerTurns > document.manifest.limits.maxControllerTurns)
            semanticError("committed cells exceed the global manifest turn limit");
          if (event.iteration !== frame.cells.size + 1) semanticError("cell iterations are not contiguous");
          frame.cells.set(event.iteration, event);
          const controller = operations.get(`${event.frameId}\0${event.frameId}:controller:${event.iteration}`);
          const segment = controller?.segments.at(-1);
          if (controller && (controller.kind !== "controller" || controller.segments.length !== 1
            || !segment || segment.settlements !== segment.intents.length))
            semanticError("cell controller operation is incomplete");
          if (!same(event.usage ?? ZERO_CALL_USAGE, segment?.usage ?? ZERO_CALL_USAGE))
            semanticError("cell usage does not match controller settlements");
          if (event.outputRef !== undefined)
            content.push(reference("answer", event.outputRef, event.outputRefSha256, event.outputRefBytes));
        }
        break;
      }
      case "key_bound":
        rememberExact(keys, recoveryKeyRegistryId(runId, event), event, "key binding");
        break;
      case "agent_approval":
        rememberExact(approvals, `${event.frameId}\0${event.callId}`, event, "agent approval");
        break;
      case "operation_intended": {
        if (event.runId !== runId)
          throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "operation intent run does not match the manifest");
        if (intents.has(event.intentId)) semanticError("duplicate operation intent");

        const reservation = event.reservation;
        attempts += reservation.attempts;
        logicalCalls += reservation.logicalCalls;
        if (attempts > document.manifest.limits.maxAttempts
          || logicalCalls > document.manifest.limits.maxLogicalCalls)
          semanticError("operation reservations exceed manifest limits");
        if (tokensReserved > Number.MAX_SAFE_INTEGER - reservation.tokens)
          semanticError("operation token reservations overflow");
        const nextReserved = tokensReserved + reservation.tokens;
        if (document.manifest.limits.tokenLimit !== undefined
          && tokensUsed > document.manifest.limits.tokenLimit - nextReserved)
          semanticError("operation token reservations exceed the manifest token limit");
        tokensReserved = nextReserved;

        if (event.requestIdentityVersion === AGENT_REQUEST_IDENTITY_VERSION
          || event.requestIdentityVersion === EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION) {
          if (reservation.tokens !== 0) semanticError("opaque operation has a token reservation");
        } else if (event.requestIdentityVersion === PROVIDER_REQUEST_IDENTITY_VERSION && reservation.tokens === 0) {
          semanticError("provider operation lacks a token reservation");
        }

        if (event.kind === "controller") {
          const iteration = frame.cells.size + 1;
          if (event.operationId !== `${event.frameId}:controller:${iteration}` || event.key !== String(iteration)
            || event.requestIdentityVersion !== PROVIDER_REQUEST_IDENTITY_VERSION)
            semanticError("controller operation does not match its authoritative turn");
          if (!controllerOperations.has(event.operationId)) {
            controllerOperations.add(event.operationId);
            if (controllerOperations.size > document.manifest.limits.maxControllerTurns)
              semanticError("controller operations exceed the manifest turn limit");
          }
        } else if (event.kind === "extractor") {
          if (event.frameId !== rootFrameId || event.operationId !== `${runId}:extractor`
            || event.key !== frame.fallbackProjection?.projectionHash
            || document.manifest.components.extractor === null)
            semanticError("extractor operation lacks its authoritative fallback projection");
        } else {
          const expectedPrefix = event.kind === "llm" ? "call_llm_" : "call_agent_";
          const binding = keys.get(operationKeyRegistryId(event.kind, event.key));
          const expectedCallId = binding ? `${expectedPrefix}${sha256(canonicalStringify({
            runId,
            kind: event.kind,
            key: event.key,
            identityHash: binding.identityHash,
          }))}` : undefined;
          if (event.operationId !== expectedCallId)
            semanticError("call operation lacks its authoritative key binding");
          if (event.kind === "llm" && event.requestIdentityVersion !== PROVIDER_REQUEST_IDENTITY_VERSION)
            semanticError("llm operation has an invalid request protocol");
          if (event.kind === "agent") {
            const approval = approvals.get(`${event.frameId}\0${event.operationId}`);
            if (event.requestIdentityVersion !== AGENT_REQUEST_IDENTITY_VERSION
              || !approval || approval.decision === "denied")
              semanticError("agent operation lacks prior approval");
          }
        }

        const operationKey = `${event.frameId}\0${event.operationId}`;
        let operation = operations.get(operationKey);
        if (operation && (operation.kind !== event.kind || operation.key !== event.key))
          semanticError("operation identity changed between attempts");
        const attemptKey = `${operationKey}\0${event.attempt}`;
        if (attemptIntents.has(attemptKey)) semanticError("duplicate operation attempt intent");
        if (operation ? event.attempt !== operation.lastAttempt + 1 : event.attempt !== 1)
          semanticError("operation attempts are not contiguous");
        if (operation && !settlements.has(operation.lastIntentId))
          semanticError("operation launched another attempt before prior settlement");
        if (!operation && reservation.logicalCalls !== 1)
          semanticError("first operation attempt lacks a logical-call reservation");
        if (event.kind === "agent" && reservation.logicalCalls !== 1)
          semanticError("agent attempt lacks a logical-call reservation");

        let segment: OperationSegment;
        if (reservation.logicalCalls === 1) {
          segment = { intents: [], outcomes: [], usage: ZERO_CALL_USAGE, settlements: 0 };
          if (!operation) operation = { kind: event.kind, key: event.key, segments: [], lastAttempt: 0, lastIntentId: "" };
          operation.segments.push(segment);
        } else {
          segment = operation?.segments.at(-1) as OperationSegment;
          if (!segment) semanticError("operation attempt has no logical-call segment");
        }
        operation!.lastAttempt = event.attempt;
        operation!.lastIntentId = event.intentId;
        segment.intents.push(event);
        intents.set(event.intentId, event);
        attemptIntents.set(attemptKey, event);
        attemptRecords.set(event.intentId, { operation: operation!, segment });
        operations.set(operationKey, operation!);
        break;
      }
      case "operation_settled": {
        if (event.runId !== runId)
          throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "operation settlement run does not match the manifest");
        const intent = intents.get(event.intentId);
        const attempt = attemptRecords.get(event.intentId);
        if (!intent || !attempt)
          throw new RunRecoveryError("RECOVERY_SEMANTIC_CORRUPTION", "operation settlement has no prior intent");
        if (intent.frameId !== event.frameId) semanticError("operation settlement frame does not match its intent");
        if (settlements.has(event.intentId)) semanticError("duplicate operation settlement");
        const normalized = normalizeCallUsage(event.usage);
        const parts = (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        if (!normalized.ok || (event.usage.totalTokens !== undefined && parts > event.usage.totalTokens))
          semanticError("operation settlement usage is invalid");
        if (tokensReserved < intent.reservation.tokens) semanticError("operation token settlement exceeds reservations");
        const actualTokens = event.usage.totalTokens ?? parts;
        if (tokensUsed > Number.MAX_SAFE_INTEGER - actualTokens) semanticError("operation token usage overflows");
        tokensReserved -= intent.reservation.tokens;
        tokensUsed += actualTokens;
        const combined = addUsage(attempt.segment.usage, event.usage);
        if (combined.ok) attempt.segment.usage = combined.value;
        else semanticError("operation settlement usage aggregate is invalid");
        attempt.segment.settlements += 1;
        attempt.segment.outcomes.push(event);
        settlements.set(event.intentId, event);
        break;
      }
      case "checkpoint_committed": {
        if (event.runId !== runId || event.manifestHash !== document.manifestHash || event.frameId !== rootFrameId)
          throw new RunRecoveryError("RECOVERY_IDENTITY_MISMATCH", "checkpoint identity does not match the run manifest");
        if (event.checkpointSequence !== checkpointSequence + 1)
          semanticError("checkpoint sequences are not contiguous");
        if (event.nextIteration !== (frames.get(rootFrameId)?.cells.size ?? 0) + 1
          || event.nextControllerTurn !== committedControllerTurns + 1)
          semanticError("checkpoint continuation does not match the next controller turn");
        if ([...intents.keys()].some((intentId) => !settlements.has(intentId)) || tokensReserved !== 0)
          semanticError("checkpoint was committed with an unsettled external operation");
        const openFrames = [...frames.values()].filter((candidate) => !candidate.closed);
        if (openFrames.length !== 1 || openFrames[0]?.opened.frameId !== rootFrameId)
          semanticError("checkpoint was not committed at a quiescent root-frame boundary");
        checkpointSequence = event.checkpointSequence;
        content.push(reference(
          "checkpoint",
          event.checkpointRef,
          event.checkpointSha256,
          event.checkpointBytes,
          event,
        ));
        break;
      }
      case "call_committed": {
        const binding = event.kind === "llm" || event.kind === "agent"
          ? keys.get(operationKeyRegistryId(event.kind, event.key))
          : keys.get(recoveryKeyRegistryId(runId, event as unknown as Extract<RlmEvent, { type: "key_bound" }>));
        if (!binding || event.cached) semanticError("committed call lacks one prior key binding");
        const executions = calls.get(event.callId) ?? [];
        const prior = executions.at(-1);
        if (prior && same(prior, event)) break;
        if (prior && (prior.frameId !== event.frameId || prior.kind !== event.kind || prior.key !== event.key
          || prior.ok)) semanticError("invalid repeated call execution");
        if (event.kind === "llm" || event.kind === "agent") {
          const expectedCallId = `call_${event.kind}_${sha256(canonicalStringify({
            runId,
            kind: event.kind,
            key: event.key,
            identityHash: binding!.identityHash,
          }))}`;
          const operation = operations.get(`${event.frameId}\0${event.callId}`);
          const segment = operation?.segments.at(-1);
          if (event.callId !== expectedCallId || !event.ok || operation?.kind !== event.kind || !segment
            || segment.settlements !== segment.intents.length || segment.outcomes.at(-1)?.outcome !== "ok"
            || !same(event.usage, segment.usage))
            semanticError("committed call identity or usage does not match authoritative operation settlements");
        }
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

  const unresolved = [...intents.keys()].filter((intentId) => !settlements.has(intentId));
  if (unresolved.length > 0)
    throw new RunRecoveryError("RECOVERY_AMBIGUOUS", "one or more external operation intents have no authoritative settlement");
  if (tokensReserved !== 0) semanticError("settled operation journal retains token reservations");

  return {
    rootFrameId,
    ...(terminal ? { terminal } : {}),
    ...(root?.answer ? { rootAnswer: root.answer } : {}),
    content,
    committedCells: cells.size,
    committedCalls: calls.size,
  };
};
