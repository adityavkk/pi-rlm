import { lstat } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { LIVE_CASE_IDS, LIVE_FIXTURE_DESCRIPTOR, type LiveCaseId } from "./live-descriptors.ts";
import {
  buildLiveBenchmark, type LiveCaseCode, type LiveCaseReport, type LiveNumericAccounting,
  type LiveWorkerRouteReport,
} from "./live-contract.ts";
import type { LiveWorkerRequest } from "./live-worker-contract.ts";
import { extensionScenario } from "./live-extension-scenario.ts";
import {
  batchScenario, benchmarkRlmScenario, cancellationScenario, fallbackScenario,
  recurseScenario, retryScenario, structuredScenario, type RuntimeScenarioContext,
} from "./live-runtime-scenarios.ts";
import {
  LiveCallBudget, caseReport, instrumentPiBoundary, piErrorCode, runWall,
} from "./live-scenario-support.ts";

export interface LiveRouteScenarioInput {
  readonly request: LiveWorkerRequest;
  readonly root: string;
}

const directScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const model = context.budget.client(context.runtime, context.route, "direct");
  const measured = await runWall(() => model.complete({
    prompt: `Return exactly this public nonce and no other bytes: ${LIVE_FIXTURE_DESCRIPTOR.directNonce}`,
    maxOutputTokens: 64,
  }));
  const exact = measured.value.text === LIVE_FIXTURE_DESCRIPTOR.directNonce;
  return caseReport("direct", context.budget, {
    code: exact ? "PASS" : "DIRECT_MISMATCH", wallDurationMs: measured.wallDurationMs,
    outputBytes: Buffer.byteLength(measured.value.text, "utf8"),
  });
};

const truncationScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const model = context.budget.client(context.runtime, context.route, "truncation");
  const started = performance.now();
  try {
    const response = await model.complete({
      prompt: "Write at least one hundred public words. Do not stop early.", maxOutputTokens: 1,
    });
    return caseReport("truncation", context.budget, {
      code: "TRUNCATION_FAILED",
      wallDurationMs: performance.now() - started, outputBytes: Buffer.byteLength(response.text, "utf8"),
    });
  } catch (error) {
    const code = piErrorCode(error);
    return caseReport("truncation", context.budget, {
      code: code === "OUTPUT_TRUNCATED" ? "OUTPUT_TRUNCATED" : "TRUNCATION_FAILED",
      verdict: code === "OUTPUT_TRUNCATED" ? "pass" : "fail",
      wallDurationMs: performance.now() - started,
    });
  }
};

const providerErrorScenario = async (
  request: LiveWorkerRequest,
  budget: LiveCallBudget,
): Promise<LiveCaseReport> => {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = runtime.getModel(request.route.provider, request.route.model);
  if (!model || model.api !== request.route.apiFamily) return caseReport("provider_error", budget, { code: "PROVIDER_ERROR_FAILED" });
  await runtime.setRuntimeApiKey(request.route.provider, LIVE_FIXTURE_DESCRIPTOR.invalidCredentialCanary);
  const boundary = instrumentPiBoundary(runtime);
  const client = budget.client(runtime, `${request.route.provider}/${request.route.model}`, "provider_error");
  const started = performance.now();
  try {
    await client.complete({ prompt: "Return the public word acceptance.", maxOutputTokens: 16 });
    return caseReport("provider_error", budget, { code: "PROVIDER_ERROR_FAILED", wallDurationMs: performance.now() - started });
  } catch (error) {
    const expected = piErrorCode(error) === "PROVIDER_ERROR" && boundary.maxRetriesZeroCalls() === 1;
    return caseReport("provider_error", budget, {
      code: expected ? "PROVIDER_ERROR" : "PROVIDER_ERROR_FAILED", verdict: expected ? "pass" : "fail",
      wallDurationMs: performance.now() - started,
      usageCompleteness: expected && budget.accounting("provider_error").aggregateTokens === 0 ? "unavailable" : undefined,
    });
  } finally { boundary.restore(); }
};

export const generateLiveLongSource = (): string => {
  const size = LIVE_FIXTURE_DESCRIPTOR.longSourceBytes;
  const bytes = Buffer.alloc(size, 0x78);
  const lines = [
    `\nBENCHMARK_TARGET_FIRST=${LIVE_FIXTURE_DESCRIPTOR.longNeedles[0]}\n`,
    `\n${LIVE_FIXTURE_DESCRIPTOR.longSourceSentinel}\n`,
    `\nBENCHMARK_TARGET_SECOND=${LIVE_FIXTURE_DESCRIPTOR.longNeedles[1]}\n`,
    `\nBENCHMARK_TARGET_THIRD=${LIVE_FIXTURE_DESCRIPTOR.longNeedles[2]}\n`,
  ];
  const offsets = [16_384, 57_344, 98_304, 176_128];
  for (let index = 0; index < lines.length; index++) bytes.write(lines[index]!, offsets[index]!, "ascii");
  return bytes.toString("ascii");
};

