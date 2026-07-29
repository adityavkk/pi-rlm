import { canonicalStringify, type JsonObject, type JsonValue } from "../core/json.ts";
import { LIVE_BENCHMARK_THRESHOLDS, LIVE_CASE_DESCRIPTORS, LIVE_CASE_IDS, type LiveCaseId } from "./live-descriptors.ts";
import {
  liveBoolean, liveEnum, liveExactKeys, liveFail, liveFinite, liveInteger, liveObject, liveOwn,
  livePattern, parseCanonicalLiveJson, strictLiveJson,
} from "./live-json.ts";

export const MAX_LIVE_REPORT_BYTES = 256 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
export const LIVE_ROUTE_ALIASES = ["route-1", "route-2"] as const;
export const LIVE_ROUTE_CODES = [
  "PASS", "ACCEPTANCE_FAILED", "PROVIDER_DISCOVERY_FAILED", "ROUTE_MISMATCH",
  "INVOCATION_FAILED", "CANCELLED",
] as const;
export const LIVE_OVERALL_CODES = ["PASS", "ACCEPTANCE_FAILED", ...LIVE_ROUTE_CODES.slice(2)] as const;
export const LIVE_CASE_CODES = [
  "PASS", "NOT_RUN", "DISCOVERY_FAILED", "ROUTE_MISMATCH", "AUTH_UNAVAILABLE",
  "DIRECT_MISMATCH", "EXTENSION_FAILED", "STRUCTURED_FAILED", "BATCH_FAILED",
  "RECURSE_FAILED", "FALLBACK_FAILED", "OUTPUT_TRUNCATED", "TRUNCATION_FAILED",
  "CANCELLED", "CANCELLATION_FAILED", "PROVIDER_ERROR", "PROVIDER_ERROR_FAILED",
  "RETRY_FAILED", "ACCOUNTING_MISMATCH", "BENCHMARK_FAILED", "THRESHOLD_FAILED",
  "CONTAINMENT_FAILED", "BUDGET_EXCEEDED", "SCENARIO_FAILED",
] as const;
const USAGE_COMPLETENESS = ["exact", "unknown_after_cancel", "unavailable"] as const;
const LIVE_FIXTURE_SENTINELS = 3;
const VERDICTS = ["pass", "fail", "not_run"] as const;

export type LiveRouteAlias = typeof LIVE_ROUTE_ALIASES[number];
export type LiveReportCode = typeof LIVE_ROUTE_CODES[number];
export type LiveOverallReportCode = typeof LIVE_OVERALL_CODES[number];
export type LiveCaseCode = typeof LIVE_CASE_CODES[number];
export type LiveUsageCompleteness = typeof USAGE_COMPLETENESS[number];

export interface LiveNumericAccounting {
  readonly invocations: number;
  readonly intents: number;
  readonly settlements: number;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly aggregateTokens: number;
  readonly piCatalogEstimateUsd: number;
  readonly providerDurationMs: number;
  readonly wallDurationMs: number;
  readonly outputBytes: number;
  readonly maxConcurrency: number;
  readonly sourceSentinelHits: number;
}

export interface LiveCaseReport extends LiveNumericAccounting {
  readonly id: LiveCaseId;
  readonly code: LiveCaseCode;
  readonly verdict: typeof VERDICTS[number];
  readonly usageCompleteness: LiveUsageCompleteness;
  readonly correctnessPpm: number;
}

export type LiveCancellationUsage =
  | { readonly status: "not_cancelled" }
  | { readonly status: "known"; readonly aggregateTokens: number }
  | { readonly status: "unknown_after_cancel" };

export interface LiveBenchmarkReport {
  readonly scorePpm: number;
  readonly correctnessThresholdPpm: number;
  readonly correctnessPass: boolean;
  readonly rlmAttempts: number;
  readonly rlmAttemptsThreshold: number;
  readonly rlmAttemptsPass: boolean;
  readonly tokenRatioPpm: number;
  readonly tokenRatioThresholdPpm: number;
  readonly tokenRatioPass: boolean;
  readonly costRatioPpm: number;
  readonly costRatioThresholdPpm: number;
  readonly costRatioPass: boolean;
  readonly latencyRatioPpm: number;
  readonly latencyRatioThresholdPpm: number;
  readonly latencyRatioPass: boolean;
  readonly rlmWallTimeMs: number;
  readonly rlmWallTimeThresholdMs: number;
  readonly rlmWallTimePass: boolean;
  readonly directSourceSentinelHits: number;
  readonly rlmSourceSentinelHits: number;
  readonly sourceIsolationPass: boolean;
}

