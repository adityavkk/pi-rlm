/**
 * Minimal JSON Schema validator (pure).
 *
 * Supported subset: type (one primitive type name), required (unique string
 * array), properties (schema map), additionalProperties (boolean or schema),
 * items (one schema), and enum (non-empty, canonically unique JSON values).
 * Boolean schemas, type arrays, tuple items, and every other keyword are
 * rejected during normalization.
 */

import {
  canonicalStringify,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJsonValue,
} from "./json.ts";
import { err, ok, type Result } from "./result.ts";

export const SUPPORTED_SCHEMA_TYPES = ["array", "boolean", "integer", "null", "number", "object", "string"] as const;

const SCHEMA_TYPES = new Set<string>(SUPPORTED_SCHEMA_TYPES);
const SCHEMA_KEYWORDS = new Set<string>([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "enum",
]);
const hasOwn = (object: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
const nullSchema = (): Record<string, JsonValue> => Object.create(null) as Record<string, JsonValue>;

export interface SchemaError {
  readonly path: string;
  readonly message: string;
}

/** Normalize an untrusted schema and reject everything outside the documented subset. */
export const normalizeJsonSchema = (input: unknown): Result<JsonObject, SchemaError[]> => {
  const parsed = parseJsonValue(input);
  if (!parsed.ok) return err([{ path: parsed.path, message: parsed.reason }]);
  if (!isJsonObject(parsed.value)) return err([{ path: "$", message: "schema must be a JSON object" }]);

  const errors: SchemaError[] = [];
  const walk = (schema: JsonObject, path: string): JsonObject => {
    const out = nullSchema();
    for (const keyword of Object.keys(schema)) {
      if (!SCHEMA_KEYWORDS.has(keyword))
        errors.push({ path: childPath(path, keyword), message: `unsupported JSON Schema keyword "${keyword}"` });
    }

    if (hasOwn(schema, "type")) {
      const type = schema["type"];
      if (typeof type !== "string")
        errors.push({ path: `${path}.type`, message: "type must be one supported type name; type arrays are not supported" });
      else if (!SCHEMA_TYPES.has(type)) errors.push({ path: `${path}.type`, message: `unsupported JSON Schema type "${type}"` });
      else out["type"] = type;
    }

    if (hasOwn(schema, "required")) {
      const required = schema["required"];
      if (!Array.isArray(required)) errors.push({ path: `${path}.required`, message: "required must be an array of unique strings" });
      else {
        const seen = new Set<string>();
        let valid = true;
        required.forEach((name, index) => {
          if (typeof name !== "string") {
            errors.push({ path: `${path}.required[${index}]`, message: "required entries must be strings" });
            valid = false;
          } else if (seen.has(name)) {
            errors.push({ path: `${path}.required[${index}]`, message: `duplicate required property "${name}"` });
            valid = false;
          } else seen.add(name);
        });
        if (valid) out["required"] = required;
      }
    }

    if (hasOwn(schema, "properties")) {
      const properties = schema["properties"];
      if (!isJsonObject(properties)) errors.push({ path: `${path}.properties`, message: "properties must be an object of schemas" });
      else {
        const normalizedProperties = nullSchema();
        for (const key of Object.keys(properties)) {
          const propertySchema = properties[key];
          const propertyPath = childPath(`${path}.properties`, key);
          if (!isJsonObject(propertySchema))
            errors.push({ path: propertyPath, message: "property schema must be a JSON object" });
          else normalizedProperties[key] = walk(propertySchema, propertyPath);
        }
        out["properties"] = normalizedProperties;
      }
    }

    if (hasOwn(schema, "additionalProperties")) {
      const additional = schema["additionalProperties"];
      if (typeof additional === "boolean") out["additionalProperties"] = additional;
      else if (isJsonObject(additional)) out["additionalProperties"] = walk(additional, `${path}.additionalProperties`);
      else errors.push({ path: `${path}.additionalProperties`, message: "additionalProperties must be a boolean or schema object" });
    }

    if (hasOwn(schema, "items")) {
      const items = schema["items"];
      if (!isJsonObject(items)) errors.push({ path: `${path}.items`, message: "items must be one schema object; tuple forms are not supported" });
      else out["items"] = walk(items, `${path}.items`);
    }

    if (hasOwn(schema, "enum")) {
      const values = schema["enum"];
      if (!Array.isArray(values) || values.length === 0)
        errors.push({ path: `${path}.enum`, message: "enum must be a non-empty array" });
      else {
        const identities = new Set<string>();
        let valid = true;
        values.forEach((value, index) => {
          const identity = canonicalStringify(value);
          if (identities.has(identity)) {
            errors.push({ path: `${path}.enum[${index}]`, message: "enum values must be canonically unique" });
            valid = false;
          }
          identities.add(identity);
        });
        if (valid) out["enum"] = values;
      }
    }

    return out;
  };

  const schema = walk(parsed.value, "$schema");
  return errors.length > 0 ? err(errors) : ok(schema);
};

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
      return false;
  }
};

const validateNormalized = (value: JsonValue, schema: JsonObject, path: string): string[] => {
  const errors: string[] = [];
  const type = schema["type"];
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${path}: expected ${type} but got ${typeOf(value)}`);
    return errors;
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) {
    const identity = canonicalStringify(value);
    if (!enumValues.some((candidate) => canonicalStringify(candidate) === identity)) errors.push(`${path}: value not in enum`);
  }

  if (isJsonObject(value)) {
    const required = schema["required"];
    if (Array.isArray(required))
      for (const key of required)
        if (typeof key === "string" && !hasOwn(value, key)) errors.push(`${childPath(path, key)}: required`);

    const declared = schema["properties"];
    const properties = isJsonObject(declared) ? declared : null;
    if (properties) {
      for (const key of Object.keys(properties)) {
        if (hasOwn(value, key))
          errors.push(...validateNormalized(value[key] as JsonValue, properties[key] as JsonObject, childPath(path, key)));
      }
    }

    const additional = schema["additionalProperties"];
    if (additional === false) {
      for (const key of Object.keys(value))
        if (!properties || !hasOwn(properties, key)) errors.push(`${childPath(path, key)}: additional property not allowed`);
    } else if (isJsonObject(additional)) {
      for (const key of Object.keys(value))
        if (!properties || !hasOwn(properties, key))
          errors.push(...validateNormalized(value[key] as JsonValue, additional, childPath(path, key)));
    }
  }

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (isJsonObject(items))
      value.forEach((item, i) => errors.push(...validateNormalized(item, items, `${path}[${i}]`)));
  }

  return errors;
};

/** Validate a JSON value. Invalid or unsupported schemas fail closed. */
export const validateAgainstSchema = (value: JsonValue, schema: JsonObject, path = "$"): string[] => {
  const parsedValue = parseJsonValue(value);
  if (!parsedValue.ok) return [`${path}: invalid JSON value (${parsedValue.reason} at ${parsedValue.path})`];
  const normalized = normalizeJsonSchema(schema);
  if (!normalized.ok)
    return normalized.error.map((error) => `${path}: invalid JSON schema at ${error.path}: ${error.message}`);
  return validateNormalized(parsedValue.value, normalized.value, path);
};

export const isValidAgainstSchema = (value: JsonValue, schema: JsonObject): boolean =>
  validateAgainstSchema(value, schema).length === 0;
