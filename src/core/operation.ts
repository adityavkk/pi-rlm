/** Pure identity and wire types for write-ahead external operations. */

import type { Hasher } from "./ids.ts";
import { canonicalStringify, type JsonValue } from "./json.ts";
import type { CallUsage } from "./usage.ts";

export const OPERATION_JOURNAL_SCHEMA_VERSION = 2;
export const PROVIDER_REQUEST_IDENTITY_VERSION = "pi-rlm.provider-request.v1";
export const AGENT_REQUEST_IDENTITY_VERSION = "pi-rlm.agent-request.v1";
export const EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION = "pi-rlm.external-extractor-request.v1";

export type OperationKind = "controller" | "llm" | "extractor" | "agent";
export type OperationRequestIdentityVersion =
  | typeof PROVIDER_REQUEST_IDENTITY_VERSION
  | typeof AGENT_REQUEST_IDENTITY_VERSION
  | typeof EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION;
export type OperationOutcome = "ok" | "error" | "cancelled" | "invalid_result";

/** Exact tree-wide capacity committed before one external request. */
export interface OperationReservation {
  readonly logicalCalls: 0 | 1;
  readonly attempts: 1;
  readonly tokens: number;
}

export interface OperationIntentIdentity {
  readonly schemaVersion: typeof OPERATION_JOURNAL_SCHEMA_VERSION;
  readonly runId: string;
  readonly frameId: string;
  readonly operationId: string;
  readonly kind: OperationKind;
  /** Durable linkage to the authoritative controller iteration, call binding, or extractor projection. */
  readonly key: string;
  readonly attempt: number;
  readonly requestIdentityVersion: OperationRequestIdentityVersion;
  readonly requestSha256: string;
  readonly reservation: OperationReservation;
}

export interface OperationIntendedEvent extends OperationIntentIdentity {
  readonly type: "operation_intended";
  readonly intentId: string;
}

export interface OperationSettledEvent {
  readonly type: "operation_settled";
  readonly schemaVersion: typeof OPERATION_JOURNAL_SCHEMA_VERSION;
  readonly runId: string;
  readonly frameId: string;
  readonly intentId: string;
  readonly outcome: OperationOutcome;
  readonly usage: CallUsage;
  readonly errorCode?: string;
}

const digest = (hasher: Hasher, input: string): string => {
  const value = hasher(input);
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new TypeError("operation intent hasher must return lowercase SHA-256");
  return value;
};

/** Identity binds scope, logical operation, exact request hash, attempt, and budget reservation. */
export const deriveOperationIntentId = (
  hasher: Hasher,
  identity: OperationIntentIdentity,
): string => `op_${digest(hasher, canonicalStringify(identity as unknown as JsonValue))}`;

export const operationRequestVersionAllowed = (
  kind: OperationKind,
  version: string,
): version is OperationRequestIdentityVersion => kind === "agent"
  ? version === AGENT_REQUEST_IDENTITY_VERSION
  : kind === "extractor"
    ? version === PROVIDER_REQUEST_IDENTITY_VERSION || version === EXTERNAL_EXTRACTOR_REQUEST_IDENTITY_VERSION
    : version === PROVIDER_REQUEST_IDENTITY_VERSION;
