/**
 * QuickJS interpreter backend (imperative shell).
 *
 * Validated bun-safe strategy (see docs/PHASE0-FINDINGS.md):
 *   - singlefile SYNC variant (wasm inlined; avoids bun cache subpath issues),
 *   - async host calls modeled with `ctx.newPromise()` deferreds,
 *   - a single drive loop owns all `executePendingJobs` pumping,
 *   - progress/answer are synchronous native functions (no unawaited work),
 *   - CPU interrupt plus a host wall timer, heap cap, fresh runtime and context
 *     per cell, and strict epoch/alive guards so late callbacks are dropped.
 */

import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  ERROR_DETAIL_MAX_LENGTH,
  ERROR_MESSAGE_MAX_LENGTH,
  type CallErrorDetails,
  type InterpreterError,
  type InterpreterErrorCode,
  interpreterError,
  normalizeCallErrorDetails,
} from "../../core/errors.ts";
import type { JsonValue } from "../../core/json.ts";
import type { CellEvalOptions, CellEvalOutcome, InterpreterBackend } from "./backend.ts";
import { buildPreamble } from "./preamble.ts";

const RESULT_READBACK = `(() => {
  const stringify = JSON.stringify;
  return (value) => {
    const json = stringify(value);
    return json === undefined ? "" : json;
  };
})()`;

const WORKSPACE_READBACK = `(() => {
  const arrayIsArray = Array.isArray;
  const objectKeys = Object.keys;
  const stringify = JSON.stringify;
  const WeakSetCtor = WeakSet;
  return () => {
    const seen = new WeakSetCtor();
    const bad = [];
    const check = (v, path) => {
      if (v === null) return;
      const t = typeof v;
      if (t === "function" || t === "undefined" || t === "symbol" || t === "bigint") { bad.push(path); return; }
      if (t === "number" && !isFinite(v)) { bad.push(path); return; }
      if (t === "object") {
        if (seen.has(v)) { bad.push(path); return; }
        seen.add(v);
        if (arrayIsArray(v)) v.forEach((x, i) => check(x, path + "[" + i + "]"));
        else for (const k of objectKeys(v)) check(v[k], path + "." + k);
      }
    };
    const ws = globalThis.workspace;
    if (ws && typeof ws === "object" && !arrayIsArray(ws)) for (const k of objectKeys(ws)) check(ws[k], k);
    else bad.push("<root>");
    return stringify({ bad, json: bad.length === 0 ? ws : {} });
  };
})()`;

const EPOCH_CLOSED_PAYLOAD = JSON.stringify({ ok: false, error: { name: "RlmError", message: "cell epoch closed" } });

const classify = (message: string): InterpreterErrorCode => {
  const m = message.toLowerCase();
  if (m.includes("interrupt")) return "CPU_LIMIT";
  if (m.includes("out of memory") || m.includes("memory")) return "HEAP_LIMIT";
  if (m.includes("stack")) return "CPU_LIMIT";
  return "UNHANDLED_REJECTION";
};

// A guest promise rejection is normally recoverable, but an interrupt or
// out-of-memory surfaces as a rejection too and must escalate to terminal.
const terminalFromGuestMessage = (message: string): InterpreterErrorCode | undefined => {
  const m = message.toLowerCase();
  if (m.includes("interrupt")) return "CPU_LIMIT";
  if (m.includes("out of memory")) return "HEAP_LIMIT";
  return undefined;
};

interface WorkspaceReadback {
  readonly workspace: JsonValue;
  readonly invalid: string[];
}

type Readback<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: InterpreterError };

export class QuickJsBackend implements InterpreterBackend {
  readonly id = "quickjs-emscripten-core/singlefile-sync";
  readonly version = "0.32.0";

  private constructor(private readonly module: QuickJSWASMModule) {}

  static async create(): Promise<QuickJsBackend> {
    const module = await newQuickJSWASMModuleFromVariant(variant as never);
    return new QuickJsBackend(module);
  }

