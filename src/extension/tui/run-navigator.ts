/** Bounded, inspect-only managed run navigator with a pure display projection. */

import { isProxy } from "node:util/types";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ManagedRunListing } from "../../runtime/run-retention.ts";
import type { CoordinatedRun } from "../run-coordinator.ts";
import { sanitizeDisplayText, truncateDisplayLine } from "../run-display.ts";
import {
  compactBytes,
  fitStyledLine,
  padStyledLine,
  plainVisualStyle,
  renderPanel,
  statusGlyph,
  visualStyleForTheme,
  type VisualStatus,
  type VisualStyle,
} from "./visual-style.ts";

export const RUN_NAVIGATOR_MAX_LOCAL = 16;
const RUN_NAVIGATOR_MAX_LOCAL_INPUT = 48;
export const RUN_NAVIGATOR_MAX_MANAGED = 200;
export const RUN_NAVIGATOR_MAX_VISIBLE = 8;

const RUN_NAME = /^run-[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{64}$/;
const LOCAL_ALIAS = /^[A-Za-z0-9_.:-]{1,128}$/;
const STATES = new Set(["running", "cancelling"]);
const STATUSES = new Set(["active", "completed", "failed", "cancelled"]);
const ACTIVITIES = new Set(["owned", "live", "inactive", "stale", "ambiguous"]);

export interface RunNavigatorRow {
  readonly source: "local" | "managed" | "local+managed";
  readonly localAlias?: string;
  readonly runName?: string;
  readonly runId?: string;
  readonly state?: "running" | "cancelling";
  readonly status?: "active" | "completed" | "failed" | "cancelled";
  readonly activity?: "owned" | "live" | "inactive" | "stale" | "ambiguous";
  readonly bytes?: number;
  readonly updatedAtMs?: number;
  readonly inspectable: boolean;
}

interface ManagedProjection {
  readonly runName: string;
  readonly runId?: string;
  readonly status: RunNavigatorRow["status"];
  readonly activity: RunNavigatorRow["activity"];
  readonly bytes: number;
  readonly updatedAtMs: number;
}

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

const plainArray = (value: unknown, maxLength: number): readonly unknown[] | undefined => {
  try {
    if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const rawLength = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength)
      || rawLength < 0 || rawLength > maxLength) return undefined;
    const copy: unknown[] = [];
    for (let index = 0; index < rawLength; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !("value" in entry) || !entry.enumerable) return undefined;
      copy.push(entry.value);
    }
    if (Reflect.ownKeys(value).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= rawLength))) return undefined;
    return copy;
  } catch { return undefined; }
};

const unsigned = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const managedProjection = (value: unknown): ManagedProjection | undefined => {
  try {
    const item = plainRecord(value);
    const metadata = plainRecord(item?.["metadata"]);
    const runName = item?.["name"];
    const status = metadata?.["status"];
    const activity = item?.["activity"];
    const bytes = unsigned(item?.["bytes"]);
    const updatedAtMs = unsigned(metadata?.["updatedAtMs"]);
    const runId = metadata?.["runId"];
    if (typeof runName !== "string" || !RUN_NAME.test(runName)
      || typeof status !== "string" || !STATUSES.has(status)
      || typeof activity !== "string" || !ACTIVITIES.has(activity)
      || bytes === undefined || updatedAtMs === undefined
      || (runId !== undefined && (typeof runId !== "string" || !RUN_ID.test(runId)))) return undefined;
    return Object.freeze({
      runName,
      ...(typeof runId === "string" ? { runId } : {}),
      status: status as ManagedProjection["status"],
      activity: activity as ManagedProjection["activity"],
      bytes,
      updatedAtMs,
    });
  } catch { return undefined; }
};

const managedRows = (listing: unknown): ManagedProjection[] => {
  const record = plainRecord(listing);
  const values = plainArray(record?.["runs"], RUN_NAVIGATOR_MAX_MANAGED);
  if (!values) return [];
  const projected: ManagedProjection[] = [];
  const count = Math.min(values.length, RUN_NAVIGATOR_MAX_MANAGED);
  for (let index = 0; index < count; index += 1) {
    const item = managedProjection(values[index]);
    if (item) projected.push(item);
  }
  return projected.sort((left, right) =>
    right.updatedAtMs - left.updatedAtMs || left.runName.localeCompare(right.runName));
};

