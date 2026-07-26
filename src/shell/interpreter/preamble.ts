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

  // Capture every intrinsic used by bridge serialization before guest code can
  // replace globals or prototypes. Snapshot through data descriptors so getters
  // never run, and track guest-created Proxies so their traps never run either.
  const SAFE_STRINGIFY = JSON.stringify;
  const SAFE_PARSE = JSON.parse;
  const ARRAY_IS_ARRAY = Array.isArray;
  const NUMBER_IS_FINITE = Number.isFinite;
  const NUMBER_FROM = Number;
  const HAS_OWN = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const IS_ARRAY_INDEX = Function.prototype.call.bind(RegExp.prototype.test, /^(0|[1-9][0-9]*)$/);
  const GET_DESCRIPTORS = Object.getOwnPropertyDescriptors;
  const OWN_KEYS = Reflect.ownKeys;
  const OBJECT_CREATE = Object.create;
  const OBJECT_DEFINE = Object.defineProperty;
  const OBJECT_FREEZE = Object.freeze;
  const OBJECT_SET_PROTOTYPE = Object.setPrototypeOf;
  const NativeProxy = globalThis.Proxy;
  const ProxySet = new WeakSet();
  const StackSet = new WeakSet();
  const WEAK_ADD = Function.prototype.call.bind(WeakSet.prototype.add);
  const WEAK_HAS = Function.prototype.call.bind(WeakSet.prototype.has);
  const WEAK_DELETE = Function.prototype.call.bind(WeakSet.prototype.delete);
  const GuestProxy = function(target, handler) {
    const proxy = new NativeProxy(target, handler);
    WEAK_ADD(ProxySet, proxy);
    return proxy;
  };
  GuestProxy.revocable = (target, handler) => {
    const pair = NativeProxy.revocable(target, handler);
    WEAK_ADD(ProxySet, pair.proxy);
    return pair;
  };
  OBJECT_FREEZE(GuestProxy);
  OBJECT_DEFINE(globalThis, "Proxy", { value: GuestProxy, writable: false, configurable: false });

  const invalidJson = () => { throw "invalid JSON payload"; };
  const cloneJson = (value) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return NUMBER_IS_FINITE(value) ? value : invalidJson();
    if (typeof value !== "object") return invalidJson();
    if (WEAK_HAS(ProxySet, value) || WEAK_HAS(StackSet, value)) return invalidJson();
    WEAK_ADD(StackSet, value);
    try {
      const descriptors = GET_DESCRIPTORS(value);
      const keys = OWN_KEYS(descriptors);
      if (ARRAY_IS_ARRAY(value)) {
        const lengthDescriptor = descriptors.length;
        if (!lengthDescriptor || !HAS_OWN(lengthDescriptor, "value")) return invalidJson();
        const length = lengthDescriptor.value;
        const clone = [];
        OBJECT_SET_PROTOTYPE(clone, null);
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string" || !IS_ARRAY_INDEX(key) || NUMBER_FROM(key) >= length) return invalidJson();
          const descriptor = descriptors[key];
          if (!descriptor || !HAS_OWN(descriptor, "value")) return invalidJson();
        }
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !HAS_OWN(descriptor, "value")) return invalidJson();
          clone[index] = cloneJson(descriptor.value);
        }
        return clone;
      }
      const clone = OBJECT_CREATE(null);
      for (const key of keys) {
        if (typeof key !== "string") return invalidJson();
        const descriptor = descriptors[key];
        if (!descriptor || !HAS_OWN(descriptor, "value") || !descriptor.enumerable) return invalidJson();
        OBJECT_DEFINE(clone, key, { value: cloneJson(descriptor.value), enumerable: true });
      }
      return clone;
    } finally {
      WEAK_DELETE(StackSet, value);
    }
  };
  const snapshotJson = (value) => {
    const json = SAFE_STRINGIFY(cloneJson(value));
    if (json === undefined) return invalidJson();
    SAFE_PARSE(json);
    return json;
  };

  const DATA = ${data};
  const call = (name, args) =>
    HOST(name, SAFE_STRINGIFY(args === undefined ? null : args)).then((s) => {
      const r = SAFE_PARSE(s);
      if (r.ok) return r.value;
      const e = new Error((r.error && r.error.message) || "host error");
      if (r.error) {
        e.name = typeof r.error.name === "string" ? r.error.name : "RlmError";
        if (typeof r.error.code === "string") e.code = r.error.code;
        if (typeof r.error.retryable === "boolean") e.retryable = r.error.retryable;
        const d = r.error.details;
        if (d && typeof d === "object" && !Array.isArray(d)) {
          const details = {};
          if (typeof d.stopReason === "string") details.stopReason = d.stopReason;
          if (typeof d.provider === "string") details.provider = d.provider;
          if (typeof d.model === "string") details.model = d.model;
          const u = d.usage;
          if (u && typeof u === "object" && !Array.isArray(u)
            && typeof u.attempts === "number" && typeof u.durationMs === "number") {
            const usage = { attempts: u.attempts, durationMs: u.durationMs };
            for (const k of ["inputTokens", "outputTokens", "totalTokens", "costUsd"])
              if (typeof u[k] === "number") usage[k] = u[k];
            details.usage = usage;
          }
          if (Object.keys(details).length > 0) e.details = details;
        }
      }
      throw e;
    });
  const effect = (name, args) => {
    let payload = "";
    try {
      payload = snapshotJson(args === undefined ? null : args);
    } catch {
      // Still report invalid answer attempts so exactly-one counting cannot be
      // bypassed. The host parses the impossible empty payload as invalid.
    }
    EFFECT(name, payload);
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
  // Non-determinism is withheld from the guest in v1.
  Object.defineProperty(globalThis, "Date", { value: undefined });
  if (globalThis.Math) globalThis.Math.random = () => { throw new Error("Math.random is disabled in pi-rlm cells"); };
})();
`;
};