  async evalCell(options: CellEvalOptions): Promise<CellEvalOutcome> {
    const runtime: QuickJSRuntime = this.module.newRuntime();
    runtime.setMemoryLimit(options.memoryBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(options.deadlineMs));
    const ctx: QuickJSContext = runtime.newContext();

    let alive = true;
    let epochOpen = true;
    let deadlineFired = false;
    let ownerAborted = options.signal?.aborted ?? false;
    let resultReader: QuickJSHandle | undefined;
    let workspaceReader: QuickJSHandle | undefined;
    const cellAbort = new AbortController();
    const inflight = new Set<Promise<void>>();
    const outstanding = new Set<QuickJSDeferredPromise>();

    const settle = (deferred: QuickJSDeferredPromise, payloadJson: string): void => {
      const payload = ctx.newString(payloadJson);
      try {
        deferred.resolve(payload);
      } finally {
        payload.dispose();
      }
    };

    const closeEpoch = (reason: Error): void => {
      if (!epochOpen) return;
      epochOpen = false;
      cellAbort.abort(reason);
      for (const deferred of outstanding) {
        try {
          settle(deferred, EPOCH_CLOSED_PAYLOAD);
        } catch {
          // If allocation or resolution failed, release all three deferred
          // handles rather than leaving an unsettled promise in the runtime.
          deferred.dispose();
        }
      }
      outstanding.clear();
    };

    let wakeStop!: () => void;
    const stop = new Promise<void>((resolve) => {
      wakeStop = resolve;
    });
    const fireDeadline = (): void => {
      if (deadlineFired) return;
      deadlineFired = true;
      closeEpoch(new Error("cell exceeded deadline"));
      wakeStop();
    };
    const fireOwnerAbort = (): void => {
      if (ownerAborted && !epochOpen) return;
      ownerAborted = true;
      closeEpoch(new Error("cell owner cancelled"));
      wakeStop();
    };
    const ownerAbortListener = (): void => fireOwnerAbort();
    if (options.signal && !options.signal.aborted) options.signal.addEventListener("abort", ownerAbortListener, { once: true });
    else if (options.signal?.aborted) fireOwnerAbort();

    const delayMs = Math.max(0, Math.min(2_147_483_647, options.deadlineMs - Date.now()));
    const deadlineTimer = setTimeout(fireDeadline, delayMs);
    const deadlineExceeded = (): boolean => {
      if (!deadlineFired && Date.now() >= options.deadlineMs) fireDeadline();
      return deadlineFired;
    };

    const finish = (outcome: CellEvalOutcome): CellEvalOutcome => {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", ownerAbortListener);
      closeEpoch(new Error("cell epoch closed"));
      alive = false;
      // Propagate closed-epoch rejections while the deadline interrupt remains
      // installed. Cleanup jobs therefore cannot create an unbounded second
      // execution window.
      try {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) jobs.error.dispose();
      } catch {
        /* interrupted or already terminal */
      }
      for (const handle of [resultReader, workspaceReader]) {
        try {
          handle?.dispose();
        } catch {
          /* already disposed */
        }
      }
      inflight.clear();
      try {
        ctx.dispose();
      } catch {
        /* ignore */
      }
      try {
        runtime.dispose();
      } catch {
        /* ignore */
      }
      return outcome;
    };

    if (ownerAborted) return finish({ kind: "terminal", error: interpreterError("DISPOSED", "cell owner cancelled") });

    const completeDeferred = (deferred: QuickJSDeferredPromise, payloadJson: string): void => {
      if (!alive || !epochOpen || !outstanding.has(deferred)) return;
      try {
        settle(deferred, payloadJson);
      } catch {
        deferred.dispose();
      } finally {
        outstanding.delete(deferred);
      }
    };

    const hostFn = ctx.newFunction("__rlm_host", (nameHandle, argsHandle): QuickJSHandle => {
      const deferred = ctx.newPromise();
      if (!epochOpen) {
        settle(deferred, EPOCH_CLOSED_PAYLOAD);
        return deferred.handle;
      }

      const name = ctx.getString(nameHandle);
      const args = safeParse(ctx.getString(argsHandle));
      outstanding.add(deferred);
      let operation!: Promise<void>;
      operation = (async () => {
        try {
          const value = await options.dispatch(name, args, cellAbort.signal, options.deadlineMs);
          let payloadJson: string;
          try {
            payloadJson = JSON.stringify({ ok: true, value });
          } catch (error) {
            payloadJson = JSON.stringify({ ok: false, error: normalizeError(error) });
          }
          completeDeferred(deferred, payloadJson);
        } catch (error) {
          completeDeferred(deferred, JSON.stringify({ ok: false, error: normalizeError(error) }));
        }
      })()
        .catch(() => {
          // Bridge completion must never become an unhandled host rejection.
        })
        .finally(() => inflight.delete(operation));
      inflight.add(operation);
      return deferred.handle;
    });
    hostFn.consume((f) => ctx.setProp(ctx.global, "__rlm_host", f));

    const effectFn = ctx.newFunction("__rlm_effect", (nameHandle, argsHandle): void => {
      const name = ctx.getString(nameHandle);
      const args = safeParse(ctx.getString(argsHandle));
      try {
        options.effect(name, args);
      } catch {
        // Effects must never break the guest; drop failures.
      }
    });
    effectFn.consume((f) => ctx.setProp(ctx.global, "__rlm_effect", f));

    // Install preamble (data globals + shims).
    const pre = ctx.evalCode(buildPreamble(options.globals), "preamble.js");
    if (pre.error) {
      const message = describe(ctx, pre.error);
      pre.error.dispose();
      return finish({ kind: "terminal", error: interpreterError(classify(message), `preamble failed: ${message}`) });
    }
    pre.value.dispose();

