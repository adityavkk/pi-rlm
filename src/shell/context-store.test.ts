import { link as hardLink, mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { canonicalStringify, MAX_JSON_DEPTH, type JsonValue } from "../core/json.ts";
import {
  ContextBudgetError,
  ContextChunkOverflowError,
  ContextIntegrityError,
  ContextSpecError,
  ContextStore,
  ContextUnavailableError,
  DEFAULT_CONTEXT_STORE_LIMITS,
  type ContextStoreLimits,
} from "./context-store.ts";
import { sha256 } from "./hash.ts";

const runSubprocess = async (script: string, timeoutMs = 5_000): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> => {
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);
  return { code, stdout: await stdout, stderr: await stderr, timedOut };
};

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

  test("preflights chunk count, overlap progress, and profile cap", async () => {
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
    expect(bounded.totalBytes()).toBe(before);
  });

  test("budget-denied producers leave entries, bytes, and files unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-budget-"));
    const bounded = new ContextStore(dir);
    const source = await bounded.ingestText("source", "abcdefgh");
    const beforeBytes = bounded.totalBytes();
    const beforeFiles = await readdir(join(dir, "contexts"));
    const control = { maxOutputBytes: 0 };
    const denied = [
      () => bounded.derive({ key: "denied", value: "new" }, control),
      () => bounded.derive({ key: "denied", value: "new" }, control),
      () => bounded.concat({ key: "concat", refs: [source, source], separator: "" }, control),
      () => bounded.chunks(source.id, { targetTokens: 1, maxChunks: 4 }, control),
    ];
    for (const operation of denied) await expect(operation()).rejects.toBeInstanceOf(ContextBudgetError);
    expect(bounded.totalBytes()).toBe(beforeBytes);
    expect(await readdir(join(dir, "contexts"))).toEqual(beforeFiles);
  });

  test("materializes each unique prepared candidate exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-materialize-"));
    const materialized: string[] = [];
    const observed = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, {
      onMaterialize: (descriptor) => materialized.push(descriptor.id),
    });
    const source = await observed.ingestText("duplicates", "abcdabcd");
    materialized.length = 0;

    const chunks = await observed.chunks(source.id, { targetTokens: 1, maxChunks: 2 });
    expect(chunks[0]?.id).toBe(chunks[1]?.id);
    expect(materialized).toEqual([chunks[0]?.id as string]);
    expect(await observed.load(chunks[0]?.id as string)).toBe("abcd");

    materialized.length = 0;
    await observed.chunks(source.id, { targetTokens: 1, maxChunks: 2 });
    expect(materialized).toEqual([]);
  });

  test("keeps exact-limit concat and chunk candidate allocations bounded in a subprocess", async () => {
    const moduleUrl = new URL("./context-store.ts", import.meta.url).href;
    const script = `
      import { mkdtemp } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const { ContextStore, DEFAULT_CONTEXT_STORE_LIMITS } = await import(${JSON.stringify(moduleUrl)});
      const allocations = [];
      const store = new ContextStore(
        await mkdtemp(join(tmpdir(), "pi-rlm-near-limit-")),
        DEFAULT_CONTEXT_STORE_LIMITS,
        { onMaterialize: (descriptor) => allocations.push(descriptor.bytes) },
      );
      const halfMiB = "abcd".repeat(128 * 1024);
      const source = await store.ingestText("source", halfMiB + halfMiB);
      allocations.length = 0;
      let reserved = 0;
      const chunks = await store.chunks(source.id, { targetTokens: 128 * 1024, maxChunks: 2 }, {
        maxOutputBytes: 512 * 1024,
        reserveBytes: (bytes) => {
          reserved += bytes;
          return { rollback: () => { reserved -= bytes; } };
        },
      });
      const concat = await store.concat({ key: "near-limit", refs: [source, source], separator: "" }, {
        maxOutputBytes: 2 * 1024 * 1024,
        reserveBytes: (bytes) => {
          reserved += bytes;
          return { rollback: () => { reserved -= bytes; } };
        },
      });
      console.log(JSON.stringify({
        allocations,
        chunkIds: chunks.map((chunk) => chunk.id),
        concatBytes: concat.bytes,
        reserved,
        totalBytes: store.totalBytes(),
      }));
    `;
    const result = await runSubprocess(script);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      allocations: [512 * 1024, 2 * 1024 * 1024],
      chunkIds: [expect.any(String), expect.any(String)],
      concatBytes: 2 * 1024 * 1024,
      reserved: 2_621_440,
      totalBytes: 3_670_016,
    });
    const output = JSON.parse(result.stdout) as { chunkIds: string[] };
    expect(output.chunkIds[0]).toBe(output.chunkIds[1]);
  });

  test("reserves the exact unique byte delta for duplicate chunks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-unique-"));
    const exact = new ContextStore(dir);
    const source = await exact.ingestText("duplicates", "abcdabcd");
    let reserved = 0;
    const chunks = await exact.chunks(source.id, { targetTokens: 1, maxChunks: 2 }, {
      maxOutputBytes: 4,
      reserveBytes: (bytes) => {
        reserved += bytes;
        return {
          release: (released) => { reserved -= released; },
          rollback: () => { reserved -= bytes; },
        };
      },
    });
    expect(reserved).toBe(4);
    expect(chunks[0]?.id).toBe(chunks[1]?.id);
    expect(exact.totalBytes()).toBe(12);
  });

  test("zero-overlap chunks preserve 2, 3, and 4-byte UTF-8 boundary crossings", async () => {
    const sources = ["abcéZ", "abc€Z", "ab😀Z"];
    for (const source of sources) {
      const descriptor = await store.ingestText(`utf8-${source}`, source);
      const chunks = await store.chunks(descriptor.id, { targetTokens: 1, maxChunks: 10 });
      const reconstructed = (await Promise.all(chunks.map((chunk) => store.load(chunk.id)))).join("");
      expect(new TextEncoder().encode(reconstructed)).toEqual(new TextEncoder().encode(source));
    }
  });

  test("overlapping UTF-8 chunks preserve coverage and make progress", async () => {
    const source = "AéB€C😀DEFGHIJK";
    const descriptor = await store.ingestText("utf8-overlap", source);
    const chunks = await store.chunks(descriptor.id, {
      targetTokens: 2,
      overlapTokens: 1,
      maxChunks: 10,
    });
    const texts = await Promise.all(chunks.map((chunk) => store.load(chunk.id)));
    let reconstructed = texts[0] as string;
    for (const text of texts.slice(1)) {
      let overlap = Math.min(reconstructed.length, text.length);
      while (overlap > 0 && !reconstructed.endsWith(text.slice(0, overlap))) overlap--;
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThan(text.length);
      reconstructed += text.slice(overlap);
    }
    expect(reconstructed).toBe(source);
  });

  test("rolls byte reservation and filesystem state back when persistence fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-failure-"));
    const contentPath = join(dir, "contexts");
    await writeFile(contentPath, "block writes");
    const failing = new ContextStore(dir);
    let reserved = 0;
    await expect(failing.derive({ key: "failure", value: "new context" }, {
      maxOutputBytes: 100,
      reserveBytes: (bytes) => {
        reserved += bytes;
        return {
          release: (released) => { reserved -= released; },
          rollback: () => { reserved -= bytes; },
        };
      },
    })).rejects.toBeInstanceOf(Error);
    expect(reserved).toBe(0);
    expect(failing.totalBytes()).toBe(0);
    expect(await readFile(contentPath, "utf8")).toBe("block writes");
  });

  test("retains exact partial payload charge when failed-write cleanup cannot unlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-orphan-"));
    let unlinkAttempts = 0;
    const orphaned = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, {
      writeFile: async (path, bytes) => {
        await writeFile(path, bytes.subarray(0, 4), { flag: "wx" });
        throw new Error("injected partial write failure");
      },
      unlink: async (path) => {
        unlinkAttempts++;
        if (unlinkAttempts === 1) throw new Error("injected unlink failure");
        await unlink(path);
      },
    });
    let ledgerBytes = 0;
    const reserveBytes = (bytes: number) => {
      ledgerBytes += bytes;
      let remaining = bytes;
      return {
        release: (released: number) => {
          ledgerBytes -= released;
          remaining -= released;
        },
        rollback: () => {
          ledgerBytes -= remaining;
          remaining = 0;
        },
      };
    };
    const value = "partial payload";

    await expect(orphaned.derive({ key: "partial", value }, {
      maxOutputBytes: 100,
      reserveBytes,
    })).rejects.toMatchObject({ code: "CONTEXT_CLEANUP_FAILED", failures: [{ bytes: 4 }] });
    expect(orphaned.get(`ctx_${sha256(value)}`)).toBeUndefined();
    expect(orphaned.totalBytes()).toBe(4);
    expect(orphaned.orphanedBytes()).toBe(4);
    expect(ledgerBytes).toBe(4);
    expect(await readdir(join(dir, "contexts"))).toHaveLength(1);

    await orphaned.cleanupOrphans();
    expect(orphaned.totalBytes()).toBe(0);
    expect(orphaned.orphanedBytes()).toBe(0);
    expect(ledgerBytes).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  test("releases an orphan when unlink removes the payload before throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-orphan-removed-"));
    let unlinkAttempts = 0;
    const orphaned = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, {
      writeFile: async (path, bytes) => {
        await writeFile(path, bytes.subarray(0, 4), { flag: "wx" });
        throw new Error("injected partial write failure");
      },
      unlink: async (path) => {
        unlinkAttempts++;
        if (unlinkAttempts === 1) throw new Error("injected unlink failure before removal");
        await unlink(path);
        throw new Error("injected unlink failure after removal");
      },
    });
    let ledgerBytes = 0;
    const value = "partial payload";
    const contentPath = join(dir, "contexts", `${sha256(value)}.bin`);

    await expect(orphaned.derive({ key: "partial", value }, {
      maxOutputBytes: 100,
      reserveBytes: (bytes) => {
        ledgerBytes += bytes;
        let remaining = bytes;
        return {
          release: (released) => {
            ledgerBytes -= released;
            remaining -= released;
          },
          rollback: () => {
            ledgerBytes -= remaining;
            remaining = 0;
          },
        };
      },
    })).rejects.toMatchObject({ code: "CONTEXT_CLEANUP_FAILED", failures: [{ bytes: 4 }] });
    expect(orphaned.totalBytes()).toBe(4);
    expect(orphaned.orphanedBytes()).toBe(4);
    expect(ledgerBytes).toBe(4);

    await orphaned.cleanupOrphans();
    await expect(readFile(contentPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(orphaned.totalBytes()).toBe(0);
    expect(orphaned.orphanedBytes()).toBe(0);
    expect(ledgerBytes).toBe(0);

    await orphaned.cleanupOrphans();
    expect(orphaned.totalBytes()).toBe(0);
    expect(orphaned.orphanedBytes()).toBe(0);
    expect(ledgerBytes).toBe(0);
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

  test("streamed JSON derive matches canonical ordering, escaping, depth, and identity", async () => {
    const value = JSON.parse('{"z":"","constructor":{"b":2},"__proto__":{"a":1}}') as Record<string, JsonValue>;
    value["z"] = 'quote" slash\\ controls\b\f\n\r\t\u0000\u001f separators\u2028\u2029 pair😀 lone\ud800';
    value["a"] = [{ y: 2, x: 1 }, true, null];
    const expected = canonicalStringify(value);
    const descriptor = await store.derive({ key: "canonical", value });
    expect(await store.load(descriptor.id)).toBe(expected);
    expect(descriptor.bytes).toBe(Buffer.byteLength(expected, "utf8"));
    expect(descriptor.sha256).toBe(sha256(expected));

    let nested: JsonValue = 0;
    for (let i = 0; i < MAX_JSON_DEPTH; i++) nested = [nested];
    const atLimit = await store.derive({ key: "depth-limit", value: nested });
    expect(await store.load(atLimit.id)).toBe(canonicalStringify(nested));
    nested = [nested];
    await expect(store.derive({ key: "too-deep", value: nested })).rejects.toThrow("maximum JSON depth");

    let invoked = false;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 1;
      },
    }) as JsonValue;
    await expect(store.derive({ key: "accessor", value: accessor })).rejects.toThrow("accessor property");
    expect(invoked).toBe(false);
  });

  test("denies large JSON before canonical output allocation and leaves ledger, store, and files unchanged", async () => {
    const moduleUrl = new URL("./context-store.ts", import.meta.url).href;
    const script = `
      import { mkdtemp, readdir } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const { ContextStore, DEFAULT_CONTEXT_STORE_LIMITS } = await import(${JSON.stringify(moduleUrl)});
      const dir = await mkdtemp(join(tmpdir(), "pi-rlm-json-denial-"));
      let materialized = 0;
      let reserved = 0;
      let fullStringifyAttempted = false;
      const store = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, {
        onMaterialize: () => { materialized++; },
      });
      const nativeStringify = JSON.stringify;
      JSON.stringify = (value, ...args) => {
        if ((typeof value === "string" && value.length > 1024) || (value !== null && typeof value === "object")) {
          fullStringifyAttempted = true;
          throw new Error("full canonical stringify attempted");
        }
        return nativeStringify(value, ...args);
      };
      let code = "NO_ERROR";
      try {
        await store.derive({ key: "large", value: { z: "x".repeat(8 * 1024 * 1024), a: [1, true, null] } }, {
          maxOutputBytes: 1,
          reserveBytes: (bytes) => {
            reserved += bytes;
            return { rollback: () => { reserved -= bytes; } };
          },
        });
      } catch (error) {
        code = error?.code ?? error?.message ?? "UNKNOWN";
      } finally {
        JSON.stringify = nativeStringify;
      }
      console.log(nativeStringify({
        code,
        fullStringifyAttempted,
        materialized,
        reserved,
        totalBytes: store.totalBytes(),
        files: await readdir(dir),
      }));
    `;
    const result = await runSubprocess(script, 10_000);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      code: "BUDGET_BYTES",
      fullStringifyAttempted: false,
      materialized: 0,
      reserved: 0,
      totalBytes: 0,
      files: [],
    });
  });

  test("uses full hashes so equal prefixes cannot alias", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-collision-"));
    const collisionPrefix = "0123456789abcdef";
    const hasher = (value: string | Uint8Array) => {
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      return collisionPrefix + sha256(text).slice(collisionPrefix.length);
    };
    const collisionSafe = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, { hasher });
    const first = await collisionSafe.ingestText("first", "alpha");
    const second = await collisionSafe.ingestText("second", "beta");

    expect(first.id).toMatch(/^ctx_[0-9a-f]{64}$/);
    expect(first.id.slice(4, 20)).toBe(second.id.slice(4, 20));
    expect(first.id).not.toBe(second.id);
    expect(await collisionSafe.load(first.id)).toBe("alpha");
    expect(await collisionSafe.load(second.id)).toBe("beta");
  });

  test("loads verified content after restart and rejects corruption, truncation, and hostile ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-restart-"));
    const descriptor = await new ContextStore(dir).ingestText("restart", "durable payload");
    const restarted = new ContextStore(dir);
    expect(new TextDecoder().decode(await restarted.loadFromDisk(descriptor))).toBe("durable payload");

    for (const id of ["ctx_../events", `ctx_${descriptor.sha256.toUpperCase()}`, "ctx_deadbeef"]) {
      await expect(restarted.loadFromDisk({ ...descriptor, id })).rejects.toBeInstanceOf(ContextSpecError);
    }

    const path = join(dir, "contexts", `${descriptor.sha256}.bin`);
    await writeFile(path, "xxxxxxxxxxxxxxx");
    await expect(restarted.loadFromDisk(descriptor)).rejects.toBeInstanceOf(ContextIntegrityError);
    await writeFile(path, "short");
    await expect(restarted.loadFromDisk(descriptor)).rejects.toMatchObject({
      code: "CONTEXT_INTEGRITY_FAILED",
      contextId: descriptor.id,
    });
  });

  test("concurrent independent writers dedupe one complete final payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-concurrent-"));
    const [first, second] = await Promise.all([
      new ContextStore(dir).ingestText("first", "same concurrent payload"),
      new ContextStore(dir).ingestText("second", "same concurrent payload"),
    ]);
    expect(first.id).toBe(second.id);
    expect(await readdir(join(dir, "contexts"))).toEqual([`${first.sha256}.bin`]);
    expect(new TextDecoder().decode(await new ContextStore(dir).loadFromDisk(first))).toBe("same concurrent payload");
  });

  test("a publisher rollback cannot unlink another store's committed dedupe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-cross-store-"));
    const payload = "shared transaction payload";
    let chargedA = 0;
    let chargedB = 0;
    const reserve = (charged: "a" | "b") => (bytes: number) => {
      if (charged === "a") chargedA += bytes;
      else chargedB += bytes;
      let remaining = bytes;
      return {
        commit: () => { remaining = 0; },
        release: (released: number) => {
          remaining -= released;
          if (charged === "a") chargedA -= released;
          else chargedB -= released;
        },
        rollback: () => {
          if (charged === "a") chargedA -= remaining;
          else chargedB -= remaining;
          remaining = 0;
        },
      };
    };
    const publisher = new ContextStore(dir);
    const deduper = new ContextStore(dir);
    const transaction = await publisher.beginDerive({ key: "a", value: payload }, { reserveBytes: reserve("a") });
    const committed = await deduper.derive({ key: "b", value: payload }, { reserveBytes: reserve("b") });

    await transaction.rollback();

    expect(chargedA).toBe(Buffer.byteLength(payload));
    expect(chargedB).toBe(Buffer.byteLength(payload));
    expect(publisher.totalBytes()).toBe(Buffer.byteLength(payload));
    expect(publisher.orphanedBytes()).toBe(Buffer.byteLength(payload));
    expect(deduper.totalBytes()).toBe(Buffer.byteLength(payload));
    expect(await readdir(join(dir, "contexts"))).toEqual([`${committed.sha256}.bin`]);
    expect(new TextDecoder().decode(await new ContextStore(dir).loadFromDisk(committed))).toBe(payload);
  });

  test("rejects a contexts directory symlink without writing outside the run root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-dir-link-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-outside-"));
    await symlink(outside, join(dir, "contexts"), "dir");
    await expect(new ContextStore(dir).ingestText("escape", "must stay inside"))
      .rejects.toMatchObject({ code: "CONTEXT_INTEGRITY_FAILED", reason: "type" });
    expect(await readdir(outside)).toEqual([]);
  });

  test.each(["symlink", "hardlink"] as const)("rejects a final payload %s", async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-final-link-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-final-outside-"));
    await mkdir(join(dir, "contexts"));
    const payload = "linked payload";
    const digest = sha256(payload);
    const external = join(outside, "payload.bin");
    await writeFile(external, payload);
    const finalPath = join(dir, "contexts", `${digest}.bin`);
    if (kind === "symlink") await symlink(external, finalPath);
    else await hardLink(external, finalPath);
    await expect(new ContextStore(dir).loadFromDisk({ id: `ctx_${digest}`, sha256: digest, bytes: payload.length }))
      .rejects.toMatchObject({ code: "CONTEXT_INTEGRITY_FAILED", reason: "type" });
  });

  test.each(["corrupt", "partial"] as const)("post-write %s temp content is never published", async (fault) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-post-write-"));
    const faulted = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, {
      syncFile: async (path) => { await writeFile(path, fault === "partial" ? "x" : "corrupt payload"); },
    });
    await expect(faulted.ingestText("fault", "complete payload"))
      .rejects.toMatchObject({ code: "CONTEXT_INTEGRITY_FAILED" });
    expect((await readdir(join(dir, "contexts")).catch(() => [])).filter((name) => name.endsWith(".bin"))).toEqual([]);
  });

  test("published unlink failure reports final and temp, then settles only the exclusive temp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-published-orphan-"));
    const payload = "published orphan";
    let attempts = 0;
    let charged = 0;
    const faulted = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, {
      unlink: async (path) => {
        if (++attempts <= 2) throw new Error("injected unlink failure");
        await unlink(path);
      },
    });
    await expect(faulted.ingestText("fault", payload, "text/plain", {
      reserveBytes: (bytes) => {
        charged += bytes;
        return { commit: () => {}, release: (released) => { charged -= released; }, rollback: () => { charged -= bytes; } };
      },
    })).rejects.toMatchObject({
      code: "CONTEXT_CLEANUP_FAILED",
      failures: [
        { path: expect.stringMatching(/\.bin$/), bytes: Buffer.byteLength(payload) },
        { path: expect.stringMatching(/\.tmp$/), bytes: Buffer.byteLength(payload) },
      ],
    });
    expect(charged).toBe(Buffer.byteLength(payload));
    expect(faulted.orphanedBytes()).toBe(Buffer.byteLength(payload));
    const orphanFiles = await readdir(join(dir, "contexts"));
    expect(orphanFiles.filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    expect(orphanFiles.filter((name) => name.endsWith(".bin"))).toEqual([`${sha256(payload)}.bin`]);

    await faulted.cleanupOrphans();
    expect(faulted.orphanedBytes()).toBe(Buffer.byteLength(payload));
    expect(charged).toBe(Buffer.byteLength(payload));
    expect(await readdir(join(dir, "contexts"))).toEqual([`${sha256(payload)}.bin`]);
    const reference = { id: `ctx_${sha256(payload)}`, sha256: sha256(payload), bytes: Buffer.byteLength(payload) };
    expect(new TextDecoder().decode(await new ContextStore(dir).loadFromDisk(reference))).toBe(payload);
  });

  test.each(["write", "sync", "rename", "directory sync"] as const)(
    "%s fault never publishes unverified content",
    async (phase) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-rlm-ctx-fault-"));
      const payload = "complete payload";
      const digest = sha256(payload);
      const faulted = new ContextStore(dir, DEFAULT_CONTEXT_STORE_LIMITS, {
        ...(phase === "write" ? {
          writeFile: async (path, bytes) => {
            await writeFile(path, bytes.subarray(0, 3), { flag: "wx" });
            throw new Error("injected write fault");
          },
        } : {}),
        ...(phase === "sync" ? { syncFile: async () => { throw new Error("injected sync fault"); } } : {}),
        ...(phase === "rename" ? { rename: async () => { throw new Error("injected rename fault"); } } : {}),
        ...(phase === "directory sync" ? {
          syncDirectory: async () => { throw new Error("injected directory sync fault"); },
        } : {}),
      });
      await expect(faulted.ingestText("fault", payload)).rejects.toBeInstanceOf(Error);
      const files = await readdir(join(dir, "contexts")).catch(() => []);
      expect(files.filter((name) => name.endsWith(".bin"))).toEqual(
        phase === "directory sync" ? [`${digest}.bin`] : [],
      );
      expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      if (phase === "directory sync") {
        const reference = { id: `ctx_${digest}`, sha256: digest, bytes: Buffer.byteLength(payload) };
        expect(new TextDecoder().decode(await new ContextStore(dir).loadFromDisk(reference))).toBe(payload);
        expect(faulted.orphanedBytes()).toBe(Buffer.byteLength(payload));
      }
    },
  );

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
