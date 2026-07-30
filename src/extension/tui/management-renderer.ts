/** Compact TUI summary for bounded management metadata. */

import { isProxy } from "node:util/types";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "../run-display.ts";
import {
  fitStyledLine,
  plainVisualStyle,
  statusGlyph,
  visualStyleForTheme,
  type VisualStyle,
} from "./visual-style.ts";

const SAFE_CODE = /^[A-Z][A-Z0-9_-]{0,63}$/;
const RUN_NAME = /^run-[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{64}$/;
const OPERATIONS = new Set(["runs", "inspect", "resume", "cleanup", "cancel", "invalid"]);
const STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_COUNTS = 16;
const MAX_WARNINGS = 8;

interface ManagementDisplayModel {
  readonly operation: "runs" | "inspect" | "resume" | "cleanup" | "cancel" | "invalid";
  readonly status: "completed" | "failed" | "cancelled";
  readonly code: string;
  readonly message: string;
  readonly managedName?: string;
  readonly runId?: string;
  readonly counts: readonly { readonly label: string; readonly value: number }[];
  readonly warningCodes: readonly string[];
}

const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || isProxy(value)) return undefined;
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

const ownArray = (value: unknown, max: number): readonly unknown[] | undefined => {
  try {
    if (!Array.isArray(value) || isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > max) return undefined;
    const copied: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || !("value" in item) || !item.enumerable) return undefined;
      copied.push(item.value);
    }
    return copied;
  } catch { return undefined; }
};

const invalidModel = (): ManagementDisplayModel => Object.freeze({
  operation: "invalid",
  status: "failed",
  code: "RLM_MANAGEMENT_INVALID",
  message: "Management result metadata is unavailable.",
  counts: Object.freeze([]),
  warningCodes: Object.freeze([]),
});

const projectManagement = (value: unknown): ManagementDisplayModel => {
  try {
    const item = plainRecord(value);
    const operation = item?.["operation"];
    const status = item?.["status"];
    const rawCode = item?.["code"];
    const rawMessage = item?.["message"];
    if (item?.["version"] !== 1 || typeof operation !== "string" || !OPERATIONS.has(operation)
      || typeof status !== "string" || !STATUSES.has(status)
      || typeof rawCode !== "string" || !SAFE_CODE.test(rawCode)
      || typeof rawMessage !== "string") return invalidModel();

    const countRecord = plainRecord(item["counts"]);
    const counts: Array<{ readonly label: string; readonly value: number }> = [];
    if (countRecord) {
      for (const [label, count] of Object.entries(countRecord).slice(0, MAX_COUNTS)) {
        if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(label)
          || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
        counts.push(Object.freeze({ label: sanitizeDisplayText(label, 64), value: count }));
      }
    }
    const rawWarnings = ownArray(item["warningCodes"], MAX_WARNINGS) ?? [];
    const warningCodes = rawWarnings.map((warning) =>
      typeof warning === "string" && SAFE_CODE.test(warning) ? warning : "RLM_WARNING_INVALID");
    const managedName = item["managedName"];
    const runId = item["runId"];
    return Object.freeze({
      operation: operation as ManagementDisplayModel["operation"],
      status: status as ManagementDisplayModel["status"],
      code: rawCode,
      message: sanitizeDisplayText(rawMessage, 512),
      ...(typeof managedName === "string" && RUN_NAME.test(managedName) ? { managedName } : {}),
      ...(typeof runId === "string" && RUN_ID.test(runId) ? { runId } : {}),
      counts: Object.freeze(counts),
      warningCodes: Object.freeze(warningCodes),
    });
  } catch { return invalidModel(); }
};

const operationTitle: Readonly<Record<ManagementDisplayModel["operation"], string>> = Object.freeze({
  runs: "RLM runs",
  inspect: "RLM inspection",
  resume: "RLM continuation",
  cleanup: "RLM cleanup",
  cancel: "RLM cancellation",
  invalid: "RLM management",
});

const renderModel = (
  model: ManagementDisplayModel,
  width: number,
  style: VisualStyle = plainVisualStyle,
): string[] => {
  const visualStatus = model.status === "completed" ? "completed"
    : model.status === "cancelled" ? "cancelled" : "failed";
  const identity = model.managedName
    ? model.managedName
    : model.runId ? `#${model.runId.slice(-8)}` : undefined;
  const title = [
    statusGlyph(visualStatus, style),
    style.strong(operationTitle[model.operation]),
    ...(identity ? [style.tone("accent", identity)] : []),
    style.tone(model.status === "failed" ? "error" : "muted", model.code),
  ].join("  ");
  const lines = [title];
  if (model.message) lines.push(`  ${style.tone("muted", model.message)}`);
  if (model.counts.length > 0)
    lines.push(`  ${style.tone("muted", model.counts.map(({ label, value }) => `${label} ${value}`).join(" · "))}`);
  if (model.warningCodes.length > 0)
    lines.push(`  ${statusGlyph("approval", style)} ${style.tone("warning", `${model.warningCodes.length} warnings`)}  ${style.tone("muted", model.warningCodes.join(", "))}`);
  return lines.map((line) => fitStyledLine(line, width)).filter(Boolean);
};

export const renderRlmManagementResult = (metadata: unknown, width: number): string[] =>
  renderModel(projectManagement(metadata), width);

export class RlmManagementResultComponent implements Component {
  private readonly model: ManagementDisplayModel;
  private readonly style: VisualStyle;
  constructor(metadata: unknown, theme?: Theme) {
    this.model = projectManagement(metadata);
    this.style = visualStyleForTheme(theme);
  }
  render(width: number): string[] { return renderModel(this.model, width, this.style); }
  invalidate(): void {}
}

export const renderRlmManagementResultComponent = (metadata: unknown, theme?: Theme): Component =>
  new RlmManagementResultComponent(metadata, theme);
