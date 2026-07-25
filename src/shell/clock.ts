/** Injectable clock so deadlines and timestamps are deterministic in tests. */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
export const monotonicClock: Clock = { now: () => performance.now() };

/** A manually advanced clock for tests. */
export class ManualClock implements Clock {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
