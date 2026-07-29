import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RlmEvent } from "../core/journal.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import { JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import { DEFAULT_PROFILE, MockController, ModelController, ModelExtractor, runProgram, type Profile, type RunResult } from "../runtime/index.ts";
import { LIVE_FIXTURE_DESCRIPTOR, type LiveCaseId } from "./live-descriptors.ts";
import type { LiveCaseCode, LiveCaseReport } from "./live-contract.ts";
import {
  LiveCallBudget, LiveScenarioError, caseReport, instrumentPiBoundary, piErrorCode,
  runWall, runtimeAccountingReconciles,
} from "./live-scenario-support.ts";

export interface RuntimeScenarioContext {
  readonly runtime: ModelRuntime;
  readonly route: string;
  readonly root: string;
  readonly budget: LiveCallBudget;
  readonly backend: QuickJsBackend;
  readonly boundary: ReturnType<typeof instrumentPiBoundary>;
}

const profile = (route: string, overrides: Partial<Profile> = {}): Profile => ({
  ...DEFAULT_PROFILE,
  name: "live-acceptance",
  maxDepth: 2,
  maxFrames: 2,
  maxLogicalCalls: 8,
  maxAttempts: 8,
  maxControllerTurns: 2,
  maxConcurrency: 2,
  tokenLimit: 100_000,
  wallMs: 60_000,
  cellWallMs: 15_000,
  models: { small: route, medium: route, large: route },
  ...overrides,
});

const program = (objective: string, outputSchema: Record<string, unknown>): RlmProgram => {
  const normalized = normalizeProgram({
    objective, profile: "live-acceptance",
    inputs: [{ name: "context", adapter: "text", description: "fixed public synthetic source" }],
    outputs: [{ name: "answer", schema: outputSchema as never }],
  });
  if (!normalized.ok) throw new LiveScenarioError("SCENARIO_FAILED");
  return normalized.value;
};

const caseDir = async (context: RuntimeScenarioContext, id: LiveCaseId): Promise<string> => {
  const dir = join(context.root, id);
  await mkdir(dir, { mode: 0o700 });
  return dir;
};
const events = async (dir: string): Promise<RlmEvent[]> => {
  const result = await new JournalStore(dir).readEvents();
  if (!result.ok) throw new LiveScenarioError("SCENARIO_FAILED");
  return result.value;
};

interface FinishedRun {
  readonly result: RunResult;
  readonly events: readonly RlmEvent[];
  readonly wallDurationMs: number;
}
const execute = async (
  context: RuntimeScenarioContext,
  id: LiveCaseId,
  controller: MockController | ModelController,
  source: string,
  outputSchema: Record<string, unknown>,
  objective: string,
  options: { readonly extractor?: ModelExtractor; readonly signal?: AbortSignal; readonly profile?: Partial<Profile> } = {},
): Promise<FinishedRun> => {
  const dir = await caseDir(context, id);
  const model = context.budget.client(context.runtime, context.route, id);
  const owner = options.signal ?? new AbortController().signal;
  const measured = await runWall(() => runProgram({
    program: program(objective, outputSchema), sources: { context: source }, controller, model,
    backend: context.backend, dir, signal: owner, profile: profile(context.route, options.profile),
    ...(options.extractor ? { extractor: options.extractor } : {}),
  }));
  return { result: measured.value, events: await events(dir), wallDurationMs: measured.wallDurationMs };
};

const fromRun = (
  context: RuntimeScenarioContext,
  id: LiveCaseId,
  run: FinishedRun,
  successful: boolean,
  failure: LiveCaseCode,
  extras: { readonly outputBytes?: number; readonly sourceSentinelHits?: number; readonly correctnessPpm?: number } = {},
): LiveCaseReport => {
  const observed = context.budget.accounting(id);
  const reconciled = runtimeAccountingReconciles(observed, run.result, run.events);
  const code = !reconciled ? "ACCOUNTING_MISMATCH" : successful ? "PASS" : failure;
  return caseReport(id, context.budget, {
    code, wallDurationMs: run.wallDurationMs, outputBytes: extras.outputBytes ?? run.result.output?.bytes ?? 0,
    sourceSentinelHits: extras.sourceSentinelHits, correctnessPpm: extras.correctnessPpm,
    intents: run.events.filter((event) => event.type === "operation_intended").length,
    settlements: run.events.filter((event) => event.type === "operation_settled").length,
    attempts: run.result.ledger.usage.attempts,
  });
};

export const structuredScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const controller = new MockController([{
    reasoning: "fixed structured leaf",
    code: `const r = await llm({key:'structured',prompt:'Return only JSON {"value":731209}.',maxOutputTokens:256,schema:{type:'object',required:['value'],properties:{value:{type:'integer'}}}}); answer({answer:r.ok?r.value.value:-1})`,
  }]);
  const run = await execute(context, "structured", controller, "public structured source", { type: "integer" }, "Return the fixed validated integer.");
  return fromRun(context, "structured", run, run.result.status === "completed" && (run.result.answer as { answer?: unknown })?.answer === LIVE_FIXTURE_DESCRIPTOR.structuredValue, "STRUCTURED_FAILED");
};

