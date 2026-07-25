/**
 * Launch-grant state machine (pure).
 *
 * Prompt guidance is not authorization. Before any RLM run spends resources the
 * host must hold a single-use grant bound to the current session, turn nonce,
 * prompt hash, normalized request, and exact tool call. Only an exact-request
 * host confirmation or the dedicated `/rlm` host action can mint one.
 */

import { err, ok, type Result } from "./result.ts";

export type GrantMode = "slash_command" | "confirmed";

export interface LaunchGrant {
  readonly grantId: string;
  readonly sessionId: string;
  readonly turnNonce: string;
  readonly promptSha256: string;
  readonly requestSha256: string;
  readonly toolCallId: string;
  readonly mode: GrantMode;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly expiresAfterToolCall: true;
}

export interface GrantStore {
  readonly grants: Readonly<Record<string, LaunchGrant>>;
}

export const emptyGrantStore = (): GrantStore => ({ grants: {} });

export const mintGrant = (
  store: GrantStore,
  grant: LaunchGrant,
): { store: GrantStore; grant: LaunchGrant } => ({
  store: { grants: { ...store.grants, [grant.grantId]: grant } },
  grant,
});

export type GrantDenial =
  | "NOT_FOUND"
  | "EXPIRED"
  | "SESSION_MISMATCH"
  | "TURN_MISMATCH"
  | "PROMPT_MISMATCH"
  | "REQUEST_MISMATCH"
  | "TOOL_CALL_MISMATCH";

export interface GrantConsumeContext {
  readonly grantId: string;
  readonly sessionId: string;
  readonly turnNonce: string;
  readonly promptSha256: string;
  readonly requestSha256: string;
  readonly toolCallId: string;
  readonly nowMs: number;
}

/** Consume a grant exactly once, enforcing expiry and every launch binding. */
export const consumeGrant = (
  store: GrantStore,
  ctx: GrantConsumeContext,
): Result<{ store: GrantStore; grant: LaunchGrant }, GrantDenial> => {
  const grant = store.grants[ctx.grantId];
  if (!grant) return err("NOT_FOUND");
  if (ctx.nowMs >= grant.expiresAtMs) return err("EXPIRED");
  if (grant.sessionId !== ctx.sessionId) return err("SESSION_MISMATCH");
  if (grant.turnNonce !== ctx.turnNonce) return err("TURN_MISMATCH");
  if (grant.promptSha256 !== ctx.promptSha256) return err("PROMPT_MISMATCH");
  if (grant.requestSha256 !== ctx.requestSha256) return err("REQUEST_MISMATCH");
  if (grant.toolCallId !== ctx.toolCallId) return err("TOOL_CALL_MISMATCH");
  const remaining = { ...store.grants };
  delete remaining[ctx.grantId];
  return ok({ store: { grants: remaining }, grant });
};

/** Drop every grant bound to a superseded turn nonce. */
export const expireOtherTurns = (store: GrantStore, currentTurnNonce: string): GrantStore => {
  const grants: Record<string, LaunchGrant> = {};
  for (const [id, grant] of Object.entries(store.grants))
    if (grant.turnNonce === currentTurnNonce) grants[id] = grant;
  return { grants };
};
