/** Public-root Pi TUI component for the bounded active-run display. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CoordinatedRun } from "../run-coordinator.ts";
import { visualStyleForTheme, type VisualStyle } from "./visual-style.ts";
import {
  projectRunDisplayItems,
  renderRunDisplay,
  type RunDisplayItem,
} from "../run-display.ts";

export type RunWidgetRequestRender = () => void;

export class RunWidget implements Component {
  private runs: readonly RunDisplayItem[] = Object.freeze([]);
  private disposed = false;
  private readonly requestRender: RunWidgetRequestRender;
  private readonly onDispose: () => void;
  private readonly style: VisualStyle;

  constructor(requestRender?: RunWidgetRequestRender);
  constructor(
    runs?: readonly CoordinatedRun[],
    requestRender?: RunWidgetRequestRender,
    onDispose?: () => void,
    theme?: Theme,
  );
  constructor(
    runsOrRequest: readonly CoordinatedRun[] | RunWidgetRequestRender = [],
    requestRender: RunWidgetRequestRender = () => {},
    onDispose: () => void = () => {},
    theme?: Theme,
  ) {
    this.onDispose = onDispose;
    this.style = visualStyleForTheme(theme);
    if (typeof runsOrRequest === "function") {
      this.requestRender = runsOrRequest;
    } else {
      this.requestRender = requestRender;
      this.runs = projectRunDisplayItems(runsOrRequest);
    }
  }

  /** Replace the bounded safe projection and request one host render. */
  update(runs: readonly CoordinatedRun[]): void {
    if (this.disposed) return;
    this.runs = projectRunDisplayItems(runs);
    this.requestRender();
  }

  render(width: number): string[] {
    return this.disposed ? [] : renderRunDisplay(this.runs, width, this.style);
  }

  invalidate(): void {
    // Pure rendering has no width/theme cache to invalidate.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runs = Object.freeze([]);
    try { this.requestRender(); }
    finally { this.onDispose(); }
  }
}

export const createRunWidget = (
  requestRender?: RunWidgetRequestRender,
  runs: readonly CoordinatedRun[] = [],
  onDispose?: () => void,
): RunWidget => new RunWidget(runs, requestRender, onDispose);
