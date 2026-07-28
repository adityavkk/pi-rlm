/**
 * Deterministic identity helpers. Hashing is injected so the pure core stays
 * free of node:crypto; the shell provides a concrete sha256 Hasher.
 */

import { canonicalStringify, type JsonValue } from "./json.ts";

/** A hex-encoded content hash function (e.g. sha256). */
export type Hasher = (input: string) => string;

export type CallKind = "llm" | "agent" | "recurse" | "tool" | "artifact" | "context";

const fullDigest = (hasher: Hasher, input: string): string => {
  const digest = hasher(input);
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new TypeError("hasher must return 64 lowercase hexadecimal characters");
  return digest;
};

/** Stable identity hash of any JSON identity descriptor. */
export const identityHash = (hasher: Hasher, identity: JsonValue): string =>
  fullDigest(hasher, canonicalStringify(identity));

/**
 * Derive a deterministic call id from the run, call kind, guest key, and the
 * canonical identity of the normalized spec. Same identity => same id => cache
 * hit on replay.
 */
export const deriveCallId = (
  hasher: Hasher,
  parts: { readonly runId: string; readonly kind: CallKind; readonly key: string; readonly identity: JsonValue },
): string => {
  const digest = fullDigest(
    hasher,
    canonicalStringify({
      runId: parts.runId,
      kind: parts.kind,
      key: parts.key,
      identityHash: identityHash(hasher, parts.identity),
    }),
  );
  return `call_${parts.kind}_${digest}`;
};

/** Short, stable label hash for content-addressed handles. */
export const shortHash = (hasher: Hasher, input: string, length = 16): string =>
  fullDigest(hasher, input).slice(0, length);