const localProjection = (value: unknown): RunNavigatorRow | undefined => {
  try {
    const run = plainRecord(value);
    const state = run?.["state"];
    const localId = run?.["localId"];
    const runName = run?.["runName"];
    const runId = run?.["runId"];
    if (typeof state !== "string" || !STATES.has(state) || typeof localId !== "string" || !LOCAL_ALIAS.test(localId)
      || (runName !== undefined && (typeof runName !== "string" || !RUN_NAME.test(runName)))
      || (runId !== undefined && (typeof runId !== "string" || !RUN_ID.test(runId)))) return undefined;
    return Object.freeze({
      source: "local",
      localAlias: localId,
      ...(typeof runName === "string" ? { runName } : {}),
      ...(typeof runId === "string" ? { runId } : {}),
      state: state as "running" | "cancelling",
      inspectable: typeof runName === "string",
    });
  } catch { return undefined; }
};

/** Copy only validated identities, trusted enums, and non-negative numbers. */
export const projectRunNavigatorRows = (
  localRuns: readonly CoordinatedRun[],
  listing: ManagedRunListing,
): readonly RunNavigatorRow[] => {
  try {
    const managed = managedRows(listing);
    const locals = plainArray(localRuns, RUN_NAVIGATOR_MAX_LOCAL_INPUT) ?? [];
    const byName = new Map(managed.map((item) => [item.runName, item]));
    const consumed = new Set<string>();
    const rows: RunNavigatorRow[] = [];
    const localCount = Math.min(locals.length, RUN_NAVIGATOR_MAX_LOCAL);
    for (let index = 0; index < localCount; index += 1) {
      const local = localProjection(locals[index]);
      if (!local) continue;
      const retained = local.runName ? byName.get(local.runName) : undefined;
      if (!retained) { rows.push(local); continue; }
      consumed.add(retained.runName);
      rows.push(Object.freeze({
        ...local,
        source: "local+managed",
        runId: local.runId ?? retained.runId,
        status: retained.status,
        activity: retained.activity,
        bytes: retained.bytes,
        updatedAtMs: retained.updatedAtMs,
        inspectable: true,
      }));
    }
    for (const retained of managed) {
      if (consumed.has(retained.runName)) continue;
      rows.push(Object.freeze({
        source: "managed",
        runName: retained.runName,
        ...(retained.runId ? { runId: retained.runId } : {}),
        status: retained.status,
        activity: retained.activity,
        bytes: retained.bytes,
        updatedAtMs: retained.updatedAtMs,
        inspectable: true,
      }));
    }
    return Object.freeze(rows.slice(0, RUN_NAVIGATOR_MAX_LOCAL + RUN_NAVIGATOR_MAX_MANAGED));
  } catch { return Object.freeze([]); }
};

export interface RunNavigatorState {
  readonly rows: readonly RunNavigatorRow[];
  readonly selected: number;
  readonly loading?: boolean;
  readonly loadFailed?: boolean;
}

const identitySuffix = (value: string): string => value.slice(-8);

const rowStatus = (row: RunNavigatorRow): VisualStatus => {
  if (row.state === "running" || row.state === "cancelling") return row.state;
  if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") return row.status;
  return "inactive";
};

const rowState = (row: RunNavigatorRow): string =>
  row.state ?? row.status ?? (row.inspectable ? "retained" : "unbound");

const rowIdentity = (row: RunNavigatorRow): string => {
  if (row.localAlias) return sanitizeDisplayText(row.localAlias, 128);
  if (row.runId) return `run #${identitySuffix(row.runId)}`;
  if (row.runName) return `run #${identitySuffix(row.runName)}`;
  return "unbound run";
};

const sourceLabel = (source: RunNavigatorRow["source"]): string =>
  source === "local" ? "session" : source === "managed" ? "retained" : "both";

export const renderRunNavigatorRow = (
  row: RunNavigatorRow,
  selected: boolean,
  width: number,
  style: VisualStyle = plainVisualStyle,
): string => {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (limit === 0) return "";
  const selection = selected ? style.selected("›") : " ";
  const marker = statusGlyph(rowStatus(row), style);
  const identity = selected ? style.selected(rowIdentity(row)) : style.tone("text", rowIdentity(row));
  const state = style.tone(rowStatus(row) === "failed" ? "error" : "muted", rowState(row));
  const activity = style.tone("muted", row.activity ?? (row.state ? "owned" : "inactive"));
  const stored = style.tone("muted", row.bytes === undefined ? "" : compactBytes(row.bytes));
  const source = style.tone("muted", sourceLabel(row.source));

  if (limit < 58)
    return fitStyledLine(`${selection} ${marker} ${identity}  ${state}`, limit);
  if (limit < 84)
    return fitStyledLine(`${selection} ${marker} ${padStyledLine(identity, 24)} ${padStyledLine(state, 11)} ${padStyledLine(stored, 9, "right")}`, limit);
  return fitStyledLine([
    `${selection} ${marker}`,
    padStyledLine(identity, 26),
    padStyledLine(state, 11),
    padStyledLine(activity, 10),
    padStyledLine(stored, 9, "right"),
    source,
  ].join("  "), limit);
};

