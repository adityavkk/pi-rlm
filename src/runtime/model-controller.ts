/**
 * One-response controller driver.
 *
 * Each iteration performs exactly one model completion and yields exactly one
 * cell. It never runs an open-ended agent loop. Invalid controller output is
 * repaired once, then surfaced as a no-op cell so the frame records the wasted
 * turn and the run can still make progress or exhaust cleanly.
 */

import type { RuntimeComponentIdentity } from "../core/identity.ts";
import { isJsonObject } from "../core/json.ts";
import { validateAgainstSchema } from "../core/schema.ts";
import { MAX_CALL_TOKENS } from "../core/usage.ts";
import type { ModelClient } from "../shell/model/client.ts";
import { throwIfAborted } from "./abort.ts";
import {
  buildBasePrompt,
  buildTurnMessage,
  CELL_SCHEMA,
  CONTROLLER_PROMPT_VERSION,
  CONTROLLER_TURN_VERSION,
} from "./controller-prompt.ts";
import {
  CONTROLLER_RESUME_CAPABILITY_VERSION,
  type Cell,
  type ControllerDriver,
  type ControllerModelOperation,
  type ControllerResumeCapabilityV1,
  type FrameState,
} from "./controller.ts";

export interface ModelControllerOptions {
  readonly model?: string;
  readonly maxOutputTokens?: number;
}

const parseCell = (text: string): Cell | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed as never)) return undefined;
  const obj = parsed as { reasoning?: unknown; code?: unknown };
  if (validateAgainstSchema(parsed as never, CELL_SCHEMA).length > 0) return undefined;
  return { reasoning: String(obj.reasoning), code: String(obj.code) };
};

export class ModelController implements ControllerDriver {
  private readonly system = buildBasePrompt();
  readonly identity: RuntimeComponentIdentity;
  readonly resumeCapability: ControllerResumeCapabilityV1 = {
    version: CONTROLLER_RESUME_CAPABILITY_VERSION,
    strategy: "trajectory-derived",
    capture: (boundary) => ({ nextIteration: boundary.nextIteration }),
    validate: (state, boundary) => {
      if (!isJsonObject(state) || Object.keys(state).length !== 1
        || state["nextIteration"] !== boundary.nextIteration)
        throw new TypeError("ModelController checkpoint does not match the trajectory boundary");
    },
    restore: (state, boundary) => {
      if (!isJsonObject(state) || Object.keys(state).length !== 1
        || state["nextIteration"] !== boundary.nextIteration)
        throw new TypeError("ModelController checkpoint does not match the trajectory boundary");
    },
  };

  constructor(
    private readonly model: ModelClient,
    private readonly options: ModelControllerOptions = {},
  ) {
    if (options.maxOutputTokens !== undefined
      && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0 || options.maxOutputTokens > MAX_CALL_TOKENS))
      throw new TypeError(`maxOutputTokens must be a positive safe integer at most ${MAX_CALL_TOKENS}`);
    if (!model.identity) throw new TypeError("ModelController requires a ModelClient identity");
    this.identity = {
      id: "pi-rlm/model-controller",
      version: "1",
      configuration: {
        model: model.identity,
        modelRoute: options.model ?? null,
        maxOutputTokens: options.maxOutputTokens ?? null,
        staticPromptPolicy: {
          renderer: "pi-rlm/controller",
          staticVersion: CONTROLLER_PROMPT_VERSION,
          turnVersion: CONTROLLER_TURN_VERSION,
        },
      } as unknown as RuntimeComponentIdentity["configuration"],
    };
  }

  async next(state: FrameState, signal: AbortSignal, operation: ControllerModelOperation): Promise<Cell> {
    throwIfAborted(signal);
    const user = buildTurnMessage(state);
    const request = {
      prompt: user,
      system: this.system,
      schema: CELL_SCHEMA,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.maxOutputTokens !== undefined ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      ...(signal ? { signal } : {}),
    };
    const first = await operation.complete(this.model, request);
    throwIfAborted(signal);
    let cell = parseCell(first.text);
    if (!cell) {
      const repair = await operation.complete(this.model, {
        ...request,
        prompt: `${user}\n\nYour previous response was not valid JSON of the form {"reasoning","code"}. Respond with ONLY that JSON now.`,
      });
      throwIfAborted(signal);
      cell = parseCell(repair.text);
    }
    return cell ?? { reasoning: "controller produced no valid cell", code: "" };
  }

  fork(childObjective: string): ControllerDriver {
    void childObjective;
    return new ModelController(this.model, this.options);
  }
}
