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
- Lifecycle rule: guard every `executePendingJobs()` with an alive check and drain in-flight
  host work before disposing context/runtime, or a late `.finally` pump hits UseAfterFree.
- CPU interrupt via `shouldInterruptAfterDeadline` works on the sync runtime.
- Memory limit via `rt.setMemoryLimit` works.
