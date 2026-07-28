/** Pi/TUI-neutral ownership, aliases, cancellation, and terminal projection. */

import { randomBytes } from "node:crypto";
import type { RunProgressSnapshot, RunProgressSource } from "../runtime/run-progress.ts";
import type { RunResult } from "../runtime/run.ts";

export const RUN_COORDINATOR_MAX_ACTIVE = 16;
export const RUN_COORDINATOR_MAX_RECENT = 32;
export const RUN_COORDINATOR_MAX_SUBSCRIBERS = 32;
export const RUN_OBJECTIVE_PREVIEW_MAX_BYTES = 240;

const RUN_ID = /^run_[a-f0-9]{64}$/;
const RUN_NAME = /^run-[a-f0-9]{32}$/;
const SAFE_ALIAS = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_-]{0,63}$/;

export type CoordinatedRunState = "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface RunTerminalProjection {
  readonly status: "completed" | "failed" | "cancelled";
  readonly completionMode?: "answer" | "fallback_extract";
  readonly errorCode?: string;
  readonly warningCodes: readonly string[];
}

export interface CoordinatedRun {
  readonly localId: string;
  readonly runId?: string;
  readonly runName?: string;
  readonly sessionId: string;
  readonly authorizationGeneration: number;
  readonly objectivePreview: string;
  readonly state: CoordinatedRunState;
  readonly progress?: RunProgressSnapshot;
  readonly terminal?: RunTerminalProjection;
}

/** Local capability. It must never be copied into display/status projections. */
export interface LocalRunControl {
  readonly localId: string;
  readonly token: string;
}

export interface OwnedRunHandle {
  readonly control: LocalRunControl;
  readonly signal: AbortSignal;
  setObjective(objective: string): void;
  setPhase(phase: "source_capture" | "initializing" | "allocating"): CoordinatorMutationResult;
  bindRunName(runName: string): CoordinatorMutationResult;
  bindRunId(runId: string): CoordinatorMutationResult;
  attachProgress(source: RunProgressSource): void;
  observe(snapshot: RunProgressSnapshot): void;
  finish(result: RunResult): CoordinatorMutationResult;
  fail(status?: "failed" | "cancelled", errorCode?: string): CoordinatorMutationResult;
  cancel(): CoordinatorCancelResult;
}

export interface CoordinatorMutationResult {
  readonly ok: boolean;
  readonly code?: "RUN_NOT_FOUND" | "RUN_NOT_OWNED" | "RUN_TERMINAL" | "ALIAS_COLLISION" | "INVALID_ALIAS" | "IDENTITY_MISMATCH";
}

export interface CoordinatorCancelResult extends CoordinatorMutationResult {
  readonly requested?: boolean;
  readonly alreadyRequested?: boolean;
}

export interface RunCoordinatorOptions {
  readonly createLocalId?: () => string;
  readonly createControlToken?: () => string;
}

export interface RunCoordinator {
  setSession(sessionId: string, authorizationGeneration: number): void;
  invalidateSession(): void;
  create(input: {
    readonly sessionId: string;
    readonly authorizationGeneration: number;
    readonly objective: string;
    readonly ownerSignal?: AbortSignal;
  }): OwnedRunHandle;
  resolve(alias: string): CoordinatedRun | undefined;
  list(): readonly CoordinatedRun[];
  cancel(control: LocalRunControl): CoordinatorCancelResult;
  /** Host-only exact local alias lookup; never exposes the stored control token. */
  cancelLocalAlias(alias: string): CoordinatorCancelResult;
  subscribe(subscriber: (runs: readonly CoordinatedRun[]) => void): () => void;
}

interface RecordState {
  readonly localId: string;
  readonly controlToken: string;
  readonly controller: AbortController;
  readonly sessionId: string;
  readonly generation: number;
  objectivePreview: string;
  runId?: string;
  runName?: string;
  progress?: RunProgressSnapshot;
  progressSource?: RunProgressSource;
  identityConflict?: boolean;
  cancelRequested: boolean;
  terminal?: RunTerminalProjection;
  ownerSignal?: AbortSignal;
  ownerAbort?: () => void;
}

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");
const defaultLocalId = (): string => `rlm_${randomHex(8)}`;
const defaultControlToken = (): string => randomHex(32);

const coordinatorError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { name: "RunCoordinatorError", code });

const validSession = (value: string): boolean =>
  Buffer.byteLength(value, "utf8") <= 256 && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value);

