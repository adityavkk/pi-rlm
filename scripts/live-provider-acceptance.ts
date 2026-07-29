import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
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
import { liveRouteDigest } from "../src/acceptance/live-worker-contract.ts";

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
  readonly code: "ARGUMENTS_INVALID" | "GIT_COMMIT_INVALID" | "REPORT_AUTHORITY_MISMATCH" | "CANARY_FILE_INVALID";
  constructor(code: LiveRunnerError["code"], message: string) {
    super(message);
    this.name = "LiveRunnerError";
    this.code = code;
  }
}

const parseArgs = (args: readonly string[]): {
  consentPath: string; outputPath: string; canaryPath?: string;
} => {
  const withCanary = args.length === 6 && args[4] === "--canary-file" && Boolean(args[5]);
  if ((args.length !== 4 && !withCanary) || args[0] !== "--consent" || args[2] !== "--output"
    || !args[1] || !args[3])
    throw new LiveRunnerError("ARGUMENTS_INVALID", "expected exact live acceptance arguments");
  const paths = [args[1], args[3], ...(withCanary ? [args[5]!] : [])].map((path) => resolve(path));
  if (new Set(paths).size !== paths.length)
    throw new LiveRunnerError("ARGUMENTS_INVALID", "live acceptance paths must be distinct");
  return { consentPath: args[1], outputPath: args[3], ...(withCanary ? { canaryPath: args[5]! } : {}) };
};

const consumeCanaryFile = async (path: string): Promise<readonly string[]> => {
  const consumed = `${path}.consumed-${randomBytes(16).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await rename(path, consumed);
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") throw new Error("no-follow unavailable");
    handle = await open(consumed, constants.O_RDONLY | noFollow);
    const stat = await handle.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1n || (Number(stat.mode) & 0o7777) !== 0o600
      || uid === undefined || stat.uid !== BigInt(uid) || stat.size > 16_384n) throw new Error("metadata");
    const bytes = new Uint8Array(Number(stat.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== Number(stat.size) || after.dev !== stat.dev || after.ino !== stat.ino
      || after.size !== stat.size || after.mode !== stat.mode || after.uid !== stat.uid || after.nlink !== stat.nlink
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new Error("changed");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16
      || parsed.some((item) => typeof item !== "string" || item.length < 8 || item.length > 1024)
      || new Set(parsed).size !== parsed.length) throw new Error("shape");
    return Object.freeze([...parsed] as string[]);
  } catch {
    throw new LiveRunnerError("CANARY_FILE_INVALID", "one-shot canary file is invalid");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(consumed).catch(() => {});
  }
};

const validateReportAuthority = (reportInput: unknown, consent: LiveConsent): LiveAcceptanceReport => {
  const report = parseLiveReport(reportInput);
  if (report.gitCommit !== consent.gitCommit || report.suiteDigest !== consent.suiteDigest
    || report.fixtureDigest !== consent.fixtureDigest)
    throw new LiveRunnerError("REPORT_AUTHORITY_MISMATCH", "report identity is outside consent authority");
  if (report.routes[0].routeDigest !== liveRouteDigest(consent.routes[0], consent.nonce)
    || report.routes[1].routeDigest !== liveRouteDigest(consent.routes[1], consent.nonce))
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
  const { consentPath, outputPath, canaryPath } = parseArgs(args);
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
    const canaries = [
      ...LIVE_REPORT_CANARIES,
      ...(canaryPath ? await consumeCanaryFile(canaryPath) : []),
      ...(dependencies.canaries ?? []),
    ];
    const suite = await (dependencies.loadSuite ?? (() => import("../src/acceptance/live-suite.ts")))();
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
  "ARGUMENTS_INVALID", "GIT_COMMIT_INVALID", "REPORT_AUTHORITY_MISMATCH", "CANARY_FILE_INVALID",
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