const parseBenchmarkAnswer = (text: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
};
const expectedBenchmark = () => ({
  first: LIVE_FIXTURE_DESCRIPTOR.longNeedles[0],
  second: LIVE_FIXTURE_DESCRIPTOR.longNeedles[1],
  third: LIVE_FIXTURE_DESCRIPTOR.longNeedles[2],
});
const exactBenchmarkValue = (value: Record<string, unknown> | undefined): boolean => {
  if (!value || Object.keys(value).sort().join(",") !== "first,second,third") return false;
  const expected = expectedBenchmark();
  return value["first"] === expected.first && value["second"] === expected.second && value["third"] === expected.third;
};

const benchmarkDirectScenario = async (context: RuntimeScenarioContext, source: string): Promise<LiveCaseReport> => {
  const model = context.budget.client(context.runtime, context.route, "benchmark_direct");
  const measured = await runWall(() => model.complete({
    system: "Use the complete supplied context. Return only strict JSON with keys first, second, third.",
    prompt: "Find the values on BENCHMARK_TARGET_FIRST, BENCHMARK_TARGET_SECOND, and BENCHMARK_TARGET_THIRD.",
    context: [source], maxOutputTokens: 256,
  }));
  const parsed = parseBenchmarkAnswer(measured.value.text);
  const exact = exactBenchmarkValue(parsed);
  return caseReport("benchmark_direct", context.budget, {
    code: exact ? "PASS" : "BENCHMARK_FAILED", correctnessPpm: exact ? 1_000_000 : 0,
    wallDurationMs: measured.wallDurationMs, outputBytes: Buffer.byteLength(measured.value.text, "utf8"),
  });
};

const containmentScenario = async (input: LiveRouteScenarioInput, budget: LiveCallBudget): Promise<LiveCaseReport> => {
  const stat = await lstat(input.root, { bigint: true });
  const pass = stat.isDirectory() && (Number(stat.mode) & 0o7777) === 0o700 && stat.nlink >= 1n;
  return caseReport("containment", budget, { code: pass ? "PASS" : "CONTAINMENT_FAILED" });
};

const notRun = (id: LiveCaseId, budget: LiveCallBudget): LiveCaseReport => caseReport(id, budget, { code: "NOT_RUN" });
const failureCode = (id: LiveCaseId): LiveCaseCode => ({
  discovery: "DISCOVERY_FAILED", direct: "DIRECT_MISMATCH", extension: "EXTENSION_FAILED",
  structured: "STRUCTURED_FAILED", batch: "BATCH_FAILED", recurse: "RECURSE_FAILED",
  fallback: "FALLBACK_FAILED", truncation: "TRUNCATION_FAILED", cancellation: "CANCELLATION_FAILED",
  provider_error: "PROVIDER_ERROR_FAILED", retry: "RETRY_FAILED", benchmark_direct: "BENCHMARK_FAILED",
  benchmark_rlm: "BENCHMARK_FAILED", containment: "CONTAINMENT_FAILED",
})[id] as LiveCaseCode;

const accountCases = (cases: readonly LiveCaseReport[]): LiveNumericAccounting => ({
  invocations: cases.reduce((sum, item) => sum + item.invocations, 0),
  intents: cases.reduce((sum, item) => sum + item.intents, 0),
  settlements: cases.reduce((sum, item) => sum + item.settlements, 0),
  attempts: cases.reduce((sum, item) => sum + item.attempts, 0),
  inputTokens: cases.reduce((sum, item) => sum + item.inputTokens, 0),
  outputTokens: cases.reduce((sum, item) => sum + item.outputTokens, 0),
  aggregateTokens: cases.reduce((sum, item) => sum + item.aggregateTokens, 0),
  piCatalogEstimateUsd: cases.reduce((sum, item) => sum + item.piCatalogEstimateUsd, 0),
  providerDurationMs: cases.reduce((sum, item) => sum + item.providerDurationMs, 0),
  wallDurationMs: cases.reduce((sum, item) => sum + item.wallDurationMs, 0),
  outputBytes: cases.reduce((sum, item) => sum + item.outputBytes, 0),
  maxConcurrency: Math.max(...cases.map((item) => item.maxConcurrency)),
  sourceSentinelHits: cases.reduce((sum, item) => sum + item.sourceSentinelHits, 0),
});

