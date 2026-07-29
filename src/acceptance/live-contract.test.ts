import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  LIVE_ACCEPTANCE_PURPOSE, LIVE_FIXTURE_DIGEST, LIVE_SUITE_DIGEST, MAX_LIVE_REPORT_BYTES,
  buildLiveBenchmark, canonicalLiveReport, parseLiveConsent, parseLiveConsentText,
  parseLiveReport, parseLiveReportText, type LiveAcceptanceReport, type LiveCaseReport,
  type LiveRouteReport,
} from "./live-contract.ts";
import { digestDescriptor, LIVE_CASE_IDS, liveFixtureDescriptor, liveSuiteDescriptor } from "./live-descriptors.ts";
import { publishLiveReport } from "./live-report.ts";

const digest = (character: string): string => character.repeat(64);
const canonical = (value: unknown): string => canonicalStringify(value as JsonValue);
const consent = (): Record<string, unknown> => ({
  purpose: LIVE_ACCEPTANCE_PURPOSE, version: 1, gitCommit: "1".repeat(40),
  suiteDigest: LIVE_SUITE_DIGEST, fixtureDigest: LIVE_FIXTURE_DIGEST,
  issuedAtMs: 1_000, expiresAtMs: 2_000, nonce: "n".repeat(32),
  routes: [
    { provider: "provider-one", model: "model-one", apiFamily: "family-one" },
    { provider: "provider-two", model: "model-two", apiFamily: "family-two" },
  ],
  bounds: {
    maxInvocations: 100, maxOutputTokensPerInvocation: 2_000, maxAggregateTokens: 1_000_000,
    maxWallTimeMs: 2_000_000, maxPiCatalogEstimateUsd: 20,
  },
});
const zeroCase = (id: typeof LIVE_CASE_IDS[number]): LiveCaseReport => ({
  id, code: "PASS", verdict: "pass", usageCompleteness: "unavailable", correctnessPpm: 1_000_000,
  invocations: 0, intents: 0, settlements: 0, attempts: 0, inputTokens: 0, outputTokens: 0,
  aggregateTokens: 0, piCatalogEstimateUsd: 0, providerDurationMs: 0, wallDurationMs: 0,
  outputBytes: 0, maxConcurrency: 0, sourceSentinelHits: 0,
});
const route = (alias: "route-1" | "route-2", routeDigest: string, cancelled = false): LiveRouteReport => {
  const cases = LIVE_CASE_IDS.map(zeroCase);
  cases[LIVE_CASE_IDS.indexOf("benchmark_direct")] = {
    ...zeroCase("benchmark_direct"), sourceSentinelHits: 1,
  };
  if (cancelled) cases[LIVE_CASE_IDS.indexOf("cancellation")] = {
    ...zeroCase("cancellation"), code: "CANCELLED", usageCompleteness: "unknown_after_cancel",
    invocations: 1, intents: 1, attempts: 1, maxConcurrency: 1,
  };
  return {
    alias, routeDigest, code: "PASS", cases, benchmark: buildLiveBenchmark(
      cases[LIVE_CASE_IDS.indexOf("benchmark_direct")]!, cases[LIVE_CASE_IDS.indexOf("benchmark_rlm")]!,
    ),
    invocations: cancelled ? 1 : 0, intents: cancelled ? 1 : 0, settlements: 0, attempts: cancelled ? 1 : 0,
    inputTokens: 0, outputTokens: 0, aggregateTokens: 0, piCatalogEstimateUsd: 0,
    providerDurationMs: 0, wallDurationMs: 0, outputBytes: 0, maxConcurrency: cancelled ? 1 : 0,
    sourceSentinelHits: 1, cancellationUsage: cancelled ? { status: "unknown_after_cancel" } : { status: "not_cancelled" },
  };
};
const report = (): LiveAcceptanceReport => {
  const routes = [route("route-1", digest("a")), route("route-2", digest("b"), true)] as const;
  return {
    version: 1, gitCommit: "1".repeat(40), suiteDigest: LIVE_SUITE_DIGEST, fixtureDigest: LIVE_FIXTURE_DIGEST,
    code: "PASS", startedAtMs: 1_000, durationMs: 500, routes,
    totals: {
      invocations: 1, intents: 1, settlements: 0, attempts: 1, inputTokens: 0, outputTokens: 0,
      aggregateTokens: 0, piCatalogEstimateUsd: 0, providerDurationMs: 0, wallDurationMs: 0,
      outputBytes: 0, maxConcurrency: 1, sourceSentinelHits: 2,
      cancellationUsage: { status: "unknown_after_cancel" },
    },
  };
};

