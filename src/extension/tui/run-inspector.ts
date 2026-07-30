/** Bounded inspect-only TUI projection for authenticated managed-run pages. */

import { isProxy } from "node:util/types";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  DEFAULT_RUN_INSPECTION_PAGE_SIZE,
  RUN_INSPECTION_VERSION,
  type RunInspectionPage,
  type RunInspectionRequest,
  type RunInspectionView,
} from "../../runtime/run-inspection-types.ts";
import { sanitizeDisplayText, truncateDisplayLine } from "../run-display.ts";
import { visualStyleForTheme, type VisualStyle } from "./visual-style.ts";
import {
  renderRunInspector,
  RUN_INSPECTOR_VIEWS,
  type RunInspectionProjection,
  type RunInspectorState,
} from "./run-inspector-view.ts";
export {
  renderRunInspector,
  RUN_INSPECTOR_MAX_VISIBLE,
  RUN_INSPECTOR_VIEWS,
} from "./run-inspector-view.ts";
export type { RunInspectionProjection, RunInspectorState } from "./run-inspector-view.ts";

export const RUN_INSPECTOR_PAGE_SIZE = 50;
export const RUN_INSPECTOR_MAX_CURSOR_HISTORY = 32;

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const RUN_ID_SOURCE = "run_[a-f0-9]{64}";
const CALL_KIND_SOURCE = "(?:llm|agent|recurse|tool|artifact|context)";
const RUN_ID = new RegExp(`^${RUN_ID_SOURCE}$`);
const ROOT_FRAME_ID = new RegExp(`^(${RUN_ID_SOURCE}):f(0|[1-9][0-9]*)$`);
const CHILD_FRAME_ID = new RegExp(`^(${RUN_ID_SOURCE}):frame:(call_(${CALL_KIND_SOURCE})_([a-f0-9]{64})):e(0|[1-9][0-9]*)$`);
const CALL_ID = new RegExp(`^call_(${CALL_KIND_SOURCE})_([a-f0-9]{64})$`);
const CONTROLLER_OPERATION = /^(.*):controller:(0|[1-9][0-9]*)$/;
const EXTRACTOR_OPERATION = new RegExp(`^(${RUN_ID_SOURCE}):extractor$`);
const HASH = /^[a-f0-9]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,4096}$/;
const SUMMARY_STATUS = new Set(["nonterminal", "completed", "failed", "cancelled"]);
const COMPLETION_MODE = new Set(["answer", "fallback_extract"]);
const FRAME_STATE = new Set(["open", "answered", "closed", "failed", "cancelled"]);
const CALL_KIND = new Set(["llm", "agent", "recurse", "tool", "artifact", "context"]);
const CALL_OUTCOME = new Set(["ok", "error", "cancelled", "invalid_result"]);
const ERROR_SOURCE = new Set(["cell", "provider", "run"]);
const TRUSTED_ERROR_CODES = new Set([
  "FAILED", "DENIED", "CANCELLED", "INTERRUPTED", "TIMED_OUT", "ACCEPTANCE_FAILED", "INVALID_REQUEST",
  "INVALID_RESULT", "UNAVAILABLE_CONTEXT", "SOURCE_CHANGED", "UNKNOWN_EFFECT", "BUDGET_DEPTH", "BUDGET_FRAMES",
  "BUDGET_CALLS", "BUDGET_ATTEMPTS", "BUDGET_TOKENS", "BUDGET_BYTES", "BUDGET_DEADLINE", "CPU_LIMIT",
  "HEAP_LIMIT", "WORKER_EXIT", "JOURNAL_CORRUPT", "LATE_CALLBACK", "UNHANDLED_REJECTION", "PARSE_ERROR",
  "DISPOSED", "NO_ANSWER", "ITERATION_BUDGET_EXHAUSTED", "SOURCE_FAILED", "CONTROLLER_FAILED", "EXTRACTOR_FAILED",
  "CONTEXT_FAILED", "JOURNAL_FAILED", "FALLBACK_EVIDENCE_TRUNCATED",
]);

/** Getter-free snapshot of one plain record. Proxies and any accessor are rejected. */
const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
  try {
    if (typeof value !== "object" || value === null || isProxy(value) || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return undefined; }
};

/** Getter-free snapshot of a conventional dense array. */
const plainArray = (value: unknown, maxLength: number): readonly unknown[] | undefined => {
  try {
    if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length)
      || length < 0 || length > maxLength) return undefined;
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      copy.push(descriptor.value);
    }
    if (Reflect.ownKeys(value).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) return undefined;
    return copy;
  } catch { return undefined; }
};

