import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "../shell/model/client.ts";
import type { ExtractorEvidenceProjection } from "./extractor-evidence.ts";
import { ModelExtractor } from "./model-extractor.ts";

const evidenceId = `ev_${"a".repeat(64)}`;
const evidence = {
  version: "1.3.0",
  outputContract: [{ name: "answer", description: "answer", schema: { type: "string" } }],
  variables: [], answerCandidates: [], workspaceValues: [],
  handles: [{
    evidenceId, id: "ctx_test", kind: "context", sha256: "b".repeat(64), bytes: 5,
    preview: "value", previewBytes: 5, previewStrategy: "exact", omittedBytes: 0,
    truncated: false, required: false, references: [],
  }],
  trajectory: { entries: [], omittedCount: 0, total: 0 },
  maxBytes: 4096, serializedBytes: 512, omittedBytes: 0, omittedItems: 0, truncatedItems: 0,
  omittedWorkspaceValues: 0, omittedAnswerCandidates: 0, omittedHandles: 0,
  omittedTrajectoryEntries: 0, substantiveItems: 1, truncated: false,
} as ExtractorEvidenceProjection;

describe("ModelExtractor", () => {
  test("uses a stable provider identity and returns a provenance envelope", async () => {
    const requests: ModelRequest[] = [];
    const extractor = new ModelExtractor({ model: "provider/model", maxOutputTokens: 321 });
    const result = await extractor.extract(evidence, new AbortController().signal, {
      async complete(request) {
        requests.push(request);
        return {
          text: JSON.stringify({ value: { answer: "ok" }, evidenceRefs: [evidenceId] }),
          usage: { attempts: 1, durationMs: 1 },
        };
      },
    });

    expect(result).toEqual({ ok: true, value: { answer: "ok" }, evidenceRefs: [evidenceId] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "provider/model", maxOutputTokens: 321 });
    expect(requests[0]?.prompt).toContain('"preview":"value"');
    expect(extractor.identity).toMatchObject({
      id: "pi-rlm/model-extractor", version: "1",
      configuration: { modelRoute: "provider/model", maxOutputTokens: 321, repairAttempts: 1 },
    });
  });

  test("repairs once without replaying invalid provider text", async () => {
    const prompts: string[] = [];
    let call = 0;
    const result = await new ModelExtractor({ model: "provider/model" }).extract(
      evidence,
      new AbortController().signal,
      {
        async complete(request) {
          prompts.push(request.prompt);
          call++;
          return {
            text: call === 1 ? "PRIVATE INVALID PROVIDER TEXT" : JSON.stringify({
              value: { answer: "repaired" }, evidenceRefs: [evidenceId],
            }),
            usage: { attempts: 1, durationMs: 1 },
          };
        },
      },
    );
    expect(result).toEqual({ ok: true, value: { answer: "repaired" }, evidenceRefs: [evidenceId] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("PRIVATE INVALID PROVIDER TEXT");
  });
});
