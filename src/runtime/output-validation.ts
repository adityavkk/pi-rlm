/** Shared direct/fallback final-output validation. */

import { isJsonObject, type JsonValue } from "../core/json.ts";
import type { RlmOutputField } from "../core/program.ts";
import { validateAgainstSchema } from "../core/schema.ts";

export const validateOutputContract = (
  candidate: JsonValue,
  outputs: readonly RlmOutputField[],
): string[] => {
  if (outputs.length === 0) return [];
  if (!isJsonObject(candidate)) return ["answer must be an object containing every declared output"];
  const errors: string[] = [];
  for (const field of outputs) {
    if (!Object.prototype.hasOwnProperty.call(candidate, field.name)) {
      errors.push(`${field.name}: required output missing`);
      continue;
    }
    errors.push(...validateAgainstSchema(candidate[field.name] as JsonValue, field.schema, field.name));
  }
  return errors;
};

export const outputContractErrorMessage = (errors: readonly string[]): string =>
  `answer did not satisfy the output contract: ${errors.join("; ")}`;
