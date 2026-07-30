/** Responsive workflow-style layout for one bounded managed-run inspection page. */

import type { RunInspectionView } from "../../runtime/run-inspection-types.ts";
import {
  fitStyledLine,
  padStyledLine,
  plainVisualStyle,
  renderPanel,
  statusGlyph,
  type VisualStyle,
} from "./visual-style.ts";

export const RUN_INSPECTOR_VIEWS: readonly RunInspectionView[] = Object.freeze([
  "summary", "frames", "cells", "calls", "budget", "errors",
]);
export const RUN_INSPECTOR_MAX_VISIBLE = 9;

export interface RunInspectionProjection {
  readonly runName: string;
  readonly runId: string;
  readonly manifestHash: string;
  readonly journalPrefixSha256: string;
  readonly eventCount: number;
  readonly view: RunInspectionView;
  readonly rows: readonly string[];
  readonly nextCursor?: string;
}

export interface RunInspectorState {
  readonly page: RunInspectionProjection;
  readonly pageNumber: number;
  readonly selected?: number;
  readonly hasPrevious?: boolean;
  readonly loading?: boolean;
  readonly loadFailed?: boolean;
}

const titleCase = (value: string): string => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;

const selectedWindow = (length: number, selectedValue: number): { readonly selected: number; readonly start: number } => {
  const selected = length === 0 ? 0 : Math.min(Math.max(0, selectedValue), length - 1);
  const start = Math.max(0, Math.min(
    selected - Math.floor(RUN_INSPECTOR_MAX_VISIBLE / 2),
    Math.max(0, length - RUN_INSPECTOR_MAX_VISIBLE),
  ));
  return { selected, start };
};

const displayInspectionRow = (
  row: string,
  absoluteIndex: number,
  selected: boolean,
  width: number,
  style: VisualStyle,
): string => {
  const marker = selected ? style.selected("›") : " ";
  const number = style.tone("muted", String(absoluteIndex + 1).padStart(2, " "));
  const content = selected ? style.selected(row) : style.tone("text", row);
  return fitStyledLine(`${marker} ${number}  ${content}`, width);
};

/** Compact workflow-style run detail with local item scrolling and bounded backend pages. */
export const renderRunInspector = (
  state: RunInspectorState,
  width: number,
  style: VisualStyle = plainVisualStyle,
): string[] => {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (limit === 0) return [];
  const page = state.page;
  const { selected, start } = selectedWindow(page.rows.length, state.selected ?? 0);
  const visible = page.rows.slice(start, start + RUN_INSPECTOR_MAX_VISIBLE);
  const title = `RLM run #${page.runId.slice(-8)} · ${titleCase(page.view)} · page ${state.pageNumber}`;
  const bodyWidth = Math.max(0, limit - 6);
  const integrity = style.tone("muted",
    `events ${page.eventCount} · manifest #${page.manifestHash.slice(0, 12)} · journal #${page.journalPrefixSha256.slice(0, 12)}`);
  const body: string[] = [integrity];

  if (state.loading) body.push(`${statusGlyph("running", style)} ${style.tone("muted", "Refreshing inspection page")}`);
  else if (state.loadFailed) body.push(`${statusGlyph("failed", style)} ${style.tone("error", "Inspection page unavailable")}`);
  else if (page.rows.length === 0) body.push(`${statusGlyph("inactive", style)} ${style.tone("muted", "No metadata items in this view")}`);

  if (bodyWidth >= 90) {
    const railWidth = 16;
    const detailWidth = Math.max(1, bodyWidth - railWidth - 3);
    const rows = Math.max(RUN_INSPECTOR_VIEWS.length + 1, visible.length);
    for (let index = 0; index < rows; index += 1) {
      const view = RUN_INSPECTOR_VIEWS[index];
      const rail = view
        ? `${view === page.view ? style.selected("›") : " "} ${view === page.view ? style.selected(titleCase(view)) : style.tone("muted", titleCase(view))}`
        : "";
      const detailRow = visible[index];
      const detail = detailRow === undefined ? "" : displayInspectionRow(
        detailRow,
        start + index,
        start + index === selected,
        detailWidth,
        style,
      );
      body.push(`${padStyledLine(rail, railWidth)} ${style.tone("border", "│")} ${fitStyledLine(detail, detailWidth)}`);
    }
  } else {
    const tabs = RUN_INSPECTOR_VIEWS.map((view) => view === page.view
      ? style.selected(`[${titleCase(view)}]`)
      : style.tone("muted", titleCase(view))).join("  ");
    body.push(fitStyledLine(tabs, bodyWidth));
    visible.forEach((row, index) => body.push(displayInspectionRow(
      row,
      start + index,
      start + index === selected,
      bodyWidth,
      style,
    )));
  }
  if (page.rows.length > RUN_INSPECTOR_MAX_VISIBLE)
    body.push(style.tone("muted", `  item ${selected + 1} of ${page.rows.length}`));

  const paging = [
    ...(state.hasPrevious ? ["p previous"] : []),
    ...(page.nextCursor ? ["n next"] : []),
  ];
  const footer = ["←→ view", "↑↓ item", ...paging, "r refresh", "esc back"].join(" · ");
  return renderPanel({ title, body, width: limit, style, surface: true, footer });
};