describe("live consent contract", () => {
  test("binds canonical case and fixture descriptors", () => {
    expect(digestDescriptor(liveSuiteDescriptor())).toBe(LIVE_SUITE_DIGEST);
    expect(digestDescriptor(liveFixtureDescriptor())).toBe(LIVE_FIXTURE_DIGEST);
  });
  test("accepts only exact bounded two-route authority", () => {
    expect(parseLiveConsentText(canonical(consent())).routes).toHaveLength(2);
    for (const mutation of [
      (value: any) => { value.prompt = "forbidden"; },
      (value: any) => { value.routes.push(value.routes[0]); },
      (value: any) => { value.routes[1].provider = value.routes[0].provider; },
      (value: any) => { value.routes[1].apiFamily = value.routes[0].apiFamily; },
      (value: any) => { value.bounds.maxInvocations = Infinity; },
      (value: any) => { value.bounds.maxAggregateTokens = 1; },
    ]) {
      const hostile = consent(); mutation(hostile); expect(() => parseLiveConsent(hostile)).toThrow();
    }
    expect(() => parseLiveConsentText(`${canonical(consent())}\n`)).toThrow(/canonical/);
  });
});

describe("numeric allowlisted live report", () => {
  test("round trips exact cases, benchmark thresholds, and cancellation unknown", () => {
    const text = canonicalLiveReport(report());
    expect(parseLiveReportText(text)).toEqual(report());
    expect(text).not.toContain("provider-one");
    expect(text).toContain("unknown_after_cancel");
  });
  test("rejects hostile keys, canaries, oversized input, malformed order, and totals", () => {
    for (const key of ["prompt", "source", "error", "provider", "model", "actualCostUsd", "path"]) {
      const hostile = structuredClone(report()) as any;
      hostile.routes[0].cases[0][key] = "secret";
      expect(() => parseLiveReport(hostile)).toThrow(/fields/);
    }
    expect(() => canonicalLiveReport(report(), [LIVE_FIXTURE_DIGEST])).toThrow(/canary/);
    expect(() => parseLiveReportText(`${canonical(report())}${" ".repeat(MAX_LIVE_REPORT_BYTES)}`)).toThrow(/byte bound/);
    const reordered = structuredClone(report()) as any;
    [reordered.routes[0].cases[0], reordered.routes[0].cases[1]] = [reordered.routes[0].cases[1], reordered.routes[0].cases[0]];
    expect(() => parseLiveReport(reordered)).toThrow(/canonical/);
    const unreconciled = structuredClone(report()) as any;
    unreconciled.totals.attempts += 1;
    expect(() => parseLiveReport(unreconciled)).toThrow(/reconcile/);
  });
  test("publishes canonical 0600 no-clobber output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rlm-live-report-"));
    try {
      const output = join(directory, "report.json");
      await publishLiveReport(output, report());
      expect(parseLiveReportText(await readFile(output, "utf8"))).toEqual(report());
      expect(Number((await lstat(output)).mode) & 0o7777).toBe(0o600);
      await expect(publishLiveReport(output, report())).rejects.toMatchObject({ code: "REPORT_PUBLICATION_FAILED" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
