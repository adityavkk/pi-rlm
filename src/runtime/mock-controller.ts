/** Deterministic scripted controller for tests and offline demos. */

import type { RuntimeComponentIdentity } from "../core/identity.ts";
import type { Cell, ControllerDriver, FrameState } from "./controller.ts";

export type ForkFactory = (objective: string, frameId: string) => ControllerDriver;

export class MockController implements ControllerDriver {
  private index = 0;
  readonly identity: RuntimeComponentIdentity;
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
