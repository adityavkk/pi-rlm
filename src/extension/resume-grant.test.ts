import { describe, expect, test } from "bun:test";
import {
  consumeResumeGrant,
  emptyResumeGrantStore,
  mintResumeGrant,
  type ManagedResumeGrant,
  type ResumeAuthorizationBinding,
  type ResumeGrantDenial,
} from "./resume-grant.ts";

const binding: ResumeAuthorizationBinding = {
  sessionId: "session-1",
  authorizationGeneration: 4,
  commandNonce: "command-1",
  turnOriginSha256: "1".repeat(64),
  managedName: `run-${"2".repeat(32)}`,
  runId: `run_${"3".repeat(64)}`,
  manifestHash: "4".repeat(64),
  checkpointSequence: 7,
  checkpointSha256: "5".repeat(64),
  checkpointPrefixSha256: "6".repeat(64),
  writerOrdinal: 9,
  writerTokenSha256: "7".repeat(64),
  mode: "tui",
};
const grant: ManagedResumeGrant = {
  grantId: "grant-1",
  ...binding,
  issuedAtMs: 100,
  expiresAtMs: 200,
  oneShot: true,
};

const consume = (actual: ResumeAuthorizationBinding, nowMs = 150) => consumeResumeGrant(
  mintResumeGrant(emptyResumeGrantStore(), grant),
  { grantId: grant.grantId, ...actual, nowMs },
);

describe("managed resume grant", () => {
  test.each([
    ["sessionId", "session-2", "SESSION_MISMATCH"],
    ["authorizationGeneration", 5, "AUTHORIZATION_GENERATION_MISMATCH"],
    ["commandNonce", "command-2", "COMMAND_NONCE_MISMATCH"],
    ["turnOriginSha256", "8".repeat(64), "TURN_ORIGIN_MISMATCH"],
    ["managedName", `run-${"8".repeat(32)}`, "MANAGED_NAME_MISMATCH"],
    ["runId", `run_${"8".repeat(64)}`, "RUN_ID_MISMATCH"],
    ["manifestHash", "8".repeat(64), "MANIFEST_HASH_MISMATCH"],
    ["checkpointSequence", 8, "CHECKPOINT_SEQUENCE_MISMATCH"],
    ["checkpointSha256", "8".repeat(64), "CHECKPOINT_HASH_MISMATCH"],
    ["checkpointPrefixSha256", "8".repeat(64), "CHECKPOINT_PREFIX_MISMATCH"],
    ["writerOrdinal", 10, "WRITER_ORDINAL_MISMATCH"],
    ["writerTokenSha256", "8".repeat(64), "WRITER_TOKEN_MISMATCH"],
    ["mode", "rpc", "MODE_MISMATCH"],
  ] as const)("rejects a %s mismatch and invalidates the grant", (field, value, denial) => {
    const result = consume({ ...binding, [field]: value } as ResumeAuthorizationBinding);
    expect(result).toMatchObject({ ok: false, denial: denial as ResumeGrantDenial });
    expect(result.store.grants).toEqual({});
    expect(consumeResumeGrant(result.store, { grantId: grant.grantId, ...binding, nowMs: 150 }))
      .toMatchObject({ ok: false, denial: "NOT_FOUND" });
  });

  test("expires, consumes once, and reports replay", () => {
    expect(consume(binding, 200)).toMatchObject({ ok: false, denial: "EXPIRED", store: { grants: {} } });
    const first = consume(binding);
    expect(first).toMatchObject({ ok: true, grant });
    const replay = consumeResumeGrant(first.store, { grantId: grant.grantId, ...binding, nowMs: 151 });
    expect(replay).toMatchObject({ ok: false, denial: "REPLAY" });
  });
});