    // Capture serialization intrinsics before the cell can replace built-ins.
    const resultReaderResult = ctx.evalCode(RESULT_READBACK, "result-reader.js");
    if (resultReaderResult.error) {
      const message = describe(ctx, resultReaderResult.error);
      resultReaderResult.error.dispose();
      return finish({ kind: "terminal", error: interpreterError(classify(message), `result reader failed: ${message}`) });
    }
    resultReader = resultReaderResult.value;
    const workspaceReaderResult = ctx.evalCode(WORKSPACE_READBACK, "workspace-reader.js");
    if (workspaceReaderResult.error) {
      const message = describe(ctx, workspaceReaderResult.error);
      workspaceReaderResult.error.dispose();
      return finish({ kind: "terminal", error: interpreterError(classify(message), `workspace reader failed: ${message}`) });
    }
    workspaceReader = workspaceReaderResult.value;

    // Evaluate the cell IIFE (returns a promise handle).
    const evalRes = ctx.evalCode(options.source, "cell.js");
    if (evalRes.error) {
      const message = describe(ctx, evalRes.error);
      evalRes.error.dispose();
      return finish({ kind: "terminal", error: interpreterError(classify(message), message) });
    }
    const topHandle = evalRes.value;

    const readResult = (handle: QuickJSHandle): Readback<{ result: JsonValue | undefined; hasResult: boolean }> => {
      const res = ctx.callFunction(resultReader!, ctx.undefined, handle);
      if (res.error) {
        const message = describe(ctx, res.error);
        res.error.dispose();
        const terminalCode = terminalFromGuestMessage(message);
        if (terminalCode || deadlineExceeded()) {
          return { ok: false, error: interpreterError(terminalCode ?? "CPU_LIMIT", `result readback failed: ${message}`) };
        }
        return { ok: true, value: { result: undefined, hasResult: false } };
      }
      try {
        const raw = ctx.getString(res.value);
        if (raw.length === 0) return { ok: true, value: { result: undefined, hasResult: false } };
        return { ok: true, value: { result: JSON.parse(raw) as JsonValue, hasResult: true } };
      } catch (error) {
        return { ok: false, error: interpreterError("UNHANDLED_REJECTION", `result readback failed: ${String(error)}`) };
      } finally {
        res.value.dispose();
      }
    };

    const readWorkspace = (): Readback<WorkspaceReadback> => {
      const res = ctx.callFunction(workspaceReader!, ctx.undefined);
      if (res.error) {
        const message = describe(ctx, res.error);
        res.error.dispose();
        const code = deadlineExceeded() ? "CPU_LIMIT" : classify(message);
        return { ok: false, error: interpreterError(code, `workspace readback failed: ${message}`) };
      }
      try {
        const parsed = JSON.parse(ctx.getString(res.value)) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid readback envelope");
        const record = parsed as { bad?: unknown; json?: unknown };
        if (!Array.isArray(record.bad) || !record.bad.every((path) => typeof path === "string")) throw new Error("invalid readback paths");
        return { ok: true, value: { workspace: (record.json ?? {}) as JsonValue, invalid: record.bad } };
      } catch (error) {
        return { ok: false, error: interpreterError("UNHANDLED_REJECTION", `workspace readback failed: ${String(error)}`) };
      } finally {
        res.value.dispose();
      }
    };

