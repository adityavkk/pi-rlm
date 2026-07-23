/** Per-call usage accounting. Token and cost fields are optional because some
 * providers report them late or not at all; the ledger must tolerate absence. */

export interface CallUsage {
  readonly attempts: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly durationMs: number;
}

export const ZERO_CALL_USAGE: CallUsage = { attempts: 0, durationMs: 0 };

const addOptional = (a?: number, b?: number): number | undefined => {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
};

export const addUsage = (a: CallUsage, b: CallUsage): CallUsage => {
  const totalTokens = addOptional(a.totalTokens, b.totalTokens);
  const inputTokens = addOptional(a.inputTokens, b.inputTokens);
  const outputTokens = addOptional(a.outputTokens, b.outputTokens);
  const costUsd = addOptional(a.costUsd, b.costUsd);
  return {
    attempts: a.attempts + b.attempts,
    durationMs: a.durationMs + b.durationMs,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};
