/** Controller driver contract. Each iteration the driver observes bounded frame
 * state and returns exactly one cell (`reasoning` + `code`). `fork` produces an
 * isolated child driver for a `recurse()` frame. Real drivers call a model; the
 * mock driver replays a script. */

import type { BudgetView } from "../core/budget.ts";
import type { RuntimeComponentIdentity } from "../core/identity.ts";
import type { JsonValue } from "../core/json.ts";
import type { RlmOutputField } from "../core/program.ts";
import type { TrajectoryProjection } from "../core/trajectory.ts";
import type { CallUsage } from "../core/usage.ts";
import type { ContextDescriptor } from "../shell/context-store.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "../shell/model/client.ts";

export const CONTROLLER_RESUME_CAPABILITY_VERSION = "pi-rlm.controller-resume.v1" as const;

export interface ControllerResumeBoundary {
  readonly frameId: string;
  readonly nextIteration: number;
  readonly trajectoryLength: number;
}

export interface ControllerResumeCapabilityV1 {
  readonly version: typeof CONTROLLER_RESUME_CAPABILITY_VERSION;
  /** `trajectory-derived` has no private cursor; `state-token` checkpoints one bounded JSON cursor. */
  readonly strategy: "trajectory-derived" | "state-token";
  capture(boundary: ControllerResumeBoundary): JsonValue;
  /** Effect-free validation used before journal repair or runtime restoration. */
  validate(state: JsonValue, boundary: ControllerResumeBoundary): void;
  restore(state: JsonValue, boundary: ControllerResumeBoundary): void;
}

export interface ControllerResumeCapabilityIdentityV1 {
  readonly version: typeof CONTROLLER_RESUME_CAPABILITY_VERSION;
  readonly strategy: ControllerResumeCapabilityV1["strategy"];
}

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

export interface ControllerModelOperation {
  readonly usage: CallUsage;
  complete(client: ModelClient, request: ModelRequest): Promise<ModelResponse>;
}

export interface ControllerDriver {
  /** Required before run effects. Includes implementation and all behavior-affecting instance options. */
  readonly identity: RuntimeComponentIdentity;
  /** Optional explicit checkpoint contract. Resume rejects drivers without this own-data capability. */
  readonly resumeCapability?: ControllerResumeCapabilityV1;
  /** Drivers must perform provider work only through `operation.complete`. */
  next(state: FrameState, signal: AbortSignal, operation: ControllerModelOperation): Promise<Cell>;
  fork(childObjective: string, childFrameId: string): ControllerDriver;
}

export class ControllerResumeCapabilityError extends TypeError {
  override readonly name = "ControllerResumeCapabilityError";
  readonly code = "CONTROLLER_RESUME_UNSUPPORTED";
}

const capabilityData = (value: object, key: keyof ControllerResumeCapabilityV1): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set)
    throw new ControllerResumeCapabilityError(`controller resume capability.${key} must be an own data property`);
  return descriptor.value;
};

/** Effect-free own-data inspection. Accessors cannot run during component preflight. */
export const inspectControllerResumeCapability = (
  controller: ControllerDriver,
): { readonly identity: ControllerResumeCapabilityIdentityV1; readonly capability: ControllerResumeCapabilityV1 } | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(controller, "resumeCapability");
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.value === undefined || descriptor.get || descriptor.set)
    throw new ControllerResumeCapabilityError("controller resume capability must be an own data property");
  const source = descriptor.value;
  if (source === null || typeof source !== "object")
    throw new ControllerResumeCapabilityError("controller resume capability is malformed or unsupported");
  const version = capabilityData(source, "version");
  const strategy = capabilityData(source, "strategy");
  const capture = capabilityData(source, "capture");
  const validate = capabilityData(source, "validate");
  const restore = capabilityData(source, "restore");
  if (version !== CONTROLLER_RESUME_CAPABILITY_VERSION
    || (strategy !== "trajectory-derived" && strategy !== "state-token")
    || typeof capture !== "function" || typeof validate !== "function" || typeof restore !== "function")
    throw new ControllerResumeCapabilityError("controller resume capability is malformed or unsupported");
  const capability: ControllerResumeCapabilityV1 = Object.freeze({
    version: CONTROLLER_RESUME_CAPABILITY_VERSION,
    strategy,
    capture: capture.bind(source) as ControllerResumeCapabilityV1["capture"],
    validate: validate.bind(source) as ControllerResumeCapabilityV1["validate"],
    restore: restore.bind(source) as ControllerResumeCapabilityV1["restore"],
  });
  return {
    identity: { version: CONTROLLER_RESUME_CAPABILITY_VERSION, strategy },
    capability,
  };
};

export const requireControllerResumeCapability = (
  controller: ControllerDriver,
): { readonly identity: ControllerResumeCapabilityIdentityV1; readonly capability: ControllerResumeCapabilityV1 } => {
  const inspected = inspectControllerResumeCapability(controller);
  if (!inspected) throw new ControllerResumeCapabilityError("controller does not declare resumable state semantics");
  return inspected;
};
