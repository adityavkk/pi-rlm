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
   * internal provider usage is unknowable. Only `provider` receives the
   * separately accounted `model.complete` capability.
   */
  readonly accountingMode?: "external" | "provider";
  extract(
    evidence: ExtractorEvidence,
    signal: AbortSignal,
    model?: ExtractorModelOperation,
  ): Promise<ExtractorResult>;
}

type ExternalExtractorFn = (
  evidence: ExtractorEvidence,
  signal: AbortSignal,
) => Promise<ExtractorResult> | ExtractorResult;

type ProviderExtractorFn = (
  evidence: ExtractorEvidence,
  signal: AbortSignal,
  model: ExtractorModelOperation,
) => Promise<ExtractorResult> | ExtractorResult;

export class FunctionExtractor implements Extractor {
  private readonly fn: ExternalExtractorFn | ProviderExtractorFn;
  readonly accountingMode: "external" | "provider";

  constructor(fn: ExternalExtractorFn, accountingMode?: "external");
  constructor(fn: ProviderExtractorFn, accountingMode: "provider");
  constructor(
    fn: ExternalExtractorFn | ProviderExtractorFn,
    accountingMode: "external" | "provider" = "external",
  ) {
    this.fn = fn;
    this.accountingMode = accountingMode;
  }

  async extract(
    evidence: ExtractorEvidence,
    signal: AbortSignal,
    model?: ExtractorModelOperation,
  ): Promise<ExtractorResult> {
    if (this.accountingMode === "provider") {
      if (!model) throw new TypeError("provider extractor requires an accounted model operation");
      return (this.fn as ProviderExtractorFn)(evidence, signal, model);
    }
    return (this.fn as ExternalExtractorFn)(evidence, signal);
  }
}