export const batchScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const controller = new MockController([{
    reasoning: "fixed ordered batch",
    code: `const values=[101,202,303,404]; const r=await llm.batch({key:'batch',concurrency:2,items:values.map((value,index)=>({key:'item:'+index,prompt:'Return only JSON {"value":'+value+'}.',maxOutputTokens:64,schema:{type:'object',required:['value'],properties:{value:{type:'integer'}}}}))}); answer({answer:r.map(x=>x.ok?x.value.value:-1)})`,
  }]);
  const run = await execute(context, "batch", controller, "public batch source", { type: "array", items: { type: "integer" } }, "Return the four fixed values in order.");
  const answer = (run.result.answer as { answer?: unknown })?.answer;
  const ordered = JSON.stringify(answer) === JSON.stringify(LIVE_FIXTURE_DESCRIPTOR.batchValues);
  const concurrency = context.budget.accounting("batch").maxConcurrency;
  return fromRun(context, "batch", run, ordered && concurrency === 2, "BATCH_FAILED");
};

export const recurseScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const childIdentity = { id: "pi-rlm/live-child-fixture", version: "1", configuration: { fixture: "recurse" } } as const;
  const controller = new MockController([{
    reasoning: "open one child",
    code: "const r=await recurse({key:'only-child',objective:'perform one live leaf',context:input}); answer({answer:r.ok?r.value:-1})",
  }], () => new MockController([{
    reasoning: "one live leaf",
    code: `const r=await llm({key:'only-leaf',prompt:'Return only JSON {"value":918273}.',maxOutputTokens:128,schema:{type:'object',required:['value'],properties:{value:{type:'integer'}}}}); answer(r.ok?r.value.value:-1)`,
  }]), childIdentity);
  const run = await execute(context, "recurse", controller, "public recurse source", { type: "integer" }, "Open exactly one child which performs one live leaf.");
  const success = run.result.status === "completed" && (run.result.answer as { answer?: unknown })?.answer === LIVE_FIXTURE_DESCRIPTOR.recurseValue
    && run.result.ledger.usage.framesOpened === 1;
  return fromRun(context, "recurse", run, success, "RECURSE_FAILED");
};

export const fallbackScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const extractor = new ModelExtractor({ model: context.route, maxOutputTokens: 512 });
  const run = await execute(
    context, "fallback", new MockController([]),
    `Fixed public fallback evidence. Required integer answer: ${LIVE_FIXTURE_DESCRIPTOR.fallbackValue}.`,
    { type: "integer" }, "Extract the required integer from represented evidence.",
    { extractor, profile: { maxControllerTurns: 0, maxAttempts: 2, maxLogicalCalls: 1 } },
  );
  const success = run.result.status === "completed" && run.result.completionMode === "fallback_extract"
    && (run.result.answer as { answer?: unknown })?.answer === LIVE_FIXTURE_DESCRIPTOR.fallbackValue;
  return fromRun(context, "fallback", run, success, "FALLBACK_FAILED");
};

class RepairFixtureModel implements ModelClient {
  readonly id = "live-repair-fixture-model";
  readonly identity;
  private calls = 0;
  constructor(private readonly inner: ModelClient) {
    this.identity = {
      id: "pi-rlm/live-repair-fixture", version: "1",
      configuration: { innerId: inner.identity.id, innerVersion: inner.identity.version },
    } as const;
  }
  async complete(request: Parameters<ModelClient["complete"]>[0]) {
    const response = await this.inner.complete(request);
    this.calls += 1;
    return {
      ...response,
      text: this.calls === 1 ? "fixed-public-invalid-json" : JSON.stringify({
        reasoning: "fixed repair", code: `answer({answer:${LIVE_FIXTURE_DESCRIPTOR.retryValue}})`,
      }),
    };
  }
}

export const retryScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const before = context.boundary.maxRetriesZeroCalls();
  const model = new RepairFixtureModel(context.budget.client(context.runtime, context.route, "retry"));
  const controller = new ModelController(model, { model: context.route, maxOutputTokens: 512 });
  const dir = await caseDir(context, "retry");
  const measured = await runWall(() => runProgram({
    program: program("Exercise one controller repair.", { type: "integer" }), sources: { context: "public retry source" },
    controller, model, backend: context.backend, dir, signal: new AbortController().signal,
    profile: profile(context.route, { maxAttempts: 2, maxControllerTurns: 1 }),
  }));
  const run = { result: measured.value, events: await events(dir), wallDurationMs: measured.wallDurationMs };
  const success = run.result.status === "completed" && (run.result.answer as { answer?: unknown })?.answer === LIVE_FIXTURE_DESCRIPTOR.retryValue
    && context.boundary.maxRetriesZeroCalls() - before === 2;
  return fromRun(context, "retry", run, success, "RETRY_FAILED");
};

