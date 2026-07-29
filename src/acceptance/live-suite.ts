import type { LiveConsent, LiveAcceptanceReport } from "./live-contract.ts";

export interface LiveSuiteInput {
  readonly consent: LiveConsent;
  readonly canaries: readonly string[];
}

export class LiveSuiteError extends Error {
  readonly code = "SUITE_NOT_IMPLEMENTED" as const;
  constructor() {
    super("live provider acceptance suite is not implemented");
    this.name = "LiveSuiteError";
  }
}

/** Phase 1 seam. Phase 2 replaces this body with provider orchestration. */
export const runLiveProviderAcceptanceSuite = async (_input: LiveSuiteInput): Promise<LiveAcceptanceReport> => {
  throw new LiveSuiteError();
};
