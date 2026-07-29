import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalStringify, type JsonValue } from "../src/core/json.ts";
import {
  LIVE_FIXTURE_DIGEST,
  LIVE_SUITE_DIGEST,
  parseLiveReport,
  type LiveAcceptanceReport,
  type LiveConsent,
} from "../src/acceptance/live-contract.ts";
import { withConsumedLiveConsent, type LiveConsentDependencies } from "../src/acceptance/live-consent.ts";
import { LIVE_REPORT_CANARIES } from "../src/acceptance/live-descriptors.ts";
import {
  currentLiveRepositoryRevision,
  verifyLiveRepositoryRevision,
} from "../src/acceptance/live-revision.ts";
import { publishLiveReport } from "../src/acceptance/live-report.ts";

interface LiveSuiteModule {
  readonly runLiveProviderAcceptanceSuite: (input: {
    readonly consent: LiveConsent;
    readonly canaries: readonly string[];
    readonly verifyRevision?: () => void;
  }) => Promise<LiveAcceptanceReport>;
}

export interface LiveRunnerDependencies {
  readonly gitCommit?: () => string;
  readonly nowMs?: number;
  readonly consent?: LiveConsentDependencies;
  readonly verifyRevision?: (expected: string) => void;
  /** Provider-capable seam. Called only after consent has been atomically consumed. */
  readonly loadSuite?: () => Promise<LiveSuiteModule>;
  readonly publishReport?: typeof publishLiveReport;
  readonly canaries?: readonly string[];
}

export class LiveRunnerError extends Error {
  readonly code: "ARGUMENTS_INVALID" | "GIT_COMMIT_INVALID" | "REPORT_AUTHORITY_MISMATCH";
  constructor(code: LiveRunnerError["code"], message: string) {
    super(message);
    this.name = "LiveRunnerError";
    this.code = code;
  }
}

const parseArgs = (args: readonly string[]): { consentPath: string; outputPath: string } => {
  if (args.length !== 4 || args[0] !== "--consent" || args[2] !== "--output"
    || !args[1] || !args[3] || resolve(args[1]) === resolve(args[3]))
    throw new LiveRunnerError("ARGUMENTS_INVALID", "expected --consent <path> --output <path>");
  return { consentPath: args[1], outputPath: args[3] };
};

const routeDigest = (route: LiveConsent["routes"][number]): string =>
  createHash("sha256").update(canonicalStringify(route as unknown as JsonValue)).digest("hex");

const validateReportAuthority = (reportInput: unknown, consent: LiveConsent): LiveAcceptanceReport => {
  const report = parseLiveReport(reportInput);
  if (report.gitCommit !== consent.gitCommit || report.suiteDigest !== consent.suiteDigest
    || report.fixtureDigest !== consent.fixtureDigest)
    throw new LiveRunnerError("REPORT_AUTHORITY_MISMATCH", "report identity is outside consent authority");
  if (report.routes[0].routeDigest !== routeDigest(consent.routes[0])
    || report.routes[1].routeDigest !== routeDigest(consent.routes[1]))
    throw new LiveRunnerError("REPORT_AUTHORITY_MISMATCH", "report routes are outside consent authority");
  if (report.totals.invocations > consent.bounds.maxInvocations
    || report.totals.aggregateTokens > consent.bounds.maxAggregateTokens
    || report.totals.piCatalogEstimateUsd > consent.bounds.maxPiCatalogEstimateUsd
    || report.durationMs > consent.bounds.maxWallTimeMs
    || report.totals.outputTokens > report.totals.invocations * consent.bounds.maxOutputTokensPerInvocation)
    throw new LiveRunnerError("REPORT_AUTHORITY_MISMATCH", "report accounting exceeds consent authority");
  return report;
};

export const runLiveProviderAcceptance = async (
  args: readonly string[],
  dependencies: LiveRunnerDependencies = {},
): Promise<LiveAcceptanceReport> => {
  const { consentPath, outputPath } = parseArgs(args);
  const gitCommit = (dependencies.gitCommit ?? currentLiveRepositoryRevision)();
  if (!/^[a-f0-9]{40}$/.test(gitCommit))
    throw new LiveRunnerError("GIT_COMMIT_INVALID", "current git commit is invalid");
  const verifyRevision = dependencies.verifyRevision
    ?? (dependencies.gitCommit ? (() => {}) : verifyLiveRepositoryRevision);
  verifyRevision(gitCommit);
  return withConsumedLiveConsent(consentPath, {
    gitCommit,
    suiteDigest: LIVE_SUITE_DIGEST,
    fixtureDigest: LIVE_FIXTURE_DIGEST,
    nowMs: dependencies.nowMs,
  }, async (consent) => {
    verifyRevision(gitCommit);
    const suite = await (dependencies.loadSuite ?? (() => import("../src/acceptance/live-suite.ts")))();
    const canaries = [...LIVE_REPORT_CANARIES, ...(dependencies.canaries ?? [])];
    const report = validateReportAuthority(
      await suite.runLiveProviderAcceptanceSuite({
        consent,
        canaries,
        verifyRevision: () => verifyRevision(gitCommit),
      }),
      consent,
    );
    verifyRevision(gitCommit);
    return (dependencies.publishReport ?? publishLiveReport)(outputPath, report, canaries);
  }, dependencies.consent);
};

const CLI_CODES = new Set<string>([
  "ARGUMENTS_INVALID", "GIT_COMMIT_INVALID", "REPORT_AUTHORITY_MISMATCH",
  "LIVE_CONTRACT_INVALID", "CONSENT_FILE_INVALID", "CONSENT_EXPIRED", "CONSENT_NOT_YET_VALID",
  "CONSENT_COMMIT_MISMATCH", "CONSENT_SUITE_MISMATCH", "CONSENT_FIXTURE_MISMATCH",
  "CONSENT_CONSUMPTION_FAILED", "REPORT_PUBLICATION_FAILED", "SUITE_NOT_IMPLEMENTED",
  "LIVE_PLAN_OUTSIDE_AUTHORITY", "CHILD_FAILED", "CHILD_TIMEOUT", "CHILD_OUTPUT",
  "CHILD_REPORT_INVALID", "CHILD_CONTAINMENT_FAILED",
]);
const safeCode = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("code" in error)) return "LIVE_ACCEPTANCE_FAILED";
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && CLI_CODES.has(code) ? code : "LIVE_ACCEPTANCE_FAILED";
};

if (import.meta.main) {
  try {
    await runLiveProviderAcceptance(process.argv.slice(2));
  } catch (error) {
    console.error(safeCode(error));
    process.exitCode = 1;
  }
}
