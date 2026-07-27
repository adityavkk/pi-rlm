import { describe, expect, test } from "bun:test";
import {
  MAX_ARBITRATION_ENTRIES,
  MAX_ARBITRATION_ORDINAL,
  MAX_ARBITRATION_ORPHANS,
  decodeGenerationRecord,
  decodeReleaseRecord,
  encodeGenerationRecord,
  encodeReleaseRecord,
  generationIntentFilename,
  inspectArbitrationDirectory,
  releaseIntentFilename,
  releaseSlotFilename,
  scanArbitrationDirectory,
  successorSlotFilename,
  type ArbitrationDirectoryEntry,
  type GenerationRecord,
  type ReleaseRecord,
} from "./run-writer-protocol.ts";

const token = (digit: string): string => digit.repeat(64);
const identity = { rootDev: 9_007_199_254_740_993n, rootIno: 18_014_398_509_481_987n, runDev: 4n, runIno: 5n };
const generation = (overrides: Partial<GenerationRecord> = {}): GenerationRecord => ({
  schemaVersion: 1, type: "generation", token: token("a"), predecessor: null, ordinal: 1, role: "writer",
  ...identity, runName: `run-${"1".repeat(32)}`, pid: 123, processNonce: token("b"), osProcessIdentity: null,
  createdAtMs: 456, ...overrides,
});
const release = (overrides: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  schemaVersion: 1, type: "release", token: token("c"), generation: token("a"), processNonce: token("b"),
  ...identity, releasedAtMs: 789, ...overrides,
});
const entry = (name: string, bytes: Uint8Array, ino: bigint, nlink = 2n, mode = 0o100600): ArbitrationDirectoryEntry => ({
  name, load: { status: "loaded", bytes, stat: {
    dev: 7n, ino, mode, nlink, size: BigInt(bytes.byteLength), isFile: true,
  } },
});
const failedEntry = (name: string, error: unknown): ArbitrationDirectoryEntry =>
  ({ name, load: { status: "failed", error } });
const linked = (intentName: string, slotName: string, bytes: Uint8Array, ino: bigint): ArbitrationDirectoryEntry[] => [
  entry(intentName, bytes, ino), entry(slotName, bytes, ino),
];