/** Deterministic width-bounded rendering with one responsive container. */
export const renderRunNavigator = (
  state: RunNavigatorState,
  width: number,
  style: VisualStyle = plainVisualStyle,
): string[] => {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (limit === 0) return [];
  const rows = state.rows.slice(0, RUN_NAVIGATOR_MAX_LOCAL + RUN_NAVIGATOR_MAX_MANAGED);
  const selected = rows.length === 0 ? 0 : Math.min(Math.max(0, state.selected), rows.length - 1);
  const start = Math.max(0, Math.min(
    selected - Math.floor(RUN_NAVIGATOR_MAX_VISIBLE / 2),
    Math.max(0, rows.length - RUN_NAVIGATOR_MAX_VISIBLE),
  ));
  const visible = rows.slice(start, start + RUN_NAVIGATOR_MAX_VISIBLE);
  const active = rows.filter((row) => row.state === "running" || row.state === "cancelling" || row.status === "active").length;
  const completed = rows.filter((row) => row.status === "completed").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const title = [
    "RLM runs",
    `${active} active`,
    `${completed} completed`,
    ...(failed ? [`${failed} failed`] : []),
  ].join(" · ");
  const bodyWidth = Math.max(0, limit - 6);
  const body: string[] = [];
  if (bodyWidth >= 78) body.push(style.tone("muted", [
    "  ", padStyledLine("Run", 26), padStyledLine("State", 11), padStyledLine("Activity", 10),
    padStyledLine("Stored", 9, "right"), "Source",
  ].join("  ")));
  if (state.loading) body.push(`${statusGlyph("running", style)} ${style.tone("muted", "Refreshing managed metadata")}`);
  else if (state.loadFailed) body.push(`${statusGlyph("failed", style)} ${style.tone("error", "Managed listing unavailable")}`);
  else if (rows.length === 0) body.push(`${statusGlyph("inactive", style)} ${style.tone("muted", "No retained or active runs")}`);
  visible.forEach((row, offset) => body.push(renderRunNavigatorRow(row, start + offset === selected, bodyWidth, style)));
  if (rows.length > RUN_NAVIGATOR_MAX_VISIBLE)
    body.push(style.tone("muted", `  ${selected + 1} of ${rows.length}`));
  return renderPanel({
    title,
    body,
    width: limit,
    style,
    surface: true,
    footer: "↑↓ select · enter inspect · r refresh · esc close",
  });
};

export type RunNavigatorResult =
  | { readonly type: "close" }
  | { readonly type: "inspect"; readonly runName: string };

export class RunNavigator implements Component {
  private state: RunNavigatorState;
  private disposed = false;
  private completed = false;
  private refreshing = false;
  private readonly style: VisualStyle;
  private readonly abortListener = (): void => { this.complete({ type: "close" }); };

  constructor(
    rows: readonly RunNavigatorRow[],
    private readonly done: (result: RunNavigatorResult) => void,
    private readonly requestRender: () => void = () => {},
    private readonly reload?: () => Promise<readonly RunNavigatorRow[]>,
    private readonly signal: AbortSignal = new AbortController().signal,
    theme?: Theme,
  ) {
    this.state = { rows: rows.slice(0, RUN_NAVIGATOR_MAX_LOCAL + RUN_NAVIGATOR_MAX_MANAGED), selected: 0 };
    this.style = visualStyleForTheme(theme);
    if (signal.aborted) this.complete({ type: "close" });
    else signal.addEventListener("abort", this.abortListener, { once: true });
  }

  private renderRequested(): void { try { this.requestRender(); } catch {} }
  private complete(result: RunNavigatorResult): void {
    if (this.completed || this.disposed) return;
    this.completed = true;
    try { this.done(result); } catch {}
  }
  private move(delta: number): void {
    if (this.state.rows.length === 0) return;
    const selected = (this.state.selected + delta + this.state.rows.length) % this.state.rows.length;
    this.state = { ...this.state, selected };
    this.renderRequested();
  }
  private refresh(): void {
    if (!this.reload || this.refreshing || this.disposed || this.completed || this.signal.aborted) return;
    this.refreshing = true;
    this.state = { ...this.state, loading: true, loadFailed: false };
    this.renderRequested();
    void Promise.resolve().then(() => this.reload!()).then((rows) => {
      if (this.disposed || this.completed || this.signal.aborted) return;
      this.state = { rows: rows.slice(0, RUN_NAVIGATOR_MAX_LOCAL + RUN_NAVIGATOR_MAX_MANAGED), selected: 0 };
    }, () => {
      if (this.disposed || this.completed || this.signal.aborted) return;
      this.state = { ...this.state, loading: false, loadFailed: true };
    }).finally(() => {
      this.refreshing = false;
      if (!this.disposed && !this.completed && !this.signal.aborted) this.renderRequested();
    });
  }

