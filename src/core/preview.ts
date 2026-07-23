/**
 * UTF-8 aware truncation and head-tail previews.
 *
 * Previews never split a code point. Every truncated preview reports the
 * original byte size and the number of omitted bytes so callers can prove that
 * bounded context, not full source, entered a model request.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export const byteLength = (text: string): number => encoder.encode(text).length;

/** True when the byte at `index` is a UTF-8 continuation byte (0b10xxxxxx). */
const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** Largest prefix of `text` whose UTF-8 encoding fits within `maxBytes`. */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && isContinuation(bytes[end] as number)) end--;
  return decoder.decode(bytes.subarray(0, end));
};

/** Suffix of `text` whose UTF-8 encoding fits within `maxBytes`, on a boundary. */
export const truncateUtf8Tail = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && isContinuation(bytes[start] as number)) start++;
  return decoder.decode(bytes.subarray(start));
};

export interface Preview {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly omittedBytes: number;
}

export interface HeadTailOptions {
  readonly headBytes: number;
  readonly tailBytes: number;
  readonly separator?: string;
}

/** Bounded preview keeping a head and tail slice, joined by a marker. */
export const headTailPreview = (text: string, options: HeadTailOptions): Preview => {
  const originalBytes = byteLength(text);
  const budget = Math.max(0, options.headBytes) + Math.max(0, options.tailBytes);
  if (originalBytes <= budget) {
    return { text, truncated: false, originalBytes, omittedBytes: 0 };
  }
  const head = truncateUtf8(text, options.headBytes);
  const tail = truncateUtf8Tail(text, options.tailBytes);
  const keptBytes = byteLength(head) + byteLength(tail);
  const omittedBytes = originalBytes - keptBytes;
  const separator = options.separator ?? `\n... [${omittedBytes} bytes omitted] ...\n`;
  return { text: `${head}${separator}${tail}`, truncated: true, originalBytes, omittedBytes };
};

/** Head-only bounded preview. */
export const headPreview = (text: string, maxBytes: number): Preview => {
  const originalBytes = byteLength(text);
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes, omittedBytes: 0 };
  }
  const head = truncateUtf8(text, maxBytes);
  const omittedBytes = originalBytes - byteLength(head);
  return { text: head, truncated: true, originalBytes, omittedBytes };
};
