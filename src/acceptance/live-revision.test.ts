import { describe, expect, test } from "bun:test";
import { verifyLiveRepositoryRevision } from "./live-revision.ts";

const commit = "a".repeat(40);

describe("live suite revision binding", () => {
  test("accepts one exact clean revision with separately verified dependency pins", () => {
    const calls: string[][] = [];
    let dependencyChecks = 0;
    verifyLiveRepositoryRevision(commit, {
      git: (args) => { calls.push([...args]); return args[0] === "rev-parse" ? commit : ""; },
      verifyDependencies: () => { dependencyChecks += 1; },
    });
    expect(calls).toEqual([
      ["diff", "--quiet", "HEAD", "--"],
      ["rev-parse", "--verify", "HEAD"],
    ]);
    expect(dependencyChecks).toBe(1);
  });

  test("rejects a dirty tree, changed revision, and dependency drift", () => {
    expect(() => verifyLiveRepositoryRevision(commit, {
      git: (args) => { if (args[0] === "diff") throw new Error("dirty"); return commit; },
      verifyDependencies: () => {},
    })).toThrow(/clean pinned/);
    expect(() => verifyLiveRepositoryRevision(commit, {
      git: (args) => args[0] === "rev-parse" ? "b".repeat(40) : "",
      verifyDependencies: () => {},
    })).toThrow(/revision changed/);
    expect(() => verifyLiveRepositoryRevision(commit, {
      git: (args) => args[0] === "rev-parse" ? commit : "",
      verifyDependencies: () => { throw new Error("drift"); },
    })).toThrow(/clean pinned/);
  });
});
