import { readFileSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

export const MAX_CAPTURE_BYTES = 128 * 1024;

export const expectedProjection = {
  error: {
    code: "RLM_SOURCE_REQUIRED",
    message: "A normative /rlm source form is required.",
  },
  errorCode: "RLM_SOURCE_REQUIRED",
  mode: null,
  output: null,
  runId: null,
  status: "failed",
  truncation: { omittedBytes: 0, originalBytes: 0, truncated: false },
  usage: null,
  warningCodes: [],
};

const expectedMetadata = {
  runId: null,
  status: "failed",
  mode: null,
  output: null,
  usage: null,
  warningCodes: [],
  truncation: { truncated: false, originalBytes: 0, omittedBytes: 0 },
  errorCode: "RLM_SOURCE_REQUIRED",
};

const fail = (message) => { throw new Error(message); };
const exact = (actual, expected, message) => {
  if (!isDeepStrictEqual(actual, expected)) fail(message);
};
const exactKeys = (value, keys, message) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message);
  exact(Object.keys(value).sort(), [...keys].sort(), message);
};

export const parseStrictJsonl = (raw, label) => {
  if (Buffer.byteLength(raw, "utf8") > MAX_CAPTURE_BYTES) fail(`${label} was not bounded`);
  if (raw.length === 0 || !raw.endsWith("\n")) fail(`${label} was not complete JSONL`);
  const lines = raw.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) fail(`${label} contained an empty or prose record`);
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { return fail(`${label} record ${index + 1} was not JSON`); }
  });
};

const assertProjection = (content, label) => {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 4 * 1024)
    fail(`${label} content was not bounded JSON`);
  let projection;
  try { projection = JSON.parse(content); }
  catch { return fail(`${label} content was arbitrary prose`); }
  exact(projection, expectedProjection, `${label} projection was not exact RLM_SOURCE_REQUIRED failure`);
};

const assertHeader = (header, caseName) => {
  exactKeys(header, ["type", "version", "id", "timestamp", "cwd"], `${caseName} session header was malformed`);
  if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string"
    || typeof header.timestamp !== "string" || typeof header.cwd !== "string")
    fail(`${caseName} session header was malformed`);
};

export const assertPackedSmokeLifecycle = ({ outputRaw, stderrRaw, sessionRaw, caseName }) => {
  if (Buffer.byteLength(stderrRaw, "utf8") > MAX_CAPTURE_BYTES) fail(`${caseName} Pi stderr was not bounded`);
  if (stderrRaw !== "") fail(`${caseName} Pi wrote stderr during offline command lifecycle`);

  const records = parseStrictJsonl(outputRaw, `${caseName} Pi output`);
  if (records.length !== 4) fail(`${caseName} emitted duplicate, missing, or unexpected lifecycle records`);
  const [header, appended, started, ended] = records;
  assertHeader(header, caseName);

  exactKeys(appended, ["type", "entry"], `${caseName} custom result append was malformed`);
  if (appended.type !== "entry_appended") fail(`${caseName} custom result append was missing`);
  exactKeys(appended.entry, ["type", "customType", "data", "id", "parentId", "timestamp"], `${caseName} custom result append was malformed`);
  if (appended.entry.type !== "custom" || appended.entry.customType !== "pi-rlm-result"
    || typeof appended.entry.id !== "string" || typeof appended.entry.parentId !== "string"
    || typeof appended.entry.timestamp !== "string") fail(`${caseName} custom result append was malformed`);
  exact(appended.entry.data, expectedMetadata, `${caseName} custom result metadata was not exact`);

  const assertMessage = (record, type) => {
    exactKeys(record, ["type", "message"], `${caseName} ${type} was malformed`);
    if (record.type !== type) fail(`${caseName} ${type} was missing`);
    exactKeys(record.message, ["role", "customType", "content", "display", "details", "timestamp"], `${caseName} ${type} was malformed`);
    if (record.message.role !== "custom" || record.message.customType !== "pi-rlm-result"
      || record.message.display !== true || typeof record.message.timestamp !== "number")
      fail(`${caseName} ${type} was malformed`);
    exact(record.message.details, expectedMetadata, `${caseName} ${type} metadata was not exact`);
    assertProjection(record.message.content, `${caseName} ${type}`);
  };
  assertMessage(started, "message_start");
  assertMessage(ended, "message_end");
  exact(started.message, ended.message, `${caseName} custom message lifecycle did not match`);

  const persisted = parseStrictJsonl(sessionRaw, `${caseName} persisted session`);
  if (persisted.length !== 4) fail(`${caseName} persisted duplicate, missing, or unexpected entries`);
  const [persistedHeader, stateEntry, customEntry, customMessage] = persisted;
  assertHeader(persistedHeader, caseName);
  if (persistedHeader.id !== header.id || persistedHeader.cwd !== header.cwd)
    fail(`${caseName} output and persisted session did not match`);
  exactKeys(stateEntry, ["type", "id", "parentId", "timestamp", "thinkingLevel"], `${caseName} durable session state was malformed`);
  if (stateEntry.type !== "thinking_level_change" || stateEntry.thinkingLevel !== "off"
    || typeof stateEntry.id !== "string" || stateEntry.parentId !== null || typeof stateEntry.timestamp !== "string")
    fail(`${caseName} durable session state was malformed`);
  exact(customEntry, appended.entry, `${caseName} custom audit was not durably persisted`);
  if (customEntry.parentId !== stateEntry.id) fail(`${caseName} result/session lifecycle did not match`);
  exactKeys(customMessage, ["type", "customType", "content", "display", "details", "id", "parentId", "timestamp"], `${caseName} durable custom message was malformed`);
  if (customMessage.type !== "custom_message" || customMessage.customType !== "pi-rlm-result"
    || customMessage.display !== true || customMessage.parentId !== customEntry.id)
    fail(`${caseName} durable custom message was malformed`);
  exact(customMessage.details, expectedMetadata, `${caseName} durable custom message metadata was not exact`);
  assertProjection(customMessage.content, `${caseName} durable custom message`);
  return { records, persisted };
};

const snapshot = (root) => {
  const entries = [];
  const visit = (path, relative) => {
    const stat = lstatSync(path, { bigint: true });
    const item = {
      path: relative,
      mode: stat.mode.toString(), uid: stat.uid.toString(), gid: stat.gid.toString(),
      size: stat.size.toString(), ino: stat.ino.toString(),
      mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
    };
    if (stat.isSymbolicLink()) item.target = readlinkSync(path);
    entries.push(item);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
    }
  };
  visit(root, ".");
  return JSON.stringify(entries, null, 2) + "\n";
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate") {
    const [outputPath, stderrPath, sessionPath, caseName] = args;
    assertPackedSmokeLifecycle({
      outputRaw: readFileSync(outputPath, "utf8"),
      stderrRaw: readFileSync(stderrPath, "utf8"),
      sessionRaw: readFileSync(sessionPath, "utf8"),
      caseName,
    });
    console.log(`${caseName} exact lifecycle and durable result passed`);
  } else if (command === "snapshot") {
    process.stdout.write(snapshot(args[0]));
  } else {
    fail("expected validate or snapshot command");
  }
}
