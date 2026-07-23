/**
 * Fallback extractor contract.
 *
 * When the controller exhausts its turns without a valid answer, the host may
 * run a separately budgeted extractor over a bounded evidence projection. It
 * must satisfy the same output contract or fail typed rather than invent data.
 */

import type { JsonValue } from "../core/json.ts";
import type { RlmOutputField } from "../core/program.ts";
import type { TrajectoryProjection } from "../core/trajectory.ts";

export interface ExtractorEvidence {
  readonly outputContract: readonly RlmOutputField[];
  readonly workspace: JsonValue;
  readonly trajectory: TrajectoryProjection;
}

export type ExtractorResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: "FALLBACK_EVIDENCE_TRUNCATED" | "FAILED"; readonly message: string };

export interface Extractor {
  extract(evidence: ExtractorEvidence): Promise<ExtractorResult>;
}

export class FunctionExtractor implements Extractor {
  constructor(private readonly fn: (evidence: ExtractorEvidence) => Promise<ExtractorResult> | ExtractorResult) {}
  async extract(evidence: ExtractorEvidence): Promise<ExtractorResult> {
    return this.fn(evidence);
  }
}
