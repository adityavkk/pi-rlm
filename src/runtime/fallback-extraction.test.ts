import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import type { RlmEvent } from "../core/journal.ts";
import { canonicalStringify } from "../core/json.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { QuickJsBackend } from "../shell/interpreter/quickjs.ts";
import type { ModelResponse } from "../shell/model/client.ts";
import { MockModelClient } from "../shell/model/mock.ts";
import { buildExtractorEvidence, isSubstantiveJsonEvidence } from "./extractor-evidence.ts";
import { FunctionExtractor, type ExtractorEvidenceProjection } from "./index.ts";
import { MockController } from "./mock-controller.ts";
import { DEFAULT_PROFILE, type Profile } from "./profile.ts";
import { runProgram } from "./run.ts";

const modelIdentity = (fixture: string) => ({ id: "test/mock-model-handler", version: "1", configuration: { fixture } } as const);
const extractorIdentity = (fixture: string) => ({
  closure: { id: "test/extractor-closure", version: "1", configuration: { fixture } },
  configuration: { fixture },
  modelRoute: "test/model",
  providerPrompt: { id: "test/extractor-prompt", version: "1", configuration: { fixture } },
} as const);

let backend: QuickJsBackend;
beforeAll(async () => { backend = await QuickJsBackend.create(); });

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-fallback-"));
const events = async (dir: string): Promise<RlmEvent[]> => {
  const { JournalStore } = await import("../shell/journal-store.ts");
  const result = await new JournalStore(dir).readEvents();
  if (!result.ok) throw result.error;
  return result.value;
};