export interface LiveReportAccounting extends LiveNumericAccounting {
  readonly cancellationUsage: LiveCancellationUsage;
}
export interface LiveRouteReport extends LiveReportAccounting {
  readonly alias: LiveRouteAlias;
  readonly routeDigest: string;
  readonly code: LiveReportCode;
  readonly cases: readonly LiveCaseReport[];
  readonly benchmark: LiveBenchmarkReport;
}
export interface LiveAcceptanceReport {
  readonly version: 1;
  readonly gitCommit: string;
  readonly suiteDigest: string;
  readonly fixtureDigest: string;
  readonly code: LiveOverallReportCode;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly routes: readonly [LiveRouteReport, LiveRouteReport];
  readonly totals: LiveReportAccounting;
}

const ACCOUNTING_KEYS = [
  "invocations", "intents", "settlements", "attempts", "inputTokens", "outputTokens",
  "aggregateTokens", "piCatalogEstimateUsd", "providerDurationMs", "wallDurationMs",
  "outputBytes", "maxConcurrency", "sourceSentinelHits",
] as const;
const SUM_KEYS = ACCOUNTING_KEYS.filter((key) => key !== "maxConcurrency");
const MAX_COUNT = 100_000_000;

const parseAccounting = (value: JsonObject, label: string): LiveNumericAccounting => ({
  invocations: liveInteger(liveOwn(value, "invocations"), 0, 10_000, `${label}.invocations`),
  intents: liveInteger(liveOwn(value, "intents"), 0, 10_000, `${label}.intents`),
  settlements: liveInteger(liveOwn(value, "settlements"), 0, 10_000, `${label}.settlements`),
  attempts: liveInteger(liveOwn(value, "attempts"), 0, 10_000, `${label}.attempts`),
  inputTokens: liveInteger(liveOwn(value, "inputTokens"), 0, MAX_COUNT, `${label}.inputTokens`),
  outputTokens: liveInteger(liveOwn(value, "outputTokens"), 0, MAX_COUNT, `${label}.outputTokens`),
  aggregateTokens: liveInteger(liveOwn(value, "aggregateTokens"), 0, MAX_COUNT, `${label}.aggregateTokens`),
  piCatalogEstimateUsd: liveFinite(liveOwn(value, "piCatalogEstimateUsd"), 0, 10_000, `${label}.piCatalogEstimateUsd`),
  providerDurationMs: liveInteger(liveOwn(value, "providerDurationMs"), 0, 86_400_000, `${label}.providerDurationMs`),
  wallDurationMs: liveInteger(liveOwn(value, "wallDurationMs"), 0, 86_400_000, `${label}.wallDurationMs`),
  outputBytes: liveInteger(liveOwn(value, "outputBytes"), 0, MAX_COUNT, `${label}.outputBytes`),
  maxConcurrency: liveInteger(liveOwn(value, "maxConcurrency"), 0, 10_000, `${label}.maxConcurrency`),
  sourceSentinelHits: liveInteger(liveOwn(value, "sourceSentinelHits"), 0, 10_000, `${label}.sourceSentinelHits`),
});

const parseCancellation = (value: JsonValue | undefined, label: string): LiveCancellationUsage => {
  const object = liveObject(value as JsonValue, label);
  const status = liveEnum(liveOwn(object, "status"), ["not_cancelled", "known", "unknown_after_cancel"] as const, `${label}.status`);
  if (status === "known") {
    liveExactKeys(object, ["status", "aggregateTokens"], label);
    return { status, aggregateTokens: liveInteger(liveOwn(object, "aggregateTokens"), 0, MAX_COUNT, `${label}.aggregateTokens`) };
  }
  liveExactKeys(object, ["status"], label);
  return { status };
};

