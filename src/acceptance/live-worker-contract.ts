import { createHash } from "node:crypto";
import { canonicalStringify, type JsonValue } from "../core/json.ts";
import {
  LIVE_ACCEPTANCE_VERSION, LIVE_FIXTURE_DIGEST, LIVE_SUITE_DIGEST,
  parseLiveBounds, type LiveConsentBounds, type LiveConsentRoute,
} from "./live-contract.ts";
import { parseLiveWorkerRouteReport, type LiveWorkerRouteReport } from "./live-report-contract.ts";
import {
  liveExactKeys, liveFail, liveObject, liveOwn, livePattern, parseCanonicalLiveJson, strictLiveJson,
} from "./live-json.ts";

export const MAX_LIVE_WORKER_REQUEST_BYTES = 16 * 1024;
const ROUTE_PART = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ROUTE_DIGEST_NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;

export interface LiveWorkerRequest {
  readonly version: typeof LIVE_ACCEPTANCE_VERSION;
  readonly gitCommit: string;
  readonly suiteDigest: typeof LIVE_SUITE_DIGEST;
  readonly fixtureDigest: typeof LIVE_FIXTURE_DIGEST;
  readonly route: LiveConsentRoute;
  readonly routeDigestNonce: string;
  readonly routeDigest: string;
  readonly bounds: LiveConsentBounds;
}

export const liveRouteDigest = (route: LiveConsentRoute, nonce: string): string =>
  createHash("sha256")
    .update(nonce)
    .update("\0")
    .update(canonicalStringify(route as unknown as JsonValue))
    .digest("hex");

export const parseLiveWorkerRequest = (input: unknown): LiveWorkerRequest => {
  const value = liveObject(strictLiveJson(input, "worker request"), "worker request");
  liveExactKeys(value, [
    "version", "gitCommit", "suiteDigest", "fixtureDigest", "route", "routeDigestNonce", "routeDigest", "bounds",
  ], "worker request");
  if (liveOwn(value, "version") !== LIVE_ACCEPTANCE_VERSION
    || liveOwn(value, "suiteDigest") !== LIVE_SUITE_DIGEST
    || liveOwn(value, "fixtureDigest") !== LIVE_FIXTURE_DIGEST)
    liveFail("worker request identity is invalid");
  const routeValue = liveObject(liveOwn(value, "route") as JsonValue, "worker request.route");
  liveExactKeys(routeValue, ["provider", "model", "apiFamily"], "worker request.route");
  const route = {
    provider: livePattern(liveOwn(routeValue, "provider"), ROUTE_PART, "worker request.route.provider"),
    model: livePattern(liveOwn(routeValue, "model"), ROUTE_PART, "worker request.route.model"),
    apiFamily: livePattern(liveOwn(routeValue, "apiFamily"), ROUTE_PART, "worker request.route.apiFamily"),
  };
  const routeDigestNonce = livePattern(
    liveOwn(value, "routeDigestNonce"), ROUTE_DIGEST_NONCE, "worker request.routeDigestNonce",
  );
  const routeDigest = livePattern(liveOwn(value, "routeDigest"), DIGEST, "worker request.routeDigest");
  if (routeDigest !== liveRouteDigest(route, routeDigestNonce))
    liveFail("worker request route digest does not reconcile");
  return {
    version: LIVE_ACCEPTANCE_VERSION,
    gitCommit: livePattern(liveOwn(value, "gitCommit"), GIT_COMMIT, "worker request.gitCommit"),
    suiteDigest: LIVE_SUITE_DIGEST, fixtureDigest: LIVE_FIXTURE_DIGEST,
    route, routeDigestNonce, routeDigest, bounds: parseLiveBounds(liveOwn(value, "bounds") as JsonValue, "worker request.bounds"),
  };
};

export const parseLiveWorkerRequestText = (text: string): LiveWorkerRequest =>
  parseLiveWorkerRequest(parseCanonicalLiveJson(text, MAX_LIVE_WORKER_REQUEST_BYTES, "worker request"));

export const canonicalLiveWorkerRequest = (input: unknown): string =>
  canonicalStringify(parseLiveWorkerRequest(input) as unknown as JsonValue);

export const canonicalLiveWorkerRouteReport = (input: unknown): string =>
  canonicalStringify(parseLiveWorkerRouteReport(input) as unknown as JsonValue);