const unsigned = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const finiteUnsigned = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const safeHash = (value: unknown): string | undefined =>
  typeof value === "string" && HASH.test(value) ? value : undefined;
const enumValue = (value: unknown, allowed: ReadonlySet<string>): string | undefined =>
  typeof value === "string" && allowed.has(value) ? value : undefined;
const hashLabel = (hash: string): string => `#${hash.slice(0, 12)}`;

const frameIdentity = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const root = ROOT_FRAME_ID.exec(value);
  if (root) return `run #${root[1]!.slice(-8)} · f${root[2]}`;
  const child = CHILD_FRAME_ID.exec(value);
  if (!child) return undefined;
  return `run #${child[1]!.slice(-8)} · frame ${child[3]}#${child[4]!.slice(-12)} · e${child[5]}`;
};

const callIdentity = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const matched = CALL_ID.exec(value);
  return matched ? `${matched[1]}#${matched[2]!.slice(-12)}` : undefined;
};

const operationIdentity = (value: unknown): string | undefined => {
  const call = callIdentity(value);
  if (call) return call;
  if (typeof value !== "string") return undefined;
  const extractor = EXTRACTOR_OPERATION.exec(value);
  if (extractor) return `extractor@run #${extractor[1]!.slice(-8)}`;
  const controller = CONTROLLER_OPERATION.exec(value);
  const frame = controller ? frameIdentity(controller[1]) : undefined;
  return frame && controller ? `controller@${frame} · ${controller[2]}` : undefined;
};

const textIdentity = (value: unknown): string | undefined => {
  const item = plainRecord(value);
  const hash = safeHash(item?.["sha256"]);
  const bytes = unsigned(item?.["bytes"]);
  return hash && bytes !== undefined ? `${hashLabel(hash)}:${bytes}b` : undefined;
};

const errorIdentity = (value: unknown): string | undefined => {
  const item = plainRecord(value);
  if (!item) return undefined;
  const trustedCode = typeof item["trustedCode"] === "string" && TRUSTED_ERROR_CODES.has(item["trustedCode"])
    ? item["trustedCode"] : undefined;
  const code = textIdentity(item["code"]);
  const message = textIdentity(item["message"]);
  const parts = [trustedCode ? `trusted ${trustedCode}` : undefined, code ? `code ${code}` : undefined,
    message ? `message ${message}` : undefined].filter((entry): entry is string => entry !== undefined);
  return parts.length ? parts.join(" · ") : undefined;
};

const addNumber = (segments: string[], label: string, value: unknown, finite = false): void => {
  const projected = finite ? finiteUnsigned(value) : unsigned(value);
  if (projected !== undefined) segments.push(`${label} ${projected}`);
};
const addFrame = (segments: string[], label: string, value: unknown): void => {
  const projected = frameIdentity(value);
  if (projected) segments.push(`${label} ${projected}`);
};
const usageSegments = (value: unknown): string[] => {
  const usage = plainRecord(value);
  if (!usage) return [];
  const segments: string[] = [];
  addNumber(segments, "attempts", usage["attempts"]);
  addNumber(segments, "input", usage["inputTokens"]);
  addNumber(segments, "output", usage["outputTokens"]);
  addNumber(segments, "total", usage["totalTokens"]);
  addNumber(segments, "cost", usage["costUsd"], true);
  addNumber(segments, "duration", usage["durationMs"]);
  return segments;
};

