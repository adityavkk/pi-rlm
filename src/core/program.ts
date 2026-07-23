/**
 * RlmProgram: the typed, declarative contract a launcher submits to start a run.
 *
 * Normalization is pure and total: it trims text, validates identifiers, rejects
 * reserved-name collisions and duplicates, and returns every error at once for a
 * good authoring experience. The normalized program is content-addressable and
 * feeds prompt construction and replay identity.
 */

import { type JsonObject, type JsonValue, parseJsonValue } from "./json.ts";
import { err, ok, type Result } from "./result.ts";

/** Reserved guest globals an input name must not shadow. */
export const RESERVED_NAMES = new Set<string>([
  "objective",
  "input",
  "inputs",
  "variables",
  "budget",
  "workspace",
  "console",
  "llm",
  "agent",
  "recurse",
  "phase",
  "checkpoint",
  "emit",
  "answer",
  "contexts",
  "artifacts",
  "tools",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface RlmInput {
  readonly name: string;
  readonly adapter: string;
  readonly description: string;
  readonly constraints?: string;
}

export interface RlmOutputField {
  readonly name: string;
  readonly schema: JsonObject;
  readonly description?: string;
}

export interface RlmProgram {
  readonly objective: string;
  readonly inputs: readonly RlmInput[];
  readonly outputs: readonly RlmOutputField[];
  readonly profile: string;
  readonly metadata?: JsonObject;
}

export interface ProgramError {
  readonly path: string;
  readonly message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const reqString = (
  value: unknown,
  path: string,
  errors: ProgramError[],
  { allowEmpty = false } = {},
): string => {
  if (typeof value !== "string") {
    errors.push({ path, message: "must be a string" });
    return "";
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) errors.push({ path, message: "must not be empty" });
  return trimmed;
};

const validateName = (name: string, path: string, errors: ProgramError[]): void => {
  if (!IDENTIFIER.test(name)) {
    errors.push({ path, message: `"${name}" is not a valid identifier` });
    return;
  }
  if (RESERVED_NAMES.has(name)) errors.push({ path, message: `"${name}" is a reserved name` });
};

const normalizeInput = (raw: unknown, index: number, errors: ProgramError[]): RlmInput => {
  const path = `inputs[${index}]`;
  if (!isRecord(raw)) {
    errors.push({ path, message: "must be an object" });
    return { name: "", adapter: "", description: "" };
  }
  const name = reqString(raw["name"], `${path}.name`, errors);
  if (name) validateName(name, `${path}.name`, errors);
  const adapter = reqString(raw["adapter"], `${path}.adapter`, errors);
  const description = reqString(raw["description"], `${path}.description`, errors, { allowEmpty: true });
  const constraints = raw["constraints"];
  const base: RlmInput = { name, adapter, description };
  return typeof constraints === "string" ? { ...base, constraints: constraints.trim() } : base;
};

const normalizeOutput = (raw: unknown, index: number, errors: ProgramError[]): RlmOutputField => {
  const path = `outputs[${index}]`;
  if (!isRecord(raw)) {
    errors.push({ path, message: "must be an object" });
    return { name: "", schema: {} };
  }
  const name = reqString(raw["name"], `${path}.name`, errors);
  const schemaValue = raw["schema"];
  const parsed = parseJsonValue(schemaValue);
  let schema: JsonObject = {};
  if (!parsed.ok) errors.push({ path: `${path}.schema`, message: `invalid JSON schema: ${parsed.reason}` });
  else if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value))
    errors.push({ path: `${path}.schema`, message: "schema must be a JSON object" });
  else schema = parsed.value;
  const description = raw["description"];
  const base: RlmOutputField = { name, schema };
  return typeof description === "string" ? { ...base, description: description.trim() } : base;
};

/** Validate and normalize an untrusted program payload. */
export const normalizeProgram = (input: unknown): Result<RlmProgram, ProgramError[]> => {
  const errors: ProgramError[] = [];
  if (!isRecord(input)) return err([{ path: "$", message: "program must be an object" }]);

  const objective = reqString(input["objective"], "objective", errors);
  const profile = reqString(input["profile"] ?? "default", "profile", errors);

  const inputsRaw = input["inputs"];
  const inputs: RlmInput[] = [];
  if (!Array.isArray(inputsRaw)) errors.push({ path: "inputs", message: "must be an array" });
  else inputsRaw.forEach((item, i) => inputs.push(normalizeInput(item, i, errors)));

  const seenInputs = new Set<string>();
  for (const inp of inputs) {
    if (inp.name && seenInputs.has(inp.name)) errors.push({ path: "inputs", message: `duplicate input "${inp.name}"` });
    seenInputs.add(inp.name);
  }

  const outputsRaw = input["outputs"];
  const outputs: RlmOutputField[] = [];
  if (!Array.isArray(outputsRaw)) errors.push({ path: "outputs", message: "must be an array" });
  else outputsRaw.forEach((item, i) => outputs.push(normalizeOutput(item, i, errors)));
  if (Array.isArray(outputsRaw) && outputsRaw.length === 0)
    errors.push({ path: "outputs", message: "at least one output is required" });

  const seenOutputs = new Set<string>();
  for (const out of outputs) {
    if (out.name && seenOutputs.has(out.name)) errors.push({ path: "outputs", message: `duplicate output "${out.name}"` });
    seenOutputs.add(out.name);
  }

  let metadata: JsonObject | undefined;
  if (input["metadata"] !== undefined) {
    const parsed = parseJsonValue(input["metadata"]);
    if (!parsed.ok) errors.push({ path: "metadata", message: `invalid metadata: ${parsed.reason}` });
    else if (typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value))
      metadata = parsed.value;
    else errors.push({ path: "metadata", message: "metadata must be a JSON object" });
  }

  if (errors.length > 0) return err(errors);
  const program: RlmProgram = { objective, inputs, outputs, profile, ...(metadata ? { metadata } : {}) };
  return ok(program);
};

export interface ShorthandSpec {
  readonly objective: string;
  readonly adapter?: string;
  readonly profile?: string;
}

/** Compile the `/rlm` objective+sources shorthand into a full program. */
export const compileShorthand = (spec: ShorthandSpec): Result<RlmProgram, ProgramError[]> =>
  normalizeProgram({
    objective: spec.objective,
    profile: spec.profile ?? "default",
    inputs: [{ name: "context", adapter: spec.adapter ?? "text", description: "Primary source context." }],
    outputs: [
      {
        name: "answer",
        description: "Final answer to the objective.",
        schema: { type: "string" } satisfies JsonValue,
      },
    ],
  });

/** Canonical identity descriptor used for prompt and replay hashing. */
export const programIdentity = (program: RlmProgram): JsonValue => ({
  objective: program.objective,
  profile: program.profile,
  inputs: program.inputs.map((i) => ({ name: i.name, adapter: i.adapter })),
  outputs: program.outputs.map((o) => ({ name: o.name, schema: o.schema })),
});
