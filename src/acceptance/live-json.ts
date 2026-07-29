import { canonicalStringify, isJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../core/json.ts";

export class LiveContractError extends Error {
  readonly code = "LIVE_CONTRACT_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "LiveContractError";
  }
}

export const liveFail = (message: string): never => { throw new LiveContractError(message); };
export const liveOwn = (value: JsonObject, key: string): JsonValue | undefined =>
  Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
export const liveObject = (value: JsonValue, label: string): JsonObject =>
  isJsonObject(value) ? value : liveFail(`${label} must be an object`);
export const liveExactKeys = (value: JsonObject, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    liveFail(`${label} fields are not exact`);
};
export const livePattern = (value: JsonValue | undefined, pattern: RegExp, label: string): string =>
  typeof value === "string" && pattern.test(value) ? value : liveFail(`${label} is invalid`);
export const liveEnum = <T extends string>(value: JsonValue | undefined, values: readonly T[], label: string): T =>
  typeof value === "string" && values.includes(value as T) ? value as T : liveFail(`${label} is invalid`);
export const liveInteger = (value: JsonValue | undefined, min: number, max: number, label: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value : liveFail(`${label} is outside its finite integer bounds`);
export const liveFinite = (value: JsonValue | undefined, min: number, max: number, label: string): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value : liveFail(`${label} is outside its finite bounds`);
export const liveBoolean = (value: JsonValue | undefined, label: string): boolean =>
  typeof value === "boolean" ? value : liveFail(`${label} must be boolean`);

export const parseCanonicalLiveJson = (text: string, maximumBytes: number, label: string): JsonValue => {
  if (Buffer.byteLength(text, "utf8") > maximumBytes) liveFail(`${label} exceeds its byte bound`);
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { return liveFail(`${label} is not JSON`); }
  const parsed = parseJsonValue(raw);
  if (!parsed.ok) return liveFail(`${label} is not strict JSON`);
  if (canonicalStringify(parsed.value) !== text) liveFail(`${label} is not canonical JSON`);
  return parsed.value;
};

export const strictLiveJson = (input: unknown, label: string): JsonValue => {
  const parsed = parseJsonValue(input);
  return parsed.ok ? parsed.value : liveFail(`${label} is not strict JSON`);
};
