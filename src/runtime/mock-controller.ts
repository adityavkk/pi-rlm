/** Deterministic scripted controller for tests and offline demos. */

import type { Cell, ControllerDriver, FrameState } from "./controller.ts";

export type ForkFactory = (objective: string, frameId: string) => ControllerDriver;

export class MockController implements ControllerDriver {
  private index = 0;
  constructor(
    private readonly cells: readonly Cell[],
    private readonly forkFactory?: ForkFactory,
  ) {}

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
