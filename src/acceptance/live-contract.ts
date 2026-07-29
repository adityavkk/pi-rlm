import { type JsonValue } from "../core/json.ts";
import {
  liveExactKeys, liveFail, liveFinite, liveInteger, liveObject, liveOwn, livePattern,
  parseCanonicalLiveJson, strictLiveJson,
} from "./live-json.ts";

export {
  LiveContractError,
} from "./live-json.ts";
export {
  MAX_LIVE_REPORT_BYTES,
  LIVE_CASE_CODES,
  LIVE_OVERALL_CODES,
  LIVE_ROUTE_ALIASES,
  LIVE_ROUTE_CODES,
  assertNoLiveReportCanaries,
  buildLiveBenchmark,
  canonicalLiveReport,
  parseLiveReport,
  parseLiveReportText,
  parseLiveWorkerRouteReport,
  parseLiveWorkerRouteReportText,
  type LiveAcceptanceReport,
  type LiveBenchmarkReport,
  type LiveCancellationUsage,
  type LiveCaseCode,
  type LiveCaseReport,
  type LiveNumericAccounting,
  type LiveOverallReportCode,
  type LiveReportAccounting,
  type LiveReportCode,
  type LiveRouteAlias,
  type LiveRouteReport,
  type LiveUsageCompleteness,
  type LiveWorkerRouteReport,
} from "./live-report-contract.ts";

export const LIVE_ACCEPTANCE_PURPOSE = "pi-rlm-live-provider-acceptance" as const;
export const LIVE_ACCEPTANCE_VERSION = 1 as const;
export const LIVE_SUITE_DIGEST = "48e7f07469559942c1a38dbe91e96c36be590a840cddd7cb09793036727a59fb" as const;
export const LIVE_FIXTURE_DIGEST = "bae88a4adf91b4adb3f4a3ef9b7dc1586269be7054c82f4a76286223c75b0434" as const;
export const MAX_LIVE_CONSENT_BYTES = 64 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const ROUTE_PART = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export interface LiveConsentRoute {
  readonly provider: string;
  readonly model: string;
  readonly apiFamily: string;
}
export interface LiveConsentBounds {
  readonly maxInvocations: number;
  readonly maxOutputTokensPerInvocation: number;
  readonly maxAggregateTokens: number;
  readonly maxWallTimeMs: number;
  /** Pi catalog estimate ceiling only. Never a billed or actual cost guarantee. */
  readonly maxPiCatalogEstimateUsd: number;
}
export interface LiveConsent {
  readonly purpose: typeof LIVE_ACCEPTANCE_PURPOSE;
  readonly version: typeof LIVE_ACCEPTANCE_VERSION;
  readonly gitCommit: string;
  readonly suiteDigest: string;
  readonly fixtureDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly nonce: string;
  readonly routes: readonly [LiveConsentRoute, LiveConsentRoute];
  readonly bounds: LiveConsentBounds;
}

const route = (value: JsonValue, label: string): LiveConsentRoute => {
  const object = liveObject(value, label);
  liveExactKeys(object, ["provider", "model", "apiFamily"], label);
  return {
    provider: livePattern(liveOwn(object, "provider"), ROUTE_PART, `${label}.provider`),
    model: livePattern(liveOwn(object, "model"), ROUTE_PART, `${label}.model`),
    apiFamily: livePattern(liveOwn(object, "apiFamily"), ROUTE_PART, `${label}.apiFamily`),
  };
};

export const parseLiveBounds = (value: JsonValue, label = "consent.bounds"): LiveConsentBounds => {
  const object = liveObject(value, label);
  const keys = ["maxInvocations", "maxOutputTokensPerInvocation", "maxAggregateTokens", "maxWallTimeMs", "maxPiCatalogEstimateUsd"];
  liveExactKeys(object, keys, label);
  const parsed = {
    maxInvocations: liveInteger(liveOwn(object, "maxInvocations"), 1, 10_000, `${label}.maxInvocations`),
    maxOutputTokensPerInvocation: liveInteger(liveOwn(object, "maxOutputTokensPerInvocation"), 1, 1_000_000, `${label}.maxOutputTokensPerInvocation`),
    maxAggregateTokens: liveInteger(liveOwn(object, "maxAggregateTokens"), 1, 100_000_000, `${label}.maxAggregateTokens`),
    maxWallTimeMs: liveInteger(liveOwn(object, "maxWallTimeMs"), 1, 86_400_000, `${label}.maxWallTimeMs`),
    maxPiCatalogEstimateUsd: liveFinite(liveOwn(object, "maxPiCatalogEstimateUsd"), 0, 10_000, `${label}.maxPiCatalogEstimateUsd`),
  };
  if (parsed.maxAggregateTokens < parsed.maxOutputTokensPerInvocation)
    liveFail(`${label} aggregate token bound is below its per-invocation output bound`);
  return parsed;
};

export const parseLiveConsent = (input: unknown): LiveConsent => {
  const value = liveObject(strictLiveJson(input, "consent"), "consent");
  liveExactKeys(value, ["purpose", "version", "gitCommit", "suiteDigest", "fixtureDigest", "issuedAtMs", "expiresAtMs", "nonce", "routes", "bounds"], "consent");
  if (liveOwn(value, "purpose") !== LIVE_ACCEPTANCE_PURPOSE || liveOwn(value, "version") !== 1)
    liveFail("consent purpose or version is invalid");
  const values = liveOwn(value, "routes");
  if (!Array.isArray(values) || values.length !== 2) liveFail("consent.routes must contain exactly two routes");
  const routeValues = values as JsonValue[];
  const routes = [route(routeValues[0]!, "consent.routes[0]"), route(routeValues[1]!, "consent.routes[1]")] as const;
  if (routes[0].provider === routes[1].provider || routes[0].apiFamily === routes[1].apiFamily
    || `${routes[0].provider}\0${routes[0].model}` === `${routes[1].provider}\0${routes[1].model}`)
    liveFail("consent routes, providers, and API families must be distinct");
  const issuedAtMs = liveInteger(liveOwn(value, "issuedAtMs"), 0, Number.MAX_SAFE_INTEGER, "consent.issuedAtMs");
  const expiresAtMs = liveInteger(liveOwn(value, "expiresAtMs"), 0, Number.MAX_SAFE_INTEGER, "consent.expiresAtMs");
  if (expiresAtMs <= issuedAtMs) liveFail("consent expiry must follow issuance");
  return {
    purpose: LIVE_ACCEPTANCE_PURPOSE, version: 1,
    gitCommit: livePattern(liveOwn(value, "gitCommit"), GIT_COMMIT, "consent.gitCommit"),
    suiteDigest: livePattern(liveOwn(value, "suiteDigest"), DIGEST, "consent.suiteDigest"),
    fixtureDigest: livePattern(liveOwn(value, "fixtureDigest"), DIGEST, "consent.fixtureDigest"),
    issuedAtMs, expiresAtMs, nonce: livePattern(liveOwn(value, "nonce"), NONCE, "consent.nonce"), routes,
    bounds: parseLiveBounds(liveOwn(value, "bounds") as JsonValue),
  };
};

export const parseLiveConsentText = (text: string): LiveConsent =>
  parseLiveConsent(parseCanonicalLiveJson(text, MAX_LIVE_CONSENT_BYTES, "consent"));
