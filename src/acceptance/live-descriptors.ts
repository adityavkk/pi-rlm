import { canonicalStringify, type JsonValue } from "../core/json.ts";
import { sha256 } from "../shell/hash.ts";

export const LIVE_CASE_IDS = [
  "discovery", "direct", "extension", "structured", "batch", "recurse", "fallback",
  "truncation", "cancellation", "provider_error", "retry", "benchmark_direct",
  "benchmark_rlm", "containment",
] as const;

export type LiveCaseId = typeof LIVE_CASE_IDS[number];

export interface LiveCaseDescriptor {
  readonly id: LiveCaseId;
  readonly maxInvocations: number;
  readonly maxOutputTokens: number;
  readonly estimatedInputTokens: number;
  readonly maxWallTimeMs: number;
  /** Higher only when the case must observe and reject a provider cap violation. */
  readonly maxReportedOutputTokens?: number;
}

/** Fixed one-campaign plan. Invocation maxima include schema/controller repair attempts. */
export const LIVE_CASE_DESCRIPTORS: readonly LiveCaseDescriptor[] = [
  { id: "discovery", maxInvocations: 0, maxOutputTokens: 0, estimatedInputTokens: 0, maxWallTimeMs: 10_000 },
  { id: "direct", maxInvocations: 1, maxOutputTokens: 64, estimatedInputTokens: 256, maxWallTimeMs: 45_000 },
  { id: "extension", maxInvocations: 2, maxOutputTokens: 1_024, estimatedInputTokens: 8_000, maxWallTimeMs: 90_000 },
  { id: "structured", maxInvocations: 2, maxOutputTokens: 256, estimatedInputTokens: 512, maxWallTimeMs: 45_000 },
  { id: "batch", maxInvocations: 8, maxOutputTokens: 64, estimatedInputTokens: 1_024, maxWallTimeMs: 60_000 },
  { id: "recurse", maxInvocations: 2, maxOutputTokens: 128, estimatedInputTokens: 1_024, maxWallTimeMs: 45_000 },
  { id: "fallback", maxInvocations: 2, maxOutputTokens: 512, estimatedInputTokens: 4_096, maxWallTimeMs: 60_000 },
  { id: "truncation", maxInvocations: 1, maxOutputTokens: 1, estimatedInputTokens: 256, maxWallTimeMs: 45_000, maxReportedOutputTokens: 8_192 },
  { id: "cancellation", maxInvocations: 1, maxOutputTokens: 64, estimatedInputTokens: 256, maxWallTimeMs: 45_000 },
  { id: "provider_error", maxInvocations: 1, maxOutputTokens: 16, estimatedInputTokens: 256, maxWallTimeMs: 45_000 },
  { id: "retry", maxInvocations: 2, maxOutputTokens: 512, estimatedInputTokens: 4_096, maxWallTimeMs: 60_000 },
  { id: "benchmark_direct", maxInvocations: 1, maxOutputTokens: 256, estimatedInputTokens: 52_000, maxWallTimeMs: 90_000 },
  { id: "benchmark_rlm", maxInvocations: 8, maxOutputTokens: 1_024, estimatedInputTokens: 12_000, maxWallTimeMs: 180_000 },
  { id: "containment", maxInvocations: 0, maxOutputTokens: 0, estimatedInputTokens: 0, maxWallTimeMs: 5_000 },
] as const;

export const LIVE_BENCHMARK_THRESHOLDS = {
  correctnessPpm: 1_000_000,
  rlmAttempts: 12,
  tokenRatioPpm: 6_000_000,
  costRatioPpm: 6_000_000,
  latencyRatioPpm: 8_000_000,
  rlmWallTimeMs: 180_000,
  directSourceSentinelHits: 1,
  rlmSourceSentinelHits: 0,
} as const;

export const LIVE_FIXTURE_DESCRIPTOR = {
  version: 1,
  directNonce: "PI_RLM_LIVE_DIRECT_7F31C2",
  structuredValue: 731_209,
  batchValues: [101, 202, 303, 404],
  recurseValue: 918_273,
  fallbackValue: 624_801,
  retryValue: 517_349,
  providerErrorPromptCanary: "PI_RLM_PROVIDER_ERROR_CANARY_1618033",
  longSourceBytes: 192 * 1_024,
  longSourceSentinel: "FULL_SOURCE_SENTINEL_2718281828",
  longNeedles: ["NEEDLE_A_104729", "NEEDLE_B_209759", "NEEDLE_C_314159"],
} as const;

export const LIVE_REPORT_CANARIES = [
  LIVE_FIXTURE_DESCRIPTOR.providerErrorPromptCanary,
  LIVE_FIXTURE_DESCRIPTOR.longSourceSentinel,
] as const;

export const liveSuiteDescriptor = (): JsonValue => ({
  version: 1,
  authorityContractVersion: 2,
  scenarioImplementationVersion: 7,
  cases: LIVE_CASE_DESCRIPTORS as unknown as JsonValue,
  thresholds: LIVE_BENCHMARK_THRESHOLDS as unknown as JsonValue,
});

export const liveFixtureDescriptor = (): JsonValue => LIVE_FIXTURE_DESCRIPTOR as unknown as JsonValue;
export const digestDescriptor = (value: JsonValue): string => sha256(canonicalStringify(value));