const terminals = (events: readonly RlmEvent[]): RlmEvent[] => events.filter((event) =>
  event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled");

const program = (withInput = true): RlmProgram => {
  const normalized = normalizeProgram({
    objective: "extract a typed answer",
    profile: "default",
    inputs: withInput ? [{ name: "context", adapter: "text", description: "bounded source" }] : [],
    outputs: [{ name: "answer", schema: { type: "string" } }],
  });
  if (!normalized.ok) throw new Error("invalid test program");
  return normalized.value;
};

const boundedProfile = (overrides: Partial<Profile> = {}): Profile => ({
  ...DEFAULT_PROFILE,
  maxControllerTurns: 1,
  extractorEvidenceMaxBytes: 8 * 1024,
  extractorValueMaxBytes: 256,
  extractorValuesMaxBytes: 1024,
  extractorHandleHeadBytes: 32,
  extractorHandleTailBytes: 32,
  ...overrides,
});

const response = (text: string): ModelResponse => ({
  text,
  usage: { attempts: 1, inputTokens: 5, outputTokens: 3, totalTokens: 8, durationMs: 4 },
});

describe("bounded fallback extraction", () => {
  test("invalid extractor schema uses direct validation and never commits", async () => {
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, backend, dir,
      controller: new MockController([{ reasoning: "invalid direct", code: "answer({ answer: 7 })" }]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:60")), signal: new AbortController().signal,
      profile: boundedProfile(),
      extractor: new FunctionExtractor((evidence) => {
        expect(evidence.answerCandidates[0]?.value).toEqual({ answer: 7 });
        return {
          ok: true,
          value: { answer: 7 },
          evidenceRefs: [evidence.answerCandidates[0]!.evidenceId!],
        };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:62")),
    });

    expect(result).toMatchObject({ status: "failed", error: { code: "INVALID_RESULT" } });
    const journal = await events(dir);
    const directError = journal.find((event) => event.type === "cell_committed")?.error;
    expect(result.error?.message).toBe(directError?.message);
    expect(journal.filter((event) => event.type === "answer_committed")).toHaveLength(0);
    expect(terminals(journal)).toHaveLength(1);
  });

  test("schema-valid synthesized output without evidenceRefs never commits", async () => {
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "represented" }, backend, dir,
      controller: new MockController([]), model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:84")),
      signal: new AbortController().signal, profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor((() => ({
        ok: true,
        value: { answer: "fabricated" },
      })) as never, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:86")),
    });

    expect(result).toMatchObject({ status: "failed", error: { code: "INVALID_RESULT" } });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "fallback_evidence_cited")).toHaveLength(0);
    expect(journal.filter((event) => event.type === "answer_committed")).toHaveLength(0);
  });

  test("empty, duplicate, and unknown evidenceRefs are rejected", async () => {
    for (const kind of ["empty", "duplicate", "unknown"] as const) {
      const dir = await tmp();
      const result = await runProgram({
        program: program(), sources: { context: "represented" }, backend, dir,
        controller: new MockController([]), model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:103")),
        signal: new AbortController().signal, profile: boundedProfile({ maxControllerTurns: 0 }),
        extractor: new FunctionExtractor((evidence) => {
          const represented = evidence.handles[0]!.evidenceId!;
          const evidenceRefs = kind === "empty"
            ? []
            : kind === "duplicate"
              ? [represented, represented]
              : [`ev_${"0".repeat(64)}`];
          return { ok: true, value: { answer: "fabricated" }, evidenceRefs };
        }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:105")),
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "INVALID_RESULT" } });
      expect((await events(dir)).some((event) => event.type === "answer_committed")).toBe(false);
    }
  });

  test("oversized invalid candidate is omitted before exact workspace recovery", async () => {
    let seen: ExtractorEvidenceProjection | undefined;
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, backend, dir,
      controller: new MockController([{
        reasoning: "leave exact recoverable evidence",
        code: "workspace.recovery = 'represented-workspace'; answer({ answer: 42, padding: 'p'.repeat(2000) })",
      }]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:129")), signal: new AbortController().signal,
      profile: boundedProfile({ extractorValueMaxBytes: 128 }),
      extractor: new FunctionExtractor((evidence) => {
        seen = evidence;
        const recovery = evidence.workspaceValues.find((item) => item.key === "recovery");
        if (!recovery) throw new Error("missing recovery evidence");
        return {
          ok: true,
          value: { answer: String(recovery.value) },
          evidenceRefs: [recovery.evidenceId!],
        };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:131")),
    });

    expect(result).toMatchObject({
      status: "completed", completionMode: "fallback_extract", answer: { answer: "represented-workspace" },
    });
    expect(seen?.answerCandidates).toHaveLength(0);
    expect(seen?.workspaceValues).toContainEqual(expect.objectContaining({
      key: "recovery", value: "represented-workspace", exact: true, required: false, bytes: 23,
      evidenceId: expect.stringMatching(/^ev_[a-f0-9]{64}$/),
    }));
    expect(seen?.omittedAnswerCandidates).toBe(1);
    expect(seen?.omittedBytes).toBeGreaterThan(2000);
    const metadata = (await events(dir)).find((event) => event.type === "fallback_evidence_projected");
    expect(metadata).toMatchObject({ type: "fallback_evidence_projected", truncated: true, omittedItems: 1 });
  });

  test("required workspace handle truncation fails before extractor work", async () => {
    let calls = 0;
    const result = await runProgram({
      program: program(), sources: { context: `required:${"r".repeat(20_000)}` }, backend, dir: await tmp(),
      controller: new MockController([{
        reasoning: "mark the output handle required",
        code: "workspace.answer = { contextId: variables.context.id }",
      }]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:165")), signal: new AbortController().signal,
      profile: boundedProfile(),
      extractor: new FunctionExtractor(() => {
        calls++;
        return { ok: false, code: "FAILED", message: "must not run" };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:167")),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "FALLBACK_EVIDENCE_TRUNCATED" },
      ledger: { usage: { logicalCalls: 0, attempts: 0 } },
    });
    expect(calls).toBe(0);
  });

  test("schema and descriptor metadata without substantive evidence fail before extraction", async () => {
    let calls = 0;
    const result = await runProgram({
      program: program(false), sources: {}, backend, dir: await tmp(), controller: new MockController([]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:185")), signal: new AbortController().signal,
      profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => {
        calls++;
        return { ok: false, code: "FAILED", message: "must not run" };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:187")),
    });
    expect(result).toMatchObject({
      status: "failed", error: { code: "FALLBACK_EVIDENCE_TRUNCATED" },
      ledger: { usage: { logicalCalls: 0, attempts: 0 } },
    });
    expect(calls).toBe(0);
  });

  test("an empty input handle fails before extractor or provider work", async () => {
    let extractorCalls = 0;
    const model = new MockModelClient(() => "must not run", modelIdentity("src/runtime/fallback-extraction.test.ts:201"));
    const result = await runProgram({
      program: program(), sources: { context: "" }, backend, dir: await tmp(),
      controller: new MockController([]), model, signal: new AbortController().signal,
      profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => {
        extractorCalls++;
        return { ok: false, code: "FAILED", message: "must not run" };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:206")),
    });
    expect(result).toMatchObject({
      status: "failed", error: { code: "FALLBACK_EVIDENCE_TRUNCATED" },
      ledger: { usage: { logicalCalls: 0, attempts: 0 } },
    });
    expect(extractorCalls).toBe(0);
    expect(model.callCount).toBe(0);
  });

  test("empty exact JSON values are metadata, not substantive evidence", async () => {
    expect([
      null, "", " \t\n", [], {},
    ].map((value) => isSubstantiveJsonEvidence(value))).toEqual([false, false, false, false, false]);
    expect([
      false, 0, "value", [null], { value: null },
    ].map((value) => isSubstantiveJsonEvidence(value))).toEqual([true, true, true, true, true]);

    let extractorCalls = 0;
    const result = await runProgram({
      program: program(), sources: { context: "" }, backend, dir: await tmp(),
      controller: new MockController([{
        reasoning: "",
        code: "workspace.empty = ''; workspace.whitespace = '   '; workspace.object = {}; workspace.array = []; workspace.nil = null; answer(null)",
      }]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:234")), signal: new AbortController().signal,
      profile: boundedProfile({
        trajectory: { ...DEFAULT_PROFILE.trajectory, headEntries: 0, tailEntries: 0 },
      }),
      extractor: new FunctionExtractor(() => {
        extractorCalls++;
        return { ok: false, code: "FAILED", message: "must not run" };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:238")),
    });
    expect(result).toMatchObject({
      status: "failed", error: { code: "FALLBACK_EVIDENCE_TRUNCATED" },
      ledger: { usage: { logicalCalls: 0, attempts: 0 } },
    });
    expect(extractorCalls).toBe(0);
  });

  test("false and zero have distinct citeable exact-value IDs", async () => {
    const result = await runProgram({
      program: program(), sources: { context: "" }, backend, dir: await tmp(),
      controller: new MockController([{
        reasoning: "",
        code: "workspace.falseValue = false; workspace.zeroValue = 0",
      }]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:257")), signal: new AbortController().signal,
      profile: boundedProfile({
        trajectory: { ...DEFAULT_PROFILE.trajectory, headEntries: 0, tailEntries: 0 },
      }),
      extractor: new FunctionExtractor((evidence) => {
        const falseItem = evidence.workspaceValues.find((item) => item.key === "falseValue");
        const zeroItem = evidence.workspaceValues.find((item) => item.key === "zeroValue");
        expect(falseItem?.evidenceId).toMatch(/^ev_[a-f0-9]{64}$/);
        expect(zeroItem?.evidenceId).toMatch(/^ev_[a-f0-9]{64}$/);
        expect(falseItem?.evidenceId).not.toBe(zeroItem?.evidenceId);
        if (!falseItem?.evidenceId || !zeroItem?.evidenceId) throw new Error("missing exact-value evidence IDs");
        return {
          ok: true,
          value: { answer: "false and zero" },
          evidenceRefs: [falseItem.evidenceId, zeroItem.evidenceId],
        };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:261")),
    });
    expect(result).toMatchObject({
      status: "completed", completionMode: "fallback_extract", answer: { answer: "false and zero" },
    });
  });

  test("huge source handle is head-tail bounded in the provider request", async () => {
    const secret = "SOURCE_ONLY_CANARY_MUST_NOT_LEAK";
    const source = `HEAD:${"h".repeat(2000)}${secret}${"t".repeat(2000)}:TAIL`;
    let requestText = "";
    let seen: ExtractorEvidenceProjection | undefined;
    const model = new MockModelClient((request) => {
      requestText = request.prompt;
      const projectionText = request.prompt.split("\n\nFallback extraction provenance contract:")[0]!;
      const projected = JSON.parse(projectionText) as {
        handles: Array<{ preview: string; evidenceId: string }>;
      };
      const represented = `${projected.handles[0]?.preview.slice(0, 5)}${projected.handles[0]?.preview.slice(-5)}`;
      return response(JSON.stringify({
        value: { answer: represented },
        evidenceRefs: [projected.handles[0]!.evidenceId],
      }));
    }, modelIdentity("src/runtime/fallback-extraction.test.ts:285"));
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: source }, backend, dir,
      controller: new MockController([]), model, signal: new AbortController().signal,
      profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(async (evidence, _signal, operation) => {
        seen = evidence;
        const completed = await operation.complete({
          prompt: canonicalStringify(evidence as unknown as never), maxOutputTokens: 32,
        });
        const envelope = JSON.parse(completed.text) as { value: { answer: string }; evidenceRefs: string[] };
        return { ok: true, ...envelope };
      }, "provider", extractorIdentity("src/runtime/fallback-extraction.test.ts:302")),
    });

    expect(result).toMatchObject({ status: "completed", answer: { answer: "HEAD::TAIL" } });
    expect(model.callCount).toBe(1);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, tokensUsed: 8 });
    expect(requestText).not.toContain(secret);
    expect(requestText).not.toContain(source);
    expect(seen?.serializedBytes).toBeLessThanOrEqual(8 * 1024);
    expect(seen?.handles[0]).toMatchObject({ kind: "context", previewStrategy: "head-tail", truncated: true });
    expect(seen?.omittedBytes).toBe(seen?.handles[0]?.omittedBytes);
    const journal = await events(dir);
    const metadata = journal.find((event) => event.type === "fallback_evidence_projected");
    expect(metadata).toMatchObject({
      type: "fallback_evidence_projected",
      evidenceIdCount: expect.any(Number),
      evidenceIdsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(metadata?.type === "fallback_evidence_projected" && metadata.projectionHash).toMatch(/^[a-f0-9]{64}$/);
    const cited = journal.find((event) => event.type === "fallback_evidence_cited");
    expect(cited).toMatchObject({
      type: "fallback_evidence_cited",
      evidenceRefs: [seen?.handles[0]?.evidenceId],
      evidenceRefsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("huge artifact handles are bounded and explicit", async () => {
    let seen: ExtractorEvidenceProjection | undefined;
    const result = await runProgram({
      program: program(), sources: { context: "source" }, backend, dir: await tmp(),
      controller: new MockController([{
        reasoning: "retain artifact handle",
        code: `const artifact = await artifacts.write({ key: 'large', name: 'large.txt', value: 'A'.repeat(4000) });
          workspace.answerArtifact = { artifactId: artifact.id };`,
      }]),
      model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:345")), signal: new AbortController().signal,
      profile: boundedProfile(),
      extractor: new FunctionExtractor((evidence) => {
        seen = evidence;
        const handle = evidence.handles.find((item) => item.kind === "artifact");
        if (!handle?.evidenceId) throw new Error("missing artifact evidence");
        return { ok: true, value: { answer: "artifact" }, evidenceRefs: [handle.evidenceId] };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:347")),
    });
    expect(result.status).toBe("completed");
    expect(seen?.handles.find((handle) => handle.kind === "artifact")).toMatchObject({
      bytes: 4000, previewStrategy: "head-tail", truncated: true,
    });
  });

  test("non-ASCII projection order and evidence hash are locale-independent", async () => {
    const hashes: string[] = [];
    const evidenceHashes: string[] = [];
    const evidenceIdOrders: string[][] = [];
    const projections: string[] = [];
    for (let run = 0; run < 2; run++) {
      const dir = await tmp();
      const result = await runProgram({
        program: program(), sources: { context: "stable source" }, backend, dir,
        controller: new MockController([{
          reasoning: "stable",
          code: "workspace['😀'] = 5; workspace['中'] = 4; workspace['é'] = 3; workspace.z = 2; workspace.a = 1",
        }]),
        model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:373")), signal: new AbortController().signal,
        profile: boundedProfile(),
        extractor: new FunctionExtractor((evidence) => {
          expect(evidence.workspaceValues.map((item) => item.key)).toEqual(["a", "z", "é", "中", "😀"]);
          const ids = evidence.workspaceValues.map((item) => item.evidenceId!);
          expect(ids.every((id) => /^ev_[a-f0-9]{64}$/.test(id))).toBe(true);
          evidenceIdOrders.push(ids);
          projections.push(canonicalStringify(evidence as unknown as never));
          return {
            ok: true,
            value: { answer: "stable" },
            evidenceRefs: [evidence.workspaceValues[0]!.evidenceId!],
          };
        }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:375")),
      });
      expect(result.status).toBe("completed");
      const journalText = await readFile(join(dir, "events.jsonl"), "utf8");
      const event = (await events(dir)).find((candidate) => candidate.type === "fallback_evidence_projected");
      if (event?.type === "fallback_evidence_projected") {
        hashes.push(event.projectionHash);
        evidenceHashes.push(event.evidenceIdsHash);
      }
      expect(journalText).not.toContain("stable source");
      expect(journalText).not.toContain('"workspaceValues"');
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(evidenceHashes[0]).toBe(evidenceHashes[1]);
    expect(evidenceIdOrders[0]).toEqual(evidenceIdOrders[1]);
    expect(projections[0]).toBe(projections[1]);
  });

  test("opaque throw, invalid accessor result, and cancellation are typed and accounted", async () => {
    const thrownDir = await tmp();
    const thrown = await runProgram({
      program: program(), sources: { context: "represented source" }, backend, dir: thrownDir,
      controller: new MockController([]), model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:408")),
      signal: new AbortController().signal, profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => { throw new Error("private extractor detail"); }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:410")),
    });
    expect(thrown).toMatchObject({ status: "failed", error: { code: "EXTRACTOR_FAILED" }, ledger: { usage: { attempts: 1 } } });
    expect(terminals(await events(thrownDir))).toHaveLength(1);

    let getterCalls = 0;
    const invalid = await runProgram({
      program: program(), sources: { context: "represented source" }, backend, dir: await tmp(),
      controller: new MockController([]), model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:418")),
      signal: new AbortController().signal, profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => {
        const value = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(value, "ok", { enumerable: true, get() { getterCalls++; return true; } });
        return value as never;
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:420")),
    });
    expect(invalid).toMatchObject({ status: "failed", error: { code: "INVALID_RESULT" }, ledger: { usage: { attempts: 1 } } });
    expect(getterCalls).toBe(0);

    const owner = new AbortController();
    let started!: () => void;
    const extractorStarted = new Promise<void>((resolve) => { started = resolve; });
    const cancelledDir = await tmp();
    const work = runProgram({
      program: program(), sources: { context: "represented source" }, backend, dir: cancelledDir,
      controller: new MockController([]), model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:435")),
      signal: owner.signal, profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => {
        started();
        return new Promise<never>(() => {});
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:437")),
    });
    await extractorStarted;
    owner.abort(new Error("owner cancelled"));
    const cancelled = await work;
    expect(cancelled).toMatchObject({ status: "cancelled", error: { code: "CANCELLED" }, ledger: { usage: { attempts: 1 } } });
    expect(terminals(await events(cancelledDir))).toHaveLength(1);
  });

  test("extractor attempt exhaustion denies work after evidence construction", async () => {
    let calls = 0;
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "represented source" }, backend, dir,
      controller: new MockController([]), model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:454")),
      signal: new AbortController().signal,
      profile: boundedProfile({ maxControllerTurns: 0, maxAttempts: 0 }),
      extractor: new FunctionExtractor(() => {
        calls++;
        return { ok: false, code: "FAILED", message: "must not run" };
      }, "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:457")),
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "BUDGET_ATTEMPTS" }, ledger: { usage: { attempts: 0 } } });
    expect(calls).toBe(0);
    expect((await events(dir)).filter((event) => event.type === "fallback_evidence_projected")).toHaveLength(1);
    expect(terminals(await events(dir))).toHaveLength(1);
  });

  test("missing handles preserve known omitted bytes with saturating totals", async () => {
    const evidenceProgram = normalizeProgram({
      objective: "account omitted descriptors",
      profile: "default",
      inputs: [
        { name: "first", adapter: "text", description: "missing first" },
        { name: "second", adapter: "text", description: "missing second" },
      ],
      outputs: [{ name: "answer", schema: { type: "string" } }],
    });
    if (!evidenceProgram.ok) throw new Error("invalid evidence program");
    const descriptor = (id: string, bytes: number) => ({
      id, label: id, bytes, estimatedTokens: 1, tokenEstimator: "utf8-bytes/4",
      mimeType: "text/plain", sha256: "a".repeat(64),
    });
    const built = await buildExtractorEvidence({
      program: evidenceProgram.value,
      variables: {
        first: descriptor("ctx_missing_first", Number.MAX_SAFE_INTEGER),
        second: descriptor("ctx_missing_second", 17),
      } as never,
      workspace: { recovery: "represented" }, entries: [],
      store: { get: () => undefined } as never,
      artifacts: new Map(), profile: boundedProfile(), signal: new AbortController().signal,
      deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.projection).toMatchObject({
      omittedBytes: Number.MAX_SAFE_INTEGER, omittedItems: 2, omittedHandles: 2,
      substantiveItems: 1, truncated: true,
    });

    const artifactProgram = program(false);
    const artifacts = new Map(Array.from({ length: 64 }, (_, index) => {
      const id = `artifact_${String(index).padStart(2, "0")}`;
      return [id, {
        descriptor: { id, name: `${id}.txt`, bytes: 1000, sha256: "b".repeat(64), mimeType: "text/plain" },
        text: "x".repeat(1000),
      }] as const;
    }));
    const artifactWorkspace = Object.fromEntries([
      ...[...artifacts.keys()].map((id) => [`ref_${id}`, { artifactId: id }] as const),
      ["recovery", "represented"],
    ]);
    const fullyOmitted = await buildExtractorEvidence({
      program: artifactProgram, variables: {}, workspace: artifactWorkspace, entries: [],
      store: { get: () => undefined } as never, artifacts, profile: boundedProfile(),
      signal: new AbortController().signal, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0,
    });
    expect(fullyOmitted.ok).toBe(true);
    if (!fullyOmitted.ok) return;
    expect(fullyOmitted.projection.omittedHandles).toBeGreaterThan(0);
    expect(fullyOmitted.projection.omittedItems).toBe(fullyOmitted.projection.omittedHandles);
    const representedOmittedBytes = fullyOmitted.projection.handles
      .reduce((total, handle) => total + handle.omittedBytes, 0);
    expect(fullyOmitted.projection.omittedBytes).toBe(
      representedOmittedBytes + (fullyOmitted.projection.omittedHandles * 1000),
    );
  });

  test("fallback output-byte denial rolls back and emits one terminal", async () => {
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "represented source" }, backend, dir,
      controller: new MockController([]), model: new MockModelClient(() => "unused", modelIdentity("src/runtime/fallback-extraction.test.ts:533")),
      signal: new AbortController().signal,
      profile: boundedProfile({ maxControllerTurns: 0, storedByteLimit: Buffer.byteLength("represented source") + 1 }),
      extractor: new FunctionExtractor((evidence) => ({
        ok: true,
        value: { answer: "too large" },
        evidenceRefs: [evidence.handles[0]!.evidenceId!],
      }), "external", extractorIdentity("src/runtime/fallback-extraction.test.ts:536")),
    });
    expect(result).toMatchObject({
      status: "failed", error: { code: "BUDGET_BYTES" },
      ledger: { usage: { storedBytes: Buffer.byteLength("represented source") } },
    });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "answer_committed")).toHaveLength(0);
    expect(terminals(journal)).toHaveLength(1);
    expect((await readdir(join(dir, "contexts"))).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
  });
});
