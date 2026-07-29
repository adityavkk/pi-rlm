import { canonicalStringify, isJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../core/json.ts";

export const LIVE_ACCEPTANCE_PURPOSE = "pi-rlm-live-provider-acceptance" as const;
export const LIVE_ACCEPTANCE_VERSION = 1 as const;
export const LIVE_SUITE_DIGEST = "0be38bf0ffe26c9e5affc9071bcc0c415c2f63073a0ff0d04beca92bd43de514" as const;
export const LIVE_FIXTURE_DIGEST = "c116e7ff4037956b274a3c5e102759db5a35eb69b4b550451e5756e21b643480" as const;
export const MAX_LIVE_CONSENT_BYTES = 64 * 1024;
export const MAX_LIVE_REPORT_BYTES = 256 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const ROUTE_PART = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ROUTE_ALIASES = ["route-1", "route-2"] as const;
const REPORT_CODES = [
  "PASS",
  "ACCEPTANCE_FAILED",
  "PROVIDER_DISCOVERY_FAILED",
  "ROUTE_MISMATCH",
  "INVOCATION_FAILED",
  "CANCELLED",
] as const;
const OVERALL_REPORT_CODES = [...REPORT_CODES, "SUITE_NOT_IMPLEMENTED"] as const;

export type LiveRouteAlias = typeof ROUTE_ALIASES[number];
export type LiveReportCode = typeof REPORT_CODES[number];
export type LiveOverallReportCode = typeof OVERALL_REPORT_CODES[number];

export interface LiveConsentRoute {
  readonly provider: string;
  readonly model: string;
  /** Expected API family returned by route discovery. */
  readonly apiFamily: string;
}

export interface LiveConsentBounds {
  readonly maxInvocations: number;
  readonly maxOutputTokensPerInvocation: number;
  readonly maxAggregateTokens: number;
  readonly maxWallTimeMs: number;
  /** Upper bound on Pi catalog estimate, not billed or actual cost. */
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

export type LiveCancellationUsage =
  | { readonly status: "not_cancelled" }
  | { readonly status: "known"; readonly aggregateTokens: number }
  | { readonly status: "unknown_after_cancel" };

export interface LiveReportAccounting {
  readonly invocations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly aggregateTokens: number;
  /** Pi model-catalog estimate only. Never a billed or actual cost. */
  readonly piCatalogEstimateUsd: number;
  readonly cancellationUsage: LiveCancellationUsage;
}

export interface LiveRouteReport extends LiveReportAccounting {
  readonly alias: LiveRouteAlias;
  readonly routeDigest: string;
  readonly code: LiveReportCode;
}

export interface LiveAcceptanceReport {
  readonly version: typeof LIVE_ACCEPTANCE_VERSION;
  readonly gitCommit: string;
  readonly suiteDigest: string;
  readonly fixtureDigest: string;
  readonly code: LiveOverallReportCode;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly routes: readonly [LiveRouteReport, LiveRouteReport];
  readonly totals: LiveReportAccounting;
}

export class LiveContractError extends Error {
  readonly code = "LIVE_CONTRACT_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "LiveContractError";
  }
}

const fail = (message: string): never => { throw new LiveContractError(message); };
const own = (value: JsonObject, key: string): JsonValue | undefined =>
  Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const object = (value: JsonValue, label: string): JsonObject =>
  isJsonObject(value) ? value : fail(`${label} must be an object`);
const exactKeys = (value: JsonObject, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(`${label} fields are not exact`);
};
const exactString = (value: JsonValue | undefined, expected: string, label: string): string =>
  value === expected ? value : fail(`${label} is invalid`);
const patternString = (value: JsonValue | undefined, pattern: RegExp, label: string): string =>
  typeof value === "string" && pattern.test(value) ? value : fail(`${label} is invalid`);
const enumString = <T extends string>(value: JsonValue | undefined, values: readonly T[], label: string): T =>
  typeof value === "string" && values.includes(value as T) ? value as T : fail(`${label} is invalid`);
const integer = (value: JsonValue | undefined, min: number, max: number, label: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value : fail(`${label} is outside its finite integer bounds`);
const finite = (value: JsonValue | undefined, min: number, max: number, label: string): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value : fail(`${label} is outside its finite bounds`);

const parseStrictJson = (text: string, maximumBytes: number, label: string): JsonValue => {
  if (Buffer.byteLength(text, "utf8") > maximumBytes) fail(`${label} exceeds its byte bound`);
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { return fail(`${label} is not JSON`); }
  const parsed = parseJsonValue(raw);
  if (!parsed.ok) return fail(`${label} is not strict JSON`);
  if (canonicalStringify(parsed.value) !== text) fail(`${label} is not canonical JSON`);
  return parsed.value;
};

const parseRoute = (value: JsonValue, label: string): LiveConsentRoute => {
  const route = object(value, label);
  exactKeys(route, ["provider", "model", "apiFamily"], label);
  return {
    provider: patternString(own(route, "provider"), ROUTE_PART, `${label}.provider`),
    model: patternString(own(route, "model"), ROUTE_PART, `${label}.model`),
    apiFamily: patternString(own(route, "apiFamily"), ROUTE_PART, `${label}.apiFamily`),
  };
};

const parseBounds = (value: JsonValue | undefined): LiveConsentBounds => {
  const bounds = object(value as JsonValue, "consent.bounds");
  exactKeys(bounds, ["maxInvocations", "maxOutputTokensPerInvocation", "maxAggregateTokens", "maxWallTimeMs", "maxPiCatalogEstimateUsd"], "consent.bounds");
  const parsed = {
    maxInvocations: integer(own(bounds, "maxInvocations"), 1, 10_000, "consent.bounds.maxInvocations"),
    maxOutputTokensPerInvocation: integer(own(bounds, "maxOutputTokensPerInvocation"), 1, 1_000_000, "consent.bounds.maxOutputTokensPerInvocation"),
    maxAggregateTokens: integer(own(bounds, "maxAggregateTokens"), 1, 100_000_000, "consent.bounds.maxAggregateTokens"),
    maxWallTimeMs: integer(own(bounds, "maxWallTimeMs"), 1, 86_400_000, "consent.bounds.maxWallTimeMs"),
    maxPiCatalogEstimateUsd: finite(own(bounds, "maxPiCatalogEstimateUsd"), 0, 10_000, "consent.bounds.maxPiCatalogEstimateUsd"),
  };
  if (parsed.maxAggregateTokens < parsed.maxOutputTokensPerInvocation)
    fail("consent aggregate token bound is below its per-invocation output bound");
  return parsed;
};

export const parseLiveConsent = (input: unknown): LiveConsent => {
  const json = parseJsonValue(input);
  if (!json.ok) return fail("consent is not strict JSON");
  const value = object(json.value, "consent");
  exactKeys(value, ["purpose", "version", "gitCommit", "suiteDigest", "fixtureDigest", "issuedAtMs", "expiresAtMs", "nonce", "routes", "bounds"], "consent");
  exactString(own(value, "purpose"), LIVE_ACCEPTANCE_PURPOSE, "consent.purpose");
  if (own(value, "version") !== LIVE_ACCEPTANCE_VERSION) fail("consent.version is invalid");
  const routesValue = own(value, "routes");
  if (!Array.isArray(routesValue) || routesValue.length !== 2) return fail("consent.routes must contain exactly two routes");
  const routes = [parseRoute(routesValue[0] as JsonValue, "consent.routes[0]"), parseRoute(routesValue[1] as JsonValue, "consent.routes[1]")] as const;
  if (`${routes[0].provider}\0${routes[0].model}` === `${routes[1].provider}\0${routes[1].model}`)
    fail("consent routes must be distinct");
  if (routes[0].provider === routes[1].provider) fail("consent route providers must be distinct");
  if (routes[0].apiFamily === routes[1].apiFamily) fail("consent route API families must be distinct");
  const issuedAtMs = integer(own(value, "issuedAtMs"), 0, Number.MAX_SAFE_INTEGER, "consent.issuedAtMs");
  const expiresAtMs = integer(own(value, "expiresAtMs"), 0, Number.MAX_SAFE_INTEGER, "consent.expiresAtMs");
  if (expiresAtMs <= issuedAtMs) fail("consent expiry must follow issuance");
  return {
    purpose: LIVE_ACCEPTANCE_PURPOSE,
    version: LIVE_ACCEPTANCE_VERSION,
    gitCommit: patternString(own(value, "gitCommit"), GIT_COMMIT, "consent.gitCommit"),
    suiteDigest: patternString(own(value, "suiteDigest"), DIGEST, "consent.suiteDigest"),
    fixtureDigest: patternString(own(value, "fixtureDigest"), DIGEST, "consent.fixtureDigest"),
    issuedAtMs, expiresAtMs,
    nonce: patternString(own(value, "nonce"), NONCE, "consent.nonce"),
    routes,
    bounds: parseBounds(own(value, "bounds")),
  };
};

export const parseLiveConsentText = (text: string): LiveConsent =>
  parseLiveConsent(parseStrictJson(text, MAX_LIVE_CONSENT_BYTES, "consent"));

const parseCancellation = (value: JsonValue | undefined, label: string): LiveCancellationUsage => {
  const cancellation = object(value as JsonValue, label);
  const status = enumString(own(cancellation, "status"), ["not_cancelled", "known", "unknown_after_cancel"] as const, `${label}.status`);
  if (status === "known") {
    exactKeys(cancellation, ["status", "aggregateTokens"], label);
    return { status, aggregateTokens: integer(own(cancellation, "aggregateTokens"), 0, 100_000_000, `${label}.aggregateTokens`) };
  }
  exactKeys(cancellation, ["status"], label);
  return { status };
};

const parseAccounting = (value: JsonObject, label: string): LiveReportAccounting => ({
  invocations: integer(own(value, "invocations"), 0, 10_000, `${label}.invocations`),
  inputTokens: integer(own(value, "inputTokens"), 0, 100_000_000, `${label}.inputTokens`),
  outputTokens: integer(own(value, "outputTokens"), 0, 100_000_000, `${label}.outputTokens`),
  aggregateTokens: integer(own(value, "aggregateTokens"), 0, 100_000_000, `${label}.aggregateTokens`),
  piCatalogEstimateUsd: finite(own(value, "piCatalogEstimateUsd"), 0, 10_000, `${label}.piCatalogEstimateUsd`),
  cancellationUsage: parseCancellation(own(value, "cancellationUsage"), `${label}.cancellationUsage`),
});

const ACCOUNTING_KEYS = ["invocations", "inputTokens", "outputTokens", "aggregateTokens", "piCatalogEstimateUsd", "cancellationUsage"] as const;
const parseRouteReport = (value: JsonValue, index: number): LiveRouteReport => {
  const label = `report.routes[${index}]`;
  const route = object(value, label);
  exactKeys(route, ["alias", "routeDigest", "code", ...ACCOUNTING_KEYS], label);
  const parsed = {
    alias: enumString(own(route, "alias"), ROUTE_ALIASES, `${label}.alias`),
    routeDigest: patternString(own(route, "routeDigest"), DIGEST, `${label}.routeDigest`),
    code: enumString(own(route, "code"), REPORT_CODES, `${label}.code`),
    ...parseAccounting(route, label),
  };
  if (parsed.aggregateTokens < parsed.inputTokens + parsed.outputTokens)
    fail(`${label}.aggregateTokens does not reconcile`);
  return parsed;
};

export const parseLiveReport = (input: unknown): LiveAcceptanceReport => {
  const json = parseJsonValue(input);
  if (!json.ok) return fail("report is not strict JSON");
  const value = object(json.value, "report");
  exactKeys(value, ["version", "gitCommit", "suiteDigest", "fixtureDigest", "code", "startedAtMs", "durationMs", "routes", "totals"], "report");
  if (own(value, "version") !== LIVE_ACCEPTANCE_VERSION) fail("report.version is invalid");
  const routeValues = own(value, "routes");
  if (!Array.isArray(routeValues) || routeValues.length !== 2) return fail("report.routes must contain exactly two routes");
  const routes = [parseRouteReport(routeValues[0] as JsonValue, 0), parseRouteReport(routeValues[1] as JsonValue, 1)] as const;
  if (routes[0].alias !== ROUTE_ALIASES[0] || routes[1].alias !== ROUTE_ALIASES[1]) fail("report route aliases are not canonical");
  if (routes[0].routeDigest === routes[1].routeDigest) fail("report route digests must be distinct");
  const totalsValue = object(own(value, "totals") as JsonValue, "report.totals");
  exactKeys(totalsValue, ACCOUNTING_KEYS, "report.totals");
  const totals = parseAccounting(totalsValue, "report.totals");
  for (const key of ["invocations", "inputTokens", "outputTokens", "aggregateTokens"] as const)
    if (totals[key] !== routes[0][key] + routes[1][key]) fail(`report.totals.${key} does not reconcile`);
  if (Math.abs(totals.piCatalogEstimateUsd - routes[0].piCatalogEstimateUsd - routes[1].piCatalogEstimateUsd) > 1e-9)
    fail("report.totals.piCatalogEstimateUsd does not reconcile");
  const cancellationStatuses = routes.map((route) => route.cancellationUsage.status);
  if (cancellationStatuses.includes("unknown_after_cancel")) {
    if (totals.cancellationUsage.status !== "unknown_after_cancel") fail("report.totals.cancellationUsage does not reconcile");
  } else if (cancellationStatuses.includes("known")) {
    const knownTokens = routes.reduce((sum, route) => sum
      + (route.cancellationUsage.status === "known" ? route.cancellationUsage.aggregateTokens : 0), 0);
    if (totals.cancellationUsage.status !== "known" || totals.cancellationUsage.aggregateTokens !== knownTokens)
      fail("report.totals.cancellationUsage does not reconcile");
  } else if (totals.cancellationUsage.status !== "not_cancelled") {
    fail("report.totals.cancellationUsage does not reconcile");
  }
  const code = enumString(own(value, "code"), OVERALL_REPORT_CODES, "report.code");
  if (code === "PASS" && routes.some((route) => route.code !== "PASS")) fail("report PASS code does not reconcile with routes");
  return {
    version: LIVE_ACCEPTANCE_VERSION,
    gitCommit: patternString(own(value, "gitCommit"), GIT_COMMIT, "report.gitCommit"),
    suiteDigest: patternString(own(value, "suiteDigest"), DIGEST, "report.suiteDigest"),
    fixtureDigest: patternString(own(value, "fixtureDigest"), DIGEST, "report.fixtureDigest"),
    code,
    startedAtMs: integer(own(value, "startedAtMs"), 0, Number.MAX_SAFE_INTEGER, "report.startedAtMs"),
    durationMs: integer(own(value, "durationMs"), 0, 86_400_000, "report.durationMs"),
    routes, totals,
  };
};

const reportStrings = (report: LiveAcceptanceReport): string[] => [
  report.gitCommit, report.suiteDigest, report.fixtureDigest, report.code,
  ...report.routes.flatMap((route) => [route.alias, route.routeDigest, route.code, route.cancellationUsage.status]),
  report.totals.cancellationUsage.status,
];

export const assertNoLiveReportCanaries = (report: LiveAcceptanceReport, canaries: readonly string[]): void => {
  for (const canary of canaries) {
    if (canary.length === 0) fail("report canary must not be empty");
    if (reportStrings(report).some((value) => value.includes(canary))) fail("report contains a secret canary");
  }
};

const assertNoTextCanaries = (text: string, canaries: readonly string[]): void => {
  for (const canary of canaries) {
    if (canary.length === 0) fail("report canary must not be empty");
    if (text.includes(canary)) fail("report contains a secret canary");
  }
};

export const parseLiveReportText = (text: string, canaries: readonly string[] = []): LiveAcceptanceReport => {
  const report = parseLiveReport(parseStrictJson(text, MAX_LIVE_REPORT_BYTES, "report"));
  assertNoLiveReportCanaries(report, canaries);
  assertNoTextCanaries(text, canaries);
  return report;
};

export const canonicalLiveReport = (input: unknown, canaries: readonly string[] = []): string => {
  const report = parseLiveReport(input);
  assertNoLiveReportCanaries(report, canaries);
  const text = canonicalStringify(report as unknown as JsonValue);
  if (Buffer.byteLength(text, "utf8") > MAX_LIVE_REPORT_BYTES) fail("report exceeds its byte bound");
  assertNoTextCanaries(text, canaries);
  return text;
};
