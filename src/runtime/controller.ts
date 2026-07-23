/** Controller driver contract. Each iteration the driver observes bounded frame
 * state and returns exactly one cell (`reasoning` + `code`). `fork` produces an
 * isolated child driver for a `recurse()` frame. Real drivers call a model; the
 * mock driver replays a script. */

import type { BudgetView } from "../core/budget.ts";
import type { JsonValue } from "../core/json.ts";
import type { RlmOutputField } from "../core/program.ts";
import type { TrajectoryProjection } from "../core/trajectory.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";

export interface FrameState {
  readonly frameId: string;
  readonly depth: number;
  readonly objective: string;
  readonly inputs: Readonly<Record<string, ContextDescriptor>>;
  readonly variables: JsonValue;
  readonly budget: BudgetView;
  readonly workspace: JsonValue;
  readonly outputs: readonly RlmOutputField[];
  readonly trajectory: TrajectoryProjection;
  readonly lastOutcome?: { readonly kind: string; readonly preview?: string; readonly message?: string };
}

export interface Cell {
  readonly reasoning: string;
  readonly code: string;
}

export interface ControllerDriver {
  next(state: FrameState): Promise<Cell>;
  fork(childObjective: string, childFrameId: string): ControllerDriver;
}
