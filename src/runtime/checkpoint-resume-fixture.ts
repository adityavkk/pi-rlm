import type { RuntimeComponentIdentity } from "../core/identity.ts";
import { isJsonObject } from "../core/json.ts";
import {
  CONTROLLER_RESUME_CAPABILITY_VERSION,
  type Cell,
  type ControllerDriver,
  type ControllerResumeCapabilityV1,
  type FrameState,
} from "./controller.ts";

export const RESUME_FIXTURE_FIRST_CELL = `
const model = await llm({ key: "once", prompt: "spend exactly once" });
const context = await contexts.derive({ key: "derived", value: { retained: true }, label: "derived" });
const artifact = await artifacts.write({ key: "artifact", name: "resume.txt", value: "retained artifact" });
workspace = {
  count: (workspace.count || 0) + 1,
  model: model.value,
  contextId: context.id,
  artifactId: artifact.id,
};
"checkpoint-ready";
`;

export const RESUME_FIXTURE_SECOND_CELL = `
const model = await llm({ key: "once", prompt: "spend exactly once" });
const context = await contexts.derive({ key: "derived", value: { retained: true }, label: "derived" });
const artifact = await artifacts.write({ key: "artifact", name: "resume.txt", value: "retained artifact" });
answer({ answer: workspace.count + ":" + model.value + ":" + (context.id === workspace.contextId) + ":" + (artifact.id === workspace.artifactId) });
"resumed";
`;

export const NESTED_RESUME_FIXTURE_FIRST_CELL = `
const child = await recurse({ key: "nested", objective: "complete before checkpoint" });
workspace = { nested: child.value.answer };
"nested-checkpoint-ready";
`;

export const NESTED_RESUME_FIXTURE_SECOND_CELL = `
const child = await recurse({ key: "nested", objective: "complete before checkpoint" });
answer({ answer: workspace.nested + ":" + child.value.answer + ":" + child.cached });
"nested-resumed";
`;

class NestedResumeChildController implements ControllerDriver {
  private complete = false;
  readonly identity: RuntimeComponentIdentity = {
    id: "pi-rlm/test-nested-resume-child-controller",
    version: "1",
    configuration: {},
  };

  async next(): Promise<Cell> {
    if (this.complete) throw new Error("nested resume child script exhausted");
    this.complete = true;
    return { reasoning: "complete nested frame", code: "answer({ answer: 'nested' }); 'nested-done'" };
  }

  fork(): ControllerDriver { return new NestedResumeChildController(); }
}

export class NestedResumeFixtureController implements ControllerDriver {
  private index = 0;
  readonly identity: RuntimeComponentIdentity = {
    id: "pi-rlm/test-nested-resume-controller",
    version: "1",
    configuration: { fixture: "checkpoint-nested-resume-v1" },
  };

  readonly resumeCapability: ControllerResumeCapabilityV1 = {
    version: CONTROLLER_RESUME_CAPABILITY_VERSION,
    strategy: "state-token",
    capture: (boundary) => ({ index: this.index, nextIteration: boundary.nextIteration }),
    validate: (state, boundary) => {
      if (!isJsonObject(state) || Object.keys(state).length !== 2 || state["index"] !== 1
        || state["index"] !== boundary.trajectoryLength || state["nextIteration"] !== boundary.nextIteration)
        throw new TypeError("nested resume fixture controller cursor is invalid");
    },
    restore: (state, boundary) => {
      this.resumeCapability.validate(state, boundary);
      this.index = 1;
    },
  };

  constructor(private readonly beforeSecond?: (state: FrameState) => void | Promise<void>) {}

  async next(state: FrameState): Promise<Cell> {
    const index = this.index++;
    if (index === 0) return { reasoning: "complete child before checkpoint", code: NESTED_RESUME_FIXTURE_FIRST_CELL };
    await this.beforeSecond?.(state);
    if (index === 1) return { reasoning: "reuse hydrated child result", code: NESTED_RESUME_FIXTURE_SECOND_CELL };
    throw new Error("nested resume fixture controller script exhausted");
  }

  fork(): ControllerDriver { return new NestedResumeChildController(); }
}

export class ResumeFixtureController implements ControllerDriver {
  private index = 0;
  readonly identity: RuntimeComponentIdentity = {
    id: "pi-rlm/test-resume-controller",
    version: "1",
    configuration: { fixture: "checkpoint-resume-v1" },
  };

  readonly resumeCapability: ControllerResumeCapabilityV1 = {
    version: CONTROLLER_RESUME_CAPABILITY_VERSION,
    strategy: "state-token",
    capture: (boundary) => ({ index: this.index, nextIteration: boundary.nextIteration }),
    validate: (state, boundary) => {
      if (!isJsonObject(state) || Object.keys(state).length !== 2 || state["index"] !== 1
        || state["nextIteration"] !== boundary.nextIteration)
        throw new TypeError("resume fixture controller cursor is invalid");
    },
    restore: (state, boundary) => {
      if (!isJsonObject(state) || Object.keys(state).length !== 2 || state["index"] !== 1
        || state["nextIteration"] !== boundary.nextIteration)
        throw new TypeError("resume fixture controller cursor is invalid");
      this.index = 1;
    },
  };

  constructor(private readonly beforeSecond?: (state: FrameState) => void | Promise<void>) {}

  async next(state: FrameState): Promise<Cell> {
    const index = this.index++;
    if (index === 0) return { reasoning: "build checkpoint state", code: RESUME_FIXTURE_FIRST_CELL };
    await this.beforeSecond?.(state);
    if (index === 1) return { reasoning: "continue without replay", code: RESUME_FIXTURE_SECOND_CELL };
    throw new Error("resume fixture controller script exhausted");
  }

  fork(): ControllerDriver {
    return new ResumeFixtureController(this.beforeSecond);
  }
}