/** Project one item without copying guest/provider text or arbitrary keys. */
export const projectRunInspectionItem = (value: unknown): string => {
  try {
    const item = plainRecord(value);
    if (!item) return "invalid metadata item";
    const kind = item["kind"];
    if (kind === "summary") {
      const segments = ["summary"];
      const status = enumValue(item["status"], SUMMARY_STATUS);
      if (status) segments.push(status);
      const mode = enumValue(item["completionMode"], COMPLETION_MODE);
      if (mode) segments.push(mode);
      addNumber(segments, "frames", item["frames"]);
      addNumber(segments, "cells", item["cells"]);
      addNumber(segments, "calls", item["committedCalls"]);
      addNumber(segments, "attempts", item["observedProviderAttempts"]);
      const error = errorIdentity(item["error"]);
      if (error) segments.push(`error ${error}`);
      return sanitizeDisplayText(segments.join(" · "));
    }
    if (kind === "frame") {
      const segments = ["frame"];
      addFrame(segments, "id", item["frameId"]);
      if (item["parentFrameId"] === null) segments.push("root");
      else addFrame(segments, "parent", item["parentFrameId"]);
      addNumber(segments, "depth", item["depth"]);
      const state = enumValue(item["state"], FRAME_STATE);
      if (state) segments.push(state);
      addNumber(segments, "cells", item["cells"]);
      addNumber(segments, "calls", item["committedCalls"]);
      const phase = textIdentity(item["phase"]);
      if (phase) segments.push(`phase ${phase}`);
      return sanitizeDisplayText(segments.join(" · "));
    }
    if (kind === "cell") {
      const segments = ["cell"];
      addFrame(segments, "frame", item["frameId"]);
      addNumber(segments, "iteration", item["iteration"]);
      const hash = safeHash(item["codeHash"]);
      if (hash) segments.push(`code ${hashLabel(hash)}`);
      if (typeof item["hasResult"] === "boolean") segments.push(item["hasResult"] ? "result" : "no-result");
      addNumber(segments, "output", item["outputBytes"]);
      addNumber(segments, "omitted", item["outputOmittedBytes"]);
      addNumber(segments, "committed", item["committedOutputBytes"]);
      segments.push(...usageSegments(item["usage"]));
      const error = errorIdentity(item["error"]);
      if (error) segments.push(`error ${error}`);
      return sanitizeDisplayText(segments.join(" · "));
    }
    if (kind === "call") {
      const segments = ["call"];
      addFrame(segments, "frame", item["frameId"]);
      const id = callIdentity(item["callId"]);
      if (id) segments.push(`id ${id}`);
      const callKind = enumValue(item["callKind"], CALL_KIND);
      if (callKind) segments.push(callKind);
      const key = textIdentity(item["key"]);
      if (key) segments.push(`key ${key}`);
      addNumber(segments, "executions", item["executions"]);
      if (typeof item["ok"] === "boolean") segments.push(item["ok"] ? "ok" : "error");
      segments.push(...usageSegments(item["usage"]));
      const hash = safeHash(item["outputSha256"]);
      if (hash) segments.push(`output ${hashLabel(hash)}`);
      addNumber(segments, "bytes", item["outputBytes"]);
      addNumber(segments, "provider-attempts", item["observedProviderAttempts"]);
      const outcome = enumValue(item["lastOutcome"], CALL_OUTCOME);
      if (outcome) segments.push(outcome);
      const errorCode = textIdentity(item["errorCode"]);
      if (errorCode) segments.push(`error-code ${errorCode}`);
      return sanitizeDisplayText(segments.join(" · "));
    }
    if (kind === "budget") {
      const segments = ["budget"];
      const limits = plainRecord(item["limits"]);
      if (limits) {
        const fields = [
          ["max-depth", "maxDepth"], ["max-frames", "maxFrames"], ["max-calls", "maxLogicalCalls"],
          ["max-attempts", "maxAttempts"], ["max-controller-turns", "maxControllerTurns"],
          ["max-concurrency", "maxConcurrency"], ["token-limit", "tokenLimit"],
          ["stored-byte-limit", "storedByteLimit"], ["deadline", "deadlineMs"],
        ] as const;
        for (const [label, field] of fields) addNumber(segments, label, limits[field]);
      }
      const observed = plainRecord(item["observedLowerBounds"]);
      if (observed) {
        const fields = [
          ["frames", "frames"], ["cells", "cells"], ["calls", "committedCalls"],
          ["attempts", "observedProviderAttempts"], ["controller-attempts", "observedControllerProviderAttempts"],
          ["input", "reportedInputTokens"], ["output", "reportedOutputTokens"], ["tokens", "reportedTotalTokens"],
          ["cost", "reportedCostUsd"], ["duration", "providerDurationMs"], ["content", "committedContentBytes"],
        ] as const;
        for (const [label, field] of fields) addNumber(segments, label, observed[field], field === "reportedCostUsd");
      }
      return sanitizeDisplayText(segments.join(" · "));
    }
    if (kind === "error") {
      const segments = ["error"];
      const source = enumValue(item["source"], ERROR_SOURCE);
      if (source) segments.push(source);
      addFrame(segments, "frame", item["frameId"]);
      addNumber(segments, "iteration", item["iteration"]);
      const operation = operationIdentity(item["operationId"]);
      if (operation) segments.push(`operation ${operation}`);
      const error = errorIdentity(item["error"]);
      if (error) segments.push(error);
      return sanitizeDisplayText(segments.join(" · "));
    }
  } catch { /* Invalid injected metadata projects to a fixed marker. */ }
  return "invalid metadata item";
};

