/**
 * QuickJS interpreter backend (imperative shell).
 *
 * Validated bun-safe strategy (see .tmp/phase0-findings.md):
 *   - singlefile SYNC variant (wasm inlined; avoids bun cache subpath issues),
 *   - async host calls modeled with `ctx.newPromise()` deferreds,
 *   - a single drive loop owns all `executePendingJobs` pumping,
 *   - progress/answer are synchronous native functions (no unawaited work),
 *   - CPU interrupt via deadline, heap cap via memory limit, fresh runtime and
 *     context per cell, and strict alive-guarding so late callbacks are dropped.
 */

import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { type InterpreterError, type InterpreterErrorCode, interpreterError } from "../../core/errors.ts";
import type { JsonValue } from "../../core/json.ts";
import type { CellEvalOptions, CellEvalOutcome, InterpreterBackend } from "./backend.ts";
import { buildPreamble } from "./preamble.ts";

const WORKSPACE_READBACK = `(() => {
  const seen = new WeakSet();
  const bad = [];
  const check = (v, path) => {
    if (v === null) return;
    const t = typeof v;
    if (t === "function" || t === "undefined" || t === "symbol" || t === "bigint") { bad.push(path); return; }
    if (t === "number" && !isFinite(v)) { bad.push(path); return; }
    if (t === "object") {
      if (seen.has(v)) { bad.push(path); return; }
      seen.add(v);
      if (Array.isArray(v)) v.forEach((x, i) => check(x, path + "[" + i + "]"));
      else for (const k of Object.keys(v)) check(v[k], path + "." + k);
    }
  };
  const ws = globalThis.workspace;
  if (ws && typeof ws === "object" && !Array.isArray(ws)) for (const k of Object.keys(ws)) check(ws[k], k);
  else bad.push("<root>");
  return JSON.stringify({ bad, json: bad.length === 0 ? ws : {} });
})()`;

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

export class QuickJsBackend implements InterpreterBackend {
  readonly id = "quickjs-emscripten-core@0.32.0/singlefile-sync";

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
    const inflight = new Set<Promise<void>>();
    const outstanding = new Set<QuickJSDeferredPromise>();
    const track = (p: Promise<void>): void => {
      const wrapped = p.finally(() => inflight.delete(wrapped));
      inflight.add(wrapped);
    };