const RUNTIME_CASES = new Set<LiveCaseId>(["extension", "structured", "batch", "recurse", "fallback", "retry", "benchmark_rlm"]);
const parseCase = (value: JsonValue, index: number): LiveCaseReport => {
  const label = `route.cases[${index}]`;
  const object = liveObject(value, label);
  liveExactKeys(object, ["id", "code", "verdict", "usageCompleteness", "correctnessPpm", ...ACCOUNTING_KEYS], label);
  const parsed: LiveCaseReport = {
    id: liveEnum(liveOwn(object, "id"), LIVE_CASE_IDS, `${label}.id`),
    code: liveEnum(liveOwn(object, "code"), LIVE_CASE_CODES, `${label}.code`),
    verdict: liveEnum(liveOwn(object, "verdict"), VERDICTS, `${label}.verdict`),
    usageCompleteness: liveEnum(liveOwn(object, "usageCompleteness"), USAGE_COMPLETENESS, `${label}.usageCompleteness`),
    correctnessPpm: liveInteger(liveOwn(object, "correctnessPpm"), 0, 1_000_000, `${label}.correctnessPpm`),
    ...parseAccounting(object, label),
  };
  if (parsed.id !== LIVE_CASE_IDS[index]) liveFail("route cases are not canonical");
  if ((parsed.verdict === "not_run") !== (parsed.code === "NOT_RUN")
    || (parsed.code === "PASS" && parsed.verdict !== "pass"))
    liveFail(`${label} code and verdict do not reconcile`);
  if (parsed.aggregateTokens < parsed.inputTokens + parsed.outputTokens) liveFail(`${label} token accounting does not reconcile`);
  const descriptor = LIVE_CASE_DESCRIPTORS[index]!;
  if (parsed.invocations > descriptor.maxInvocations || parsed.attempts > descriptor.maxInvocations
    || parsed.intents > descriptor.maxInvocations || parsed.settlements > descriptor.maxInvocations
    || parsed.outputTokens > parsed.invocations * descriptor.maxOutputTokens
    || parsed.wallDurationMs > descriptor.maxWallTimeMs
    || parsed.maxConcurrency > (descriptor.maxInvocations === 0 ? 0 : 2)
    || parsed.sourceSentinelHits > LIVE_FIXTURE_SENTINELS)
    liveFail(`${label} exceeds its fixed case bounds`);
  if (parsed.usageCompleteness === "exact" && RUNTIME_CASES.has(parsed.id)
    && (parsed.invocations !== parsed.intents || parsed.intents !== parsed.settlements || parsed.settlements !== parsed.attempts))
    liveFail(`${label} provider attempts do not reconcile`);
  return parsed;
};

const ratioPpm = (numerator: number, denominator: number): number => {
  if (denominator === 0) return numerator === 0 ? 1_000_000 : 1_000_000_000;
  return Math.min(1_000_000_000, Math.round(numerator / denominator * 1_000_000));
};

export const buildLiveBenchmark = (direct: LiveCaseReport, rlm: LiveCaseReport): LiveBenchmarkReport => {
  const tokenRatioPpm = ratioPpm(rlm.aggregateTokens, direct.aggregateTokens);
  const costRatioPpm = ratioPpm(rlm.piCatalogEstimateUsd, direct.piCatalogEstimateUsd);
  const latencyRatioPpm = ratioPpm(rlm.wallDurationMs, direct.wallDurationMs);
  return {
    scorePpm: rlm.correctnessPpm,
    correctnessThresholdPpm: LIVE_BENCHMARK_THRESHOLDS.correctnessPpm,
    correctnessPass: rlm.correctnessPpm >= LIVE_BENCHMARK_THRESHOLDS.correctnessPpm,
    rlmAttempts: rlm.attempts,
    rlmAttemptsThreshold: LIVE_BENCHMARK_THRESHOLDS.rlmAttempts,
    rlmAttemptsPass: rlm.attempts <= LIVE_BENCHMARK_THRESHOLDS.rlmAttempts,
    tokenRatioPpm, tokenRatioThresholdPpm: LIVE_BENCHMARK_THRESHOLDS.tokenRatioPpm,
    tokenRatioPass: tokenRatioPpm <= LIVE_BENCHMARK_THRESHOLDS.tokenRatioPpm,
    costRatioPpm, costRatioThresholdPpm: LIVE_BENCHMARK_THRESHOLDS.costRatioPpm,
    costRatioPass: costRatioPpm <= LIVE_BENCHMARK_THRESHOLDS.costRatioPpm,
    latencyRatioPpm, latencyRatioThresholdPpm: LIVE_BENCHMARK_THRESHOLDS.latencyRatioPpm,
    latencyRatioPass: latencyRatioPpm <= LIVE_BENCHMARK_THRESHOLDS.latencyRatioPpm,
    rlmWallTimeMs: rlm.wallDurationMs,
    rlmWallTimeThresholdMs: LIVE_BENCHMARK_THRESHOLDS.rlmWallTimeMs,
    rlmWallTimePass: rlm.wallDurationMs <= LIVE_BENCHMARK_THRESHOLDS.rlmWallTimeMs,
    directSourceSentinelHits: direct.sourceSentinelHits,
    rlmSourceSentinelHits: rlm.sourceSentinelHits,
    sourceIsolationPass:
      direct.sourceSentinelHits === LIVE_BENCHMARK_THRESHOLDS.directSourceSentinelHits
      && rlm.sourceSentinelHits === LIVE_BENCHMARK_THRESHOLDS.rlmSourceSentinelHits,
  };
};

