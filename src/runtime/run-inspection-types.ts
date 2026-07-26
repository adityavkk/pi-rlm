import type { BudgetLimits } from "../core/budget.ts";
import type { CompletionMode, FrameState } from "../core/journal.ts";
import type { CallKind } from "../core/ids.ts";
import type { CallUsage } from "../core/usage.ts";

export const RUN_INSPECTION_VERSION = 1 as const;
export const DEFAULT_RUN_INSPECTION_PAGE_SIZE = 50;
export const MAX_RUN_INSPECTION_PAGE_SIZE = 200;
export const MAX_RUN_INSPECTION_PAGE_BYTES = 256 * 1024;
export const MAX_RUN_INSPECTION_AGGREGATE_ITEMS = 10_000;
export const MAX_RUN_INSPECTION_EVENTS = 100_000;
export const MAX_RUN_INSPECTION_CURSOR_BYTES = 4096;

export type RunInspectionView = "summary" | "frames" | "cells" | "calls" | "budget" | "errors";

export interface RunInspectionRequest {
  readonly version: typeof RUN_INSPECTION_VERSION;
  /** Managed directory name, never a filesystem path or caller-provided run directory. */
  readonly runName: string;
  readonly view: RunInspectionView;
  readonly frameId?: string;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface RunInspectionOptions {
  /** Optional host cursor key. A process-private random key is used by default. */
  readonly cursorKey?: Uint8Array;
}

export type RunInspectionErrorCode =
  | "RUN_INSPECTION_INVALID_REQUEST"
  | "RUN_INSPECTION_RUN_NOT_FOUND"
  | "RUN_INSPECTION_INVALID_CURSOR"
  | "RUN_INSPECTION_LIMIT";

export class RunInspectionError extends Error {
  override readonly name = "RunInspectionError";
  constructor(readonly code: RunInspectionErrorCode, message: string, override readonly cause?: unknown) {
    super(message);
  }
}

/** Non-secret identity for guest/provider-controlled text. */
export interface RunInspectionTextIdentity {
  readonly sha256: string;
  readonly bytes: number;
}

export interface RunInspectionErrorMetadata {
  /** Present only for a fixed host-owned error taxonomy. */
  readonly trustedCode?: string;
  readonly code: RunInspectionTextIdentity;
  readonly message?: RunInspectionTextIdentity;
}

export interface RunInspectionSummaryItem {
  readonly kind: "summary";
  readonly status: "nonterminal" | "completed" | "failed" | "cancelled";
  readonly rootFrameId: string;
  readonly eventCount: number;
  readonly frames: number;
  readonly cells: number;
  readonly committedCalls: number;
  readonly observedProviderAttempts: number;
  readonly completionMode?: CompletionMode;
  readonly error?: RunInspectionErrorMetadata;
}

export interface RunInspectionFrameItem {
  readonly kind: "frame";
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly depth: number;
  readonly state: FrameState;
  readonly cells: number;
  readonly committedCalls: number;
  readonly phase?: RunInspectionTextIdentity;
}

export interface RunInspectionCellItem {
  readonly kind: "cell";
  readonly frameId: string;
  readonly iteration: number;
  readonly codeHash: string;
  readonly hasResult: boolean;
  readonly outputBytes?: number;
  readonly outputOmittedBytes?: number;
  readonly committedOutputBytes?: number;
  readonly usage?: CallUsage;
  readonly error?: RunInspectionErrorMetadata;
}

export interface RunInspectionCallItem {
  readonly kind: "call";
  readonly frameId: string;
  readonly callId: string;
  readonly callKind: CallKind;
  readonly key: RunInspectionTextIdentity;
  readonly executions: number;
  readonly ok: boolean;
  readonly usage: CallUsage;
  readonly outputSha256?: string;
  readonly outputBytes?: number;
  readonly observedProviderAttempts: number;
  readonly lastOutcome?: "ok" | "error" | "cancelled" | "invalid_result";
  readonly errorCode?: RunInspectionTextIdentity;
}

/** Event-derived lower bounds. Exact ledger recovery belongs to resumable checkpoints. */
export interface RunInspectionObservedUsage {
  readonly frames: number;
  readonly cells: number;
  readonly committedCalls: number;
  readonly observedProviderAttempts: number;
  readonly observedControllerProviderAttempts: number;
  readonly reportedInputTokens: number;
  readonly reportedOutputTokens: number;
  readonly reportedTotalTokens: number;
  readonly reportedCostUsd: number;
  readonly providerDurationMs: number;
  readonly committedContentBytes: number;
}

export interface RunInspectionBudgetItem {
  readonly kind: "budget";
  readonly limits: BudgetLimits;
  readonly observedLowerBounds: RunInspectionObservedUsage;
}

export interface RunInspectionErrorItem {
  readonly kind: "error";
  readonly source: "cell" | "provider" | "run";
  readonly frameId?: string;
  readonly iteration?: number;
  readonly operationId?: string;
  readonly error: RunInspectionErrorMetadata;
}

export type RunInspectionItem =
  | RunInspectionSummaryItem
  | RunInspectionFrameItem
  | RunInspectionCellItem
  | RunInspectionCallItem
  | RunInspectionBudgetItem
  | RunInspectionErrorItem;

export interface RunInspectionPage {
  readonly version: typeof RUN_INSPECTION_VERSION;
  readonly runName: string;
  readonly runId: string;
  readonly manifestHash: string;
  readonly journalPrefixSha256: string;
  readonly eventCount: number;
  readonly view: RunInspectionView;
  readonly items: readonly RunInspectionItem[];
  readonly serializedBytes: number;
  readonly nextCursor?: string;
}
