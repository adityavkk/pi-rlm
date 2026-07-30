/** Theme-aware terminal layout primitives for trusted, already-sanitized text. */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type VisualTone = "text" | "muted" | "accent" | "success" | "warning" | "error" | "border";

export interface VisualStyle {
  readonly tone: (tone: VisualTone, text: string) => string;
  readonly strong: (text: string) => string;
  readonly selected: (text: string) => string;
  readonly surface: (text: string) => string;
}

export const plainVisualStyle: VisualStyle = Object.freeze({
  tone: (_tone: VisualTone, text: string): string => text,
  strong: (text: string): string => text,
  selected: (text: string): string => text,
  surface: (text: string): string => text,
});

const themeColor: Readonly<Record<VisualTone, ThemeColor>> = Object.freeze({
  text: "text",
  muted: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
  border: "borderMuted",
});

export const visualStyleForTheme = (theme?: Theme): VisualStyle => {
  if (!theme || typeof theme.fg !== "function" || typeof theme.bg !== "function" || typeof theme.bold !== "function")
    return plainVisualStyle;
  return Object.freeze({
    tone: (tone: VisualTone, text: string): string => theme.fg(themeColor[tone], text),
    strong: (text: string): string => theme.bold(theme.fg("text", text)),
    selected: (text: string): string => theme.bold(theme.fg("accent", text)),
    surface: (text: string): string => theme.bg("customMessageBg", text),
  });
};

const widthLimit = (width: number): number =>
  Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;

/** Bound trusted styled text without stripping host-owned ANSI styling. */
export const fitStyledLine = (value: string, width: number): string => {
  const limit = widthLimit(width);
  if (limit === 0) return "";
  return visibleWidth(value) <= limit ? value : truncateToWidth(value, limit, "…");
};

export const padStyledLine = (value: string, width: number, align: "left" | "right" = "left"): string => {
  const limit = widthLimit(width);
  const fitted = fitStyledLine(value, limit);
  const padding = " ".repeat(Math.max(0, limit - visibleWidth(fitted)));
  return align === "right" ? `${padding}${fitted}` : `${fitted}${padding}`;
};

export interface PanelOptions {
  readonly title: string;
  readonly body: readonly string[];
  readonly width: number;
  readonly style?: VisualStyle;
  readonly footer?: string;
  readonly surface?: boolean;
}

/** One responsive container. The action footer remains outside the border. */
export const renderPanel = ({
  title,
  body,
  width,
  style = plainVisualStyle,
  footer,
  surface = false,
}: PanelOptions): string[] => {
  const limit = widthLimit(width);
  if (limit === 0) return [];
  // Leave the terminal's last column untouched. Writing it can trigger autowrap
  // before the host moves to the next component row.
  const panelWidth = Math.max(1, limit - 1);
  if (panelWidth < 24) {
    const compact = [style.strong(title), ...body, ...(footer ? [style.tone("muted", footer)] : [])]
      .map((line) => fitStyledLine(line, panelWidth))
      .filter((line) => line.length > 0);
    return compact;
  }

  const inner = panelWidth - 2;
  const titleWidth = Math.max(1, inner - 3);
  const safeTitle = fitStyledLine(title, titleWidth);
  const topUsed = 2 + visibleWidth(safeTitle);
  const top = [
    style.tone("border", "╭─ "),
    style.strong(safeTitle),
    style.tone("border", `${"─".repeat(Math.max(0, inner - topUsed))}╮`),
  ].join("");
  const framedBody = body.map((line) => {
    const content = padStyledLine(line, Math.max(0, inner - 2));
    return `${style.tone("border", "│")} ${content} ${style.tone("border", "│")}`;
  });
  const bottom = style.tone("border", `╰${"─".repeat(inner)}╯`);
  const framed = [top, ...framedBody, bottom].map((line) => {
    const padded = padStyledLine(line, panelWidth);
    return surface ? style.surface(padded) : padded;
  });
  if (!footer) return framed;
  return [...framed, fitStyledLine(`  ${style.tone("muted", footer)}`, panelWidth)];
};

export type VisualStatus = "running" | "cancelling" | "approval" | "completed" | "failed" | "cancelled" | "inactive";

const statusGlyphs: Readonly<Record<VisualStatus, { readonly glyph: string; readonly tone: VisualTone }>> = Object.freeze({
  running: { glyph: "●", tone: "warning" },
  cancelling: { glyph: "◐", tone: "warning" },
  approval: { glyph: "!", tone: "warning" },
  completed: { glyph: "✓", tone: "success" },
  failed: { glyph: "×", tone: "error" },
  cancelled: { glyph: "-", tone: "muted" },
  inactive: { glyph: "·", tone: "muted" },
});

export const statusGlyph = (status: VisualStatus, style: VisualStyle = plainVisualStyle): string => {
  const marker = statusGlyphs[status];
  return style.tone(marker.tone, marker.glyph);
};

export const compactBytes = (bytes: number): string => {
  const safe = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
  if (safe < 1_024) return `${safe} B`;
  if (safe < 1_048_576) return `${(safe / 1_024).toFixed(safe < 10_240 ? 1 : 0)} KiB`;
  if (safe < 1_073_741_824) return `${(safe / 1_048_576).toFixed(safe < 10_485_760 ? 1 : 0)} MiB`;
  return `${(safe / 1_073_741_824).toFixed(1)} GiB`;
};
