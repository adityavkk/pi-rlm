import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  LIVE_ACCEPTANCE_PURPOSE, LIVE_FIXTURE_DIGEST, LIVE_SUITE_DIGEST, MAX_LIVE_REPORT_BYTES,
  buildLiveBenchmark, type LiveCaseReport, type LiveConsent, type LiveWorkerRouteReport,
} from "./live-contract.ts";
import { LIVE_CASE_IDS } from "./live-descriptors.ts";
import { expandLiveRoutePlan } from "./live-plan.ts";
import { runLiveProviderAcceptanceSuite, type LiveChildInput, type LiveChildOutcome } from "./live-suite.ts";
import { parseLiveWorkerRequestText } from "./live-worker-contract.ts";

const plan = expandLiveRoutePlan();
const consent = (): LiveConsent => ({
  purpose: LIVE_ACCEPTANCE_PURPOSE, version: 1, gitCommit: "1".repeat(40),
  suiteDigest: LIVE_SUITE_DIGEST, fixtureDigest: LIVE_FIXTURE_DIGEST,
  issuedAtMs: 1_000, expiresAtMs: 2_000, nonce: "n".repeat(32),
  routes: [
    { provider: "provider-one", model: "model-one", apiFamily: "family-one" },
    { provider: "provider-two", model: "model-two", apiFamily: "family-two" },
  ],
  bounds: {
    maxInvocations: plan.maxInvocations * 2,
    maxOutputTokensPerInvocation: plan.maxOutputTokensPerInvocation,
    maxAggregateTokens: plan.estimatedAggregateTokens * 2,
    maxWallTimeMs: plan.maxWallTimeMs * 2,
    maxPiCatalogEstimateUsd: 100,
  },
});
const zeroCase = (id: typeof LIVE_CASE_IDS[number]): LiveCaseReport => ({
  id, code: "PASS", verdict: "pass", usageCompleteness: "unavailable", correctnessPpm: 1_000_000,
  invocations: 0, intents: 0, settlements: 0, attempts: 0, inputTokens: 0, outputTokens: 0,
  aggregateTokens: 0, piCatalogEstimateUsd: 0, providerDurationMs: 0, wallDurationMs: 0,
  outputBytes: 0, maxConcurrency: 0, sourceSentinelHits: 0,
});
const routeReport = (routeDigest: string, cancelled = false): LiveWorkerRouteReport => {
  const cases = LIVE_CASE_IDS.map(zeroCase);
  cases[LIVE_CASE_IDS.indexOf("benchmark_direct")] = {
    ...zeroCase("benchmark_direct"), sourceSentinelHits: 1,
  };
  if (cancelled) cases[LIVE_CASE_IDS.indexOf("cancellation")] = {
    ...zeroCase("cancellation"), code: "CANCELLED", usageCompleteness: "unknown_after_cancel",
    invocations: 1, intents: 1, attempts: 1, maxConcurrency: 1,
  };
  return {
    routeDigest, code: "PASS", cases,
    benchmark: buildLiveBenchmark(cases[LIVE_CASE_IDS.indexOf("benchmark_direct")]!, cases[LIVE_CASE_IDS.indexOf("benchmark_rlm")]!),
    invocations: cancelled ? 1 : 0, intents: cancelled ? 1 : 0, settlements: 0, attempts: cancelled ? 1 : 0,
    inputTokens: 0, outputTokens: 0, aggregateTokens: 0, piCatalogEstimateUsd: 0,
    providerDurationMs: 0, wallDurationMs: 0, outputBytes: 0, maxConcurrency: cancelled ? 1 : 0,
    sourceSentinelHits: 1, cancellationUsage: cancelled ? { status: "unknown_after_cancel" } : { status: "not_cancelled" },
  };
};
const privateRoot = async (): Promise<string> => {
  const root = join(tmpdir(), `pi-rlm-live-suite-test-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
};
const success = async (input: LiveChildInput, cancelled = false): Promise<LiveChildOutcome> => {
  const request = parseLiveWorkerRequestText(await readFile(input.requestPath, "utf8"));
  await writeFile(input.resultPath, canonicalStringify(routeReport(request.routeDigest, cancelled) as unknown as JsonValue), { mode: 0o600 });
  await chmod(input.resultPath, 0o600);
  return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, timedOut: false };
};

describe("contained live suite orchestration", () => {
  test("scenario module import constructs no ModelRuntime", async () => {
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const holder = codingAgent.ModelRuntime as unknown as { create: typeof codingAgent.ModelRuntime.create };
    const original = holder.create;
    let constructions = 0;
    holder.create = (() => { constructions += 1; throw new Error("module import constructed a provider runtime"); }) as typeof original;
    try { await import("./live-scenarios.ts"); }
    finally { holder.create = original; }
    expect(constructions).toBe(0);
  });

  test("runs exactly two route children serially and reconciles cancellation unknown", async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const report = await runLiveProviderAcceptanceSuite({ consent: consent(), canaries: [] }, {
      now: () => 1_000,
      runChild: async (input) => {
        active += 1; maximum = Math.max(maximum, active); calls += 1;
        const result = await success(input, calls === 2);
        active -= 1;
        return result;
      },
    });
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
    expect(report.routes.map((item) => item.alias)).toEqual(["route-1", "route-2"]);
    expect(report.totals.cancellationUsage.status).toBe("unknown_after_cancel");
    expect(report.totals.invocations).toBe(1);
  });

  test("rejects timeout and any bounded child process output", async () => {
    for (const outcome of [
      { exitCode: 137, stdoutBytes: 0, stderrBytes: 0, timedOut: true },
      { exitCode: 0, stdoutBytes: 1, stderrBytes: 0, timedOut: false },
      { exitCode: 0, stdoutBytes: 0, stderrBytes: 1, timedOut: false },
    ]) {
      await expect(runLiveProviderAcceptanceSuite({ consent: consent(), canaries: [] }, {
        now: () => 1_000, runChild: async () => outcome,
      })).rejects.toMatchObject({ code: outcome.timedOut ? "CHILD_TIMEOUT" : "CHILD_OUTPUT" });
    }
  });

  test("rejects route mismatch, malformed, oversized, and canary child reports", async () => {
    const mutations: Array<(input: LiveChildInput) => Promise<void>> = [
      async (input) => { await writeFile(input.resultPath, canonicalStringify(routeReport("a".repeat(64)) as unknown as JsonValue), { mode: 0o600 }); },
      async (input) => { await writeFile(input.resultPath, "{}", { mode: 0o600 }); },
      async (input) => { await writeFile(input.resultPath, "x".repeat(MAX_LIVE_REPORT_BYTES + 1), { mode: 0o600 }); },
    ];
    for (const mutation of mutations) {
      await expect(runLiveProviderAcceptanceSuite({ consent: consent(), canaries: [] }, {
        now: () => 1_000,
        runChild: async (input) => { await mutation(input); await chmod(input.resultPath, 0o600); return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, timedOut: false }; },
      })).rejects.toBeDefined();
    }
    const authority = consent();
    const canary = (await import("./live-worker-contract.ts")).liveRouteDigest(authority.routes[0]);
    await expect(runLiveProviderAcceptanceSuite({ consent: authority, canaries: [canary] }, {
      now: () => 1_000, runChild: success,
    })).rejects.toThrow(/canary/);
  });

  test("fails plan overflow before child and removes private roots after failures", async () => {
    const undersized = structuredClone(consent()) as LiveConsent;
    (undersized.bounds as { maxInvocations: number }).maxInvocations -= 1;
    let calls = 0;
    await expect(runLiveProviderAcceptanceSuite({ consent: undersized, canaries: [] }, {
      runChild: async () => { calls += 1; throw new Error("must not run"); },
    })).rejects.toMatchObject({ code: "LIVE_PLAN_OUTSIDE_AUTHORITY" });
    expect(calls).toBe(0);

    const root = await privateRoot();
    await expect(runLiveProviderAcceptanceSuite({ consent: consent(), canaries: [] }, {
      makeRoot: async () => root, now: () => 1_000,
      runChild: async () => ({ exitCode: 1, stdoutBytes: 0, stderrBytes: 0, timedOut: false }),
    })).rejects.toMatchObject({ code: "CHILD_FAILED" });
    expect(await Bun.file(root).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});
