export interface ContextDescriptor {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly tokenEstimator: string;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface ContextRead {
  readonly text: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly truncated: boolean;
}

export interface ContextMatch {
  readonly text: string;
  readonly line: number;
  readonly startByte: number;
  readonly contextId: string;
}

export interface ContextStoreLimits {
  readonly maxReadBytes: number;
  readonly maxLines: number;
  readonly maxLineBytes: number;
  readonly maxMatches: number;
  readonly maxChunks: number;
  readonly maxPatternBytes: number;
}

/** Optional allocation and persistence hooks for diagnostics and deterministic tests. */
export interface ContextStoreInstrumentation {
  readonly onMaterialize?: (descriptor: ContextDescriptor) => void;
  /** Guard every filesystem call. Managed runs use this to fence and revalidate pinned run identity. */
  readonly runFileSystemOperation?: <T>(path: string, effect: () => Promise<T>) => Promise<T>;
  readonly hasher?: (value: string | Uint8Array) => string;
  /** Write a new temporary payload. Implementations must reject an existing path. */
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly syncFile?: (path: string) => Promise<void>;
  /** Atomically publish oldPath at newPath without replacing an existing path. */
  readonly rename?: (oldPath: string, newPath: string) => Promise<void>;
  readonly syncDirectory?: (path: string) => Promise<void>;
  readonly unlink?: (path: string) => Promise<void>;
  readonly fileBytes?: (path: string) => Promise<number>;
}

export interface ContextContentReference {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
}

export const DEFAULT_CONTEXT_STORE_LIMITS: ContextStoreLimits = {
  maxReadBytes: 1024 * 1024,
  maxLines: 10_000,
  maxLineBytes: 64 * 1024,
  maxMatches: 1_000,
  maxChunks: 256,
  maxPatternBytes: 4 * 1024,
};

export interface ContextByteReservation {
  /** Finalize exactly one successful retained-byte mutation. */
  readonly commit?: () => void;
  /** Release part of an unsettled reservation while retaining the remainder. */
  release(bytes: number): void;
  /** Release the complete unsettled reservation when its mutation does not commit. */
  rollback(): void;
}

/** A staged context mutation. The store lock remains held until settlement. */
export interface ContextStoreTransaction<T> {
  readonly value: T;
  commit(): void;
  rollback(): Promise<void>;
}

/** Optional composition points for broker deadlines and atomic byte reservation. */
export interface ContextOperationControl {
  readonly checkpoint?: () => void;
  readonly maxOutputBytes?: number;
  readonly reserveBytes?: (bytes: number) => ContextByteReservation;
}

export class ContextUnavailableError extends Error {
  readonly code = "UNAVAILABLE_CONTEXT";
  constructor(id: string) {
    super(`context ${id} is unavailable`);
    this.name = "ContextUnavailableError";
  }
}

export type ContextIntegrityReason = "length" | "hash" | "type" | "containment";

export class ContextIntegrityError extends Error {
  readonly code = "CONTEXT_INTEGRITY_FAILED";
  constructor(readonly contextId: string, readonly reason: ContextIntegrityReason) {
    super(`context ${contextId} failed ${reason} verification`);
    this.name = "ContextIntegrityError";
  }
}

export class ContextSpecError extends Error {
  readonly code = "INVALID_SPEC";
  constructor(message: string) {
    super(message);
    this.name = "ContextSpecError";
  }
}

export class ContextChunkOverflowError extends ContextSpecError {
  constructor(produced: number, max: number) {
    super(`chunking requires at least ${produced} chunks which exceeds maxChunks ${max}`);
    this.name = "ContextChunkOverflowError";
  }
}

export class ContextBudgetError extends Error {
  readonly code = "BUDGET_BYTES";
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export interface ContextCleanupFailure {
  readonly path: string;
  readonly bytes: number;
  readonly cause: unknown;
}

/** A payload remains physically retained and charged after rollback cleanup failed. */
export class ContextCleanupError extends Error {
  readonly code = "CONTEXT_CLEANUP_FAILED";

  constructor(readonly failures: readonly ContextCleanupFailure[]) {
    super(`failed to remove ${failures.length} staged context payload${failures.length === 1 ? "" : "s"}`);
    this.name = "ContextCleanupError";
  }
}
