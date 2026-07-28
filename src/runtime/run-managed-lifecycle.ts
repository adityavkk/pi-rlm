/** Internal capability bridge. Not exported from the public runtime surface. */

import type { LeaseOwnedRunPersistence } from "./run-writer-mutation.ts";

export const MANAGED_RUN_PERSISTENCE = Symbol("pi-rlm.managed-run-persistence");
export const MANAGED_RUN_RESUME = Symbol("pi-rlm.managed-run-resume");

export interface ManagedRunResumeBinding {
  readonly runId: string;
  readonly runName: string;
}

export interface ManagedRunPersistenceCarrier {
  readonly [MANAGED_RUN_PERSISTENCE]?: LeaseOwnedRunPersistence;
  readonly [MANAGED_RUN_RESUME]?: ManagedRunResumeBinding;
}

export const managedRunPersistence = (
  lifecycle: ManagedRunPersistenceCarrier,
): LeaseOwnedRunPersistence => {
  const persistence = lifecycle[MANAGED_RUN_PERSISTENCE];
  if (!persistence) throw new TypeError("managed lifecycle has no internal persistence capability");
  return persistence;
};
