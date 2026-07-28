import { isProxy } from "node:util/types";
import { sanitizeDisplayText } from "./run-display.ts";

export const RUN_COORDINATOR_MAX_PENDING_APPROVALS = 32;
const HASH = /^[a-f0-9]{64}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PendingAgentApprovalInput {
  readonly requestSha256: string;
  readonly agent: string;
  readonly taskSha256: string;
  readonly context: "fresh" | "fork";
  readonly model?: string;
  readonly thinking?: string;
}

/** Display-only projection. No task, session, path, call authority, or control token. */
export interface PendingAgentApprovalProjection {
  readonly requestSha256: string;
  readonly agent: string;
  readonly taskSha256: string;
  readonly context: "fresh" | "fork";
  readonly model?: string;
  readonly thinking?: string;
  readonly count: number;
}

export interface PendingAgentApprovalRegistration {
  /** Returns true only for the exact registration's first live settlement. */
  settle(): boolean;
}

interface PendingRecord extends Omit<PendingAgentApprovalProjection, "count"> {
  readonly localId: string;
  registrations: number;
}

const own = (value: object, key: string, optional = false): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (optional) return undefined;
    throw new TypeError(`pending approval ${key} is required`);
  }
  if (!("value" in descriptor)) throw new TypeError(`pending approval ${key} must be a data property`);
  return descriptor.value;
};

const safeOptional = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024) throw new TypeError("invalid routing field");
  const safe = sanitizeDisplayText(value, 256);
  return safe || undefined;
};

const prepare = (localId: string, input: PendingAgentApprovalInput): PendingRecord => {
  if (!input || typeof input !== "object" || isProxy(input)) throw new TypeError("invalid pending approval");
  const requestSha256 = own(input, "requestSha256");
  const taskSha256 = own(input, "taskSha256");
  const agent = own(input, "agent");
  const context = own(input, "context");
  if (typeof requestSha256 !== "string" || !HASH.test(requestSha256)
    || typeof taskSha256 !== "string" || !HASH.test(taskSha256)) throw new TypeError("invalid pending approval hash");
  if (typeof agent !== "string" || !AGENT.test(agent) || sanitizeDisplayText(agent, 128) !== agent)
    throw new TypeError("invalid pending approval agent");
  if (context !== "fresh" && context !== "fork") throw new TypeError("invalid pending approval context");
  const model = safeOptional(own(input, "model", true));
  const thinking = safeOptional(own(input, "thinking", true));
  return {
    localId,
    requestSha256,
    agent,
    taskSha256,
    context,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    registrations: 0,
  };
};

export interface PendingAgentApprovalRegistry {
  begin(localId: string, input: PendingAgentApprovalInput): PendingAgentApprovalRegistration | undefined;
  project(localId: string): PendingAgentApprovalProjection | undefined;
  clear(localId: string): boolean;
  clearAll(): boolean;
}

export const createPendingAgentApprovalRegistry = (): PendingAgentApprovalRegistry => {
  const pending = new Map<string, PendingRecord>();
  const keyFor = (localId: string, requestSha256: string): string => `${localId}\0${requestSha256}`;
  return {
    begin: (localId, input) => {
      let candidate: PendingRecord;
      try { candidate = prepare(localId, input); } catch { return undefined; }
      const key = keyFor(localId, candidate.requestSha256);
      let record = pending.get(key);
      if (!record) {
        if (pending.size >= RUN_COORDINATOR_MAX_PENDING_APPROVALS) return undefined;
        record = candidate;
        pending.set(key, record);
      }
      record.registrations += 1;
      let settled = false;
      return Object.freeze({
        settle: () => {
          if (settled) return false;
          settled = true;
          if (pending.get(key) !== record || record.registrations <= 0) return false;
          record.registrations -= 1;
          if (record.registrations === 0) pending.delete(key);
          return true;
        },
      });
    },
    project: (localId) => {
      let oldest: PendingRecord | undefined;
      let count = 0;
      for (const record of pending.values()) {
        if (record.localId !== localId) continue;
        oldest ??= record;
        count += 1;
      }
      if (!oldest) return undefined;
      return Object.freeze({
        requestSha256: oldest.requestSha256,
        agent: oldest.agent,
        taskSha256: oldest.taskSha256,
        context: oldest.context,
        ...(oldest.model ? { model: oldest.model } : {}),
        ...(oldest.thinking ? { thinking: oldest.thinking } : {}),
        count,
      });
    },
    clear: (localId) => {
      let changed = false;
      for (const [key, record] of pending) {
        if (record.localId !== localId) continue;
        pending.delete(key);
        changed = true;
      }
      return changed;
    },
    clearAll: () => {
      if (pending.size === 0) return false;
      pending.clear();
      return true;
    },
  };
};
