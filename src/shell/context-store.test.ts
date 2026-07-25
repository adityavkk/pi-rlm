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

  test("lines returns exact LF byte ranges for first, middle, final, and empty lines", async () => {
    const d = await store.ingestText("l", "first\n\nmé\nfinal");
    const cases = [
      { startLine: 1, text: "first", startByte: 0, endByte: 5, truncated: true },
      { startLine: 2, text: "", startByte: 6, endByte: 6, truncated: true },
      { startLine: 3, text: "mé", startByte: 7, endByte: 10, truncated: true },
      { startLine: 4, text: "final", startByte: 11, endByte: 16, truncated: false },
    ];

    for (const expected of cases) {
      const result = store.lines(d.id, { startLine: expected.startLine, count: 1 });
      expect(result).toEqual({
        text: expected.text,
        startByte: expected.startByte,
        endByte: expected.endByte,
        truncated: expected.truncated,
      });
      expect(store.read(d.id, {
        offsetBytes: result.startByte,
        lengthBytes: result.endByte - result.startByte,
      }).text).toBe(result.text);
    }

    expect(store.lines(d.id, { startLine: 2, count: 2 })).toEqual({
      text: "\nmé",
      startByte: 6,
      endByte: 10,
      truncated: true,
    });
  });

  test("lines preserves CRLF inside windows and excludes line delimiters at window end", async () => {
    const d = await store.ingestText("crlf", "one\r\n\r\ntwø\r\nlast");
    const result = store.lines(d.id, { startLine: 2, count: 2 });
    expect(result).toEqual({
      text: "\r\ntwø",
      startByte: 5,
      endByte: 11,
      truncated: true,
    });
    expect(store.read(d.id, {
      offsetBytes: result.startByte,
      lengthBytes: result.endByte - result.startByte,
    }).text).toBe(result.text);
    expect(store.lines(d.id, { startLine: 4, count: 1 })).toEqual({
      text: "last",
      startByte: 13,
      endByte: 17,
      truncated: false,
    });
  });

  test("lines represents a trailing newline as a final empty line", async () => {
    const lf = await store.ingestText("lf-trailing", "a\n");
    expect(store.lines(lf.id, { startLine: 2, count: 1 })).toEqual({
      text: "",
      startByte: 2,
      endByte: 2,
      truncated: false,
    });

    const crlf = await store.ingestText("crlf-trailing", "é\r\n");
    const result = store.lines(crlf.id, { startLine: 2, count: 1 });
    expect(result).toEqual({ text: "", startByte: 4, endByte: 4, truncated: false });
    expect(store.read(crlf.id, {
      offsetBytes: result.startByte,
      lengthBytes: result.endByte - result.startByte,
    }).text).toBe(result.text);
  });

  test("lines bounds clamp to the current 1-based API", async () => {
    const d = await store.ingestText("bounds", "a\nb");
    expect(store.lines(d.id, { startLine: 0, count: 1 })).toEqual({
      text: "a",
      startByte: 0,
      endByte: 1,
      truncated: true,
    });
    expect(store.lines(d.id, { startLine: 2, count: -1 })).toEqual({
      text: "",
      startByte: 2,
      endByte: 2,
      truncated: true,
    });
    expect(store.lines(d.id, { startLine: 3, count: 1 })).toEqual({
      text: "",
      startByte: 3,
      endByte: 3,
      truncated: false,
    });
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
