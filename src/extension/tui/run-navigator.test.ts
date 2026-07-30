import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ManagedRunListing } from "../../runtime/run-retention.ts";
import {
  createRunCoordinator,
  type CoordinatedRun,
} from "../run-coordinator.ts";
import {
  cancelLocalRun,
  resolveInspectionRunName,
  routeRlmCommand,
} from "../run-command.ts";
import {
  projectRunNavigatorRows,
  renderRunNavigator,
  RunNavigator,
  RUN_NAVIGATOR_MAX_LOCAL,
  RUN_NAVIGATOR_MAX_MANAGED,
} from "./run-navigator.ts";

const name = (digit: string): string => `run-${digit.repeat(32)}`;
const runId = (digit: string): string => `run_${digit.repeat(64)}`;

const retained = (digit: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: name(digit),
  path: `/private/guest/${digit}/SECRET_PATH`,
  bytes: 42,
  activity: "inactive",
  metadata: {
    schemaVersion: 1,
    status: "completed",
    owner: digit.repeat(32),
    createdAtMs: 1,
    updatedAtMs: 2,
    runId: runId(digit),
    terminalAtMs: 2,
  },
  ...overrides,
});

const listing = (runs: unknown[]): ManagedRunListing => ({
  root: "/private/SECRET_ROOT",
  runs,
  issues: [],
  scannedBytes: 0,
  scannedEntries: 0,
}) as ManagedRunListing;

const active = (localId: string, digit: string): CoordinatedRun => ({
  localId,
  runName: name(digit),
  runId: runId(digit),
  sessionId: "SECRET_SESSION",
  authorizationGeneration: 0,
  objectivePreview: "\u001b]8;;file:///SECRET_PATH\u0007hostile guest objective",
  state: "running",
});

const flush = async (): Promise<void> => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
};

describe("run navigator", () => {
  test("routes management forms before launch parsing and validates exact targets", () => {
    expect(routeRlmCommand("runs")).toEqual({ kind: "runs" });
    expect(routeRlmCommand(`inspect ${name("a")}`)).toEqual({ kind: "inspect", target: name("a") });
    expect(routeRlmCommand("cancel rlm_local")).toEqual({ kind: "cancel", target: "rlm_local" });
    expect(routeRlmCommand("inspect ../../tmp/run-a")).toEqual({ kind: "inspect", target: "../../tmp/run-a" });
    expect(routeRlmCommand("runs extra")).toEqual({ kind: "invalid-management" });
    expect(routeRlmCommand('{"objective":"runs"}').kind).toBe("launch");

    const coordinator = createRunCoordinator({ createLocalId: () => "rlm_local", createControlToken: () => "t".repeat(32) });
    coordinator.setSession("session", 0);
    const owned = coordinator.create({ sessionId: "session", authorizationGeneration: 0, objective: "hidden" });
    owned.bindRunName(name("a"));
    owned.bindRunId(runId("a"));
    expect(resolveInspectionRunName(name("b"), coordinator)).toBe(name("b"));
    expect(resolveInspectionRunName("rlm_local", coordinator)).toBe(name("a"));
    expect(resolveInspectionRunName(runId("a"), coordinator)).toBeUndefined();
    expect(resolveInspectionRunName("../../run-a", coordinator)).toBeUndefined();

    expect(cancelLocalRun(name("a"), coordinator).ok).toBe(false);
    expect(cancelLocalRun(runId("a"), coordinator).ok).toBe(false);
    expect(owned.signal.aborted).toBe(false);
    expect(cancelLocalRun("rlm_local", coordinator)).toMatchObject({ ok: true, requested: true });
    expect(owned.signal.aborted).toBe(true);
  });

  test("combines bounded active and managed metadata without guest text or paths", () => {
    const locals = Array.from({ length: RUN_NAVIGATOR_MAX_LOCAL + 5 }, (_, index) =>
      active(`rlm_${String(index).padStart(2, "0")}`, (index % 10).toString(16)));
    const managed = [
      retained("a"),
      retained("b", { name: "run-\u001b[31mHOSTILE", path: "/SECRET_2" }),
      ...Array.from({ length: RUN_NAVIGATOR_MAX_MANAGED - 2 }, (_, index) => retained((index % 10).toString(16))),
    ];
    const rows = projectRunNavigatorRows(locals, listing(managed));
    expect(rows.length).toBeLessThanOrEqual(RUN_NAVIGATOR_MAX_LOCAL + RUN_NAVIGATOR_MAX_MANAGED);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("objective");
    expect(serialized).not.toContain("session");
    expect(rows.some((row) => row.source === "local+managed" && row.activity === "owned")).toBe(true);

    for (const width of [50, 80, 120, 180]) {
      const lines = renderRunNavigator({ rows, selected: rows.length - 1 }, width);
      expect(lines.length).toBeLessThanOrEqual(14);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("SECRET");
    }
  });

  test("supports arrows, enter, refresh, and idempotent cleanup", async () => {
    const results: unknown[] = [];
    let renders = 0;
    let reloads = 0;
    const rows = projectRunNavigatorRows([], listing([retained("a"), retained("b")]));
    const component = new RunNavigator(rows, (result) => results.push(result), () => { renders += 1; }, async () => {
      reloads += 1;
      return projectRunNavigatorRows([], listing([retained("c")]));
    });
    component.handleInput("r");
    await flush();
    expect(reloads).toBe(1);
    expect(renders).toBeGreaterThan(1);
    expect(component.render(80).join("\n")).toContain("run #cccccccc");
    component.handleInput("\r");
    expect(results).toEqual([{ type: "inspect", runName: name("c") }]);
    component.handleInput("\u001b");
    expect(results).toHaveLength(1);
    component.dispose();
    component.dispose();
    expect(component.render(80)).toEqual([]);
  });

  test("rejects controls, malformed reserved routes, proxies, and accessors without invoking traps", () => {
    for (const input of ["run\u200bthis", "runs/extra", "inspect:bad", "cancel\nrlm_local"])
      expect(routeRlmCommand(input)).toEqual({ kind: "invalid-management" });
    expect(routeRlmCommand("runner objective")).toEqual({ kind: "launch", args: "runner objective" });

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "localId", {
      enumerable: true, get() { getterCalls += 1; return "rlm_bad"; },
    });
    const hostileListing = new Proxy(listing([retained("a")]), { get() { throw new Error("trap"); } });
    expect(() => projectRunNavigatorRows([accessor as CoordinatedRun], hostileListing)).not.toThrow();
    expect(projectRunNavigatorRows([accessor as CoordinatedRun], hostileListing)).toEqual([]);
    expect(getterCalls).toBe(0);
    const oversized = listing(Array.from({ length: RUN_NAVIGATOR_MAX_MANAGED + 1 }, () => retained("a")));
    expect(projectRunNavigatorRows([], oversized)).toEqual([]);
  });

  test("abort closes once and disposal removes the abort listener", () => {
    const controller = new AbortController();
    const results: unknown[] = [];
    const component = new RunNavigator([], (result) => results.push(result), () => {}, undefined, controller.signal);
    controller.abort();
    controller.abort();
    expect(results).toEqual([{ type: "close" }]);
    component.dispose();
    component.dispose();
  });
});
