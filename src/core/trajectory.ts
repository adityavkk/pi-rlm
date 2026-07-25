/**
 * Immutable controller trajectory and bounded projection (pure).
 *
 * Each iteration records the controller's reasoning, submitted code, a bounded
 * output preview, an optional full-output reference, and any typed error. The
 * controller only ever sees a bounded projection: a head and tail window of
 * iterations, each with byte-capped previews. Full output stays external.
 */

import { type CallError, type InterpreterError } from "./errors.ts";
import type { JsonValue } from "./json.ts";
import { headTailPreview, headPreview, type Preview } from "./preview.ts";
import type { CallUsage } from "./usage.ts";

export type CellError = InterpreterError | CallError;

export interface TrajectoryEntry {
  readonly iteration: number;
  readonly reasoning: string;
  readonly code: string;
  readonly hasResult: boolean;
  readonly outputPreview: string;
  readonly outputBytes?: number;
  readonly outputOmittedBytes?: number;
  readonly usage?: CallUsage;
  readonly outputRef?: string;
  readonly error?: CellError;
  /** Host-only snapshot; deliberately excluded from controller projections. */
  readonly answerCandidate?: {
    readonly value: JsonValue;
    readonly validationErrors: readonly string[];
  };
}

export interface ProjectedEntry {
  readonly iteration: number;
  readonly reasoning: string;
  readonly codePreview: Preview;
  readonly outputPreview: string;
  readonly outputBytes?: number;
  readonly outputOmittedBytes?: number;
  readonly usage?: CallUsage;
  readonly outputRef?: string;
  readonly error?: CellError;
}

export interface TrajectoryProjection {
  readonly entries: readonly ProjectedEntry[];
  readonly omittedCount: number;
  readonly total: number;
}

export interface ProjectionOptions {
  readonly headEntries: number;
  readonly tailEntries: number;
  readonly codeHeadBytes: number;
  readonly codeTailBytes: number;
  readonly reasoningMaxBytes: number;
}

const projectEntry = (entry: TrajectoryEntry, options: ProjectionOptions): ProjectedEntry => ({
  iteration: entry.iteration,
  reasoning: headPreview(entry.reasoning, options.reasoningMaxBytes).text,
  codePreview: headTailPreview(entry.code, {
    headBytes: options.codeHeadBytes,
    tailBytes: options.codeTailBytes,
  }),
  outputPreview: entry.outputPreview,
  ...(entry.outputBytes !== undefined ? { outputBytes: entry.outputBytes } : {}),
  ...(entry.outputOmittedBytes !== undefined ? { outputOmittedBytes: entry.outputOmittedBytes } : {}),
  ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
  ...(entry.outputRef !== undefined ? { outputRef: entry.outputRef } : {}),
  ...(entry.error !== undefined ? { error: entry.error } : {}),
});

/**
 * Bounded head-tail window over the trajectory. When the trajectory exceeds the
 * head+tail budget, middle iterations are omitted and counted.
 */
export const projectTrajectory = (
  entries: readonly TrajectoryEntry[],
  options: ProjectionOptions,
): TrajectoryProjection => {
  const total = entries.length;
  const capacity = options.headEntries + options.tailEntries;
  if (total <= capacity) {
    return { entries: entries.map((e) => projectEntry(e, options)), omittedCount: 0, total };
  }
  const head = entries.slice(0, options.headEntries);
  const tail = entries.slice(total - options.tailEntries);
  return {
    entries: [...head, ...tail].map((e) => projectEntry(e, options)),
    omittedCount: total - capacity,
    total,
  };
};

/** Append an entry, returning a new immutable array. */
export const appendEntry = (
  entries: readonly TrajectoryEntry[],
  entry: TrajectoryEntry,
): readonly TrajectoryEntry[] => [...entries, entry];