/** Bound the page cache to 50 safe rendered identities and one bounded cursor. */
export const projectRunInspectionPage = (
  raw: RunInspectionPage,
  expectedRunName: string,
  expectedView: RunInspectionView,
): RunInspectionProjection => {
  try {
    const page = plainRecord(raw);
    const runName = page?.["runName"];
    const runId = page?.["runId"];
    const manifestHash = page?.["manifestHash"];
    const journalPrefixSha256 = page?.["journalPrefixSha256"];
    const eventCount = unsigned(page?.["eventCount"]);
    const view = page?.["view"];
    const values = plainArray(page?.["items"], RUN_INSPECTOR_PAGE_SIZE);
    const nextCursor = page?.["nextCursor"];
    if (page?.["version"] !== RUN_INSPECTION_VERSION
      || runName !== expectedRunName || !RUN_NAME.test(expectedRunName)
      || typeof runId !== "string" || !RUN_ID.test(runId)
      || typeof manifestHash !== "string" || !HASH.test(manifestHash)
      || typeof journalPrefixSha256 !== "string" || !HASH.test(journalPrefixSha256)
      || eventCount === undefined || view !== expectedView || !values
      || (nextCursor !== undefined && (typeof nextCursor !== "string" || !CURSOR.test(nextCursor)))) throw new TypeError();
    const rows: string[] = [];
    const count = Math.min(values.length, RUN_INSPECTOR_PAGE_SIZE);
    for (let index = 0; index < count; index += 1) rows.push(projectRunInspectionItem(values[index]));
    return Object.freeze({
      runName: expectedRunName,
      runId,
      manifestHash,
      journalPrefixSha256,
      eventCount,
      view: expectedView,
      rows: Object.freeze(rows),
      ...(typeof nextCursor === "string" ? { nextCursor } : {}),
    });
  } catch { throw new TypeError("invalid managed inspection page projection"); }
};

export type RunInspectorLoader = (view: RunInspectionView, cursor?: string) => Promise<RunInspectionProjection>;
interface BackCursor { readonly cursor?: string; readonly pageNumber: number }

export class RunInspector implements Component {
  private state: RunInspectorState;
  private backCursors: BackCursor[] = [];
  private currentCursor: string | undefined;
  private disposed = false;
  private completed = false;
  private generation = 0;
  private readonly style: VisualStyle;
  private readonly abortListener = (): void => { this.complete(); };

  constructor(
    page: RunInspectionProjection,
    private readonly load: RunInspectorLoader,
    private readonly done: () => void,
    private readonly requestRender: () => void = () => {},
    private readonly signal: AbortSignal = new AbortController().signal,
    theme?: Theme,
  ) {
    this.state = { page, pageNumber: 1, selected: 0, hasPrevious: false };
    this.style = visualStyleForTheme(theme);
    if (signal.aborted) this.complete();
    else signal.addEventListener("abort", this.abortListener, { once: true });
  }

  private renderRequested(): void { try { this.requestRender(); } catch {} }
  private complete(): void {
    if (this.completed || this.disposed) return;
    this.completed = true;
    try { this.done(); } catch {}
  }

  private request(
    view: RunInspectionView,
    cursor: string | undefined,
    backCursors: BackCursor[],
    pageNumber: number,
  ): void {
    if (this.state.loading || this.disposed || this.completed || this.signal.aborted) return;
    const generation = ++this.generation;
    this.state = { ...this.state, loading: true, loadFailed: false };
    this.renderRequested();
    void Promise.resolve().then(() => this.load(view, cursor)).then((page) => {
      if (this.disposed || this.completed || this.signal.aborted || generation !== this.generation) return;
      this.backCursors = backCursors.slice(-RUN_INSPECTOR_MAX_CURSOR_HISTORY);
      this.currentCursor = cursor;
      this.state = { page, pageNumber, selected: 0, hasPrevious: this.backCursors.length > 0 };
    }, () => {
      if (this.disposed || this.completed || this.signal.aborted || generation !== this.generation) return;
      this.state = { ...this.state, loading: false, loadFailed: true };
    }).finally(() => {
      if (!this.disposed && !this.completed && !this.signal.aborted && generation === this.generation) this.renderRequested();
    });
  }