const BENCHMARK_KEYS = Object.keys(buildLiveBenchmark({ aggregateTokens: 0, piCatalogEstimateUsd: 0, wallDurationMs: 0, correctnessPpm: 0, attempts: 0 } as LiveCaseReport, { aggregateTokens: 0, piCatalogEstimateUsd: 0, wallDurationMs: 0, correctnessPpm: 0, attempts: 0 } as LiveCaseReport));
const parseBenchmark = (value: JsonValue | undefined, cases: readonly LiveCaseReport[]): LiveBenchmarkReport => {
  const object = liveObject(value as JsonValue, "route.benchmark");
  liveExactKeys(object, BENCHMARK_KEYS, "route.benchmark");
  const direct = cases[LIVE_CASE_IDS.indexOf("benchmark_direct")]!;
  const rlm = cases[LIVE_CASE_IDS.indexOf("benchmark_rlm")]!;
  const expected = buildLiveBenchmark(direct, rlm);
  for (const key of BENCHMARK_KEYS as Array<keyof LiveBenchmarkReport>) {
    const actual = typeof expected[key] === "boolean"
      ? liveBoolean(liveOwn(object, key), `route.benchmark.${key}`)
      : liveInteger(liveOwn(object, key), 0, 1_000_000_000, `route.benchmark.${key}`);
    if (actual !== expected[key]) liveFail(`route.benchmark.${key} does not reconcile`);
  }
  return expected;
};

const accountingFromCases = (cases: readonly LiveCaseReport[]): LiveNumericAccounting => {
  const output = Object.fromEntries(ACCOUNTING_KEYS.map((key) => [key, 0])) as unknown as Record<keyof LiveNumericAccounting, number>;
  for (const item of cases) {
    for (const key of SUM_KEYS) output[key] += item[key];
    output.maxConcurrency = Math.max(output.maxConcurrency, item.maxConcurrency);
  }
  return output;
};

export interface LiveWorkerRouteReport extends LiveReportAccounting {
  readonly routeDigest: string;
  readonly code: LiveReportCode;
  readonly cases: readonly LiveCaseReport[];
  readonly benchmark: LiveBenchmarkReport;
}

export const parseLiveWorkerRouteReport = (input: unknown): LiveWorkerRouteReport => {
  const value = liveObject(strictLiveJson(input, "route report"), "route report");
  liveExactKeys(value, ["routeDigest", "code", "cases", "benchmark", "cancellationUsage", ...ACCOUNTING_KEYS], "route report");
  const caseValues = liveOwn(value, "cases");
  if (!Array.isArray(caseValues) || caseValues.length !== LIVE_CASE_IDS.length) liveFail("route report cases are not exact");
  const cases = (caseValues as JsonValue[]).map((item, index) => parseCase(item, index));
  const accounting = parseAccounting(value, "route report");
  const expected = accountingFromCases(cases);
  for (const key of ACCOUNTING_KEYS) if (accounting[key] !== expected[key]) liveFail(`route report.${key} does not reconcile`);
  const cancellationUsage = parseCancellation(liveOwn(value, "cancellationUsage"), "route report.cancellationUsage");
  const cancellation = cases[LIVE_CASE_IDS.indexOf("cancellation")]!;
  if (cancellation.usageCompleteness === "unknown_after_cancel") {
    if (cancellationUsage.status !== "unknown_after_cancel") liveFail("route cancellation usage does not reconcile");
  } else if (cancellationUsage.status !== "not_cancelled") liveFail("route cancellation usage does not reconcile");
  const code = liveEnum(liveOwn(value, "code"), LIVE_ROUTE_CODES, "route report.code");
  if ((code === "PASS") !== cases.every((item) => item.verdict === "pass")) liveFail("route report code does not reconcile");
  const benchmark = parseBenchmark(liveOwn(value, "benchmark"), cases);
  const benchmarkPass = benchmark.correctnessPass && benchmark.rlmAttemptsPass && benchmark.tokenRatioPass
    && benchmark.costRatioPass && benchmark.latencyRatioPass && benchmark.rlmWallTimePass
    && benchmark.sourceIsolationPass;
  if (code === "PASS" && !benchmarkPass) liveFail("route report benchmark thresholds do not reconcile");
  return {
    routeDigest: livePattern(liveOwn(value, "routeDigest"), DIGEST, "route report.routeDigest"),
    code, cases, benchmark, cancellationUsage, ...accounting,
  };
};

