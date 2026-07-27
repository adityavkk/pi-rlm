import { describe, expect, test } from "bun:test";
import { JournalAppendError } from "../shell/journal-store.ts";
import {
  RunWriterScheduler,
  RunWriterSchedulerError,
  RunWriterSchedulerManagementError,
  type RunWriterSchedulerHooks,
} from "./run-writer-scheduler.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const passHooks = (overrides: Partial<RunWriterSchedulerHooks> = {}): RunWriterSchedulerHooks => ({
  async preFence() {}, async postFence() {}, async releaseTransition() {}, ...overrides,
});
const rejection = async (promise: Promise<unknown>): Promise<{ readonly caught: boolean; readonly error: unknown }> => {
  try {
    await promise;
    return { caught: false, error: undefined };
  } catch (error) {
    return { caught: true, error };
  }
};
const turn = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const eventLoopTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("RunWriterScheduler", () => {
  test("runs sibling fences FIFO and advances after fulfillment or rejection", async () => {
    const log: string[] = [];
    const firstGate = deferred<void>();
    const scheduler = new RunWriterScheduler(passHooks({
      async preFence() { log.push("pre"); },
      async postFence() { log.push("post"); },
    }));
    const injected = { failure: "second" };
    const first = scheduler.run(async () => {
      log.push("effect-1-start");
      await firstGate.promise;
      log.push("effect-1-end");
      return 1;
    });
    const second = scheduler.run(async () => { log.push("effect-2"); throw injected; });
    const third = scheduler.run(async () => { log.push("effect-3"); return 3; });
    await turn();
    expect(log).toEqual(["pre", "effect-1-start"]);
    firstGate.resolve();
    expect(await first).toBe(1);
    expect((await rejection(second)).error).toBe(injected);
    expect(await third).toBe(3);
    expect(log).toEqual([
      "pre", "effect-1-start", "effect-1-end", "post",
      "pre", "effect-2", "post",
      "pre", "effect-3", "post",
    ]);
  });

  test("executes awaited same-scheduler nesting inline with one JournalStore-style fence", async () => {
    const log: string[] = [];
    const scheduler = new RunWriterScheduler(passHooks({
      async preFence() { log.push("pre"); },
      async postFence() { log.push("post"); },
    }));
    const result = await scheduler.run(async () => {
      log.push("outer-start");
      const nested = await scheduler.run(async () => { log.push("append"); return 41; });
      log.push("outer-end");
      return nested + 1;
    });
    expect(result).toBe(42);
    expect(log).toEqual(["pre", "outer-start", "append", "outer-end", "post"]);
  });

  test("rejects cross-lease nesting without poisoning either scheduler", async () => {
    const first = new RunWriterScheduler(passHooks());
    const second = new RunWriterScheduler(passHooks());
    const observed = await first.run(async () => rejection(second.run(async () => "unreachable")));
    expect(observed.caught).toBe(true);
    expect(observed.error).toBeInstanceOf(RunWriterSchedulerError);
    expect((observed.error as RunWriterSchedulerError).code).toBe("WRITER_SCHEDULER_LOCK_ORDER");
    expect(await second.run(async () => "recovered")).toBe("recovered");
    const reverse = await second.run(async () => rejection(first.run(async () => "unreachable")));
    expect((reverse.error as RunWriterSchedulerError).code).toBe("WRITER_SCHEDULER_LOCK_ORDER");
    expect(await first.run(async () => "also-recovered")).toBe("also-recovered");
  });

  test("closed inherited scope queues detached work instead of bypassing a sibling", async () => {
    const detachedGate = deferred<void>();
    const siblingGate = deferred<void>();
    const siblingStarted = deferred<void>();
    const log: string[] = [];
    const scheduler = new RunWriterScheduler(passHooks());
    let detached!: Promise<string>;
    await scheduler.run(async () => {
      detached = (async () => {
        await detachedGate.promise;
        return scheduler.run(async () => { log.push("detached"); return "done"; });
      })();
    });
    const sibling = scheduler.run(async () => {
      log.push("sibling-start");
      siblingStarted.resolve();
      await siblingGate.promise;
      log.push("sibling-end");
    });
    await siblingStarted.promise;
    detachedGate.resolve();
    await turn();
    expect(log).toEqual(["sibling-start"]);
    siblingGate.resolve();
    await sibling;
    expect(await detached).toBe("done");
    expect(log).toEqual(["sibling-start", "sibling-end", "detached"]);
  });

  test("preserves exact object, JournalAppendError, primitive, undefined, and synchronous effect failures", async () => {
    const scheduler = new RunWriterScheduler(passHooks());
    const journal = new JournalAppendError("event", true, new Error("disk"));
    const failures: unknown[] = [{ marker: true }, journal, "primitive", 0, null, undefined];
    for (const failure of failures) {
      const result = await rejection(scheduler.run(() => { throw failure; }));
      expect(result.caught).toBe(true);
      expect(result.error).toBe(failure);
    }
    expect(await scheduler.run(async () => "advanced")).toBe("advanced");
  });

  test("post-fence management failure retains an unchanged effectError", async () => {
    const effectError = new JournalAppendError("event", false, new Error("effect"));
    const managementError = { failure: "post" };
    const scheduler = new RunWriterScheduler(passHooks({
      async postFence() { throw managementError; },
    }));
    const result = await rejection(scheduler.run(async () => { throw effectError; }));
    expect(result.error).toBeInstanceOf(RunWriterSchedulerManagementError);
    const error = result.error as RunWriterSchedulerManagementError;
    expect(error.code).toBe("WRITER_SCHEDULER_MANAGEMENT");
    expect(error.phase).toBe("post-fence");
    expect(error.managementError).toBe(managementError);
    expect(error.cause).toBe(managementError);
    expect(error.effectFailed).toBe(true);
    expect(error.effectError).toBe(effectError);
  });

  test("release closes admission synchronously, drains accepted work, and coalesces", async () => {
    const workGate = deferred<void>();
    const workStarted = deferred<void>();
    const log: string[] = [];
    let transitions = 0;
    const scheduler = new RunWriterScheduler(passHooks({
      async releaseTransition() { transitions++; log.push("release"); },
    }));
    const first = scheduler.run(async () => {
      log.push("first-start"); workStarted.resolve(); await workGate.promise; log.push("first-end");
    });
    const second = scheduler.run(async () => { log.push("second"); });
    await workStarted.promise;
    const released = scheduler.release();
    const coalesced = scheduler.release();
    expect(coalesced).toBe(released);
    const denied = await rejection(scheduler.run(async () => { log.push("late"); }));
    expect((denied.error as RunWriterSchedulerError).code).toBe("WRITER_SCHEDULER_CLOSED");
    expect(log).toEqual(["first-start"]);
    workGate.resolve();
    await Promise.all([first, second, released, coalesced]);
    expect(log).toEqual(["first-start", "first-end", "second", "release"]);
    expect(transitions).toBe(1);
    await scheduler.release();
    expect(transitions).toBe(1);
  });

  test("failed release remains closed and a later release retries the transition", async () => {
    const injected = { failure: "release" };
    let attempts = 0;
    const scheduler = new RunWriterScheduler(passHooks({
      async releaseTransition() { if (++attempts === 1) throw injected; },
    }));
    const first = scheduler.release();
    expect(scheduler.release()).toBe(first);
    const failed = await rejection(first);
    expect(failed.error).toBeInstanceOf(RunWriterSchedulerManagementError);
    expect((failed.error as RunWriterSchedulerManagementError).managementError).toBe(injected);
    const denied = await rejection(scheduler.run(async () => "late"));
    expect((denied.error as RunWriterSchedulerError).code).toBe("WRITER_SCHEDULER_CLOSED");
    await scheduler.release();
    expect(attempts).toBe(2);
    await scheduler.release();
    expect(attempts).toBe(2);
  });

  test("self-release rejects without deadlock and leaves transition retryable", async () => {
    let transitions = 0;
    const scheduler = new RunWriterScheduler(passHooks({
      async releaseTransition() { transitions++; },
    }));
    const result = await scheduler.run(async () => rejection(scheduler.release()));
    expect(result.error).toBeInstanceOf(RunWriterSchedulerError);
    expect((result.error as RunWriterSchedulerError).code).toBe("WRITER_SCHEDULER_SELF_RELEASE");
    expect(transitions).toBe(0);
    const denied = await rejection(scheduler.run(async () => "late"));
    expect((denied.error as RunWriterSchedulerError).code).toBe("WRITER_SCHEDULER_CLOSED");
    await scheduler.release();
    expect(transitions).toBe(1);
  });

  test("assimilates a reentrant custom thenable inside the open writer scope", async () => {
    const log: string[] = [];
    const scheduler = new RunWriterScheduler(passHooks({
      preFence() { log.push("pre"); }, postFence() { log.push("post"); },
    }));
    const result = await scheduler.run((): PromiseLike<number> => ({
      then(resolve, reject) {
        return scheduler.run(() => { log.push("nested"); return 42; }).then(resolve, reject);
      },
    }));
    expect(result).toBe(42);
    expect(log).toEqual(["pre", "nested", "post"]);
  });

  test("drains dynamically added unawaited descendants before post-fence and the next sibling", async () => {
    const gate = deferred<void>();
    const grandchildStarted = deferred<void>();
    const log: string[] = [];
    const scheduler = new RunWriterScheduler(passHooks({
      postFence() { log.push("post"); },
    }));
    const outer = scheduler.run(() => {
      void scheduler.run(() => {
        log.push("child");
        void scheduler.run(async () => {
          log.push("grandchild-start"); grandchildStarted.resolve(); await gate.promise; log.push("grandchild-end");
        });
      });
      log.push("outer-end");
    });
    const sibling = scheduler.run(() => { log.push("sibling"); });
    await grandchildStarted.promise;
    await turn();
    expect(log).toEqual(["child", "grandchild-start", "outer-end"]);
    gate.resolve();
    await Promise.all([outer, sibling]);
    expect(log).toEqual(["child", "grandchild-start", "outer-end", "grandchild-end", "post", "sibling", "post"]);
  });

  test("combines nested failure with an exact outer error and observes unawaited rejection", async () => {
    const outerError = new JournalAppendError("event", true, new Error("outer"));
    const childError = { child: true };
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const scheduler = new RunWriterScheduler(passHooks());
      const result = await rejection(scheduler.run(async () => {
        void scheduler.run(async () => { throw childError; });
        throw outerError;
      }));
      expect(result.error).toBeInstanceOf(RunWriterSchedulerManagementError);
      const error = result.error as RunWriterSchedulerManagementError;
      expect(error.phase).toBe("nested-effect");
      expect(error.managementError).toBe(childError);
      expect(error.effectError).toBe(outerError);
      await eventLoopTurn();
      await eventLoopTurn();
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", listener); }
  });

  test("does not swallow undefined hook failures or undefined effect with post failure", async () => {
    for (const phase of ["pre", "post", "release"] as const) {
      const scheduler = new RunWriterScheduler(passHooks({
        preFence() { if (phase === "pre") throw undefined; },
        postFence: () => phase === "post" ? Promise.reject(undefined) : undefined,
        releaseTransition() { if (phase === "release") throw undefined; },
      }));
      const result = phase === "release"
        ? await rejection(scheduler.release())
        : await rejection(scheduler.run(() => "effect"));
      expect(result.error).toBeInstanceOf(RunWriterSchedulerManagementError);
      expect((result.error as RunWriterSchedulerManagementError).managementError).toBeUndefined();
    }
    const postFailure = { post: true };
    const scheduler = new RunWriterScheduler(passHooks({ postFence() { throw postFailure; } }));
    const combined = await rejection(scheduler.run(() => { throw undefined; }));
    expect(combined.error).toBeInstanceOf(RunWriterSchedulerManagementError);
    expect((combined.error as RunWriterSchedulerManagementError).effectFailed).toBe(true);
    expect((combined.error as RunWriterSchedulerManagementError).effectError).toBeUndefined();
  });

  test("cross-lease release rejects without closing the target", async () => {
    const first = new RunWriterScheduler(passHooks());
    const second = new RunWriterScheduler(passHooks());
    const result = await first.run(() => rejection(second.release()));
    expect((result.error as RunWriterSchedulerError).code).toBe("WRITER_SCHEDULER_LOCK_ORDER");
    expect(await second.run(() => "still-open")).toBe("still-open");
    await Promise.all([first.release(), second.release()]);
  });
});
