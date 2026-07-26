import type { JsonValue } from "../core/json.ts";

export type RunRecoveryErrorCode =
  | "RECOVERY_MANIFEST_INVALID"
  | "RECOVERY_INCOMPATIBLE"
  | "RECOVERY_DIRECTORY_INVALID"
  | "RECOVERY_LOCK_INVALID"
  | "RECOVERY_JOURNAL_CORRUPT"
  | "RECOVERY_IDENTITY_MISMATCH"
  | "RECOVERY_ORPHAN"
  | "RECOVERY_SEMANTIC_CORRUPTION"
  | "RECOVERY_TERMINAL_INCONSISTENT"
  | "RECOVERY_CONTENT_INVALID"
  | "RECOVERY_UNSTABLE";

export class RunRecoveryError extends Error {
  override readonly name = "RunRecoveryError";
  constructor(readonly code: RunRecoveryErrorCode, message: string, override readonly cause?: unknown) {
    super(message);
  }
}

export interface RecoveredTerminal {
  readonly status: "completed" | "failed" | "cancelled";
  readonly completionMode?: "answer" | "fallback_extract";
  readonly answer?: JsonValue;
  readonly output?: { readonly ref: string; readonly sha256: string; readonly bytes: number };
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RunRecoveryInspection {
  readonly runId: string;
  readonly manifestHash: string;
  readonly status: "nonterminal" | RecoveredTerminal["status"];
  readonly rootFrameId: string;
  readonly eventCount: number;
  readonly committedCells: number;
  readonly committedCalls: number;
  readonly terminal?: RecoveredTerminal;
}
