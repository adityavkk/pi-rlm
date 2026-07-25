import { describe, expect, test } from "bun:test";
import { assertPackedSmokeLifecycle, expectedProjection } from "./smoke-packed-install-parser.mjs";

const metadata = {
  runId: null,
  status: "failed",
  mode: null,
  output: null,
  usage: null,
  warningCodes: [],
  truncation: { truncated: false, originalBytes: 0, omittedBytes: 0 },
  errorCode: "RLM_SOURCE_REQUIRED",
};

const fixture = () => {
  const header = { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/fixture" };
  const state = {
    type: "thinking_level_change",
    id: "state-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.500Z",
    thinkingLevel: "off",
  };
  const custom = {
    type: "custom",
    customType: "pi-rlm-result",
    data: metadata,
    id: "entry-1",
    parentId: "state-1",
    timestamp: "2026-01-01T00:00:01.000Z",
  };
  const message = {
    role: "custom",
    customType: "pi-rlm-result",
    content: JSON.stringify(expectedProjection),
    display: true,
    details: metadata,
    timestamp: 1,
  };
  const durable = {
    type: "custom_message",
    customType: "pi-rlm-result",
    content: message.content,
    display: true,
    details: metadata,
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:02.000Z",
  };
  const jsonl = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  return {
    records: [header, { type: "entry_appended", entry: custom }, { type: "message_start", message }, { type: "message_end", message }],
    output: jsonl([header, { type: "entry_appended", entry: custom }, { type: "message_start", message }, { type: "message_end", message }]),
    session: jsonl([header, state, custom, durable]),
    jsonl,
  };
};

describe("packed smoke exact lifecycle parser", () => {
  test("accepts one exact result lifecycle with durable custom entries", () => {
    const value = fixture();
    expect(() => assertPackedSmokeLifecycle({
      outputRaw: value.output,
      stderrRaw: "",
      sessionRaw: value.session,
      caseName: "test",
    })).not.toThrow();
  });

  test("rejects duplicate starts, result prose, and provider lifecycle records", () => {
    const duplicate = fixture();
    duplicate.records.splice(3, 0, duplicate.records[2]);
    expect(() => assertPackedSmokeLifecycle({
      outputRaw: duplicate.jsonl(duplicate.records), stderrRaw: "", sessionRaw: duplicate.session, caseName: "test",
    })).toThrow(/duplicate, missing, or unexpected/);

    const prose = fixture();
    (prose.records[2] as any).message.content = "failed: RLM_SOURCE_REQUIRED";
    expect(() => assertPackedSmokeLifecycle({
      outputRaw: prose.jsonl(prose.records), stderrRaw: "", sessionRaw: prose.session, caseName: "test",
    })).toThrow(/arbitrary prose/);

    const provider = fixture();
    provider.records.push({ type: "agent_start" });
    expect(() => assertPackedSmokeLifecycle({
      outputRaw: provider.jsonl(provider.records), stderrRaw: "", sessionRaw: provider.session, caseName: "test",
    })).toThrow(/unexpected lifecycle/);
  });
});

describe("packed smoke Pi arguments", () => {
  const argsFor = (caseName: string): string[] => {
    const script = `${process.cwd()}/scripts/smoke-packed-install-args.sh`;
    const child = Bun.spawnSync([
      "bash", "-c",
      'source "$1"; build_pi_args "$2" /worktree /session.jsonl; printf "%s\\0" "${pi_args[@]}"',
      "test", script, caseName,
    ]);
    expect(child.exitCode).toBe(0);
    return child.stdout.toString().split("\0").filter(Boolean);
  };

  test("direct loads the worktree entry explicitly", () => {
    const args = argsFor("direct");
    expect(args).toContain("--no-extensions");
    expect(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2)).toEqual(["-e", "/worktree/index.ts"]);
    expect(args.at(-1)).toBe("/rlm");
  });

  test("installed relies on settings discovery without -e", () => {
    const args = argsFor("installed");
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--no-extensions");
    expect(args.at(-1)).toBe("/rlm");
  });
});
