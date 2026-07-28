import type { RuntimeComponentIdentity } from "../core/identity.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";

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

export class ResumeFixtureController implements ControllerDriver {
  readonly identity: RuntimeComponentIdentity = {
    id: "pi-rlm/test-resume-controller",
    version: "1",
    configuration: { fixture: "checkpoint-resume-v1" },
  };

  constructor(private readonly beforeSecond?: (state: FrameState) => void | Promise<void>) {}

  async next(state: FrameState): Promise<Cell> {
    if (state.trajectory.total === 0)
      return { reasoning: "build checkpoint state", code: RESUME_FIXTURE_FIRST_CELL };
    await this.beforeSecond?.(state);
    return { reasoning: "continue without replay", code: RESUME_FIXTURE_SECOND_CELL };
  }

  fork(): ControllerDriver {
    return new ResumeFixtureController(this.beforeSecond);
  }
}
