/** Internal per-lease effect scheduler. Filesystem and runtime ownership live elsewhere. */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RunWriterSchedulerHooks {
  readonly preFence: () => void | PromiseLike<void>;
  readonly postFence: () => void | PromiseLike<void>;
  /** Must be safe to retry after an ambiguous failure. */
  readonly releaseTransition: () => void | PromiseLike<void>;
}

export type RunWriterSchedulerErrorCode =
  | "WRITER_SCHEDULER_CLOSED"
  | "WRITER_SCHEDULER_LOCK_ORDER"
  | "WRITER_SCHEDULER_SELF_RELEASE"
  | "WRITER_SCHEDULER_MANAGEMENT";

export class RunWriterSchedulerError extends Error {
  override readonly name: string = "RunWriterSchedulerError";

  constructor(readonly code: RunWriterSchedulerErrorCode, message: string) {
    super(message);
  }
}

export class RunWriterSchedulerManagementError extends RunWriterSchedulerError {
  override readonly name: string = "RunWriterSchedulerManagementError";

  constructor(
    readonly phase: "pre-fence" | "nested-effect" | "post-fence" | "release-transition",
    readonly managementError: unknown,
    readonly effectFailed: boolean,
    readonly effectError: unknown,
  ) {
    super("WRITER_SCHEDULER_MANAGEMENT", `writer scheduler management failed during ${phase}`);
    this.cause = managementError;
  }

  override readonly cause: unknown;
}

interface WriterScope {
  readonly scheduler: RunWriterScheduler;
  readonly children: Array<Promise<Attempt<unknown>>>;
  open: boolean;
}

type Attempt<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown };

const writerScope = new AsyncLocalStorage<WriterScope>();
const invoke = async <T>(effect: () => T | PromiseLike<T>): Promise<T> => effect();
const attempt = async <T>(effect: () => T | PromiseLike<T>): Promise<Attempt<T>> => {
  try {
    return { status: "fulfilled", value: await effect() };
  } catch (error) {
    return { status: "rejected", error };
  }
};

export class RunWriterScheduler {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  private released = false;
  private releaseInFlight: Promise<void> | undefined;
  private terminalInFlight: Promise<unknown> | undefined;
  private terminalPrepared = false;

  constructor(private readonly hooks: RunWriterSchedulerHooks) {}

