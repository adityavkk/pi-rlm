# Phase 0 interpreter findings (validated 2026-07)

- Runtime: bun 1.3.11, node 24, quickjs-emscripten(-core) 0.32.0.
- Bun cannot resolve the `@jitl/quickjs-wasmfile-*` self-referential `/emscripten-module`
  dynamic import from its global cache path. Use the singlefile variant instead.
- Chosen variant: `@jitl/quickjs-singlefile-mjs-release-sync` (wasm inlined as base64).
- Asyncify (`newAsyncifiedFunction` + `newQuickJSAsyncWASMModuleFromVariant`) deadlocks /
  produces no output under bun. Do NOT use Asyncify.
- Portable async bridge (validated, result 33): SYNC variant + `ctx.newPromise()` deferreds.
  Host resolves the deferred later; a driver loop pumps `rt.executePendingJobs()` and awaits
  tracked in-flight host promises until the guest promise settles.
- Lifecycle rule: each cell owns an epoch and `AbortSignal`. A real host timer closes the
  epoch at the wall deadline, aborts host work, settles guest deferreds, and wakes the job
  driver. Cleanup never waits for host promises; late callbacks observe the closed/alive
  guards and never touch disposed QuickJS handles.
- Cell cancellation propagates through recursive frames, controller calls, nested cell
  evaluation, model calls, and abortable semaphore waiters. Runtime ownership (in-flight
  identity, logical-call reservation, token reservation, and semaphore permit) detaches
  before the cancelled call returns. External work that ignores `AbortSignal` may continue
  outside runtime ownership, but its late fulfillment or rejection cannot commit or cache.
- Keep the deadline interrupt installed through result serialization, workspace readback,
  closed-epoch job pumping, and disposal. Proxy traps and getters run during readback.
- CPU interrupt via `shouldInterruptAfterDeadline` works on the sync runtime.
- Memory limit via `rt.setMemoryLimit` works.
