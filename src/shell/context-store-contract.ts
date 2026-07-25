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

/** Optional allocation observer for diagnostics and deterministic tests. */
export interface ContextStoreInstrumentation {
  readonly onMaterialize?: (descriptor: ContextDescriptor) => void;
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
  /** Release the reservation when its mutation does not commit. */
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
