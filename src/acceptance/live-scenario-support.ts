import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RlmEvent } from "../core/journal.ts";
import type { CallUsage } from "../core/usage.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../shell/model/client.ts";
import { PiModelClient, PiModelError } from "../shell/model/pi-model.ts";
import type { RunResult } from "../runtime/run.ts";
import { LIVE_FIXTURE_DESCRIPTOR, type LiveCaseId } from "./live-descriptors.ts";
import { liveCaseDescriptor } from "./live-plan.ts";
import type { LiveCaseCode, LiveCaseReport, LiveConsentBounds, LiveNumericAccounting } from "./live-contract.ts";

const ZERO: LiveNumericAccounting = {
  invocations: 0, intents: 0, settlements: 0, attempts: 0,
  inputTokens: 0, outputTokens: 0, aggregateTokens: 0, piCatalogEstimateUsd: 0,
  providerDurationMs: 0, wallDurationMs: 0, outputBytes: 0, maxConcurrency: 0, sourceSentinelHits: 0,
};

interface MutableUsage {
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  aggregateTokens: number;
  piCatalogEstimateUsd: number;
  providerDurationMs: number;
  maxConcurrency: number;
  sourceSentinelHits: number;
}

interface LiveCallReservation {
  readonly tokens: number;
  settled: boolean;
  released: boolean;
}

const usageTotal = (usage: CallUsage): number =>
  usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

export class LiveCallBudget {
  private totalInvocations = 0;
  private totalTokens = 0;
  private reservedTokens = 0;
  private totalEstimate = 0;
  private readonly usages = new Map<LiveCaseId, MutableUsage>();

  constructor(readonly bounds: LiveConsentBounds) {}

  client(runtime: ModelRuntime, route: string, id: LiveCaseId): ModelClient {
    return new ObservedModelClient(new PiModelClient(runtime, route), this, id);
  }

  before(id: LiveCaseId, request: ModelRequest): LiveCallReservation {
    const descriptor = liveCaseDescriptor(id);
    const usage = this.mutable(id);
    const output = request.maxOutputTokens;
    if (!Number.isSafeInteger(output) || !output || output > descriptor.maxOutputTokens
      || output > this.bounds.maxOutputTokensPerInvocation
      || usage.invocations >= descriptor.maxInvocations || this.totalInvocations >= this.bounds.maxInvocations)
      throw new LiveScenarioError("BUDGET_EXCEEDED");
    const reservation = descriptor.estimatedInputTokens + output;
    if (this.totalTokens + this.reservedTokens + reservation > this.bounds.maxAggregateTokens)
      throw new LiveScenarioError("BUDGET_EXCEEDED");
    usage.invocations += 1;
    this.totalInvocations += 1;
    this.reservedTokens += reservation;
    const requestText = [request.system ?? "", request.prompt, ...(request.context ?? [])];
    if (requestText.some((value) => value.includes(LIVE_FIXTURE_DESCRIPTOR.longSourceSentinel)))
      usage.sourceSentinelHits += 1;
    active += 1;
    usage.maxConcurrency = Math.max(usage.maxConcurrency, active);
    return { tokens: reservation, settled: false, released: false };
  }

  settle(id: LiveCaseId, usage: CallUsage, reservation: LiveCallReservation): void {
    if (reservation.settled || reservation.released) throw new LiveScenarioError("ACCOUNTING_MISMATCH");
    reservation.settled = true;
    this.reservedTokens -= reservation.tokens;
    const target = this.mutable(id);
    const total = usageTotal(usage);
    target.inputTokens += usage.inputTokens ?? 0;
    target.outputTokens += usage.outputTokens ?? 0;
    target.aggregateTokens += total;
    const estimate = usage.costUsd ?? 0;
    target.piCatalogEstimateUsd += estimate;
    target.providerDurationMs += usage.durationMs;
    this.totalTokens += total;
    this.totalEstimate += estimate;
    if (this.totalTokens + this.reservedTokens > this.bounds.maxAggregateTokens
      || this.totalEstimate > this.bounds.maxPiCatalogEstimateUsd)
      throw new LiveScenarioError("BUDGET_EXCEEDED");
  }

  release(reservation: LiveCallReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    if (!reservation.settled) this.reservedTokens -= reservation.tokens;
    active -= 1;
  }

  accounting(id: LiveCaseId): MutableUsage {
    return { ...this.mutable(id) };
  }

  private mutable(id: LiveCaseId): MutableUsage {
    const existing = this.usages.get(id);
    if (existing) return existing;
    const created: MutableUsage = {
      invocations: 0, inputTokens: 0, outputTokens: 0, aggregateTokens: 0,
      piCatalogEstimateUsd: 0, providerDurationMs: 0, maxConcurrency: 0, sourceSentinelHits: 0,
    };
    this.usages.set(id, created);
    return created;
  }
}

let active = 0;
class ObservedModelClient implements ModelClient {
  readonly id = "live-observed-pi-model";
  readonly identity;
  constructor(private readonly inner: PiModelClient, private readonly budget: LiveCallBudget, private readonly caseId: LiveCaseId) {
    this.identity = {
      id: "pi-rlm/live-observed-model", version: "1",
      configuration: { innerId: inner.identity.id, innerVersion: inner.identity.version, caseId },
    } as const;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const reservation = this.budget.before(this.caseId, request);
    try {
      const response = await this.inner.complete(request);
      this.budget.settle(this.caseId, response.usage, reservation);
      return response;
    } catch (error) {
      if (error instanceof PiModelError && !reservation.settled)
        this.budget.settle(this.caseId, error.usage, reservation);
      throw error;
    } finally { this.budget.release(reservation); }
  }
}