export const cancellationScenario = async (context: RuntimeScenarioContext): Promise<LiveCaseReport> => {
  const owner = new AbortController();
  let streamStarts = 0;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  context.boundary.observeNextStreamStart(() => {
    streamStarts += 1;
    // Pi's start event precedes content. Give transport a short window to enter
    // flight so an abort-before-dispatch cannot satisfy this case.
    abortTimer = setTimeout(() => owner.abort(), 25);
  });
  const dir = await caseDir(context, "cancellation");
  const model = context.budget.client(context.runtime, context.route, "cancellation");
  const controller = new MockController([{
    reasoning: "cancel live leaf",
    code: "const r=await llm({key:'cancel',prompt:'Write a numbered public sequence with at least 1000 entries and no preamble.',maxOutputTokens:64}); answer({answer:r.ok?'late':r.error.code})",
  }]);
  const measured = await runWall(() => runProgram({
    program: program("Cancel one in-flight live leaf.", { type: "string" }), sources: { context: "public cancellation source" },
    controller, model, backend: context.backend, dir, signal: owner.signal,
    profile: profile(context.route, { maxAttempts: 1, maxLogicalCalls: 1, maxControllerTurns: 1 }),
  }));
  if (abortTimer) clearTimeout(abortTimer);
  const journal = await events(dir);
  const before = await readFile(join(dir, "events.jsonl"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await readFile(join(dir, "events.jsonl"));
  const intents = journal.filter((event) => event.type === "operation_intended").length;
  const settlements = journal.filter((event) => event.type === "operation_settled").length;
  const success = measured.value.status === "cancelled" && streamStarts === 1 && before.equals(after)
    && journal.filter((event) => event.type === "run_cancelled").length === 1;
  return caseReport("cancellation", context.budget, {
    code: success ? "CANCELLED" : "CANCELLATION_FAILED", verdict: success ? "pass" : "fail",
    wallDurationMs: measured.wallDurationMs, intents, settlements,
    attempts: measured.value.ledger.usage.attempts, usageCompleteness: "unknown_after_cancel",
  });
};

export const benchmarkRlmScenario = async (context: RuntimeScenarioContext, source: string): Promise<LiveCaseReport> => {
  const model = context.budget.client(context.runtime, context.route, "benchmark_rlm");
  const controller = new MockController([{
    reasoning: "retrieve only target lines, then use one structured live leaf",
    code: `const hits=await input.grep({pattern:'BENCHMARK_TARGET_',maxMatches:3,syntax:'literal'}); const r=await llm({key:'benchmark-extract',prompt:'From these fixed grep hits return only JSON with string keys first, second, third and their exact values: '+JSON.stringify(hits),maxOutputTokens:256,schema:{type:'object',required:['first','second','third'],properties:{first:{type:'string'},second:{type:'string'},third:{type:'string'}}}}); answer({answer:r.ok?r.value:{first:'',second:'',third:''}})`,
  }]);
  const dir = await caseDir(context, "benchmark_rlm");
  const measured = await runWall(() => runProgram({
    program: program("Find the values on the three BENCHMARK_TARGET lines. Return an object answer with exact keys first, second, third.", {
      type: "object", required: ["first", "second", "third"],
      properties: { first: { type: "string" }, second: { type: "string" }, third: { type: "string" } },
    }), sources: { context: source }, controller, model, backend: context.backend, dir,
    signal: new AbortController().signal,
    profile: profile(context.route, { maxAttempts: 2, maxControllerTurns: 1, maxLogicalCalls: 2, wallMs: 180_000, contextMaxReadBytes: 256 * 1_024 }),
  }));
  const run = { result: measured.value, events: await events(dir), wallDurationMs: measured.wallDurationMs };
  const answer = (run.result.answer as { answer?: unknown })?.answer;
  const value = typeof answer === "object" && answer !== null && !Array.isArray(answer) ? answer as Record<string, unknown> : undefined;
  const exact = value !== undefined && Object.keys(value).sort().join(",") === "first,second,third"
    && value["first"] === LIVE_FIXTURE_DESCRIPTOR.longNeedles[0]
    && value["second"] === LIVE_FIXTURE_DESCRIPTOR.longNeedles[1]
    && value["third"] === LIVE_FIXTURE_DESCRIPTOR.longNeedles[2];
  return fromRun(context, "benchmark_rlm", run, exact, "BENCHMARK_FAILED", {
    correctnessPpm: exact ? 1_000_000 : 0,
  });
};
