import type { SubagentDelegationV2Cancel } from "pi-subagents/delegation";
import {
  DELEGATION_V2_LIMITS,
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
  isDelegationV2Started,
  normalizeDelegationV2Request,
  parseDelegationV2Terminal,
  parseDelegationV2Update,
  type DelegationEventBus,
  type DelegationIdentity,
  type DelegationV2CallSpec,
  type DelegationV2Outcome,
  type DelegationV2Update,
} from "./protocol.ts";

const DEFAULT_DELEGATION_TIMEOUT_MS = 30 * 60 * 1_000;

export interface DelegationV2RunOptions {
  readonly signal?: AbortSignal;
  readonly startTimeoutMs?: number;
  readonly onUpdate?: (update: DelegationV2Update) => void | Promise<void>;
}

const failure = (
  code: Exclude<DelegationV2Outcome, { ok: true }>["code"],
  status: string,
): DelegationV2Outcome => ({ ok: false, code, status });

const validTimeout = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= DELEGATION_V2_LIMITS.maxDurationMs
    ? value
    : fallback;

export class DelegationV2Client {
  constructor(private readonly events: DelegationEventBus) {}

  run(spec: DelegationV2CallSpec, options: DelegationV2RunOptions = {}): Promise<DelegationV2Outcome> {
    const normalized = normalizeDelegationV2Request(spec);
    if (!normalized.ok) return Promise.resolve(failure("INVALID_REQUEST", "invalid_request"));
    if (options.signal?.aborted) return Promise.resolve(failure("CANCELLED", "cancelled"));

    const request = normalized.value;
    const identity: DelegationIdentity = {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
    };
    const requestedResult = request.result.kind;
    const timeoutMs = validTimeout(request.timeoutMs, DEFAULT_DELEGATION_TIMEOUT_MS);
    const startTimeoutMs = Math.min(
      timeoutMs,
      validTimeout(options.startTimeoutMs, DELEGATION_V2_LIMITS.defaultStartTimeoutMs),
    );

    return new Promise<DelegationV2Outcome>((resolve) => {
      const unsubscribe: Array<() => void> = [];
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let requestEmitted = false;
      let cancelEmitted = false;
      let updateCount = 0;

      const cancel: SubagentDelegationV2Cancel = {
        version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
        requestId: identity.requestId,
        ownerRunId: identity.ownerRunId,
        nodeId: identity.nodeId,
      };

      const cleanup = (): void => {
        if (startTimer !== undefined) clearTimeout(startTimer);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        try {
          options.signal?.removeEventListener("abort", onAbort);
        } catch {}
        for (const remove of unsubscribe.splice(0).reverse()) {
          try { remove(); } catch {}
        }
      };

      const emitCancel = (): void => {
        if (!requestEmitted || cancelEmitted) return;
        cancelEmitted = true;
        try { this.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, cancel); } catch {}
      };

      const settle = (outcome: DelegationV2Outcome, cancelRemote = false): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancelRemote) emitCancel();
        resolve(outcome);
      };

      const onAbort = (): void => settle(failure("CANCELLED", "cancelled"), true);
      const onStarted = (data: unknown): void => {
        if (!requestEmitted || !isDelegationV2Started(data, identity)) return;
        if (startTimer !== undefined) {
          clearTimeout(startTimer);
          startTimer = undefined;
        }
      };
      const onUpdate = (data: unknown): void => {
        if (!requestEmitted || settled || updateCount >= DELEGATION_V2_LIMITS.maxUpdates || options.onUpdate === undefined) return;
        const update = parseDelegationV2Update(data, identity);
        if (update === undefined) return;
        updateCount += 1;
        try {
          const pending = options.onUpdate(update);
          if (pending && typeof pending.then === "function") void pending.catch(() => {});
        } catch {}
      };
      const onResponse = (data: unknown): void => {
        if (!requestEmitted || settled) return;
        const parsed = parseDelegationV2Terminal(data, identity, requestedResult);
        if (parsed.kind === "unrelated") return;
        if (parsed.kind === "invalid") {
          settle(failure("INVALID_RESULT", "invalid_result"), true);
          return;
        }
        settle(parsed.value);
      };

      const subscribe = (channel: string, handler: (data: unknown) => void): boolean => {
        try {
          const remove = this.events.on(channel, handler);
          if (typeof remove !== "function") return false;
          if (settled) {
            try { remove(); } catch {}
          } else unsubscribe.push(remove);
          return true;
        } catch {
          return false;
        }
      };

      if (!subscribe(SUBAGENT_DELEGATION_RESPONSE_EVENT, onResponse)
        || !subscribe(SUBAGENT_DELEGATION_STARTED_EVENT, onStarted)
        || !subscribe(SUBAGENT_DELEGATION_UPDATE_EVENT, onUpdate)) {
        settle(failure("UNAVAILABLE_CONTEXT", "unavailable_context"));
        return;
      }
      try {
        options.signal?.addEventListener("abort", onAbort, { once: true });
      } catch {
        settle(failure("CANCELLED", "cancelled"));
        return;
      }
      if (options.signal?.aborted) {
        settle(failure("CANCELLED", "cancelled"));
        return;
      }

      startTimer = setTimeout(
        () => settle(failure("UNAVAILABLE_CONTEXT", "unavailable_context"), true),
        startTimeoutMs,
      );
      deadlineTimer = setTimeout(
        () => settle(failure("TIMEOUT", "timed_out"), true),
        timeoutMs,
      );

      requestEmitted = true;
      try {
        this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
      } catch {
        settle(failure("UNAVAILABLE_CONTEXT", "unavailable_context"), true);
      }
    });
  }
}
