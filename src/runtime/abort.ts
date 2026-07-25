/** Abort-aware ownership helpers for work that may ignore AbortSignal. */

export class OperationAbortedError extends Error {
  constructor(cause?: unknown) {
    super("operation aborted", { cause });
    this.name = "OperationAbortedError";
  }
}

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new OperationAbortedError(signal.reason);
};

/**
 * Stop awaiting work when the signal aborts. Both fulfillment and rejection
 * handlers remain attached to the detached promise, so a late settlement is
 * observed and cannot become an unhandled rejection or mutate caller state.
 */
export const waitForAbort = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(new OperationAbortedError(signal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new OperationAbortedError(signal.reason)));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

export interface AbortScope {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

/** Compose one owner signal with an absolute deadline and release all resources. */
export const createAbortScope = (
  owner: AbortSignal,
  deadlineMs: number,
  now: () => number = Date.now,
): AbortScope => {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const onOwnerAbort = (): void => controller.abort(owner.reason);
  const onDeadline = (): void => {
    if (disposed || controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new Error("run deadline reached"));
  };

  if (owner.aborted) onOwnerAbort();
  else owner.addEventListener("abort", onOwnerAbort, { once: true });
  const delayMs = Math.max(0, Math.min(2_147_483_647, deadlineMs - now()));
  const timer = setTimeout(onDeadline, delayMs);
  if (delayMs === 0) onDeadline();

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      owner.removeEventListener("abort", onOwnerAbort);
    },
  };
};

export const wasAborted = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || error instanceof OperationAbortedError;