  private switchView(delta: number): void {
    const current = RUN_INSPECTOR_VIEWS.indexOf(this.state.page.view);
    const view = RUN_INSPECTOR_VIEWS[(current + delta + RUN_INSPECTOR_VIEWS.length) % RUN_INSPECTOR_VIEWS.length]!;
    this.request(view, undefined, [], 1);
  }
  private move(delta: number): void {
    const length = this.state.page.rows.length;
    if (length === 0) return;
    const selected = ((this.state.selected ?? 0) + delta + length) % length;
    this.state = { ...this.state, selected };
    this.renderRequested();
  }
  private next(): void {
    const cursor = this.state.page.nextCursor;
    if (!cursor) return;
    this.request(this.state.page.view, cursor, [...this.backCursors, {
      ...(this.currentCursor ? { cursor: this.currentCursor } : {}), pageNumber: this.state.pageNumber,
    }], this.state.pageNumber + 1);
  }
  private previous(): void {
    const previous = this.backCursors.at(-1);
    if (!previous) return;
    this.request(this.state.page.view, previous.cursor, this.backCursors.slice(0, -1), previous.pageNumber);
  }

  handleInput(data: string): void {
    if (this.disposed || this.completed || this.signal.aborted) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.backspace)) {
      this.complete(); return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) { this.switchView(-1); return; }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) { this.switchView(1); return; }
    if (matchesKey(data, Key.up)) { this.move(-1); return; }
    if (matchesKey(data, Key.down)) { this.move(1); return; }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, "n")) { this.next(); return; }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, "p")) { this.previous(); return; }
    if (matchesKey(data, "r"))
      this.request(this.state.page.view, this.currentCursor, [...this.backCursors], this.state.pageNumber);
  }

  render(width: number): string[] { return this.disposed ? [] : renderRunInspector(this.state, width, this.style); }
  invalidate(): void {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.backCursors = [];
    this.signal.removeEventListener("abort", this.abortListener);
  }
}

export type ManagedInspectionFunction = (request: RunInspectionRequest) => Promise<RunInspectionPage>;
export type ManagementIsCurrent = () => boolean;

/** Imperative Pi shell. All reads pass through the managed-name inspection API. */
export const openRunInspector = async (
  ctx: ExtensionContext,
  runName: string,
  inspectManaged: ManagedInspectionFunction,
  signal: AbortSignal = new AbortController().signal,
  isCurrent: ManagementIsCurrent = () => true,
): Promise<void> => {
  if (!RUN_NAME.test(runName)) {
    try { ctx.ui.notify(truncateDisplayLine("RLM inspection target is invalid.", 160), "error"); } catch {}
    return;
  }
  if (ctx.mode !== "tui") {
    try { ctx.ui.notify(truncateDisplayLine("RLM run inspector requires TUI mode.", 160), "info"); } catch {}
    return;
  }
  const current = (): boolean => {
    if (signal.aborted) return false;
    try { return isCurrent() && ctx.mode === "tui"; } catch { return false; }
  };
  const load: RunInspectorLoader = async (view, cursor) => {
    if (!current()) throw new Error("stale management inspection");
    const request: RunInspectionRequest = {
      version: RUN_INSPECTION_VERSION, runName, view,
      pageSize: Math.min(DEFAULT_RUN_INSPECTION_PAGE_SIZE, RUN_INSPECTOR_PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    };
    if (!current()) throw new Error("stale management inspection");
    const raw = await inspectManaged(request);
    if (!current()) throw new Error("stale management inspection");
    return projectRunInspectionPage(raw, runName, view);
  };
  if (!current()) return;
  let page: RunInspectionProjection;
  try { page = await load("summary"); }
  catch {
    if (current()) try { ctx.ui.notify(truncateDisplayLine("RLM inspection is unavailable for that run.", 160), "error"); } catch {}
    return;
  }
  if (!current()) return;
  try {
    if (!current()) return;
    await ctx.ui.custom<void>((tui: TUI, theme, _keys, done) =>
      new RunInspector(page, load, () => done(), () => tui.requestRender(), signal, theme));
    if (!current()) return;
  } catch {
    if (current()) try { ctx.ui.notify(truncateDisplayLine("RLM inspector UI is unavailable.", 160), "error"); } catch {}
  }
};