/** Strip terminal controls and cut only at a UTF-8 code-point boundary. */
export const objectivePreview = (objective: string): string => {
  let result = "";
  let bytes = 0;
  for (const point of objective) {
    const safe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(point) ? " " : point;
    const size = Buffer.byteLength(safe, "utf8");
    if (size > RUN_OBJECTIVE_PREVIEW_MAX_BYTES - bytes) break;
    result += safe;
    bytes += size;
  }
  return result;
};

const freezeTerminal = (terminal: RunTerminalProjection): RunTerminalProjection => {
  Object.freeze(terminal.warningCodes);
  return Object.freeze(terminal);
};

const terminalProjection = (result: RunResult): RunTerminalProjection => freezeTerminal({
  status: result.status,
  ...(result.completionMode ? { completionMode: result.completionMode } : {}),
  ...(result.error?.code && SAFE_CODE.test(result.error.code) ? { errorCode: result.error.code } : {}),
  warningCodes: Object.freeze((result.warnings ?? [])
    .map(({ code }) => code)
    .filter((code) => SAFE_CODE.test(code))
    .slice(-8)),
});

const failedProjection = (status: "failed" | "cancelled", errorCode?: string): RunTerminalProjection =>
  freezeTerminal({
    status,
    ...(errorCode && SAFE_CODE.test(errorCode) ? { errorCode } : {}),
    warningCodes: Object.freeze([]),
  });

const sameControl = (record: RecordState, control: LocalRunControl): boolean =>
  record.localId === control.localId && record.controlToken === control.token;

const earlyProgress = (
  phase: "source_capture" | "initializing" | "allocating",
  sequence: number,
): RunProgressSnapshot => Object.freeze({
  sequence,
  phase,
  status: "running",
  elapsedMs: 0,
  calls: Object.freeze({ total: 0, active: 0, failed: 0, limit: 0 }),
  frames: Object.freeze({ total: 0, active: 0, limit: 0 }),
  budgets: Object.freeze({
    tokensUsed: 0, inputTokensUsed: 0, outputTokensUsed: 0, tokensReserved: 0,
    costUsd: 0, providerDurationMs: 0, storedBytes: 0, storedByteLimit: 0, deadlineMs: 0,
  }),
});

