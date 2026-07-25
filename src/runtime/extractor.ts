/** Accounted fallback extractor contract over one bounded evidence projection. */

import type { JsonObject, JsonValue } from "../core/json.ts";
import type { ModelRequest, ModelResponse } from "../shell/model/client.ts";
import {
  compareCodeUnits,
  extractorSubstantiveEvidenceIds,
  snapshotExtractorJson,
  type ExtractorEvidenceProjection,
} from "./extractor-evidence.ts";

/** Compatibility alias; the value is always the bounded projection. */
export type ExtractorEvidence = ExtractorEvidenceProjection;

export type ExtractorResult =
  | { readonly ok: true; readonly value: JsonValue; readonly evidenceRefs: readonly string[] }
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

const invalidResult = (message = "fallback extractor returned an invalid result"): ExtractorResult => ({
  ok: false,
  code: "INVALID_RESULT",
  message,
});

/** Normalize an opaque result without invoking getters or proxy traps. */
export const normalizeExtractorResult = (input: unknown): ExtractorResult => {
  const snapshot = snapshotExtractorJson(input);
  if (!snapshot.ok || typeof snapshot.value !== "object" || snapshot.value === null || Array.isArray(snapshot.value))
    return invalidResult();
  const object = snapshot.value as object;
  const ok = ownData(object, "ok");
  if (ok === true) {
    const value = ownData(object, "value");
    const evidenceRefs = ownData(object, "evidenceRefs");
    if (value === undefined || !Array.isArray(evidenceRefs) || evidenceRefs.length === 0)
      return invalidResult("fallback extractor must cite at least one evidenceId");
    const seen = new Set<string>();
    for (const ref of evidenceRefs) {
      if (typeof ref !== "string" || !/^ev_[a-f0-9]{64}$/.test(ref) || seen.has(ref))
        return invalidResult("fallback extractor evidenceRefs must be nonempty, unique evidenceIds");
      seen.add(ref);
    }
    return { ok: true, value: value as JsonValue, evidenceRefs };
  }
  if (ok === false) {
    const code = ownData(object, "code");
    const message = ownData(object, "message");
    if ((code === "FALLBACK_EVIDENCE_TRUNCATED" || code === "FAILED" || code === "INVALID_RESULT")
      && typeof message === "string" && message.length > 0 && message.length <= 2048)
      return { ok: false, code, message };
  }
  return invalidResult();
};

/** Resolve every citation against content actually represented in this projection. */
export const validateExtractorProvenance = (
  result: ExtractorResult,
  evidence: ExtractorEvidenceProjection,
): ExtractorResult => {
  if (!result.ok) return result;
  const represented = extractorSubstantiveEvidenceIds(evidence);
  if (represented.length === 0) {
    return {
      ok: false,
      code: "FALLBACK_EVIDENCE_TRUNCATED",
      message: "fallback evidence contains no substantive content that can be cited",
    };
  }
  const available = new Set(represented);
  if (result.evidenceRefs.some((ref) => !available.has(ref)))
    return invalidResult("fallback extractor cited evidence that is not represented in the projection");
  return { ...result, evidenceRefs: [...result.evidenceRefs].sort(compareCodeUnits) };
};

/** Force provider-backed extractors to ask for the same provenance envelope as external extractors. */
export const buildExtractorModelRequest = (
  evidence: ExtractorEvidenceProjection,
  request: ModelRequest,
): ModelRequest => {
  const evidenceIds = extractorSubstantiveEvidenceIds(evidence);
  const valueProperties = Object.create(null) as Record<string, JsonValue>;
  for (const field of evidence.outputContract) valueProperties[field.name] = field.schema;
  const schema = {
    type: "object",
    required: ["value", "evidenceRefs"],
    properties: {
      value: {
        type: "object",
        required: evidence.outputContract.map((field) => field.name),
        properties: valueProperties,
        additionalProperties: false,
      },
      evidenceRefs: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  } as JsonObject;
  return {
    ...request,
    prompt: `${request.prompt}\n\n${buildExtractorPromptContract(evidenceIds)}`,
    schema,
  };
};

/** Stable rendered prompt contract shared by execution and manifest binding. */
export const buildExtractorPromptContract = (evidenceIds: readonly string[]): string => [
  "Fallback extraction provenance contract:",
  "Return ONLY one JSON object shaped as {\"value\": <output object>, \"evidenceRefs\": [\"evidenceId\", ...]}.",
  "evidenceRefs must be nonempty and unique. Cite only IDs whose represented content supports the value.",
  "A truncated preview may be cited only for the nonempty content shown; omitted bytes are not evidence.",
  `Available substantive evidenceIds, in projection order: ${JSON.stringify(evidenceIds)}`,
].join("\n");

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
