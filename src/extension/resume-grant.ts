/** Pure, host-owned one-shot authorization for one exact managed continuation. */

export type ResumeHostMode = "tui" | "rpc" | "print" | "json";

export interface ResumeAuthorizationBinding {
  readonly sessionId: string;
  readonly authorizationGeneration: number;
  readonly commandNonce: string;
  readonly turnOriginSha256: string;
  readonly managedName: string;
  readonly runId: string;
  readonly manifestHash: string;
  readonly checkpointSequence: number;
  readonly checkpointSha256: string;
  readonly checkpointPrefixSha256: string;
  readonly writerOrdinal: number;
  readonly writerTokenSha256: string;
  readonly mode: ResumeHostMode;
}

export interface ManagedResumeGrant extends ResumeAuthorizationBinding {
  readonly grantId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly oneShot: true;
}

export interface ResumeGrantStore {
  readonly grants: Readonly<Record<string, ManagedResumeGrant>>;
  readonly consumed: Readonly<Record<string, true>>;
}

export type ResumeGrantDenial =
  | "NOT_FOUND"
  | "REPLAY"
  | "EXPIRED"
  | "SESSION_MISMATCH"
  | "AUTHORIZATION_GENERATION_MISMATCH"
  | "COMMAND_NONCE_MISMATCH"
  | "TURN_ORIGIN_MISMATCH"
  | "MANAGED_NAME_MISMATCH"
  | "RUN_ID_MISMATCH"
  | "MANIFEST_HASH_MISMATCH"
  | "CHECKPOINT_SEQUENCE_MISMATCH"
  | "CHECKPOINT_HASH_MISMATCH"
  | "CHECKPOINT_PREFIX_MISMATCH"
  | "WRITER_ORDINAL_MISMATCH"
  | "WRITER_TOKEN_MISMATCH"
  | "MODE_MISMATCH";

export interface ResumeGrantConsumeContext extends ResumeAuthorizationBinding {
  readonly grantId: string;
  readonly nowMs: number;
}

export type ResumeGrantConsumeResult =
  | { readonly ok: true; readonly store: ResumeGrantStore; readonly grant: ManagedResumeGrant }
  | { readonly ok: false; readonly store: ResumeGrantStore; readonly denial: ResumeGrantDenial };

export const emptyResumeGrantStore = (): ResumeGrantStore => ({ grants: {}, consumed: {} });

export const mintResumeGrant = (
  store: ResumeGrantStore,
  grant: ManagedResumeGrant,
): ResumeGrantStore => ({
  grants: { ...store.grants, [grant.grantId]: Object.freeze({ ...grant }) },
  consumed: { ...store.consumed },
});

const without = (store: ResumeGrantStore, grantId: string, consumed = false): ResumeGrantStore => {
  const grants = { ...store.grants };
  delete grants[grantId];
  return {
    grants,
    consumed: consumed ? { ...store.consumed, [grantId]: true } : { ...store.consumed },
  };
};

export const revokeResumeGrant = (store: ResumeGrantStore, grantId: string): ResumeGrantStore =>
  without(store, grantId);

const mismatch = (
  store: ResumeGrantStore,
  grantId: string,
  denial: ResumeGrantDenial,
): ResumeGrantConsumeResult => ({ ok: false, store: without(store, grantId), denial });

/** Every denial invalidates the located grant; a successful grant becomes a replay tombstone. */
export const consumeResumeGrant = (
  store: ResumeGrantStore,
  context: ResumeGrantConsumeContext,
): ResumeGrantConsumeResult => {
  const grant = store.grants[context.grantId];
  if (!grant)
    return { ok: false, store, denial: store.consumed[context.grantId] ? "REPLAY" : "NOT_FOUND" };
  if (context.nowMs >= grant.expiresAtMs) return mismatch(store, context.grantId, "EXPIRED");
  if (context.sessionId !== grant.sessionId) return mismatch(store, context.grantId, "SESSION_MISMATCH");
  if (context.authorizationGeneration !== grant.authorizationGeneration)
    return mismatch(store, context.grantId, "AUTHORIZATION_GENERATION_MISMATCH");
  if (context.commandNonce !== grant.commandNonce) return mismatch(store, context.grantId, "COMMAND_NONCE_MISMATCH");
  if (context.turnOriginSha256 !== grant.turnOriginSha256) return mismatch(store, context.grantId, "TURN_ORIGIN_MISMATCH");
  if (context.managedName !== grant.managedName) return mismatch(store, context.grantId, "MANAGED_NAME_MISMATCH");
  if (context.runId !== grant.runId) return mismatch(store, context.grantId, "RUN_ID_MISMATCH");
  if (context.manifestHash !== grant.manifestHash) return mismatch(store, context.grantId, "MANIFEST_HASH_MISMATCH");
  if (context.checkpointSequence !== grant.checkpointSequence)
    return mismatch(store, context.grantId, "CHECKPOINT_SEQUENCE_MISMATCH");
  if (context.checkpointSha256 !== grant.checkpointSha256)
    return mismatch(store, context.grantId, "CHECKPOINT_HASH_MISMATCH");
  if (context.checkpointPrefixSha256 !== grant.checkpointPrefixSha256)
    return mismatch(store, context.grantId, "CHECKPOINT_PREFIX_MISMATCH");
  if (context.writerOrdinal !== grant.writerOrdinal)
    return mismatch(store, context.grantId, "WRITER_ORDINAL_MISMATCH");
  if (context.writerTokenSha256 !== grant.writerTokenSha256)
    return mismatch(store, context.grantId, "WRITER_TOKEN_MISMATCH");
  if (context.mode !== grant.mode) return mismatch(store, context.grantId, "MODE_MISMATCH");
  return { ok: true, store: without(store, context.grantId, true), grant };
};
