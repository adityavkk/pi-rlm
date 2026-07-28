import { describe, expect, test } from "bun:test";
import type { RuntimeComponentIdentity } from "../core/identity.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import {
  CONTROLLER_RESUME_CAPABILITY_VERSION,
  inspectControllerResumeCapability,
  requireControllerResumeCapability,
  type ControllerDriver,
} from "./controller.ts";
import { MockController } from "./mock-controller.ts";
import { ModelController } from "./model-controller.ts";

const identity: RuntimeComponentIdentity = {
  id: "test/controller-resume-model",
  version: "1",
  configuration: {},
};
const boundary = { frameId: "run_test:f0", nextIteration: 3, trajectoryLength: 2 };

describe("controller resume capability contract", () => {
  test("ModelController declares exact trajectory-derived v1 state", () => {
    const controller = new ModelController(new MockModelClient(() => "unused", identity));
    const resumed = requireControllerResumeCapability(controller);
    expect(resumed.identity).toEqual({
      version: CONTROLLER_RESUME_CAPABILITY_VERSION,
      strategy: "trajectory-derived",
    });
    const state = resumed.capability.capture(boundary);
    expect(state).toEqual({ nextIteration: 3 });
    expect(() => resumed.capability.validate(state, boundary)).not.toThrow();
    expect(() => resumed.capability.restore(state, boundary)).not.toThrow();
    expect(() => resumed.capability.restore({ nextIteration: 2 }, boundary)).toThrow();
  });

  test("state-token drivers restore their private cursor while unsupported drivers remain explicit", async () => {
    const original = new MockController([
      { reasoning: "first", code: "1" },
      { reasoning: "second", code: "2" },
    ]);
    await original.next({} as never);
    const token = requireControllerResumeCapability(original).capability.capture({ ...boundary, nextIteration: 2 });
    const fresh = new MockController([
      { reasoning: "first", code: "1" },
      { reasoning: "second", code: "2" },
    ]);
    requireControllerResumeCapability(fresh).capability.restore(token, { ...boundary, nextIteration: 2 });
    expect(await fresh.next({} as never)).toEqual({ reasoning: "second", code: "2" });

    const unsupported: ControllerDriver = {
      identity: { id: "test/unsupported", version: "1", configuration: {} },
      async next() { return { reasoning: "unused", code: "" }; },
      fork() { return this; },
    };
    expect(inspectControllerResumeCapability(unsupported)).toBeUndefined();
    expect(() => requireControllerResumeCapability(unsupported)).toThrow();
  });

  test("rejects capability accessors without invoking them", () => {
    let getterCalls = 0;
    const capability = {
      strategy: "state-token",
      capture: () => null,
      validate: () => {},
      restore: () => {},
    } as Record<string, unknown>;
    Object.defineProperty(capability, "version", {
      enumerable: true,
      get: () => { getterCalls++; return CONTROLLER_RESUME_CAPABILITY_VERSION; },
    });
    const hostile: ControllerDriver = {
      identity: { id: "test/hostile-capability", version: "1", configuration: {} },
      resumeCapability: capability as never,
      async next() { return { reasoning: "unused", code: "" }; },
      fork() { return this; },
    };
    expect(() => inspectControllerResumeCapability(hostile)).toThrow("capability.version must be an own data property");
    expect(getterCalls).toBe(0);
  });
});
