import { describe, expect, test } from "bun:test";
import { byteLength, headPreview, headTailPreview, truncateUtf8, truncateUtf8Tail } from "./preview.ts";

describe("utf-8 truncation", () => {
  test("does not split multibyte code points (head)", () => {
    const s = "a\u00e9\u{1f600}b"; // 'a', 'é'(2 bytes), emoji(4 bytes), 'b'
    expect(byteLength(s)).toBe(1 + 2 + 4 + 1);
    // budget cuts inside the emoji; must back off to before it
    const t = truncateUtf8(s, 5);
    expect(t).toBe("a\u00e9");
    expect(byteLength(t)).toBeLessThanOrEqual(5);
  });

  test("does not split multibyte code points (tail)", () => {
    const s = "a\u00e9\u{1f600}b";
    const t = truncateUtf8Tail(s, 5);
    expect(t).toBe("\u{1f600}b");
    expect(byteLength(t)).toBeLessThanOrEqual(5);
  });
});

describe("previews report omitted bytes", () => {
  test("no truncation when within budget", () => {
    const p = headTailPreview("hello", { headBytes: 10, tailBytes: 10 });
    expect(p).toEqual({ text: "hello", truncated: false, originalBytes: 5, omittedBytes: 0 });
  });

  test("head-tail preserves boundaries and accounts bytes", () => {
    const body = "0123456789".repeat(10); // 100 bytes
    const p = headTailPreview(body, { headBytes: 10, tailBytes: 10, separator: "|" });
    expect(p.truncated).toBe(true);
    expect(p.originalBytes).toBe(100);
    expect(p.omittedBytes).toBe(80);
    expect(p.text).toBe(`${body.slice(0, 10)}|${body.slice(-10)}`);
  });

  test("head preview truncates", () => {
    const p = headPreview("abcdef", 3);
    expect(p).toEqual({ text: "abc", truncated: true, originalBytes: 6, omittedBytes: 3 });
  });
});
