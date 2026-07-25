/** Resolved execution profile: budgets, interpreter limits, preview sizes,
 * trajectory projection, and abstract model routes. Deadlines are relative to
 * run start so they can be resolved against an injected clock. */

import type { BudgetLimits } from "../core/budget.ts";
import type { ProjectionOptions } from "../core/trajectory.ts";
import type { ContextStoreLimits } from "../shell/context-store.ts";

export interface Profile {
  readonly name: string;
  readonly maxDepth: number;
  readonly maxFrames: number;
  readonly maxLogicalCalls: number;
  readonly maxAttempts: number;
  readonly maxControllerTurns: number;
  readonly maxConcurrency: number;
  readonly tokenLimit?: number;
  readonly storedByteLimit: number;
  readonly wallMs: number;
  readonly cellWallMs: number;
  readonly memoryBytes: number;
  readonly previewHeadBytes: number;
  readonly previewTailBytes: number;
  readonly contextMaxReadBytes: number;
  readonly contextMaxLines: number;
  readonly contextMaxLineBytes: number;
  readonly contextMaxMatches: number;
  readonly contextMaxChunks: number;
  readonly contextMaxPatternBytes: number;
  readonly trajectory: ProjectionOptions;
  readonly models: { readonly small: string; readonly medium: string; readonly large: string };
}

export const DEFAULT_PROFILE: Profile = {
  name: "default",
  maxDepth: 3,
  maxFrames: 32,
  maxLogicalCalls: 200,
  maxAttempts: 400,
  maxControllerTurns: 40,
  maxConcurrency: 4,
  storedByteLimit: 64 * 1024 * 1024,
  wallMs: 10 * 60 * 1000,
  cellWallMs: 30 * 1000,
  memoryBytes: 128 * 1024 * 1024,
  previewHeadBytes: 1024,
  previewTailBytes: 512,
  contextMaxReadBytes: 1024 * 1024,
  contextMaxLines: 10_000,
  contextMaxLineBytes: 64 * 1024,
  contextMaxMatches: 1_000,
  contextMaxChunks: 256,
  contextMaxPatternBytes: 4 * 1024,
  trajectory: {
    headEntries: 2,
    tailEntries: 6,
    codeHeadBytes: 1200,
    codeTailBytes: 400,
    reasoningMaxBytes: 800,
  },
  models: { small: "small", medium: "medium", large: "large" },
};

export const contextStoreLimits = (profile: Profile): ContextStoreLimits => ({
  maxReadBytes: profile.contextMaxReadBytes,
  maxLines: profile.contextMaxLines,
  maxLineBytes: profile.contextMaxLineBytes,
  maxMatches: profile.contextMaxMatches,
  maxChunks: profile.contextMaxChunks,
  maxPatternBytes: profile.contextMaxPatternBytes,
});

const safeInteger = (name: string, value: number, allowZero: boolean): void => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new TypeError(`${name} must be a ${allowZero ? "nonnegative" : "positive"} safe integer`);
};

/** Validate host numeric options before any run effect or provider reservation. */
export const validateProfile = (profile: Profile): void => {
  safeInteger("maxDepth", profile.maxDepth, true);
  safeInteger("maxFrames", profile.maxFrames, true);
  safeInteger("maxLogicalCalls", profile.maxLogicalCalls, true);
  safeInteger("maxAttempts", profile.maxAttempts, true);
  safeInteger("maxControllerTurns", profile.maxControllerTurns, true);
  safeInteger("maxConcurrency", profile.maxConcurrency, false);
  if (profile.tokenLimit !== undefined) safeInteger("tokenLimit", profile.tokenLimit, false);
  safeInteger("storedByteLimit", profile.storedByteLimit, true);
  for (const [name, value] of [
    ["wallMs", profile.wallMs],
    ["cellWallMs", profile.cellWallMs],
    ["memoryBytes", profile.memoryBytes],
    ["previewHeadBytes", profile.previewHeadBytes],
    ["previewTailBytes", profile.previewTailBytes],
    ["contextMaxReadBytes", profile.contextMaxReadBytes],
    ["contextMaxLines", profile.contextMaxLines],
    ["contextMaxLineBytes", profile.contextMaxLineBytes],
    ["contextMaxMatches", profile.contextMaxMatches],
    ["contextMaxChunks", profile.contextMaxChunks],
    ["contextMaxPatternBytes", profile.contextMaxPatternBytes],
  ] as const) safeInteger(name, value, false);
  for (const [name, value] of [
    ["trajectory.headEntries", profile.trajectory.headEntries],
    ["trajectory.tailEntries", profile.trajectory.tailEntries],
    ["trajectory.codeHeadBytes", profile.trajectory.codeHeadBytes],
    ["trajectory.codeTailBytes", profile.trajectory.codeTailBytes],
    ["trajectory.reasoningMaxBytes", profile.trajectory.reasoningMaxBytes],
  ] as const) safeInteger(name, value, true);
  safeInteger(
    "trajectory head/tail entry capacity",
    profile.trajectory.headEntries + profile.trajectory.tailEntries,
    true,
  );
  safeInteger(
    "trajectory code preview capacity",
    profile.trajectory.codeHeadBytes + profile.trajectory.codeTailBytes,
    true,
  );
};

export const resolveLimits = (profile: Profile, startMs: number): BudgetLimits => {
  validateProfile(profile);
  if (!Number.isSafeInteger(startMs)) throw new TypeError("run start time must be a safe integer");
  const deadlineMs = startMs + profile.wallMs;
  if (!Number.isSafeInteger(deadlineMs)) throw new TypeError("run deadline must be a safe integer");
  return {
    maxDepth: profile.maxDepth,
    maxFrames: profile.maxFrames,
    maxLogicalCalls: profile.maxLogicalCalls,
    maxAttempts: profile.maxAttempts,
    maxControllerTurns: profile.maxControllerTurns,
    maxConcurrency: profile.maxConcurrency,
    ...(profile.tokenLimit !== undefined ? { tokenLimit: profile.tokenLimit } : {}),
    storedByteLimit: profile.storedByteLimit,
    deadlineMs,
  };
};
