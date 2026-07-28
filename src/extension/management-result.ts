/** Bounded metadata-only completion projections for textual /rlm management routes. */

import { canonicalStringify, type JsonValue } from "../core/json.ts";
import type { RunInspectionPage } from "../runtime/run-inspection-types.ts";
import type { RunCleanupResult, ManagedRunListing } from "../runtime/run-retention.ts";
import type { RunResult } from "../runtime/run.ts";
import type { CoordinatedRun } from "./run-coordinator.ts";
import { sanitizeDisplayText } from "./run-display.ts";
import { projectRunInspectionPage } from "./tui/run-inspector.ts";
import { projectRunNavigatorRows, renderRunNavigatorRow } from "./tui/run-navigator.ts";

export const MANAGEMENT_RESULT_VERSION = 1 as const;
export const MANAGEMENT_RESULT_MAX_ROWS = 64;
export const MANAGEMENT_RESULT_MAX_BYTES = 64 * 1024;
const RUN_NAME = /^run-[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_-]{0,63}$/;

export type RlmManagementOperation = "runs" | "inspect" | "resume" | "cleanup" | "cancel" | "invalid";

export interface RlmManagementMetadata {
  readonly version: typeof MANAGEMENT_RESULT_VERSION;
  readonly operation: RlmManagementOperation;
  readonly status: "completed" | "failed" | "cancelled";
  readonly code: string;
  readonly message: string;
  readonly managedName?: string;
  readonly runId?: string;
  readonly inspectOnly?: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly rows: readonly string[];
  readonly warningCodes: readonly string[];
}

const unsigned = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeCode = (value: unknown, fallback: string): string =>
  typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
const safeName = (value: unknown): string | undefined =>
  typeof value === "string" && RUN_NAME.test(value) ? value : undefined;
const safeRunId = (value: unknown): string | undefined =>
  typeof value === "string" && RUN_ID.test(value) ? value : undefined;
const safeRows = (values: readonly unknown[]): readonly string[] => Object.freeze(values
  .slice(0, MANAGEMENT_RESULT_MAX_ROWS)
  .map((value) => sanitizeDisplayText(value, 1024))
  .filter((value) => value.length > 0));

const projection = (input: Omit<RlmManagementMetadata, "version">): RlmManagementMetadata => {
  const result: RlmManagementMetadata = Object.freeze({
    version: MANAGEMENT_RESULT_VERSION,
    operation: input.operation,
    status: input.status,
    code: safeCode(input.code, "RLM_MANAGEMENT_FAILED"),
    message: sanitizeDisplayText(input.message, 512),
    ...(safeName(input.managedName) ? { managedName: input.managedName } : {}),
    ...(safeRunId(input.runId) ? { runId: input.runId } : {}),
    ...(input.inspectOnly ? { inspectOnly: true } : {}),
    counts: Object.freeze(Object.fromEntries(Object.entries(input.counts).slice(0, 16)
      .map(([key, value]) => [safeCode(key.toUpperCase(), "COUNT").toLowerCase(), unsigned(value)]))),
    rows: safeRows(input.rows),
    warningCodes: Object.freeze(input.warningCodes.map((code) => safeCode(code, "RLM_WARNING_INVALID")).slice(-8)),
  });
  if (Buffer.byteLength(canonicalStringify(result as unknown as JsonValue), "utf8") > MANAGEMENT_RESULT_MAX_BYTES)
    throw new TypeError("management projection exceeds its serialized byte limit");
  return result;
};

export const managementFailure = (
  operation: RlmManagementOperation,
  code: string,
  message: string,
  options: { readonly managedName?: string; readonly inspectOnly?: boolean } = {},
): RlmManagementMetadata => projection({
  operation, status: "failed", code, message,
  ...(options.managedName ? { managedName: options.managedName } : {}),
  ...(options.inspectOnly ? { inspectOnly: true } : {}),
  counts: {}, rows: [], warningCodes: [],
});