export class LiveScenarioError extends Error {
  constructor(readonly code: LiveCaseCode) { super(code); this.name = "LiveScenarioError"; }
}

export interface PiBoundaryInstrumentation {
  readonly maxRetriesZeroCalls: () => number;
  observeNextStreamStart(callback: () => void): void;
  restore(): void;
}

/** Numeric-only completion-boundary observation. Does not retain contexts or messages. */
export const instrumentPiBoundary = (runtime: ModelRuntime): PiBoundaryInstrumentation => {
  const originalComplete = runtime.completeSimple.bind(runtime);
  const originalStream = runtime.streamSimple.bind(runtime);
  let maxRetriesZero = 0;
  let onStart: (() => void) | undefined;
  runtime.completeSimple = (async (model, context, options) => {
    if (options?.maxRetries === 0) maxRetriesZero += 1;
    const callback = onStart;
    onStart = undefined;
    if (!callback) return originalComplete(model, context, options);
    const stream = originalStream(model, context, options);
    for await (const event of stream) if (event.type === "start") callback();
    return stream.result();
  }) as typeof runtime.completeSimple;
  return {
    maxRetriesZeroCalls: () => maxRetriesZero,
    observeNextStreamStart(callback) { onStart = callback; },
    restore() { runtime.completeSimple = originalComplete as typeof runtime.completeSimple; },
  };
};

const nearly = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-9;
export const runtimeAccountingReconciles = (
  observer: ReturnType<LiveCallBudget["accounting"]>,
  result: RunResult,
  events: readonly RlmEvent[],
): boolean => {
  const intents = events.filter((event) => event.type === "operation_intended");
  const settlements = events.filter((event) => event.type === "operation_settled");
  const settled = settlements.reduce((sum, event) => ({
    attempts: sum.attempts + event.usage.attempts,
    input: sum.input + (event.usage.inputTokens ?? 0),
    output: sum.output + (event.usage.outputTokens ?? 0),
    total: sum.total + usageTotal(event.usage),
    cost: sum.cost + (event.usage.costUsd ?? 0),
    duration: sum.duration + event.usage.durationMs,
  }), { attempts: 0, input: 0, output: 0, total: 0, cost: 0, duration: 0 });
  const ledger = result.ledger.usage;
  return observer.invocations === intents.length && intents.length === settlements.length
    && settlements.length === ledger.attempts && ledger.attempts === settled.attempts
    && observer.inputTokens === settled.input && observer.outputTokens === settled.output
    && observer.aggregateTokens === settled.total && nearly(observer.piCatalogEstimateUsd, settled.cost)
    && observer.providerDurationMs === settled.duration
    && ledger.inputTokensUsed === settled.input && ledger.outputTokensUsed === settled.output
    && ledger.tokensUsed === settled.total && nearly(ledger.costUsd, settled.cost)
    && ledger.providerDurationMs === settled.duration && ledger.tokensReserved === 0 && ledger.activeLeafCalls === 0;
};

export interface CaseResultOptions {
  readonly code: LiveCaseCode;
  readonly verdict?: LiveCaseReport["verdict"];
  readonly correctnessPpm?: number;
  readonly wallDurationMs?: number;
  readonly outputBytes?: number;
  readonly sourceSentinelHits?: number;
  readonly intents?: number;
  readonly settlements?: number;
  readonly attempts?: number;
  readonly usageCompleteness?: LiveCaseReport["usageCompleteness"];
}
export const caseReport = (id: LiveCaseId, budget: LiveCallBudget, options: CaseResultOptions): LiveCaseReport => {
  const observed = budget.accounting(id);
  const verdict = options.verdict ?? (options.code === "PASS" ? "pass" : options.code === "NOT_RUN" ? "not_run" : "fail");
  return {
    id, code: options.code, verdict,
    usageCompleteness: options.usageCompleteness ?? (observed.invocations === 0 ? "unavailable" : "exact"),
    correctnessPpm: options.correctnessPpm ?? (verdict === "pass" ? 1_000_000 : 0),
    ...ZERO,
    invocations: observed.invocations,
    intents: options.intents ?? 0,
    settlements: options.settlements ?? 0,
    attempts: options.attempts ?? observed.invocations,
    inputTokens: observed.inputTokens, outputTokens: observed.outputTokens,
    aggregateTokens: observed.aggregateTokens, piCatalogEstimateUsd: observed.piCatalogEstimateUsd,
    providerDurationMs: observed.providerDurationMs,
    wallDurationMs: Math.max(0, Math.floor(options.wallDurationMs ?? 0)),
    outputBytes: options.outputBytes ?? 0, maxConcurrency: observed.maxConcurrency,
    sourceSentinelHits: options.sourceSentinelHits ?? observed.sourceSentinelHits,
  };
};

export const runWall = async <T>(work: () => Promise<T>): Promise<{ value: T; wallDurationMs: number }> => {
  const start = performance.now();
  const value = await work();
  return { value, wallDurationMs: Math.max(0, Math.floor(performance.now() - start)) };
};

export const piErrorCode = (error: unknown): LiveCaseCode | undefined => {
  if (!(error instanceof PiModelError)) return undefined;
  if (error.code === "OUTPUT_TRUNCATED") return "OUTPUT_TRUNCATED";
  if (error.code === "CANCELLED") return "CANCELLED";
  if (error.code === "PROVIDER_ERROR") return "PROVIDER_ERROR";
  return undefined;
};
