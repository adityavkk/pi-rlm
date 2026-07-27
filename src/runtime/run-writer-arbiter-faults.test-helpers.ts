import { basename } from "node:path";
import {
  nodeImmutablePublisherFileSystem,
  type ImmutablePublisherFileSystem,
} from "./run-writer-publisher.ts";

export type IntentFaultMode = "preapply" | "partial-write";
export type IntentRecordType = "generation" | "release";

export interface OneShotIntentFault {
  readonly fileSystem: ImmutablePublisherFileSystem;
  readonly state: { fired: boolean };
}

export const oneShotIntentFault = (
  recordType: IntentRecordType,
  mode: IntentFaultMode,
): OneShotIntentFault => {
  const state = { fired: false };
  const prefix = recordType === "generation" ? "gen-" : "rel-";
  const fileSystem: ImmutablePublisherFileSystem = {
    ...nodeImmutablePublisherFileSystem,
    async createExclusive(path, requestedMode) {
      const matches = basename(path).startsWith(prefix);
      if (matches && !state.fired && mode === "preapply") {
        state.fired = true;
        throw new Error(`fault before ${recordType} intent open`);
      }
      const handle = await nodeImmutablePublisherFileSystem.createExclusive(path, requestedMode);
      if (!matches || state.fired || mode !== "partial-write") return handle;
      return {
        ...handle,
        async write(bytes) {
          state.fired = true;
          await handle.write(bytes.subarray(0, 7));
          throw new Error(`partial ${recordType} intent write`);
        },
      };
    },
  };
  return { fileSystem, state };
};
