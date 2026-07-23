import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { ContextChunkOverflowError, ContextStore, ContextUnavailableError } from "./context-store.ts";

let store: ContextStore;
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-"));
  store = new ContextStore(dir);
});

describe("ContextStore", () => {
  test("content-addressed ids are deterministic and deduped", async () => {
    const a = await store.ingestText("doc", "hello world");
    const b = await store.ingestText("doc-again", "hello world");
    expect(a.id).toBe(b.id);
    expect(store.totalBytes()).toBe(11);
  });

  test("read slices on UTF-8 boundaries", async () => {
    const d = await store.ingestText("u", "a\u00e9\u{1f600}b");
    const r = store.read(d.id, { offsetBytes: 0, lengthBytes: 2 });
    expect(r.text).toBe("a"); // é is 2 bytes; boundary backs off
    expect(r.truncated).toBe(true);
  });

  test("lines returns a 1-based window", async () => {
    const d = await store.ingestText("l", "l1\nl2\nl3\nl4");
    const r = store.lines(d.id, { startLine: 2, count: 2 });
    expect(r.text).toBe("l2\nl3");
  });

  test("grep literal, case-insensitive, bounded", async () => {
    const d = await store.ingestText("g", "Alpha\nbeta\nALPHA\ngamma");
    const hits = store.grep(d.id, { pattern: "alpha", maxMatches: 5 });
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
    const bounded = store.grep(d.id, { pattern: "a", maxMatches: 1 });
    expect(bounded).toHaveLength(1);
  });

  test("chunks respect maxChunks and overlap, or throw", async () => {
    const d = await store.ingestText("c", "x".repeat(4000));
    const chunks = await store.chunks(d.id, { targetTokens: 250, maxChunks: 10 }); // ~1000 chars each
    expect(chunks.length).toBeLessThanOrEqual(10);
    expect(chunks.length).toBeGreaterThan(1);
    await expect(store.chunks(d.id, { targetTokens: 25, maxChunks: 2 })).rejects.toBeInstanceOf(ContextChunkOverflowError);
  });

  test("derive and concat produce readable contexts", async () => {
    const j = await store.derive({ key: "k", value: { a: 1 } });
    expect(await store.load(j.id)).toBe('{"a":1}');
    const a = await store.ingestText("a", "AAA");
    const b = await store.ingestText("b", "BBB");
    const c = await store.concat({ key: "cc", refs: [a, b], separator: "|" });
    expect(await store.load(c.id)).toBe("AAA|BBB");
  });

  test("missing context throws typed error", () => {
    expect(() => store.read("ctx_missing")).toThrow(ContextUnavailableError);
  });
});
