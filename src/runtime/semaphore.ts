/** Minimal abortable semaphore bounding active leaf work. FIFO, fair. */

type Release = () => void;

interface Waiter {
  readonly resolve: (release: Release | undefined) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

export class Semaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(max: number) {
    this.available = Math.max(1, max);
  }

  async acquire(signal?: AbortSignal): Promise<Release | undefined> {
    if (signal?.aborted) return undefined;
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }

    return new Promise<Release | undefined>((resolve) => {
      const waiter: Waiter = { resolve, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          resolve(undefined);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      for (;;) {
        const next = this.waiters.shift();
        if (!next) {
          this.available += 1;
          return;
        }
        if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
        if (next.signal?.aborted) {
          next.resolve(undefined);
          continue;
        }
        // Direct handoff: the permit remains unavailable until this waiter
        // invokes the new release callback.
        next.resolve(this.makeRelease());
        return;
      }
    };
  }
}
