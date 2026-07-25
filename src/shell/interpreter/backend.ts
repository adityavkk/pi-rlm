/**
 * Interpreter backend protocol.
 *
 * The runtime is agnostic to the guest engine. Version 1 ships a QuickJS
 * backend; future backends (Deno, container, micro-VM) implement this same
 * contract. Value-returning bridge calls are async; progress effects (phase,
 * emit, answer, console) are synchronous so they never create unawaited work.
 */

import type { InterpreterError } from "../../core/errors.ts";
import type { JsonValue } from "../../core/json.ts";

/** Data globals injected into a fresh cell context. */
export interface CellGlobals {
  readonly objective: string;
  readonly inputs: JsonValue;
  readonly variables: JsonValue;
  readonly budget: JsonValue;
  readonly workspace: JsonValue;
}

/** Async bridge for value-returning calls (llm, agent, recurse, tools, ...). */
export type HostDispatch = (name: string, args: JsonValue, signal: AbortSignal, deadlineMs: number) => Promise<unknown>;

/** Synchronous effect for progress and answer recording (never awaited). */
export type HostEffect = (name: string, args: JsonValue) => void;

export interface CellEvalOptions {
  /** Transformed async IIFE source produced by core `transformCell`. */
  readonly source: string;
  /** Absolute epoch ms after which the guest is interrupted. */
  readonly deadlineMs: number;
  readonly memoryBytes: number;
  readonly globals: CellGlobals;
  /** Optional owner cancellation, composed into the cell epoch signal. */
  readonly signal?: AbortSignal;
  readonly dispatch: HostDispatch;
  readonly effect: HostEffect;
}

export type CellEvalOutcome =
  | {
      readonly kind: "value";
      readonly result: JsonValue | undefined;
      readonly hasResult: boolean;
      readonly workspace: JsonValue;
      readonly workspaceInvalidPaths: readonly string[];
    }
  | {
      readonly kind: "guest_error";
      readonly message: string;
      readonly workspace: JsonValue;
      readonly workspaceInvalidPaths: readonly string[];
    }
  | { readonly kind: "terminal"; readonly error: InterpreterError };

export interface InterpreterBackend {
  readonly id: string;
  /** Engine/package version, recorded separately from the stable backend ID. */
  readonly version?: string;
  evalCell(options: CellEvalOptions): Promise<CellEvalOutcome>;
  dispose(): Promise<void>;
}
