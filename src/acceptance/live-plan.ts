import { LIVE_CASE_DESCRIPTORS, type LiveCaseDescriptor, type LiveCaseId } from "./live-descriptors.ts";
import type { LiveConsent, LiveConsentBounds } from "./live-contract.ts";

export interface ExpandedLiveRoutePlan {
  readonly cases: readonly LiveCaseDescriptor[];
  readonly maxInvocations: number;
  readonly maxOutputTokensPerInvocation: number;
  readonly estimatedAggregateTokens: number;
  readonly maxWallTimeMs: number;
}

export class LivePlanError extends Error {
  readonly code = "LIVE_PLAN_OUTSIDE_AUTHORITY" as const;
  constructor(message: string) {
    super(message);
    this.name = "LivePlanError";
  }
}

export const expandLiveRoutePlan = (): ExpandedLiveRoutePlan => ({
  cases: LIVE_CASE_DESCRIPTORS,
  maxInvocations: LIVE_CASE_DESCRIPTORS.reduce((sum, item) => sum + item.maxInvocations, 0),
  maxOutputTokensPerInvocation: Math.max(...LIVE_CASE_DESCRIPTORS.map((item) => item.maxOutputTokens)),
  estimatedAggregateTokens: LIVE_CASE_DESCRIPTORS.reduce((sum, item) =>
    sum + item.maxInvocations * (item.estimatedInputTokens + item.maxOutputTokens), 0),
  maxWallTimeMs: LIVE_CASE_DESCRIPTORS.reduce((sum, item) => sum + item.maxWallTimeMs, 0),
});

export const liveCaseDescriptor = (id: LiveCaseId): LiveCaseDescriptor => {
  const descriptor = LIVE_CASE_DESCRIPTORS.find((item) => item.id === id);
  if (!descriptor) throw new LivePlanError("case is outside the fixed plan");
  return descriptor;
};

export const assertLivePlanWithinConsent = (consent: LiveConsent): ExpandedLiveRoutePlan => {
  const route = expandLiveRoutePlan();
  const twice = (value: number): number => {
    if (!Number.isSafeInteger(value) || value > Number.MAX_SAFE_INTEGER / 2)
      throw new LivePlanError("live plan arithmetic overflowed");
    return value * 2;
  };
  if (twice(route.maxInvocations) > consent.bounds.maxInvocations
    || route.maxOutputTokensPerInvocation > consent.bounds.maxOutputTokensPerInvocation
    || twice(route.estimatedAggregateTokens) > consent.bounds.maxAggregateTokens
    || twice(route.maxWallTimeMs) > consent.bounds.maxWallTimeMs)
    throw new LivePlanError("fixed live plan exceeds consumed authority");
  return route;
};

export const routeWorkerBounds = (
  authority: LiveConsentBounds,
  remainingInvocations: number,
  remainingTokens: number,
  remainingWallMs: number,
): LiveConsentBounds => {
  const plan = expandLiveRoutePlan();
  if (remainingInvocations < plan.maxInvocations || remainingTokens < plan.estimatedAggregateTokens
    || remainingWallMs < plan.maxWallTimeMs)
    throw new LivePlanError("remaining authority cannot contain one route plan");
  return {
    maxInvocations: Math.min(remainingInvocations, plan.maxInvocations),
    maxOutputTokensPerInvocation: authority.maxOutputTokensPerInvocation,
    maxAggregateTokens: remainingTokens,
    maxWallTimeMs: Math.min(remainingWallMs, plan.maxWallTimeMs),
    maxPiCatalogEstimateUsd: authority.maxPiCatalogEstimateUsd,
  };
};
