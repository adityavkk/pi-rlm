/** Accounted fallback extractor contract over one bounded evidence projection. */

import type { RuntimeComponentIdentity } from "../core/identity.ts";
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
  /** Required before run effects. Opaque closures must provide a stable, non-secret identity/version. */
  readonly identity: RuntimeComponentIdentity;
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

export const EXTRACTOR_PROMPT_VERSION = "2";
export const EXTRACTOR_PROMPT_CONFIGURATION = Object.freeze({ contract: "provenance-envelope-v1" });

/** Stable rendered prompt contract shared by execution and manifest binding. */
export const buildExtractorPromptContract = (evidenceIds: readonly string[]): string => [
  "Fallback extraction provenance contract:",
  "Return ONLY one JSON object shaped as {\"value\": <output object>, \"evidenceRefs\": [\"evidenceId\", ...]}.",
  "evidenceRefs must be nonempty and unique. Cite only IDs whose represented content supports the value.",
  "A truncated preview may be cited only for the nonempty content shown; omitted bytes are not evidence.",
  `Available substantive evidenceIds, in projection order: ${JSON.stringify(evidenceIds)}`,
].join("\n");

export interface FunctionExtractorIdentity {
  /** Identity of the host closure. Never derived from source text. */
  readonly closure: RuntimeComponentIdentity;
  /** All behavior-affecting extractor options not otherwise represented here. */
  readonly configuration: JsonValue;
  /** Provider/model route selected by the closure, or null for a provider-independent extractor. */
  readonly modelRoute: string | null;
  /** Dynamic provider prompt renderer identity/configuration, or null when no provider prompt is used. */
  readonly providerPrompt: RuntimeComponentIdentity | null;
}

export class FunctionExtractor implements Extractor {
  private readonly fn: ExternalExtractorFn | ProviderExtractorFn;
  readonly accountingMode: "external" | "provider";
  readonly identity: RuntimeComponentIdentity;

  constructor(fn: ExternalExtractorFn, accountingMode: "external", identity: FunctionExtractorIdentity);
  constructor(fn: ProviderExtractorFn, accountingMode: "provider", identity: FunctionExtractorIdentity);
  constructor(
    fn: ExternalExtractorFn | ProviderExtractorFn,
    accountingMode: "external" | "provider" = "external",
    identity?: FunctionExtractorIdentity,
  ) {
    this.fn = fn;
    this.accountingMode = accountingMode;
    if (!identity) throw new TypeError("FunctionExtractor requires stable non-secret closure identity and configuration");
    this.identity = {
      id: "pi-rlm/function-extractor",
      version: "1",
      configuration: {
        mode: accountingMode,
        closure: identity.closure,
        configuration: identity.configuration,
        modelRoute: identity.modelRoute,
        providerPrompt: identity.providerPrompt,
      } as unknown as JsonValue,
    };
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