  /** Filesystem adapters use inline nesting because their operation promise is always awaited by the owner shell. */
  runOwnedOperation<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    const inherited = writerScope.getStore();
    if (inherited?.open) {
      if (inherited.scheduler !== this) {
        return Promise.reject(new RunWriterSchedulerError(
          "WRITER_SCHEDULER_LOCK_ORDER",
          "cannot enter a different writer scheduler from an open writer scope",
        ));
      }
      return invoke(effect);
    }
    return this.run(effect);
  }

  run<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    const inherited = writerScope.getStore();
    if (inherited?.open) {
      if (inherited.scheduler !== this) {
        return Promise.reject(new RunWriterSchedulerError(
          "WRITER_SCHEDULER_LOCK_ORDER",
          "cannot enter a different writer scheduler from an open writer scope",
        ));
      }
      const child = invoke(effect);
      inherited.children.push(attempt(() => child));
      return child;
    }
    if (!this.accepting) {
      return Promise.reject(new RunWriterSchedulerError(
        "WRITER_SCHEDULER_CLOSED",
        "writer scheduler no longer accepts effects",
      ));
    }
    return this.enqueue(() => this.runQueued(effect));
  }

  /** Drain admitted work, fence once, then run an intentional terminal path transition without a post-fence. */
  terminal<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    const inherited = writerScope.getStore();
    if (inherited?.open && inherited.scheduler !== this) {
      return Promise.reject(new RunWriterSchedulerError(
        "WRITER_SCHEDULER_LOCK_ORDER",
        "cannot terminate a writer scheduler from a different open writer scope",
      ));
    }
    this.accepting = false;
    if (inherited?.open) {
      return Promise.reject(new RunWriterSchedulerError(
        "WRITER_SCHEDULER_SELF_RELEASE",
        "cannot terminate a writer scheduler from its own open scope",
      ));
    }
    if (this.released)
      return Promise.reject(new RunWriterSchedulerError("WRITER_SCHEDULER_CLOSED", "writer scheduler is already closed"));
    if (this.releaseInFlight)
      return Promise.reject(new RunWriterSchedulerError("WRITER_SCHEDULER_CLOSED", "writer release is already in flight"));
    if (this.terminalInFlight) return this.terminalInFlight as Promise<T>;

    const transition = this.enqueue(() => this.runTerminalQueued(effect));
    const tracked = transition.then(
      (value) => {
        this.released = true;
        this.terminalInFlight = undefined;
        return value;
      },
      (error: unknown) => {
        this.terminalInFlight = undefined;
        throw error;
      },
    );
    this.terminalInFlight = tracked;
    return tracked;
  }

  release(): Promise<void> {
    const inherited = writerScope.getStore();
    if (inherited?.open && inherited.scheduler !== this) {
      return Promise.reject(new RunWriterSchedulerError(
        "WRITER_SCHEDULER_LOCK_ORDER",
        "cannot release a writer scheduler from a different open writer scope",
      ));
    }
    this.accepting = false;
    if (inherited?.open) {
      return Promise.reject(new RunWriterSchedulerError(
        "WRITER_SCHEDULER_SELF_RELEASE",
        "cannot release a writer scheduler from its own open scope",
      ));
    }
    if (this.released) return Promise.resolve();
    if (this.terminalInFlight)
      return Promise.reject(new RunWriterSchedulerError("WRITER_SCHEDULER_CLOSED", "writer terminal transition is already in flight"));
    if (this.releaseInFlight) return this.releaseInFlight;

    const transition = this.enqueue(async () => {
      const result = await attempt(this.hooks.releaseTransition);
      if (result.status === "rejected") {
        throw new RunWriterSchedulerManagementError(
          "release-transition", result.error, false, undefined,
        );
      }
    });
    const tracked = transition.then(
      () => {
        this.released = true;
        this.releaseInFlight = undefined;
      },
      (error: unknown) => {
        this.releaseInFlight = undefined;
        throw error;
      },
    );
    this.releaseInFlight = tracked;
    return tracked;
  }

  private enqueue<T>(effect: () => Promise<T>): Promise<T> {
    const result = this.tail.then(effect);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runTerminalQueued<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    if (!this.terminalPrepared) {
      const before = await attempt(this.hooks.preFence);
      if (before.status === "rejected")
        throw new RunWriterSchedulerManagementError("pre-fence", before.error, false, undefined);
      this.terminalPrepared = true;
    }

    const scope: WriterScope = { scheduler: this, children: [], open: true };
    let effectResult: Attempt<T>;
    const childErrors: unknown[] = [];
    try {
      effectResult = await writerScope.run(scope, () => attempt(effect));
      for (let index = 0; index < scope.children.length; index++) {
        const child = await scope.children[index] as Attempt<unknown>;
        if (child.status === "rejected") childErrors.push(child.error);
      }
    } finally { scope.open = false; }
    if (effectResult.status === "rejected" && childErrors.length === 0) throw effectResult.error;
    if (effectResult.status === "rejected") {
      throw new RunWriterSchedulerManagementError(
        "nested-effect",
        childErrors.length === 1 ? childErrors[0] : new AggregateError(childErrors, "nested writer effects failed"),
        true,
        effectResult.error,
      );
    }
    if (childErrors.length === 1) throw childErrors[0];
    if (childErrors.length > 1) throw new AggregateError(childErrors, "nested writer effects failed");
    return effectResult.value;
  }

  private async runQueued<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    const before = await attempt(this.hooks.preFence);
    if (before.status === "rejected") {
      throw new RunWriterSchedulerManagementError("pre-fence", before.error, false, undefined);
    }

    const scope: WriterScope = { scheduler: this, children: [], open: true };
    let effectResult: Attempt<T>;
    const childErrors: unknown[] = [];
    try {
      effectResult = await writerScope.run(scope, () => attempt(effect));
      for (let index = 0; index < scope.children.length; index++) {
        const child = await scope.children[index] as Attempt<unknown>;
        if (child.status === "rejected") childErrors.push(child.error);
      }
    } finally {
      scope.open = false;
    }

    const primaryFailed = effectResult.status === "rejected" || childErrors.length > 0;
    const primaryError = effectResult.status === "rejected" ? effectResult.error : childErrors[0];
    const after = await attempt(this.hooks.postFence);
    if (after.status === "rejected") {
      throw new RunWriterSchedulerManagementError(
        "post-fence", after.error, primaryFailed, primaryError,
      );
    }
    if (effectResult.status === "rejected" && childErrors.length > 0) {
      throw new RunWriterSchedulerManagementError(
        "nested-effect",
        childErrors.length === 1 ? childErrors[0] : new AggregateError(childErrors, "nested writer effects failed"),
        true,
        effectResult.error,
      );
    }
    if (effectResult.status === "rejected") throw effectResult.error;
    if (childErrors.length === 1) throw childErrors[0];
    if (childErrors.length > 1) throw new AggregateError(childErrors, "nested writer effects failed");
    return effectResult.value;
  }
}