export const createRunCoordinator = (options: RunCoordinatorOptions = {}): RunCoordinator => {
  const createLocalId = options.createLocalId ?? defaultLocalId;
  const createControlToken = options.createControlToken ?? defaultControlToken;
  const active = new Map<string, RecordState>();
  const recent: RecordState[] = [];
  const aliases = new Map<string, RecordState>();
  const subscribers = new Set<(runs: readonly CoordinatedRun[]) => void>();
  let currentSession: { sessionId: string; generation: number } | undefined;
  let minimumGeneration = 0;

  const refresh = (record: RecordState): void => {
    if (!record.progressSource || record.terminal) return;
    try {
      const snapshot = record.progressSource.getSnapshot();
      if (snapshot.sequence >= (record.progress?.sequence ?? -1)) record.progress = snapshot;
      if (snapshot.runId) {
        if (!RUN_ID.test(snapshot.runId) || (record.runId !== undefined && record.runId !== snapshot.runId)) {
          record.identityConflict = true;
        } else if (!record.runId) {
          const collision = aliases.get(snapshot.runId);
          if (collision && collision !== record) record.identityConflict = true;
          else {
            record.runId = snapshot.runId;
            aliases.set(snapshot.runId, record);
          }
        }
      }
    } catch { /* A progress source has no ownership authority. */ }
  };

  const project = (record: RecordState): CoordinatedRun => {
    refresh(record);
    const state: CoordinatedRunState = record.terminal?.status
      ?? (record.cancelRequested ? "cancelling" : "running");
    return Object.freeze({
      localId: record.localId,
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.runName ? { runName: record.runName } : {}),
      sessionId: record.sessionId,
      authorizationGeneration: record.generation,
      objectivePreview: record.objectivePreview,
      state,
      ...(record.progress ? { progress: record.progress } : {}),
      ...(record.terminal ? { terminal: record.terminal } : {}),
    });
  };

  const listing = (): readonly CoordinatedRun[] => Object.freeze([
    ...[...active.values()].map(project),
    ...recent.map(project),
  ]);
  const notify = (): void => {
    if (subscribers.size === 0) return;
    const snapshot = listing();
    for (const subscriber of subscribers) {
      try { subscriber(snapshot); } catch { /* Subscribers cannot alter ownership. */ }
    }
  };

  const unbind = (record: RecordState): void => {
    for (const alias of [record.localId, record.runId, record.runName]) {
      if (alias && aliases.get(alias) === record) aliases.delete(alias);
    }
  };
  const detachOwner = (record: RecordState): void => {
    if (record.ownerSignal && record.ownerAbort)
      record.ownerSignal.removeEventListener("abort", record.ownerAbort);
    record.ownerSignal = undefined;
    record.ownerAbort = undefined;
  };
  const terminalize = (
    record: RecordState,
    terminal: RunTerminalProjection,
    refreshProgress = true,
  ): CoordinatorMutationResult => {
    if (record.terminal) return { ok: false, code: "RUN_TERMINAL" };
    if (refreshProgress) refresh(record);
    record.progressSource = undefined;
    record.terminal = terminal;
    active.delete(record.localId);
    detachOwner(record);
    recent.unshift(record);
    while (recent.length > RUN_COORDINATOR_MAX_RECENT) {
      const evicted = recent.pop();
      if (evicted) unbind(evicted);
    }
    notify();
    return { ok: true };
  };

  const owned = (control: LocalRunControl): RecordState | undefined => {
    const record = aliases.get(control.localId);
    return record && sameControl(record, control) ? record : undefined;
  };
  const bindAlias = (
    record: RecordState,
    alias: string,
    kind: "runId" | "runName",
    publish = true,
  ): CoordinatorMutationResult => {
    if (record.terminal) return { ok: false, code: "RUN_TERMINAL" };
    const valid = kind === "runId" ? RUN_ID.test(alias) : RUN_NAME.test(alias);
    if (!valid) return { ok: false, code: "INVALID_ALIAS" };
    const priorValue = record[kind];
    if (priorValue === alias) return { ok: true };
    if (priorValue !== undefined || (aliases.has(alias) && aliases.get(alias) !== record))
      return { ok: false, code: "ALIAS_COLLISION" };
    record[kind] = alias;
    aliases.set(alias, record);
    if (publish) notify();
    return { ok: true };
  };

  const cancel = (control: LocalRunControl): CoordinatorCancelResult => {
    const record = owned(control);
    if (!record) return { ok: false, code: aliases.has(control.localId) ? "RUN_NOT_OWNED" : "RUN_NOT_FOUND" };
    if (record.terminal) return { ok: false, code: "RUN_TERMINAL" };
    if (record.cancelRequested) return { ok: true, alreadyRequested: true };
    record.cancelRequested = true;
    record.controller.abort(new Error("locally owned run cancelled"));
    notify();
    return { ok: true, requested: true };
  };

  const coordinator: RunCoordinator = {
    setSession: (sessionId, generation) => {
      if (!validSession(sessionId) || !Number.isSafeInteger(generation) || generation < 0)
        throw coordinatorError("COORDINATOR_SESSION_INVALID", "invalid coordinator session binding");
      if (generation < minimumGeneration
        || (currentSession && generation < currentSession.generation)
        || (currentSession && generation === currentSession.generation && currentSession.sessionId !== sessionId))
        throw coordinatorError("COORDINATOR_STALE_GENERATION", "authorization generation is stale");
      if (currentSession && currentSession.generation !== generation) {
        for (const record of active.values()) cancel({ localId: record.localId, token: record.controlToken });
      }
      minimumGeneration = Math.max(minimumGeneration, generation);
      currentSession = { sessionId, generation };
    },
    invalidateSession: () => {
      for (const record of active.values()) cancel({ localId: record.localId, token: record.controlToken });
      if (currentSession) minimumGeneration = Math.max(minimumGeneration, currentSession.generation + 1);
      currentSession = undefined;
    },
    create: ({ sessionId, authorizationGeneration, objective, ownerSignal }) => {
      if (!currentSession || currentSession.sessionId !== sessionId
        || currentSession.generation !== authorizationGeneration)
        throw coordinatorError("COORDINATOR_STALE_GENERATION", "run does not match the current session generation");
      if (active.size >= RUN_COORDINATOR_MAX_ACTIVE)
        throw coordinatorError("COORDINATOR_ACTIVE_LIMIT", "active run limit reached");
      let localId = "";
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = createLocalId();
        if (SAFE_ALIAS.test(candidate) && !aliases.has(candidate)) { localId = candidate; break; }
      }
      if (!localId) throw coordinatorError("COORDINATOR_ID_COLLISION", "could not allocate a unique local run identity");
      const token = createControlToken();
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
        throw coordinatorError("COORDINATOR_TOKEN_INVALID", "invalid local control token");
      const controller = new AbortController();
      const record: RecordState = {
        localId,
        controlToken: token,
        controller,
        sessionId,
        generation: authorizationGeneration,
        objectivePreview: objectivePreview(objective),
        cancelRequested: false,
      };
      aliases.set(localId, record);
      active.set(localId, record);
      const control = Object.freeze({ localId, token });
      if (ownerSignal) {
        record.ownerSignal = ownerSignal;
        record.ownerAbort = () => { cancel(control); };
        if (ownerSignal.aborted) record.ownerAbort();
        else ownerSignal.addEventListener("abort", record.ownerAbort, { once: true });
      }
      const mutate = (operation: (ownedRecord: RecordState) => CoordinatorMutationResult): CoordinatorMutationResult => {
        const current = owned(control);
        return current ? operation(current) : { ok: false, code: "RUN_NOT_OWNED" };
      };
      const handle: OwnedRunHandle = Object.freeze({
        control,
        signal: controller.signal,
        setObjective: (value: string) => { mutate((current) => {
          if (current.terminal) return { ok: false, code: "RUN_TERMINAL" };
          current.objectivePreview = objectivePreview(value); notify(); return { ok: true };
        }); },
        setPhase: (value: "source_capture" | "initializing" | "allocating") => mutate((current) => {
          if (current.terminal) return { ok: false, code: "RUN_TERMINAL" };
          current.progressSource = undefined;
          current.progress = earlyProgress(value, (current.progress?.sequence ?? -1) + 1);
          notify();
          return { ok: true };
        }),
        bindRunName: (value: string) => mutate((current) => bindAlias(current, value, "runName")),
        bindRunId: (value: string) => mutate((current) => bindAlias(current, value, "runId")),
        attachProgress: (source: RunProgressSource) => { mutate((current) => {
          if (current.terminal) return { ok: false, code: "RUN_TERMINAL" };
          current.progressSource = source;
          current.progress = undefined;
          refresh(current); notify(); return { ok: true };
        }); },
        observe: (snapshot: RunProgressSnapshot) => { mutate((current) => {
          if (current.terminal) return { ok: false, code: "RUN_TERMINAL" };
          if (snapshot.sequence < (current.progress?.sequence ?? -1)) return { ok: true };
          current.progress = snapshot;
          if (snapshot.runId) {
            if (current.runId && current.runId !== snapshot.runId) current.identityConflict = true;
            else if (!current.runId) {
              const bound = bindAlias(current, snapshot.runId, "runId", false);
              if (!bound.ok) current.identityConflict = true;
            }
          }
          notify(); return { ok: true };
        }); },
        finish: (result: RunResult) => mutate((current) => {
          refresh(current);
          if (current.identityConflict || (current.runId !== undefined && current.runId !== result.runId))
            return { ok: false, code: "IDENTITY_MISMATCH" };
          if (!current.runId) {
            const bound = bindAlias(current, result.runId, "runId", false);
            if (!bound.ok) return bound;
          }
          return terminalize(current, terminalProjection(result), false);
        }),
        fail: (status: "failed" | "cancelled" = "failed", errorCode?: string) => mutate((current) =>
          terminalize(current, failedProjection(status, errorCode))),
        cancel: () => cancel(control),
      });
      notify();
      return handle;
    },
    resolve: (alias) => {
      if (!SAFE_ALIAS.test(alias)) return undefined;
      const record = aliases.get(alias);
      return record ? project(record) : undefined;
    },
    list: listing,
    cancel,
    cancelLocalAlias: (alias) => {
      if (!SAFE_ALIAS.test(alias)) return { ok: false, code: "RUN_NOT_FOUND" };
      const record = aliases.get(alias);
      if (!record || record.localId !== alias) return { ok: false, code: "RUN_NOT_FOUND" };
      return cancel({ localId: record.localId, token: record.controlToken });
    },
    subscribe: (subscriber) => {
      if (subscribers.size >= RUN_COORDINATOR_MAX_SUBSCRIBERS)
        throw coordinatorError("COORDINATOR_SUBSCRIBER_LIMIT", "subscriber limit reached");
      subscribers.add(subscriber);
      let activeSubscription = true;
      return () => {
        if (!activeSubscription) return;
        activeSubscription = false;
        subscribers.delete(subscriber);
      };
    },
  };
  return Object.freeze(coordinator);
};