export const projectRunsManagement = (
  listing: ManagedRunListing,
  localRuns: readonly CoordinatedRun[] = [],
): RlmManagementMetadata => {
  const rows = projectRunNavigatorRows(localRuns, listing);
  return projection({
    operation: "runs", status: "completed", code: "RLM_RUNS_LISTED", message: "Managed run metadata listed.",
    counts: {
      listed: rows.length,
      shown: Math.min(rows.length, MANAGEMENT_RESULT_MAX_ROWS),
      issues: unsigned(listing?.issues?.length),
      scannedEntries: unsigned(listing?.scannedEntries),
      scannedBytes: unsigned(listing?.scannedBytes),
    },
    rows: rows.map((row) => renderRunNavigatorRow(row, false, 1_000)), warningCodes: [],
  });
};

export const projectInspectManagement = (
  page: RunInspectionPage,
  managedName: string,
): RlmManagementMetadata => {
  const inspected = projectRunInspectionPage(page, managedName, "summary");
  return projection({
    operation: "inspect", status: "completed", code: "RLM_RUN_INSPECTED", message: "Managed run metadata inspected.",
    managedName: inspected.runName,
    runId: inspected.runId,
    counts: { events: inspected.eventCount, items: inspected.rows.length, nextPage: inspected.nextCursor ? 1 : 0 },
    rows: inspected.rows,
    warningCodes: [],
  });
};

const safeNameList = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100_000) return [];
  return value.filter((item): item is string => typeof item === "string" && RUN_NAME.test(item));
};

export const projectCleanupManagement = (
  result: RunCleanupResult,
  mode: "apply" | "dry-run" | "force",
): RlmManagementMetadata => {
  const deleted = safeNameList(result?.deleted);
  const wouldDelete = safeNameList(result?.wouldDelete);
  const retained = safeNameList(result?.retained);
  const selected = mode === "dry-run" ? wouldDelete : deleted;
  return projection({
    operation: "cleanup", status: "completed",
    code: mode === "dry-run" ? "RLM_CLEANUP_DRY_RUN" : "RLM_CLEANUP_COMPLETED",
    message: mode === "dry-run" ? "Cleanup dry run is advisory; no run was removed." : "Managed cleanup completed.",
    counts: {
      deleted: deleted.length,
      wouldDelete: wouldDelete.length,
      retained: retained.length,
      skipped: unsigned(result?.skipped?.length),
      issues: unsigned(result?.issues?.length),
    },
    rows: selected,
    warningCodes: [],
  });
};

/** Bounded failure projection which preserves already-applied cleanup outcomes. */
export const projectCleanupFailureManagement = (
  result: RunCleanupResult,
): RlmManagementMetadata => {
  const deleted = safeNameList(result?.deleted);
  const retained = safeNameList(result?.retained);
  return projection({
    operation: "cleanup", status: "failed", code: "RLM_CLEANUP_PARTIAL",
    message: "Managed cleanup stopped with a bounded partial result.",
    counts: {
      deleted: deleted.length,
      retained: retained.length,
      skipped: unsigned(result?.skipped?.length),
      issues: unsigned(result?.issues?.length),
    },
    rows: deleted,
    warningCodes: ["RLM_CLEANUP_PARTIAL"],
  });
};

export const projectResumeManagement = (
  result: RunResult,
  managedName: string,
): RlmManagementMetadata => projection({
  operation: "resume",
  status: result.status,
  code: result.status === "completed" ? "RLM_RESUME_COMPLETED"
    : safeCode(result.error?.code, result.status === "cancelled" ? "CANCELLED" : "RLM_RESUME_FAILED"),
  message: result.status === "completed" ? "Managed continuation completed."
    : result.status === "cancelled" ? "Managed continuation was cancelled." : "Managed continuation failed.",
  managedName,
  runId: result.runId,
  counts: {
    warnings: result.warnings?.length ?? 0,
    attempts: result.ledger.usage.attempts,
    controllerTurns: result.ledger.usage.controllerTurns,
    logicalCalls: result.ledger.usage.logicalCalls,
  },
  rows: result.completionMode ? [`completion ${result.completionMode}`] : [],
  warningCodes: (result.warnings ?? []).map((warning) => warning.code),
});

export const managementContent = (metadata: RlmManagementMetadata): string =>
  canonicalStringify(metadata as unknown as JsonValue);
