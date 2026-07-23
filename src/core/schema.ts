/**
 * Minimal JSON Schema validator (pure).
 *
 * Supports the subset pi-rlm programs use: type, required, properties,
 * additionalProperties, items, enum, and integer vs number. It returns a list
 * of human-readable errors (empty means valid) so the broker can attach precise
 * feedback to a recoverable trajectory observation.
 */

import { isJsonObject, type JsonObject, type JsonValue } from "./json.ts";

const typeOf = (value: JsonValue): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const matchesType = (value: JsonValue, type: string): boolean => {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isJsonObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
};

export const validateAgainstSchema = (value: JsonValue, schema: JsonObject, path = "$"): string[] => {
  const errors: string[] = [];
  const type = schema["type"];
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${path}: expected ${type} but got ${typeOf(value)}`);
    return errors;
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) {
    const ok = enumValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
    if (!ok) errors.push(`${path}: value not in enum`);
  }

  if (isJsonObject(value)) {
    const required = schema["required"];
    if (Array.isArray(required))
      for (const key of required)
        if (typeof key === "string" && !(key in value)) errors.push(`${path}.${key}: required`);
    const properties = schema["properties"] ?? null;
    if (isJsonObject(properties)) {
      for (const key of Object.keys(properties)) {
        if (key in value) {
          const sub = properties[key] as JsonValue;
          if (isJsonObject(sub)) errors.push(...validateAgainstSchema(value[key] as JsonValue, sub, `${path}.${key}`));
        }
      }
      const additional = schema["additionalProperties"] ?? null;
      if (additional === false) {
        for (const key of Object.keys(value))
          if (!(key in properties)) errors.push(`${path}.${key}: additional property not allowed`);
      } else if (isJsonObject(additional)) {
        for (const key of Object.keys(value))
          if (!(key in properties)) errors.push(...validateAgainstSchema(value[key] as JsonValue, additional, `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value)) {
    const items = schema["items"] ?? null;
    if (isJsonObject(items))
      value.forEach((item, i) => errors.push(...validateAgainstSchema(item, items, `${path}[${i}]`)));
  }

  return errors;
};

export const isValidAgainstSchema = (value: JsonValue, schema: JsonObject): boolean =>
  validateAgainstSchema(value, schema).length === 0;