    const settle = (deferred: QuickJSDeferredPromise, payloadJson: string): void => {
      const payload = ctx.newString(payloadJson);
      deferred.resolve(payload);
      payload.dispose();
    };
    const hostFn = ctx.newFunction("__rlm_host", (nameHandle, argsHandle): QuickJSHandle => {
      const name = ctx.getString(nameHandle);
      const args = safeParse(ctx.getString(argsHandle));
      const deferred = ctx.newPromise();
      outstanding.add(deferred);
      track(
        options
          .dispatch(name, args)
          .then(
            (value) => {
              if (!alive) return;
              outstanding.delete(deferred);
              settle(deferred, JSON.stringify({ ok: true, value }));
            },
            (error: unknown) => {
              if (!alive) return;
              outstanding.delete(deferred);
              settle(deferred, JSON.stringify({ ok: false, error: normalizeError(error) }));
            },
          ),
      );
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

    const disableInterrupts = (): void => {
      try {
        runtime.setInterruptHandler(() => false);
      } catch {
        /* ignore */
      }
    };

    const finish = async (outcome: CellEvalOutcome): Promise<CellEvalOutcome> => {
      alive = false;
      disableInterrupts();
      // Settle any promise the guest left unawaited so the runtime can free it.
      // A fulfilled promise with no reactions is simply collected; leaving it
      // unsettled makes JS_FreeRuntime assert on a non-empty GC list.
      for (const deferred of outstanding) {
        try {
          settle(deferred, JSON.stringify({ ok: false, error: { name: "RlmError", message: "cell epoch closed" } }));
        } catch {
          /* ignore */
        }
      }
      outstanding.clear();
      try {
        runtime.executePendingJobs();
      } catch {
        /* ignore */
      }
      // Late host callbacks observe `alive === false` and no-op.
      await Promise.allSettled([...inflight]);
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

    // Install preamble (data globals + shims).
    const pre = ctx.evalCode(buildPreamble(options.globals), "preamble.js");
    if (pre.error) {
      const message = describe(ctx, pre.error);
      pre.error.dispose();
      return finish({ kind: "terminal", error: interpreterError("PARSE_ERROR", `preamble failed: ${message}`) });
    }
    pre.value.dispose();

    // Evaluate the cell IIFE (returns a promise handle).
    const evalRes = ctx.evalCode(options.source, "cell.js");
    if (evalRes.error) {
      const message = describe(ctx, evalRes.error);
      evalRes.error.dispose();
      return finish({ kind: "terminal", error: interpreterError(classify(message), message) });
    }
    const topHandle = evalRes.value;

    // Drive loop: centralized pumping until the cell promise settles.
    const readWorkspace = (): { workspace: JsonValue; invalid: string[] } => {
      const res = ctx.evalCode(WORKSPACE_READBACK, "workspace.js");
      if (res.error) {
        res.error.dispose();
        return { workspace: {}, invalid: ["<readback-error>"] };
      }
      const raw = ctx.getString(res.value);
      res.value.dispose();
      const parsed = safeParse(raw) as { bad?: string[]; json?: JsonValue };
      return { workspace: parsed.json ?? {}, invalid: parsed.bad ?? [] };
    };

    try {
      for (;;) {
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

        if (state.type !== "pending") {
          disableInterrupts();
          if (state.type === "rejected") {
            const rejMessage = errorMessage(ctx, state.error);
            const terminalCode = terminalFromGuestMessage(rejMessage);
            if (terminalCode) {
              state.error.dispose();
              topHandle.dispose();
              return finish({ kind: "terminal", error: interpreterError(terminalCode, rejMessage) });
            }
          }
          // Epoch closes when the cell promise settles. Any bridge work the
          // guest failed to await is a bug: fail the cell recoverably.
          if (inflight.size > 0) {
            if (state.type === "fulfilled") state.value.dispose();
            else state.error.dispose();
            const count = inflight.size;
            topHandle.dispose();
            const ws = readWorkspace();
            return finish({
              kind: "guest_error",
              message: `UNAWAITED_WORK: ${count} host call(s) were not awaited before the cell returned`,
              workspace: ws.workspace,
              workspaceInvalidPaths: ws.invalid,
            });
          }
          if (state.type === "fulfilled") {
            const result = toJson(ctx, state.value);
            state.value.dispose();
            topHandle.dispose();
            const ws = readWorkspace();
            return finish({
              kind: "value",
              result,
              hasResult: result !== undefined,
              workspace: ws.workspace,
              workspaceInvalidPaths: ws.invalid,
            });
          }
          const message = errorMessage(ctx, state.error);
          state.error.dispose();
          topHandle.dispose();
          const ws = readWorkspace();
          return finish({ kind: "guest_error", message, workspace: ws.workspace, workspaceInvalidPaths: ws.invalid });
        }

        if (inflight.size === 0) {
          disableInterrupts();
          topHandle.dispose();
          const ws = readWorkspace();
          return finish({
            kind: "guest_error",
            message: "cell promise did not settle and no host work is pending",
            workspace: ws.workspace,
            workspaceInvalidPaths: ws.invalid,
          });
        }
        await Promise.race([...inflight]);
        if (Date.now() >= options.deadlineMs) {
          disableInterrupts();
          topHandle.dispose();
          return finish({ kind: "terminal", error: interpreterError("CPU_LIMIT", "cell exceeded deadline") });
        }
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

const normalizeError = (error: unknown): { name: string; message: string; code?: string } => {
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; message?: unknown; code?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : String(error),
      ...(typeof e.code === "string" ? { code: e.code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
};

const toJson = (ctx: QuickJSContext, handle: QuickJSHandle): JsonValue | undefined => {
  try {
    const dumped = ctx.dump(handle) as unknown;
    if (dumped === undefined) return undefined;
    return JSON.parse(JSON.stringify(dumped)) as JsonValue;
  } catch {
    return undefined;
  }
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