export const parseLiveWorkerRouteReportText = (text: string, canaries: readonly string[] = []): LiveWorkerRouteReport => {
  for (const canary of canaries) if (!canary || text.includes(canary)) liveFail("route report contains a secret canary");
  return parseLiveWorkerRouteReport(parseCanonicalLiveJson(text, MAX_LIVE_REPORT_BYTES, "route report"));
};

const route = (value: JsonValue, index: number): LiveRouteReport => {
  const object = liveObject(value, `report.routes[${index}]`);
  liveExactKeys(object, ["alias", "routeDigest", "code", "cases", "benchmark", "cancellationUsage", ...ACCOUNTING_KEYS], `report.routes[${index}]`);
  const worker = parseLiveWorkerRouteReport(Object.fromEntries(Object.entries(object).filter(([key]) => key !== "alias")));
  return { alias: liveEnum(liveOwn(object, "alias"), LIVE_ROUTE_ALIASES, `report.routes[${index}].alias`), ...worker };
};

export const parseLiveReport = (input: unknown): LiveAcceptanceReport => {
  const value = liveObject(strictLiveJson(input, "report"), "report");
  liveExactKeys(value, ["version", "gitCommit", "suiteDigest", "fixtureDigest", "code", "startedAtMs", "durationMs", "routes", "totals"], "report");
  if (liveOwn(value, "version") !== 1) liveFail("report.version is invalid");
  const values = liveOwn(value, "routes");
  if (!Array.isArray(values) || values.length !== 2) liveFail("report.routes must contain exactly two routes");
  const routeValues = values as JsonValue[];
  const routes = [route(routeValues[0]!, 0), route(routeValues[1]!, 1)] as const;
  if (routes[0].alias !== "route-1" || routes[1].alias !== "route-2" || routes[0].routeDigest === routes[1].routeDigest)
    liveFail("report route identities are not canonical");
  const totalObject = liveObject(liveOwn(value, "totals") as JsonValue, "report.totals");
  liveExactKeys(totalObject, ["cancellationUsage", ...ACCOUNTING_KEYS], "report.totals");
  const totals = { ...parseAccounting(totalObject, "report.totals"), cancellationUsage: parseCancellation(liveOwn(totalObject, "cancellationUsage"), "report.totals.cancellationUsage") };
  for (const key of SUM_KEYS) if (totals[key] !== routes[0][key] + routes[1][key]) liveFail(`report.totals.${key} does not reconcile`);
  if (totals.maxConcurrency !== Math.max(routes[0].maxConcurrency, routes[1].maxConcurrency)) liveFail("report.totals.maxConcurrency does not reconcile");
  const unknown = routes.some((item) => item.cancellationUsage.status === "unknown_after_cancel");
  if ((unknown && totals.cancellationUsage.status !== "unknown_after_cancel") || (!unknown && totals.cancellationUsage.status !== "not_cancelled"))
    liveFail("report.totals.cancellationUsage does not reconcile");
  const code = liveEnum(liveOwn(value, "code"), LIVE_OVERALL_CODES, "report.code");
  if ((code === "PASS") !== routes.every((item) => item.code === "PASS")) liveFail("report code does not reconcile");
  return {
    version: 1, gitCommit: livePattern(liveOwn(value, "gitCommit"), GIT_COMMIT, "report.gitCommit"),
    suiteDigest: livePattern(liveOwn(value, "suiteDigest"), DIGEST, "report.suiteDigest"),
    fixtureDigest: livePattern(liveOwn(value, "fixtureDigest"), DIGEST, "report.fixtureDigest"),
    code, startedAtMs: liveInteger(liveOwn(value, "startedAtMs"), 0, Number.MAX_SAFE_INTEGER, "report.startedAtMs"),
    durationMs: liveInteger(liveOwn(value, "durationMs"), 0, 86_400_000, "report.durationMs"), routes, totals,
  };
};

export const parseLiveReportText = (text: string, canaries: readonly string[] = []): LiveAcceptanceReport => {
  for (const canary of canaries) if (!canary || text.includes(canary)) liveFail("report contains a secret canary");
  return parseLiveReport(parseCanonicalLiveJson(text, MAX_LIVE_REPORT_BYTES, "report"));
};
export const canonicalLiveReport = (input: unknown, canaries: readonly string[] = []): string => {
  const text = canonicalStringify(parseLiveReport(input) as unknown as JsonValue);
  return parseLiveReportText(text, canaries) && text;
};
export const assertNoLiveReportCanaries = (report: LiveAcceptanceReport, canaries: readonly string[]): void => {
  void parseLiveReportText(canonicalStringify(report as unknown as JsonValue), canaries);
};
