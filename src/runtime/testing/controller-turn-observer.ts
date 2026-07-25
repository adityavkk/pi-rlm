type ControllerTurnObserver = (controllerTurns: number) => void;

const observers = new WeakMap<AbortSignal, ControllerTurnObserver>();

export const registerControllerTurnObserverForTest = (
  signal: AbortSignal,
  observer: ControllerTurnObserver,
): (() => void) => {
  observers.set(signal, observer);
  return () => {
    if (observers.get(signal) === observer) observers.delete(signal);
  };
};

export const resolveControllerTurnObserver = (signal: AbortSignal): ControllerTurnObserver | undefined =>
  observers.get(signal);

export const notifyControllerTurnReserved = (
  observer: ControllerTurnObserver | undefined,
  controllerTurns: number,
): void => {
  try {
    observer?.(controllerTurns);
  } catch {
    // Test observation must not affect runtime behavior.
  }
};

export type { ControllerTurnObserver };