const routeReport = (input: LiveRouteScenarioInput, cases: LiveCaseReport[]): LiveWorkerRouteReport => {
  const direct = cases[LIVE_CASE_IDS.indexOf("benchmark_direct")]!;
  let rlm = cases[LIVE_CASE_IDS.indexOf("benchmark_rlm")]!;
  let benchmark = buildLiveBenchmark(direct, rlm);
  const thresholdsPass = benchmark.correctnessPass && benchmark.rlmAttemptsPass && benchmark.tokenRatioPass
    && benchmark.costRatioPass && benchmark.latencyRatioPass && benchmark.rlmWallTimePass
    && benchmark.sourceIsolationPass;
  if (rlm.verdict === "pass" && !thresholdsPass) {
    rlm = { ...rlm, code: "THRESHOLD_FAILED", verdict: "fail" };
    cases[LIVE_CASE_IDS.indexOf("benchmark_rlm")] = rlm;
    benchmark = buildLiveBenchmark(direct, rlm);
  }
  const accounting = accountCases(cases);
  const code = cases.every((item) => item.verdict === "pass") ? "PASS"
    : cases[0]?.code === "ROUTE_MISMATCH" ? "ROUTE_MISMATCH"
      : cases[0]?.code === "AUTH_UNAVAILABLE" || cases[0]?.code === "DISCOVERY_FAILED" ? "PROVIDER_DISCOVERY_FAILED"
        : "ACCEPTANCE_FAILED";
  return {
    routeDigest: input.request.routeDigest, code, cases, benchmark, ...accounting,
    cancellationUsage: cases[LIVE_CASE_IDS.indexOf("cancellation")]?.usageCompleteness === "unknown_after_cancel"
      ? { status: "unknown_after_cancel" }
      : { status: "not_cancelled" },
  };
};

export const runLiveRouteScenarios = async (input: LiveRouteScenarioInput): Promise<LiveWorkerRouteReport> => {
  const budget = new LiveCallBudget(input.request.bounds);
  const cases: LiveCaseReport[] = [];
  let runtime: ModelRuntime;
  try { runtime = await ModelRuntime.create({ allowModelNetwork: false }); }
  catch {
    cases.push(caseReport("discovery", budget, { code: "DISCOVERY_FAILED" }));
    for (const id of LIVE_CASE_IDS.slice(1)) cases.push(notRun(id, budget));
    return routeReport(input, cases);
  }
  let discovered: ReturnType<ModelRuntime["getModel"]>;
  let routeMatches = false;
  let authAvailable = false;
  let discoveryFailed = false;
  try {
    discovered = runtime.getModel(input.request.route.provider, input.request.route.model);
    routeMatches = discovered?.api === input.request.route.apiFamily;
    authAvailable = runtime.hasConfiguredAuth(input.request.route.provider);
  } catch { discoveryFailed = true; }
  cases.push(caseReport("discovery", budget, {
    code: discoveryFailed ? "DISCOVERY_FAILED" : !routeMatches ? "ROUTE_MISMATCH" : !authAvailable ? "AUTH_UNAVAILABLE" : "PASS",
  }));
  if (!routeMatches || !authAvailable) {
    for (const id of LIVE_CASE_IDS.slice(1)) cases.push(notRun(id, budget));
  } else {
    const route = `${input.request.route.provider}/${input.request.route.model}`;
    let backend: QuickJsBackend;
    try { backend = await QuickJsBackend.create(); }
    catch {
      for (const id of LIVE_CASE_IDS.slice(1)) cases.push(caseReport(id, budget, { code: "SCENARIO_FAILED" }));
      return routeReport(input, cases);
    }
    const boundary = instrumentPiBoundary(runtime);
    const context: RuntimeScenarioContext = { runtime, route, root: input.root, budget, backend, boundary };
    const source = generateLiveLongSource();
    const work: Array<[LiveCaseId, () => Promise<LiveCaseReport>]> = [
      ["direct", () => directScenario(context)],
      ["extension", () => extensionScenario(context)],
      ["structured", () => structuredScenario(context)],
      ["batch", () => batchScenario(context)],
      ["recurse", () => recurseScenario(context)],
      ["fallback", () => fallbackScenario(context)],
      ["truncation", () => truncationScenario(context)],
      ["cancellation", () => cancellationScenario(context)],
      ["provider_error", () => providerErrorScenario(input.request, budget)],
      ["retry", () => retryScenario(context)],
      ["benchmark_direct", () => benchmarkDirectScenario(context, source)],
      ["benchmark_rlm", () => benchmarkRlmScenario(context, source)],
      ["containment", () => containmentScenario(input, budget)],
    ];
    try {
      for (const [id, scenario] of work) {
        try { cases.push(await scenario()); }
        catch { cases.push(caseReport(id, budget, { code: failureCode(id) })); }
      }
    } finally { boundary.restore(); await backend.dispose(); }
  }
  return routeReport(input, cases);
};
