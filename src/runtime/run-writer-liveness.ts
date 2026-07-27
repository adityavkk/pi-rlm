/** Internal conservative owner-liveness classification. */

import type { GenerationRecord } from "./run-writer-protocol.ts";

export type RunWriterLivenessResult =
  | "absent"
  | "live_or_reused"
  | "permission_denied"
  | "unsupported";

export type RunWriterLivenessProbe = (
  owner: GenerationRecord,
) => RunWriterLivenessResult | PromiseLike<RunWriterLivenessResult>;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;

export const isRunWriterLivenessResult = (value: unknown): value is RunWriterLivenessResult =>
  value === "absent" || value === "live_or_reused" || value === "permission_denied" || value === "unsupported";

export const nodeRunWriterLivenessProbe: RunWriterLivenessProbe = (owner) => {
  // kill(pid, 0) is only a liveness syscall. It cannot prove process ownership or distinguish the
  // recorded process from PID reuse, so either successful case deliberately blocks takeover.
  if (owner.pid === process.pid) return "unsupported";
  try {
    process.kill(owner.pid, 0);
    return "live_or_reused";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "absent";
    if (code === "EPERM" || code === "EACCES") return "permission_denied";
    return "unsupported";
  }
};
