/** Atomic mutations of the tree-wide logical retained-byte ledger. */

import { releaseBytes, reserveBytes, type Ledger } from "../core/budget.ts";
import type { CallError } from "../core/errors.ts";
import type { JsonValue } from "../core/json.ts";
import { canonicalStringify } from "../core/json.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { ContextByteReservation } from "../shell/context-store.ts";

export interface StoredByteReservation extends ContextByteReservation {
  commit(): void;
}

/** Reserve synchronously before any retained map, store, or file mutation. */
export const reserveStoredBytes = (
  ledger: { current: Ledger },
  bytes: number,
): Result<StoredByteReservation, CallError> => {
  const reserved = reserveBytes(ledger.current, bytes);
  if (!reserved.ok) return err(reserved.error);
  ledger.current = reserved.value;
  let active = true;
  return ok({
    commit: () => {
      if (!active) return;
      active = false;
    },
    rollback: () => {
      if (!active) return;
      active = false;
      ledger.current = releaseBytes(ledger.current, bytes);
    },
  });
};

export const remainingStoredBytes = (ledger: Ledger): number =>
  Math.max(0, ledger.limits.storedByteLimit - ledger.usage.storedBytes);

/** Canonical logical size of one retained call-cache snapshot. */
export const retainedJsonBytes = (value: JsonValue): number =>
  Buffer.byteLength(canonicalStringify(value), "utf8");
