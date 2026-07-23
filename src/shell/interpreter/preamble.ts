/**
 * Guest preamble installer.
 *
 * Builds the JavaScript that runs in a fresh context before each cell. It wires
 * data globals and DSL shims to two host hooks: `__rlm_host` (async, returns a
 * promise) and `__rlm_effect` (sync, returns undefined). Keeping progress and
 * answer synchronous means they never leave unawaited bridge work behind.
 */

import type { CellGlobals } from "./backend.ts";

export const buildPreamble = (globals: CellGlobals): string => {
  const data = JSON.stringify({
    objective: globals.objective,
    inputs: globals.inputs,
    variables: globals.variables,
    budget: globals.budget,
    workspace: globals.workspace,
  });
  return `"use strict";
(() => {
  const HOST = globalThis.__rlm_host;
  const EFFECT = globalThis.__rlm_effect;
  delete globalThis.__rlm_host;
  delete globalThis.__rlm_effect;
  const DATA = ${data};
  const call = (name, args) =>
    HOST(name, JSON.stringify(args === undefined ? null : args)).then((s) => {
      const r = JSON.parse(s);
      if (r.ok) return r.value;
      const e = new Error((r.error && r.error.message) || "host error");
      if (r.error) {
        e.name = r.error.name || "RlmError";
        e.code = r.error.code;
        e.details = r.error.details;
        e.retryable = r.error.retryable;
      }
      throw e;
    });
  const effect = (name, args) => {
    EFFECT(name, JSON.stringify(args === undefined ? null : args));
  };
  const makeContextRef = (d) => {
    if (!d || typeof d !== "object" || typeof d.id !== "string") return d;
    return {
      id: d.id, label: d.label, bytes: d.bytes, estimatedTokens: d.estimatedTokens,
      tokenEstimator: d.tokenEstimator, mimeType: d.mimeType, sha256: d.sha256,
      read: (o) => call("context.read", { id: d.id, options: o || {} }),
      lines: (o) => call("context.lines", { id: d.id, options: o || {} }),
      grep: (o) => call("context.grep", { id: d.id, options: o || {} }),
      chunks: (o) =>
        call("context.chunks", { id: d.id, options: o || {} }).then((list) =>
          Array.isArray(list) ? list.map(makeContextRef) : list,
        ),
      provenance: () => call("context.provenance", { id: d.id }),
    };
  };
  Object.defineProperty(globalThis, "objective", { value: DATA.objective, enumerable: true });
  const inputsObj = {};
  const inputData = DATA.inputs && typeof DATA.inputs === "object" ? DATA.inputs : {};
  for (const k of Object.keys(inputData)) inputsObj[k] = makeContextRef(inputData[k]);
  Object.defineProperty(globalThis, "inputs", { value: Object.freeze(inputsObj), enumerable: true });
  const inputKeys = Object.keys(inputsObj);
  if (inputKeys.length === 1)
    Object.defineProperty(globalThis, "input", { value: inputsObj[inputKeys[0]], enumerable: true });
  for (const k of inputKeys) {
    if (!(k in globalThis)) {
      try {
        Object.defineProperty(globalThis, k, { value: inputsObj[k], enumerable: true });
      } catch {
        /* reserved or non-configurable: skip alias */
      }
    }
  }
  Object.defineProperty(globalThis, "variables", { value: Object.freeze(DATA.variables), enumerable: true });
  Object.defineProperty(globalThis, "budget", { value: Object.freeze(DATA.budget), enumerable: true });
  globalThis.workspace = DATA.workspace && typeof DATA.workspace === "object" ? DATA.workspace : {};
  globalThis.console = {
    log: (...a) => effect("console", { level: "log", args: a }),
    warn: (...a) => effect("console", { level: "warn", args: a }),
    error: (...a) => effect("console", { level: "error", args: a }),
  };
  const llm = (spec) => call("llm", spec);
  llm.batch = (spec) => call("llm.batch", spec);
  globalThis.llm = llm;
  globalThis.agent = (spec) => call("agent", spec);
  globalThis.recurse = (spec) => call("recurse", spec);
  globalThis.checkpoint = (spec) => call("checkpoint", spec);
  globalThis.phase = (name) => effect("phase", { name });
  globalThis.emit = (event) => effect("emit", event);
  globalThis.answer = (value) => effect("answer", { value });
  globalThis.contexts = {
    derive: (s) => call("contexts.derive", s).then(makeContextRef),
    concat: (s) => call("contexts.concat", s).then(makeContextRef),
    open: (id) => call("contexts.open", { id }).then(makeContextRef),
  };
  globalThis.artifacts = {
    write: (s) => call("artifacts.write", s),
    open: (id) => call("artifacts.open", { id }),
    asContext: (artifact, options) => call("artifacts.asContext", { artifact, options }).then(makeContextRef),
  };
  globalThis.tools = { call: (s) => call("tools.call", s) };
  // Non-determinism is withheld from the guest in v1.
  Object.defineProperty(globalThis, "Date", { value: undefined });
  if (globalThis.Math) globalThis.Math.random = () => { throw new Error("Math.random is disabled in pi-rlm cells"); };
})();
`;
};
