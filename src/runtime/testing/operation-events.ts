import type { RlmEvent } from "../../core/journal.ts";

export interface SettledOperation {
  readonly type: "operation_settled";
  readonly runId: string;
  readonly frameId: string;
  readonly operationId: string;
  readonly kind: Extract<RlmEvent, { type: "operation_intended" }>["kind"];
  readonly key: string;
  readonly attempt: number;
  readonly intentId: string;
  readonly requestIdentityVersion: string;
  readonly requestSha256: string;
  readonly reservation: Extract<RlmEvent, { type: "operation_intended" }>["reservation"];
  readonly outcome: Extract<RlmEvent, { type: "operation_settled" }>["outcome"];
  readonly usage: Extract<RlmEvent, { type: "operation_settled" }>["usage"];
  readonly errorCode?: string;
}

export const settledOperations = (events: readonly RlmEvent[]): SettledOperation[] => {
  const intents = new Map(events.filter((event): event is Extract<RlmEvent, { type: "operation_intended" }> =>
    event.type === "operation_intended").map((event) => [event.intentId, event]));
  return events.flatMap((event): SettledOperation[] => {
    if (event.type !== "operation_settled") return [];
    const intent = intents.get(event.intentId);
    if (!intent) return [];
    return [{
      type: "operation_settled",
      runId: event.runId,
      frameId: event.frameId,
      operationId: intent.operationId,
      kind: intent.kind,
      key: intent.key,
      attempt: intent.attempt,
      intentId: event.intentId,
      requestIdentityVersion: intent.requestIdentityVersion,
      requestSha256: intent.requestSha256,
      reservation: intent.reservation,
      outcome: event.outcome,
      usage: event.usage,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    }];
  });
};
