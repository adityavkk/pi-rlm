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
import type { ModelRequest, ModelResponse } from "../shell/model/client.ts";

export interface ExtractorEvidence {
  readonly outputContract: readonly RlmOutputField[];
  readonly workspace: JsonValue;
  readonly trajectory: TrajectoryProjection;
}

export type ExtractorResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: "FALLBACK_EVIDENCE_TRUNCATED" | "FAILED"; readonly message: string };

export interface ExtractorModelOperation {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface Extractor {
  /**
   * `external` consumes one explicit logical operation and attempt because its
   * internal provider usage is unknowable. `provider` must use `model.complete`.
   */
  readonly accountingMode?: "external" | "provider";
  extract(
    evidence: ExtractorEvidence,
    signal: AbortSignal,
    model: ExtractorModelOperation,
  ): Promise<ExtractorResult>;
}

export class FunctionExtractor implements Extractor {
  constructor(
    private readonly fn: (
      evidence: ExtractorEvidence,
      signal: AbortSignal,
      model: ExtractorModelOperation,
    ) => Promise<ExtractorResult> | ExtractorResult,
    readonly accountingMode: "external" | "provider" = "external",
  ) {}
  async extract(
    evidence: ExtractorEvidence,
    signal: AbortSignal,
    model: ExtractorModelOperation,
  ): Promise<ExtractorResult> {
    return this.fn(evidence, signal, model);
  }
}
