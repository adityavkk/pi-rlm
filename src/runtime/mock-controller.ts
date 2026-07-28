/** Deterministic scripted controller for tests and offline demos. */

import type { RuntimeComponentIdentity } from "../core/identity.ts";
import { isJsonObject } from "../core/json.ts";
import {
  CONTROLLER_RESUME_CAPABILITY_VERSION,
  type Cell,
  type ControllerDriver,
  type ControllerResumeCapabilityV1,
  type FrameState,
} from "./controller.ts";

export type ForkFactory = (objective: string, frameId: string) => ControllerDriver;

export class MockController implements ControllerDriver {
  private index = 0;
  readonly identity: RuntimeComponentIdentity;
  readonly resumeCapability: ControllerResumeCapabilityV1 = {
    version: CONTROLLER_RESUME_CAPABILITY_VERSION,
    strategy: "state-token",
    capture: (boundary) => ({ index: this.index, nextIteration: boundary.nextIteration }),
    restore: (state, boundary) => {
      if (!isJsonObject(state) || Object.keys(state).length !== 2
        || !Number.isSafeInteger(state["index"]) || (state["index"] as number) < 0
        || state["nextIteration"] !== boundary.nextIteration)
        throw new TypeError("MockController checkpoint cursor is invalid");
      this.index = state["index"] as number;
    },
  };
  constructor(
    private readonly cells: readonly Cell[],
    private readonly forkFactory?: ForkFactory,
    forkFactoryIdentity?: RuntimeComponentIdentity,
  ) {
    if (forkFactory && !forkFactoryIdentity)
      throw new TypeError("MockController fork factory requires stable non-secret identity");
    this.identity = {
      id: "pi-rlm/mock-controller",
      version: "1",
      configuration: { cells: [...cells], forkFactory: forkFactoryIdentity ?? null } as unknown as RuntimeComponentIdentity["configuration"],
    };
  }

  async next(_state: FrameState): Promise<Cell> {
    const cell = this.cells[this.index];
    this.index += 1;
    if (!cell) throw new Error("mock controller script exhausted before answer()");
    return cell;
  }

  fork(objective: string, frameId: string): ControllerDriver {
    if (this.forkFactory) return this.forkFactory(objective, frameId);
    return new MockController([
      { reasoning: "default child", code: "answer({ answer: 'child:' + objective }); 'done'" },
    ]);
  }
}
