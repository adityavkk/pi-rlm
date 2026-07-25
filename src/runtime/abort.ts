/** Abort-aware ownership helpers for work that may ignore AbortSignal. */

export class OperationAbortedError extends Error {
  constructor() {
    super("operation aborted");
    this.name = "OperationAbortedError";
  }
}

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new OperationAbortedError();
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
    return Promise.reject(new OperationAbortedError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new OperationAbortedError()));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

export const wasAborted = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || error instanceof OperationAbortedError;
