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
import { FunctionExtractor, type ExtractorEvidenceProjection } from "./index.ts";
import { MockController } from "./mock-controller.ts";
import { DEFAULT_PROFILE, type Profile } from "./profile.ts";
import { runProgram } from "./run.ts";

let backend: QuickJsBackend;
beforeAll(async () => { backend = await QuickJsBackend.create(); });

const tmp = () => mkdtemp(join(tmpdir(), "pi-rlm-fallback-"));
const events = async (dir: string): Promise<RlmEvent[]> =>
  (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as RlmEvent);
const terminals = (journal: readonly RlmEvent[]) => journal.filter((event) =>
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
      model: new MockModelClient(() => "unused"), signal: new AbortController().signal,
      profile: boundedProfile(),
      extractor: new FunctionExtractor((evidence) => {
        expect(evidence.answerCandidates[0]?.value).toEqual({ answer: 7 });
        return { ok: true, value: { answer: 7 } };
      }),
    });

    expect(result).toMatchObject({ status: "failed", error: { code: "INVALID_RESULT" } });
    const journal = await events(dir);
    const directError = journal.find((event) => event.type === "cell_committed")?.error;
    expect(result.error?.message).toBe(directError?.message);
    expect(journal.filter((event) => event.type === "answer_committed")).toHaveLength(0);
    expect(terminals(journal)).toHaveLength(1);
  });

  test("prior invalid candidate is exact and prioritized over oversized workspace", async () => {
    let seen: ExtractorEvidenceProjection | undefined;
    const dir = await tmp();
    const result = await runProgram({
      program: program(), sources: { context: "source" }, backend, dir,
      controller: new MockController([{
        reasoning: "leave recoverable evidence",
        code: "workspace.blob = 'z'.repeat(2000); answer({ answer: 42 })",
      }]),
      model: new MockModelClient(() => "unused"), signal: new AbortController().signal,
      profile: boundedProfile(),
      extractor: new FunctionExtractor((evidence) => {
        seen = evidence;
        const candidate = evidence.answerCandidates[0]?.value as { readonly answer?: unknown } | undefined;
        return { ok: true, value: { answer: String(candidate?.answer) } };
      }),
    });

    expect(result).toMatchObject({ status: "completed", completionMode: "fallback_extract", answer: { answer: "42" } });
    expect(seen?.answerCandidates).toHaveLength(1);
    expect(seen?.workspaceValues).toHaveLength(0);
    expect(seen?.omittedWorkspaceValues).toBe(1);
    expect(seen?.omittedBytes).toBeGreaterThanOrEqual(2002);
    const metadata = (await events(dir)).find((event) => event.type === "fallback_evidence_projected");
    expect(metadata).toMatchObject({ type: "fallback_evidence_projected", truncated: true, omittedItems: 1 });
  });

  test("required candidate truncation fails before extractor work", async () => {
    let calls = 0;
    const result = await runProgram({
      program: program(), sources: { context: "source" }, backend, dir: await tmp(),
      controller: new MockController([{
        reasoning: "oversized invalid candidate",
        code: "answer({ answer: 9, padding: 'p'.repeat(2000) })",
      }]),
      model: new MockModelClient(() => "unused"), signal: new AbortController().signal,
      profile: boundedProfile({ extractorValueMaxBytes: 128 }),
      extractor: new FunctionExtractor(() => { calls++; return { ok: true, value: { answer: "must not run" } }; }),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "FALLBACK_EVIDENCE_TRUNCATED" },
      ledger: { usage: { logicalCalls: 0, attempts: 0 } },
    });
    expect(calls).toBe(0);
  });

  test("huge source handle is head-tail bounded in the provider request", async () => {
    const secret = "SOURCE_ONLY_CANARY_MUST_NOT_LEAK";
    const source = `HEAD:${"h".repeat(2000)}${secret}${"t".repeat(2000)}:TAIL`;
    let requestText = "";
    let seen: ExtractorEvidenceProjection | undefined;
    const model = new MockModelClient((request) => {
      requestText = request.prompt;
      return response('{"answer":"bounded"}');
    });
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
        return { ok: true, value: JSON.parse(completed.text) };
      }, "provider"),
    });

    expect(result).toMatchObject({ status: "completed", answer: { answer: "bounded" } });
    expect(model.callCount).toBe(1);
    expect(result.ledger.usage).toMatchObject({ logicalCalls: 1, attempts: 1, tokensUsed: 8 });
    expect(requestText).not.toContain(secret);
    expect(requestText).not.toContain(source);
    expect(seen?.serializedBytes).toBeLessThanOrEqual(8 * 1024);
    expect(seen?.handles[0]).toMatchObject({ kind: "context", previewStrategy: "head-tail", truncated: true });
    expect(seen?.omittedBytes).toBe(seen?.handles[0]?.omittedBytes);
    const metadata = (await events(dir)).find((event) => event.type === "fallback_evidence_projected");
    expect(metadata?.type === "fallback_evidence_projected" && metadata.projectionHash).toMatch(/^[a-f0-9]{64}$/);
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
      model: new MockModelClient(() => "unused"), signal: new AbortController().signal,
      profile: boundedProfile(),
      extractor: new FunctionExtractor((evidence) => {
        seen = evidence;
        return { ok: true, value: { answer: "artifact" } };
      }),
    });
    expect(result.status).toBe("completed");
    expect(seen?.handles.find((handle) => handle.kind === "artifact")).toMatchObject({
      bytes: 4000, previewStrategy: "head-tail", truncated: true,
    });
  });

  test("evidence hash is deterministic and journal contains metadata only", async () => {
    const hashes: string[] = [];
    const projections: string[] = [];
    for (let run = 0; run < 2; run++) {
      const dir = await tmp();
      const result = await runProgram({
        program: program(), sources: { context: "stable source" }, backend, dir,
        controller: new MockController([{ reasoning: "stable", code: "workspace.b = 2; workspace.a = 1" }]),
        model: new MockModelClient(() => "unused"), signal: new AbortController().signal,
        profile: boundedProfile(),
        extractor: new FunctionExtractor((evidence) => {
          projections.push(canonicalStringify(evidence as unknown as never));
          return { ok: true, value: { answer: "stable" } };
        }),
      });
      expect(result.status).toBe("completed");
      const journalText = await readFile(join(dir, "events.jsonl"), "utf8");
      const event = (await events(dir)).find((candidate) => candidate.type === "fallback_evidence_projected");
      if (event?.type === "fallback_evidence_projected") hashes.push(event.projectionHash);
      expect(journalText).not.toContain("stable source");
      expect(journalText).not.toContain('"workspaceValues"');
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(projections[0]).toBe(projections[1]);
  });

  test("opaque throw, invalid accessor result, and cancellation are typed and accounted", async () => {
    const thrownDir = await tmp();
    const thrown = await runProgram({
      program: program(false), sources: {}, backend, dir: thrownDir,
      controller: new MockController([]), model: new MockModelClient(() => "unused"),
      signal: new AbortController().signal, profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => { throw new Error("private extractor detail"); }),
    });
    expect(thrown).toMatchObject({ status: "failed", error: { code: "EXTRACTOR_FAILED" }, ledger: { usage: { attempts: 1 } } });
    expect(terminals(await events(thrownDir))).toHaveLength(1);

    let getterCalls = 0;
    const invalid = await runProgram({
      program: program(false), sources: {}, backend, dir: await tmp(),
      controller: new MockController([]), model: new MockModelClient(() => "unused"),
      signal: new AbortController().signal, profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => {
        const value = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(value, "ok", { enumerable: true, get() { getterCalls++; return true; } });
        return value as never;
      }),
    });
    expect(invalid).toMatchObject({ status: "failed", error: { code: "INVALID_RESULT" }, ledger: { usage: { attempts: 1 } } });
    expect(getterCalls).toBe(0);

    const owner = new AbortController();
    let started!: () => void;
    const extractorStarted = new Promise<void>((resolve) => { started = resolve; });
    const cancelledDir = await tmp();
    const work = runProgram({
      program: program(false), sources: {}, backend, dir: cancelledDir,
      controller: new MockController([]), model: new MockModelClient(() => "unused"),
      signal: owner.signal, profile: boundedProfile({ maxControllerTurns: 0 }),
      extractor: new FunctionExtractor(() => {
        started();
        return new Promise<never>(() => {});
      }),
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
      program: program(false), sources: {}, backend, dir,
      controller: new MockController([]), model: new MockModelClient(() => "unused"),
      signal: new AbortController().signal,
      profile: boundedProfile({ maxControllerTurns: 0, maxAttempts: 0 }),
      extractor: new FunctionExtractor(() => { calls++; return { ok: true, value: { answer: "free" } }; }),
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "BUDGET_ATTEMPTS" }, ledger: { usage: { attempts: 0 } } });
    expect(calls).toBe(0);
    expect((await events(dir)).filter((event) => event.type === "fallback_evidence_projected")).toHaveLength(1);
    expect(terminals(await events(dir))).toHaveLength(1);
  });

  test("fallback output-byte denial rolls back and emits one terminal", async () => {
    const dir = await tmp();
    const result = await runProgram({
      program: program(false), sources: {}, backend, dir,
      controller: new MockController([]), model: new MockModelClient(() => "unused"),
      signal: new AbortController().signal,
      profile: boundedProfile({ maxControllerTurns: 0, storedByteLimit: 1 }),
      extractor: new FunctionExtractor(() => ({ ok: true, value: { answer: "too large" } })),
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "BUDGET_BYTES" }, ledger: { usage: { storedBytes: 0 } } });
    const journal = await events(dir);
    expect(journal.filter((event) => event.type === "answer_committed")).toHaveLength(0);
    expect(terminals(journal)).toHaveLength(1);
    expect(await readdir(dir)).not.toContain("contexts");
  });
});
