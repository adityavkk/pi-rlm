/**
 * Cross-cell workspace validation.
 *
 * A workspace value is strict JSON or a single-key tagged handle referencing a
 * content-addressed context or artifact. Everything else (functions, promises,
 * cycles, undefined, non-finite numbers, class instances) is rejected so state
 * survives restart replay by value.
 */

import { type JsonValue, parseJsonValue } from "./json.ts";
import { err, ok, type Result } from "./result.ts";

export type WorkspaceValue = JsonValue | { readonly contextId: string } | { readonly artifactId: string };

export interface WorkspaceError {
  readonly key: string;
  readonly reason: string;
}

const asHandle = (value: unknown): WorkspaceValue | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return undefined;
  const [key] = keys;
  const inner = (value as Record<string, unknown>)[key as string];
  if (key === "contextId" && typeof inner === "string") return { contextId: inner };
  if (key === "artifactId" && typeof inner === "string") return { artifactId: inner };
  return undefined;
};

/** Validate a raw workspace snapshot produced by a cell. */
export const validateWorkspace = (
  raw: Record<string, unknown>,
): Result<Record<string, WorkspaceValue>, WorkspaceError[]> => {
  const errors: WorkspaceError[] = [];
  const out: Record<string, WorkspaceValue> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    const handle = asHandle(value);
    if (handle) {
      out[key] = handle;
      continue;
    }
    const parsed = parseJsonValue(value);
    if (!parsed.ok) {
      errors.push({ key, reason: `${parsed.reason} at ${parsed.path}` });
      continue;
    }
    out[key] = parsed.value;
  }
  return errors.length > 0 ? err(errors) : ok(out);
};

const singleKey = (value: WorkspaceValue, key: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  key in value &&
  typeof (value as Record<string, unknown>)[key] === "string";

export const isContextHandle = (value: WorkspaceValue): value is { contextId: string } =>
  singleKey(value, "contextId");

export const isArtifactHandle = (value: WorkspaceValue): value is { artifactId: string } =>
  singleKey(value, "artifactId");
