/** Internal test-only capabilities for managed lifecycle fault and race injection. */

import type { ContextStoreInstrumentation } from "../shell/context-store-contract.ts";
import type { JournalFileSystem } from "../shell/journal-store.ts";
import type { RunDirectoryFileSystem } from "./run-manifest.ts";
import type {
  ManagedRunStoreOptions,
  RunRetentionMetadataFileSystem,
} from "./run-retention.ts";
import type { RunWriterArbiterOptions } from "./run-writer-arbiter.ts";
import type { PrivateDirectoryFileSystem } from "./run-writer-directory.ts";
import type { RunQuarantineFileSystem } from "./run-writer-quarantine.ts";

export const MANAGED_RUN_STORE_FAULTS = Symbol("pi-rlm.managed-run-store.test-faults");

export interface ManagedRunStoreFaultOptions {
  readonly now?: () => number;
  readonly createToken?: () => string;
  readonly processProbe?: (pid: number) => boolean | undefined;
  readonly metadataFileSystem?: RunRetentionMetadataFileSystem;
  readonly removeDirectory?: (path: string) => Promise<void>;
  readonly beforeCleanupDecision?: (path: string) => Promise<void>;
  readonly afterCleanupAcquisition?: (path: string) => Promise<void>;
  readonly writerArbiterOptions?: RunWriterArbiterOptions;
  readonly quarantineFileSystem?: RunQuarantineFileSystem;
  readonly directoryFileSystem?: PrivateDirectoryFileSystem;
  readonly runDirectoryFileSystem?: RunDirectoryFileSystem;
  readonly journalFileSystem?: JournalFileSystem;
  readonly contextStoreInstrumentation?: ContextStoreInstrumentation;
}

export type ManagedRunStoreTestOptions = ManagedRunStoreOptions & ManagedRunStoreFaultOptions;

/** Build an options object carrying non-public capabilities under an unexported runtime symbol. */
export const managedRunStoreTestOptions = (
  options: ManagedRunStoreTestOptions,
): ManagedRunStoreOptions => ({
  ...(options.root !== undefined ? { root: options.root } : {}),
  ...(options.policy !== undefined ? { policy: options.policy } : {}),
  [MANAGED_RUN_STORE_FAULTS]: options,
} as ManagedRunStoreOptions);
