import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  ContextChunkOverflowError,
  ContextSpecError,
  ContextStore,
  ContextUnavailableError,
  DEFAULT_CONTEXT_STORE_LIMITS,
  type ContextStoreLimits,
} from "./context-store.ts";

const limitedStore = async (limits: Partial<ContextStoreLimits>): Promise<ContextStore> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-limited-"));
  return new ContextStore(dir, { ...DEFAULT_CONTEXT_STORE_LIMITS, ...limits });
};

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

  test("lines rejects invalid bounds and preserves past-EOF reads", async () => {
    const d = await store.ingestText("bounds", "a\nb");
    expect(() => store.lines(d.id, { startLine: 0, count: 1 })).toThrow(ContextSpecError);
    expect(() => store.lines(d.id, { startLine: 2, count: -1 })).toThrow(ContextSpecError);
    expect(store.lines(d.id, { startLine: 3, count: 1 })).toEqual({
      text: "",
      startByte: 3,
      endByte: 3,
      truncated: false,
    });
  });

  test("grep literal, case-insensitive, bounded", async () => {
    const d = await store.ingestText("g", "Alpha\nbeta\nALPHA\ngamma\n(a+)+$");
    const hits = store.grep(d.id, { pattern: "alpha", maxMatches: 5 });
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
    const bounded = store.grep(d.id, { pattern: "a", maxMatches: 1 });
    expect(bounded).toHaveLength(1);
    expect(store.grep(d.id, { pattern: "(a+)+$", syntax: "literal", maxMatches: 5 }).map((h) => h.line)).toEqual([5]);
  });

  test("fails closed on regex syntax without invoking host RegExp", async () => {
    const d = await store.ingestText("regex", `${"a".repeat(100_000)}!`);
    expect(() => store.grep(d.id, { pattern: "(a+)+$", syntax: "re2" as "literal", maxMatches: 1 })).toThrow(ContextSpecError);
    try {
      store.grep(d.id, { pattern: "(a+)+$", syntax: "re2" as "literal", maxMatches: 1 });
    } catch (error) {
      expect((error as ContextSpecError).code).toBe("INVALID_SPEC");
      expect((error as Error).message).toContain("unsupported in v1");
    }
  });

  test("catastrophic regex denial completes in a bounded subprocess", async () => {
    const moduleUrl = new URL("./context-store.ts", import.meta.url).href;
    const script = `
      import { mkdtemp } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const { ContextStore } = await import(${JSON.stringify(moduleUrl)});
      const store = new ContextStore(await mkdtemp(join(tmpdir(), "pi-rlm-regex-")));
      const d = await store.ingestText("hostile", "a".repeat(200_000) + "!");
      try {
        store.grep(d.id, { pattern: "(a+)+$", syntax: "re2", maxMatches: 1 });
        process.exit(2);
      } catch (error) {
        process.exit(error && error.code === "INVALID_SPEC" ? 0 : 3);
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      child.exited.then((code) => ({ code, timedOut: false })),
      new Promise<{ code: number; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve({ code: -1, timedOut: true });
        }, 2_000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  test("chunks respect maxChunks and overlap, or throw", async () => {
    const d = await store.ingestText("c", "x".repeat(4000));
    const chunks = await store.chunks(d.id, { targetTokens: 250, maxChunks: 10 }); // ~1000 bytes each
    expect(chunks.length).toBeLessThanOrEqual(10);
    expect(chunks.length).toBeGreaterThan(1);
    await expect(store.chunks(d.id, { targetTokens: 25, maxChunks: 2 })).rejects.toBeInstanceOf(ContextChunkOverflowError);
  });

  test("validates all numeric options as bounded integers", async () => {
    const d = await store.ingestText("numeric", "a\nb\nc");
    const invalid = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_VALUE];
    for (const value of invalid) {
      expect(() => store.read(d.id, { lengthBytes: value })).toThrow(ContextSpecError);
      expect(() => store.lines(d.id, { startLine: 1, count: value })).toThrow(ContextSpecError);
      expect(() => store.grep(d.id, { pattern: "a", maxMatches: value })).toThrow(ContextSpecError);
      await expect(store.chunks(d.id, { targetTokens: value, maxChunks: 1 })).rejects.toBeInstanceOf(ContextSpecError);
    }
    expect(() => store.read(d.id, { offsetBytes: -1 })).toThrow(ContextSpecError);
    expect(() => store.lines(d.id, { startLine: 0, count: 1 })).toThrow(ContextSpecError);
  });

  test("enforces read, line, match, pattern, and aggregate result caps", async () => {
    const bounded = await limitedStore({
      maxReadBytes: 12,
      maxLines: 2,
      maxLineBytes: 8,
      maxMatches: 2,
      maxPatternBytes: 4,
    });
    const d = await bounded.ingestText("caps", "12345678\n12345678\ntail");
    expect(bounded.read(d.id).text).toBe("12345678\n123");
    expect(bounded.read(d.id).truncated).toBe(true);
    expect(() => bounded.read(d.id, { lengthBytes: 13 })).toThrow(ContextSpecError);
    expect(() => bounded.lines(d.id, { startLine: 1, count: 3 })).toThrow(ContextSpecError);
    expect(() => bounded.lines(d.id, { startLine: 1, count: 2 })).toThrow(/maxReadBytes/);
    expect(() => bounded.grep(d.id, { pattern: "1", maxMatches: 3 })).toThrow(ContextSpecError);
    expect(() => bounded.grep(d.id, { pattern: "12345", maxMatches: 1 })).toThrow(/maxPatternBytes/);
    expect(() => bounded.grep(d.id, { pattern: "1", maxMatches: 2 })).toThrow(/maxReadBytes/);
  });

  test("rejects overlong lines before decoding them", async () => {
    const bounded = await limitedStore({ maxReadBytes: 64, maxLineBytes: 8, maxPatternBytes: 64 });
    const d = await bounded.ingestText("long-line", `${"x".repeat(100_000)}\nneedle`);
    expect(() => bounded.lines(d.id, { startLine: 1, count: 1 })).toThrow(/maxLineBytes/);
    expect(() => bounded.grep(d.id, { pattern: "needle", maxMatches: 1 })).toThrow(/maxLineBytes/);
  });

  test("preflights chunk count, overlap progress, profile cap, and stored bytes", async () => {
    const bounded = await limitedStore({
      maxReadBytes: 40,
      maxLineBytes: 40,
      maxChunks: 3,
      maxPatternBytes: 40,
    });
    const d = await bounded.ingestText("preflight", "0123456789".repeat(20));
    const before = bounded.totalBytes();
    await expect(bounded.chunks(d.id, { targetTokens: 5, maxChunks: 3 })).rejects.toBeInstanceOf(ContextChunkOverflowError);
    expect(bounded.totalBytes()).toBe(before);
    await expect(bounded.chunks(d.id, { targetTokens: 5, overlapTokens: 5, maxChunks: 3 })).rejects.toBeInstanceOf(ContextSpecError);
    await expect(bounded.chunks(d.id, { targetTokens: 5, overlapTokens: 0, maxChunks: 3 })).rejects.toBeInstanceOf(ContextSpecError);
    await expect(bounded.chunks(d.id, { targetTokens: 5, maxChunks: 4 })).rejects.toBeInstanceOf(ContextSpecError);
    await expect(bounded.chunks(d.id, { targetTokens: 10, maxChunks: 3 }, { maxOutputBytes: 10 })).rejects.toThrow(/stored bytes/);
    expect(bounded.totalBytes()).toBe(before);
  });

  test("checks cancellation/deadline composition points while scanning", async () => {
    const d = await store.ingestText("cancel", "line\n".repeat(20_000));
    let checks = 0;
    expect(() => store.grep(d.id, { pattern: "missing", maxMatches: 1 }, {
      checkpoint: () => {
        if (++checks === 3) throw new Error("cancelled");
      },
    })).toThrow("cancelled");
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
