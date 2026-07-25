/** Accounted fallback extractor contract over one bounded evidence projection. */

import type { JsonValue } from "../core/json.ts";
import type { ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { snapshotExtractorJson, type ExtractorEvidenceProjection } from "./extractor-evidence.ts";

/** Compatibility alias; the value is always the bounded projection. */
export type ExtractorEvidence = ExtractorEvidenceProjection;

export type ExtractorResult =
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly code: "FALLBACK_EVIDENCE_TRUNCATED" | "FAILED" | "INVALID_RESULT";
      readonly message: string;
    };

export interface ExtractorModelOperation {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface Extractor {
  /** External work is opaque but still consumes one logical operation/attempt. */
  readonly accountingMode?: "external" | "provider";
  extract(
    evidence: ExtractorEvidenceProjection,
    signal: AbortSignal,
    model?: ExtractorModelOperation,
  ): Promise<ExtractorResult>;
}

type ExternalExtractorFn = (
  evidence: ExtractorEvidenceProjection,
  signal: AbortSignal,
) => Promise<ExtractorResult> | ExtractorResult;

type ProviderExtractorFn = (
  evidence: ExtractorEvidenceProjection,
  signal: AbortSignal,
  model: ExtractorModelOperation,
) => Promise<ExtractorResult> | ExtractorResult;

const ownData = (value: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
};

/** Normalize an opaque result without invoking getters or proxy traps. */
export const normalizeExtractorResult = (input: unknown): ExtractorResult => {
  const snapshot = snapshotExtractorJson(input);
  if (!snapshot.ok || typeof snapshot.value !== "object" || snapshot.value === null || Array.isArray(snapshot.value))
    return { ok: false, code: "INVALID_RESULT", message: "fallback extractor returned an invalid result" };
  const object = snapshot.value as object;
  const ok = ownData(object, "ok");
  if (ok === true) {
    const value = ownData(object, "value");
    return value === undefined
      ? { ok: false, code: "INVALID_RESULT", message: "fallback extractor returned an invalid result" }
      : { ok: true, value: value as JsonValue };
  }
  if (ok === false) {
    const code = ownData(object, "code");
    const message = ownData(object, "message");
    if ((code === "FALLBACK_EVIDENCE_TRUNCATED" || code === "FAILED" || code === "INVALID_RESULT")
      && typeof message === "string" && message.length > 0 && message.length <= 2048)
      return { ok: false, code, message };
  }
  return { ok: false, code: "INVALID_RESULT", message: "fallback extractor returned an invalid result" };
};

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
    evidence: ExtractorEvidenceProjection,
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
