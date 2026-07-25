/** JSON shapes returned to the guest for value-returning bridge calls. */

import type { CallError, CallErrorDetails } from "../core/errors.ts";
import type { JsonValue } from "../core/json.ts";
import type { CallUsage } from "../core/usage.ts";

export interface GuestCallResult {
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean; readonly details?: CallErrorDetails };
  readonly callId: string;
  readonly usage: CallUsage;
  readonly cached: boolean;
  readonly outputRef?: string;
}

export const okResult = (
  callId: string,
  value: JsonValue,
  usage: CallUsage,
  cached: boolean,
  outputRef?: string,
): GuestCallResult => ({ ok: true, value, callId, usage, cached, ...(outputRef ? { outputRef } : {}) });

export const errResult = (
  callId: string,
  error: CallError,
  usage: CallUsage,
  cached: boolean,
): GuestCallResult => ({
  ok: false,
  error: {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details ? { details: error.details } : {}),
  },
  callId,
  usage,
  cached,
});