  handleInput(data: string): void {
    if (this.disposed || this.completed || this.signal.aborted) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.complete({ type: "close" }); return; }
    if (matchesKey(data, Key.up)) { this.move(-1); return; }
    if (matchesKey(data, Key.down)) { this.move(1); return; }
    if (matchesKey(data, "r")) { this.refresh(); return; }
    if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.return)) return;
    const row = this.state.rows[this.state.selected];
    if (row?.inspectable && row.runName) this.complete({ type: "inspect", runName: row.runName });
  }

  render(width: number): string[] { return this.disposed ? [] : renderRunNavigator(this.state, width, this.style); }
  invalidate(): void {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener("abort", this.abortListener);
  }
}

export interface RunNavigatorHost {
  readonly listLocalRuns: () => readonly CoordinatedRun[];
  readonly listManagedRuns: () => Promise<ManagedRunListing>;
  readonly inspect: (runName: string) => Promise<void>;
}
export type ManagementIsCurrent = () => boolean;

const resultSnapshot = (value: unknown, rows: readonly RunNavigatorRow[]): RunNavigatorResult | undefined => {
  const record = plainRecord(value);
  if (!record) return undefined;
  const keys = Object.keys(record).sort().join("\0");
  if (keys === "type" && record["type"] === "close") return { type: "close" };
  if (keys !== ["runName", "type"].join("\0") || record["type"] !== "inspect"
    || typeof record["runName"] !== "string" || !RUN_NAME.test(record["runName"])) return undefined;
  return rows.some((row) => row.inspectable && row.runName === record["runName"])
    ? { type: "inspect", runName: record["runName"] } : undefined;
};

const loadRows = async (
  host: RunNavigatorHost,
  current: () => boolean,
): Promise<readonly RunNavigatorRow[]> => {
  if (!current()) throw new Error("stale management listing");
  const localRuns = host.listLocalRuns();
  if (!current()) throw new Error("stale management listing");
  const listing = await host.listManagedRuns();
  if (!current()) throw new Error("stale management listing");
  return projectRunNavigatorRows(localRuns, listing);
};

/** Imperative Pi shell. Inspector escape returns to a freshly loaded navigator. */
export const openRunNavigator = async (
  ctx: ExtensionContext,
  host: RunNavigatorHost,
  signal: AbortSignal = new AbortController().signal,
  isCurrent: ManagementIsCurrent = () => true,
): Promise<void> => {
  if (ctx.mode !== "tui") {
    try { ctx.ui.notify(truncateDisplayLine("RLM run navigator requires TUI mode.", 160), "info"); } catch {}
    return;
  }
  const current = (): boolean => {
    if (signal.aborted) return false;
    try { return isCurrent() && ctx.mode === "tui"; } catch { return false; }
  };
  if (!current()) return;
  let rows: readonly RunNavigatorRow[];
  try { rows = await loadRows(host, current); }
  catch {
    if (current()) try { ctx.ui.notify(truncateDisplayLine("RLM managed listing is unavailable.", 160), "error"); } catch {}
    return;
  }
  if (!current()) return;
  while (current()) {
    let rawResult: unknown;
    try {
      if (!current()) return;
      rawResult = await ctx.ui.custom<unknown>((tui: TUI, theme, _keys, done) =>
        new RunNavigator(rows, done as (result: RunNavigatorResult) => void, () => tui.requestRender(),
          async () => {
            const refreshed = await loadRows(host, current);
            rows = refreshed;
            return refreshed;
          }, signal, theme), {
        overlay: true,
        overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center", margin: 1 },
      });
      if (!current()) return;
    } catch {
      if (current()) try { ctx.ui.notify(truncateDisplayLine("RLM navigator UI is unavailable.", 160), "error"); } catch {}
      return;
    }
    if (!current()) return;
    const result = resultSnapshot(rawResult, rows);
    if (!result || result.type === "close") return;
    if (!current()) return;
    try { await host.inspect(result.runName); }
    catch {
      if (current()) try { ctx.ui.notify(truncateDisplayLine("RLM inspection is unavailable for that run.", 160), "error"); } catch {}
      return;
    }
    if (!current()) return;
    try { rows = await loadRows(host, current); }
    catch { return; }
    if (!current()) return;
  }
};
