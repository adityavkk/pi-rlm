/**
 * Deterministic identity helpers. Hashing is injected so the pure core stays
 * free of node:crypto; the shell provides a concrete sha256 Hasher.
 */

import { canonicalStringify, type JsonValue } from "./json.ts";

/** A hex-encoded content hash function (e.g. sha256). */
export type Hasher = (input: string) => string;

export type CallKind = "llm" | "agent" | "recurse" | "tool" | "artifact" | "context";

/** Stable identity hash of any JSON identity descriptor. */
export const identityHash = (hasher: Hasher, identity: JsonValue): string =>
  hasher(canonicalStringify(identity));

/**
 * Derive a deterministic call id from the run, call kind, guest key, and the
 * canonical identity of the normalized spec. Same identity => same id => cache
 * hit on replay.
 */
export const deriveCallId = (
  hasher: Hasher,
  parts: { readonly runId: string; readonly kind: CallKind; readonly key: string; readonly identity: JsonValue },
): string => {
  const digest = hasher(
    canonicalStringify({ runId: parts.runId, kind: parts.kind, key: parts.key, identity: parts.identity }),
  );
  return `call_${parts.kind}_${digest.slice(0, 24)}`;
};

/** Short, stable label hash for content-addressed handles. */
export const shortHash = (hasher: Hasher, input: string, length = 16): string =>
  hasher(input).slice(0, length);
