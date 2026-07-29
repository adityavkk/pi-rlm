import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  LIVE_ACCEPTANCE_PURPOSE,
  LIVE_FIXTURE_DIGEST,
  LIVE_SUITE_DIGEST,
  MAX_LIVE_REPORT_BYTES,
  canonicalLiveReport,
  parseLiveConsent,
  parseLiveConsentText,
  parseLiveReport,
  parseLiveReportText,
  type LiveAcceptanceReport,
} from "./live-contract.ts";
import { publishLiveReport } from "./live-report.ts";

const digest = (character: string): string => character.repeat(64);
const consent = (): Record<string, unknown> => ({
  purpose: LIVE_ACCEPTANCE_PURPOSE,
  version: 1,
  gitCommit: "1".repeat(40),
  suiteDigest: LIVE_SUITE_DIGEST,
  fixtureDigest: LIVE_FIXTURE_DIGEST,
  issuedAtMs: 1_000,
  expiresAtMs: 2_000,
  nonce: "n".repeat(32),
  routes: [
    { provider: "provider-one", model: "model-one", apiFamily: "family-one" },
    { provider: "provider-two", model: "model-two", apiFamily: "family-two" },
  ],
  bounds: {
    maxInvocations: 4,
    maxOutputTokensPerInvocation: 100,
    maxAggregateTokens: 1_000,
    maxWallTimeMs: 10_000,
    maxPiCatalogEstimateUsd: 2,
  },
});

const report = (): LiveAcceptanceReport => ({
  version: 1,
  gitCommit: "1".repeat(40),
  suiteDigest: LIVE_SUITE_DIGEST,
  fixtureDigest: LIVE_FIXTURE_DIGEST,
  code: "ACCEPTANCE_FAILED",
  startedAtMs: 1_000,
  durationMs: 500,
  routes: [
    {
      alias: "route-1", routeDigest: digest("a"), code: "PASS", invocations: 1,
      inputTokens: 10, outputTokens: 5, aggregateTokens: 15, piCatalogEstimateUsd: 0.1,
      cancellationUsage: { status: "not_cancelled" },
    },
    {
      alias: "route-2", routeDigest: digest("b"), code: "CANCELLED", invocations: 1,
      inputTokens: 20, outputTokens: 5, aggregateTokens: 30, piCatalogEstimateUsd: 0.2,
      cancellationUsage: { status: "unknown_after_cancel" },
    },
  ],
  totals: {
    invocations: 2, inputTokens: 30, outputTokens: 10, aggregateTokens: 45,
    piCatalogEstimateUsd: 0.3, cancellationUsage: { status: "unknown_after_cancel" },
  },
});

const canonical = (value: unknown): string => canonicalStringify(value as JsonValue);

describe("live consent contract", () => {
  test("accepts only the exact bounded two-route authority", () => {
    const parsed = parseLiveConsentText(canonical(consent()));
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.routes[0].provider).not.toBe(parsed.routes[1].provider);

    for (const mutation of [
      (value: any) => { value.prompt = "forbidden"; },
      (value: any) => { value.alias = "route-1"; },
      (value: any) => { value.routes.push(value.routes[0]); },
      (value: any) => { value.routes[1].provider = value.routes[0].provider; },
      (value: any) => { value.routes[1].apiFamily = value.routes[0].apiFamily; },
      (value: any) => { value.bounds.maxInvocations = Infinity; },
      (value: any) => { value.bounds.maxAggregateTokens = 1; },
    ]) {
      const hostile = consent();
      mutation(hostile);
      expect(() => parseLiveConsent(hostile)).toThrow();
    }
  });

  test("requires bounded canonical JSON", () => {
    const text = canonical(consent());
    expect(() => parseLiveConsentText(`${text}\n`)).toThrow(/canonical/);
    expect(() => parseLiveConsentText(`{"purpose":"${LIVE_ACCEPTANCE_PURPOSE}","purpose":"${LIVE_ACCEPTANCE_PURPOSE}"}`)).toThrow();
  });
});

describe("numeric-only live report contract", () => {
  test("accepts aliases, digests, finite accounting, codes, and unknown cancellation usage", () => {
    const text = canonicalLiveReport(report());
    expect(parseLiveReportText(text)).toEqual(report());
    expect(text).not.toContain("provider-one");
    expect(text).not.toContain("actualCost");
    expect(text).toContain("piCatalogEstimateUsd");
    expect(text).toContain("unknown_after_cancel");
  });

  test("rejects hostile keys, provider identifiers, canaries, oversize, and non-finite numbers", () => {
    for (const key of ["prompt", "source", "error", "env", "header", "url", "provider", "model", "actualCostUsd", "billedCostUsd"]) {
      const hostile = structuredClone(report()) as any;
      hostile.routes[0][key] = "secret material";
      expect(() => parseLiveReport(hostile)).toThrow(/fields/);
    }
    const canaryReport = structuredClone(report()) as any;
    canaryReport.fixtureDigest = digest("c");
    expect(() => canonicalLiveReport(canaryReport, [digest("c")])).toThrow(/canary/);
    expect(() => canonicalLiveReport(report(), ["0.3"])).toThrow(/canary/);
    expect(() => parseLiveReportText(`${canonical(report())}${" ".repeat(MAX_LIVE_REPORT_BYTES)}`)).toThrow(/byte bound/);
    const nonfinite = structuredClone(report()) as any;
    nonfinite.routes[0].piCatalogEstimateUsd = Number.NaN;
    expect(() => canonicalLiveReport(nonfinite)).toThrow(/strict JSON/);
  });

  test("rejects unreconciled totals and noncanonical input", () => {
    const hostile = structuredClone(report()) as any;
    hostile.totals.aggregateTokens += 1;
    expect(() => parseLiveReport(hostile)).toThrow(/reconcile/);
    expect(() => parseLiveReportText(`${canonical(report())}\n`)).toThrow(/canonical/);
  });

  test("publishes canonical 0600 no-clobber output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rlm-live-report-"));
    try {
      const output = join(directory, "report.json");
      await publishLiveReport(output, report());
      expect(parseLiveReportText(await readFile(output, "utf8"))).toEqual(report());
      expect(Number((await lstat(output)).mode) & 0o7777).toBe(0o600);
      await writeFile(join(directory, "other"), "untouched");
      await expect(publishLiveReport(output, report())).rejects.toMatchObject({ code: "REPORT_PUBLICATION_FAILED" });
      expect(await readFile(output, "utf8")).toBe(canonical(report()));
      await chmod(output, 0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