describe("writer arbitration canonical protocol", () => {
  test("uses exact canonical fields, order, newline, filenames, and bigint decimal identities", () => {
    const encoded = encodeGenerationRecord(generation());
    expect(new TextDecoder().decode(encoded)).toBe(
      `{"schemaVersion":1,"type":"generation","token":"${token("a")}","predecessor":null,"ordinal":1,"role":"writer","rootDev":"9007199254740993","rootIno":"18014398509481987","runDev":"4","runIno":"5","runName":"run-${"1".repeat(32)}","pid":123,"processNonce":"${token("b")}","osProcessIdentity":null,"createdAtMs":456}\n`,
    );
    expect(decodeGenerationRecord(encoded)).toEqual(generation());
    expect(decodeReleaseRecord(encodeReleaseRecord(release()))).toEqual(release());
    expect(generationIntentFilename(token("a"))).toBe(`gen-${token("a")}.json`);
    expect(releaseIntentFilename(token("c"))).toBe(`rel-${token("c")}.json`);
    expect(successorSlotFilename(null)).toBe("next-root.claim");
    expect(successorSlotFilename(token("a"))).toBe(`next-${token("a")}.claim`);
    expect(releaseSlotFilename(token("a"))).toBe(`released-${token("a")}.claim`);
  });

  test("rejects noncanonical bytes, extra fields, unsafe identity encodings, and malformed filenames", () => {
    const canonical = new TextDecoder().decode(encodeGenerationRecord(generation()));
    expect(() => decodeGenerationRecord(Buffer.from(canonical.slice(0, -1)))).toThrow(/trailing newline/);
    expect(() => decodeGenerationRecord(Buffer.from(canonical.replace('"rootDev":"9007199254740993"', '"rootDev":"09007199254740993"')))).toThrow(/rootDev/);
    expect(() => decodeGenerationRecord(Buffer.from(canonical.replace('"schemaVersion":1', '"extra":0,"schemaVersion":1')))).toThrow(/fields/);
    expect(() => decodeGenerationRecord(Buffer.from(canonical.replace('"type":"generation","token"', '"token":"' + token("a") + '","type":"generation","ignored"')))).toThrow();
    expect(() => successorSlotFilename("A".repeat(64))).toThrow(/token/);
  });

  test("reserves M for irreversible retirement and permits ordinary roles only through M-1", () => {
    const predecessor = token("d");
    expect(() => encodeGenerationRecord(generation({ predecessor, ordinal: MAX_ARBITRATION_ORDINAL, role: "writer" }))).toThrow(/retirement/);
    expect(() => encodeGenerationRecord(generation({ predecessor, ordinal: MAX_ARBITRATION_ORDINAL - 1, role: "retirement" }))).toThrow(/retirement/);
    expect(decodeGenerationRecord(encodeGenerationRecord(generation({
      token: token("e"), predecessor, ordinal: MAX_ARBITRATION_ORDINAL, role: "retirement",
    }))).role).toBe("retirement");
  });

  test("builds the predecessor chain while explicitly classifying unreferenced intents", () => {
    const first = generation();
    const second = generation({ token: token("d"), predecessor: first.token, ordinal: 2, role: "retention", pid: 456 });
    const firstRelease = release();
    const malformed = Buffer.from("{partial");
    const validOrphan = generation({ token: token("e"), predecessor: token("f"), ordinal: 2 });
    const entries = [
      ...linked(generationIntentFilename(first.token), successorSlotFilename(null), encodeGenerationRecord(first), 10n),
      ...linked(releaseIntentFilename(firstRelease.token), releaseSlotFilename(first.token), encodeReleaseRecord(firstRelease), 11n),
      ...linked(generationIntentFilename(second.token), successorSlotFilename(first.token), encodeGenerationRecord(second), 12n),
      entry("gen-partial.json", malformed, 13n, 1n),
      entry(generationIntentFilename(validOrphan.token), encodeGenerationRecord(validOrphan), 14n, 1n),
    ];
    const inspected = inspectArbitrationDirectory(entries);
    expect(inspected.generations.map((item) => item.token)).toEqual([first.token, second.token]);
    expect(inspected.releases.get(first.token)).toEqual(firstRelease);
    expect(inspected.tip).toEqual(second);
    expect(inspected.orphans).toEqual([
      { name: generationIntentFilename(validOrphan.token), recordType: "generation", validity: "canonical" },
      { name: "gen-partial.json", recordType: "generation", validity: "malformed" },
    ]);
  });

  test("only authoritative slot references make malformed or mismatched records poison", () => {
    const first = generation();
    const bytes = encodeGenerationRecord(first);
    expect(inspectArbitrationDirectory([entry("gen-arbitrary.json", Buffer.from("bad"), 1n, 1n)]).orphans)
      .toEqual([{ name: "gen-arbitrary.json", recordType: "generation", validity: "malformed" }]);
    expect(() => inspectArbitrationDirectory([
      entry(generationIntentFilename(first.token), bytes, 1n),
      entry(successorSlotFilename(null), Buffer.from("bad"), 1n),
    ])).toThrow(expect.objectContaining({ code: "WRITER_PROTOCOL_CORRUPT" }));
    expect(() => inspectArbitrationDirectory([
      entry(generationIntentFilename(first.token), bytes, 1n),
      entry(successorSlotFilename(null), bytes, 2n),
    ])).toThrow(/intent inode/);
  });

  test("fails closed on dangling slots, releases of retirement, and unexpected entries", () => {
    const dangling = generation({ predecessor: token("d"), ordinal: 2 });
    expect(() => inspectArbitrationDirectory(linked(
      generationIntentFilename(dangling.token), successorSlotFilename(dangling.predecessor), encodeGenerationRecord(dangling), 1n,
    ))).toThrow(/not reachable/);
    expect(() => inspectArbitrationDirectory([failedEntry("notes.txt", new Error("ignored"))])).toThrow(/unexpected/);
    const retirement = generation({
      token: token("d"), predecessor: token("e"), ordinal: MAX_ARBITRATION_ORDINAL, role: "retirement",
    });
    const retirementRelease = release({ generation: retirement.token });
    const synthetic = Array.from({ length: MAX_ARBITRATION_ORDINAL - 1 }, (_, index) => generation({
      token: index.toString(16).padStart(64, "0"), predecessor: index === 0 ? null : (index - 1).toString(16).padStart(64, "0"),
      ordinal: index + 1, role: "writer",
    }));
    synthetic.push({ ...retirement, predecessor: synthetic.at(-1)!.token });
    const all: ArbitrationDirectoryEntry[] = [];
    synthetic.forEach((item, index) => all.push(...linked(
      generationIntentFilename(item.token), successorSlotFilename(item.predecessor), encodeGenerationRecord(item), BigInt(index + 1),
    )));
    all.push(...linked(releaseIntentFilename(retirementRelease.token), releaseSlotFilename(retirement.token), encodeReleaseRecord(retirementRelease), 5000n));
    expect(() => inspectArbitrationDirectory(all)).toThrow(/retirement generation cannot be released/);
  });

  test("enforces exact private metadata while keeping malformed unreferenced files non-authoritative", () => {
    const record = generation();
    const content = encodeGenerationRecord(record);
    expect(inspectArbitrationDirectory([
      entry(generationIntentFilename(record.token), content, 1n, 2n),
    ]).orphans).toEqual([{
      name: generationIntentFilename(record.token), recordType: "generation", validity: "malformed",
    }]);
    expect(inspectArbitrationDirectory([
      entry(generationIntentFilename(record.token), content, 1n, 1n, 0o104600),
    ]).orphans[0]?.validity).toBe("malformed");
    expect(() => inspectArbitrationDirectory([
      entry(generationIntentFilename(record.token), content, 1n, 2n, 0o104600),
      entry(successorSlotFilename(null), content, 1n, 2n, 0o104600),
    ])).toThrow(/canonical private/);
  });

  test("does not swallow an undefined directory-stat rejection", async () => {
    await expect(scanArbitrationDirectory("/unused", {
      async statDirectory() { return Promise.reject(undefined); },
      async list() { throw new Error("must not list"); },
      async load() { throw new Error("must not load"); },
    })).rejects.toMatchObject({ code: "WRITER_PROTOCOL_CORRUPT" });
  });

  test("enforces independent entry and orphan budgets and requests a bounded listing", async () => {
    expect(() => inspectArbitrationDirectory(Array.from({ length: MAX_ARBITRATION_ENTRIES + 1 }, (_, index) =>
      failedEntry(`gen-${index}.json`, new Error("partial"))))).toThrow(expect.objectContaining({ code: "WRITER_PROTOCOL_LIMIT" }));
    expect(() => inspectArbitrationDirectory(Array.from({ length: MAX_ARBITRATION_ORPHANS + 1 }, (_, index) =>
      failedEntry(`gen-orphan-${index}.json`, new Error("partial"))))).toThrow(/orphan budget/);
    let requested = 0;
    let loads = 0;
    await expect(scanArbitrationDirectory("/unused", {
      async statDirectory() { return { dev: 1n, ino: 2n, mode: 0o40700, isDirectory: true }; },
      async list(_path, maximum) { requested = maximum; return Array.from({ length: maximum + 1 }, (_, i) => String(i)); },
      async load() { loads++; throw new Error("must not load"); },
    })).rejects.toMatchObject({ code: "WRITER_PROTOCOL_LIMIT" });
    expect(requested).toBe(MAX_ARBITRATION_ENTRIES);
    expect(loads).toBe(0);
  });
});