    try {
      for (;;) {
        if (ownerAborted) {
          topHandle.dispose();
          return finish({ kind: "terminal", error: interpreterError("DISPOSED", "cell owner cancelled") });
        }
        if (deadlineExceeded()) {
          topHandle.dispose();
          return finish({ kind: "terminal", error: interpreterError("CPU_LIMIT", "cell exceeded deadline") });
        }

        let state = ctx.getPromiseState(topHandle);
        // Only pump while still pending. Pumping a settled (possibly interrupted)
        // promise near the deadline re-triggers the interrupt and corrupts the
        // runtime, so we never call executePendingJobs after settlement.
        if (state.type === "pending") {
          const jobs = runtime.executePendingJobs();
          if (jobs.error) {
            const message = describe(ctx, jobs.error);
            jobs.error.dispose();
            topHandle.dispose();
            return finish({ kind: "terminal", error: interpreterError(classify(message), message) });
          }
          state = ctx.getPromiseState(topHandle);
        }

        if (ownerAborted || deadlineExceeded()) {
          if (state.type === "fulfilled") state.value.dispose();
          else if (state.type === "rejected") state.error.dispose();
          topHandle.dispose();
          return finish({
            kind: "terminal",
            error: ownerAborted
              ? interpreterError("DISPOSED", "cell owner cancelled")
              : interpreterError("CPU_LIMIT", "cell exceeded deadline"),
          });
        }

        if (state.type !== "pending") {
          if (state.type === "rejected") {
            const rejMessage = errorMessage(ctx, state.error);
            const terminalCode = terminalFromGuestMessage(rejMessage);
            if (terminalCode) {
              state.error.dispose();
              topHandle.dispose();
              return finish({ kind: "terminal", error: interpreterError(terminalCode, rejMessage) });
            }
          }

          // Epoch closes before attacker-controlled result/workspace traversal.
          // Getter-triggered bridge calls are rejected without host dispatch.
          const unawaitedCount = inflight.size;
          closeEpoch(new Error("cell epoch closed"));
          if (unawaitedCount > 0) {
            if (state.type === "fulfilled") state.value.dispose();
            else state.error.dispose();
            topHandle.dispose();
            const ws = readWorkspace();
            if (!ws.ok) return finish({ kind: "terminal", error: ws.error });
            return finish({
              kind: "guest_error",
              message: `UNAWAITED_WORK: ${unawaitedCount} host call(s) were not awaited before the cell returned`,
              workspace: ws.value.workspace,
              workspaceInvalidPaths: ws.value.invalid,
            });
          }

          if (state.type === "fulfilled") {
            const result = readResult(state.value);
            state.value.dispose();
            topHandle.dispose();
            if (!result.ok) return finish({ kind: "terminal", error: result.error });
            const ws = readWorkspace();
            if (!ws.ok) return finish({ kind: "terminal", error: ws.error });
            return finish({
              kind: "value",
              result: result.value.result,
              hasResult: result.value.hasResult,
              workspace: ws.value.workspace,
              workspaceInvalidPaths: ws.value.invalid,
            });
          }

          const message = errorMessage(ctx, state.error);
          state.error.dispose();
          topHandle.dispose();
          const ws = readWorkspace();
          if (!ws.ok) return finish({ kind: "terminal", error: ws.error });
          return finish({ kind: "guest_error", message, workspace: ws.value.workspace, workspaceInvalidPaths: ws.value.invalid });
        }

        if (inflight.size === 0) {
          closeEpoch(new Error("cell epoch closed"));
          topHandle.dispose();
          const ws = readWorkspace();
          if (!ws.ok) return finish({ kind: "terminal", error: ws.error });
          return finish({
            kind: "guest_error",
            message: "cell promise did not settle and no host work is pending",
            workspace: ws.value.workspace,
            workspaceInvalidPaths: ws.value.invalid,
          });
        }
        await Promise.race([stop, ...inflight]);
      }
    } catch (error) {
      try {
        topHandle.dispose();
      } catch {
        /* already disposed */
      }
      return finish({ kind: "terminal", error: interpreterError("WORKER_EXIT", String(error)) });
    }
  }

  async dispose(): Promise<void> {
    // The module has no disposable runtime once per-cell runtimes are freed.
  }
}

const safeParse = (json: string): JsonValue => {
  try {
    return JSON.parse(json) as JsonValue;
  } catch {
    return null;
  }
};

interface NormalizedBridgeError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly details?: CallErrorDetails;
}

const ownData = (value: object, key: string): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

const primitiveMessage = (value: unknown): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return value;
    case "number":
    case "boolean":
    case "bigint":
    case "undefined": return String(value);
    case "symbol": return value.description ?? "symbol";
    default: return "host call failed";
  }
};

const normalizeError = (error: unknown): NormalizedBridgeError => {
  if (!error || typeof error !== "object") {
    return { name: "Error", message: primitiveMessage(error).slice(0, ERROR_MESSAGE_MAX_LENGTH) };
  }
  const name = ownData(error, "name");
  const message = ownData(error, "message");
  const code = ownData(error, "code");
  const retryable = ownData(error, "retryable");
  const details = normalizeCallErrorDetails(ownData(error, "details"));
  return {
    name: (typeof name === "string" ? name : "Error").slice(0, ERROR_DETAIL_MAX_LENGTH),
    message: (typeof message === "string" ? message : "host call failed").slice(0, ERROR_MESSAGE_MAX_LENGTH),
    ...(typeof code === "string" ? { code: code.slice(0, ERROR_DETAIL_MAX_LENGTH) } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(details ? { details } : {}),
  };
};

const errorMessage = (ctx: QuickJSContext, handle: QuickJSHandle): string => {
  try {
    const dumped = ctx.dump(handle) as unknown;
    if (dumped && typeof dumped === "object") {
      const e = dumped as { message?: unknown; name?: unknown };
      const name = typeof e.name === "string" ? e.name : "Error";
      const message = typeof e.message === "string" ? e.message : JSON.stringify(dumped);
      return `${name}: ${message}`;
    }
    return String(dumped);
  } catch {
    return "unknown guest error";
  }
};

const describe = (ctx: QuickJSContext, handle: QuickJSHandle): string => errorMessage(ctx, handle);
