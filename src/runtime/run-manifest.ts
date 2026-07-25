/** Source-bound run identity, durable directory claim, and resume-validation hooks. */

import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BudgetLimits } from "../core/budget.ts";
import { canonicalStringify, parseJsonValue, type JsonValue } from "../core/json.ts";
import { normalizeProgram, type RlmProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ControllerDriver, FrameState } from "./controller.ts";
import { buildBasePrompt, buildTurnMessage, CELL_SCHEMA } from "./controller-prompt.ts";
import { buildExtractorPromptContract, type Extractor } from "./extractor.ts";
import { validateProfile, type Profile } from "./profile.ts";

export const RUN_MANIFEST_SCHEMA_VERSION = 1;
export const RLM_RUNTIME_VERSION = "0.0.1";
export const RLM_DSL_VERSION = "0.1.0";
export const CONTROLLER_PROMPT_VERSION = "2";
export const CONTROLLER_TURN_VERSION = "2";
export const EXTRACTOR_PROMPT_VERSION = "2";
export const RUN_MANIFEST_FILE = "manifest.json";
export const RUN_LOCK_FILE = ".pi-rlm-run.lock";

export type LaunchAuthorizationMode = "confirmed" | "slash_command" | "direct";

export interface RunManifest {
  readonly schemaVersion: number;
  readonly runtime: {
    readonly package: string;
    readonly packageVersion: string;
    readonly dslVersion: string;
  };
  readonly run: { readonly nonce: string; readonly id: string };
  /** Complete normalized program, represented as canonical strict JSON. */
  readonly program: JsonValue;
  readonly inputs: readonly {
    readonly name: string;
    readonly label: string;
    readonly mimeType: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly profile: JsonValue;
  /** Exact limits enforced by this run, including its absolute deadline. */
  readonly limits: BudgetLimits;
  readonly backend: { readonly id: string; readonly version: string };
  readonly prompts: {
    readonly controller: {
      readonly staticVersion: string;
      readonly staticRenderedSha256: string;
      readonly turnVersion: string;
      readonly turnInputsSha256: string;
      readonly turnRenderedSha256: string;
      readonly responseSchemaSha256: string;
      readonly implementationSha256: string;
    };
    readonly extractor: {
      readonly enabled: boolean;
      readonly version: string;
      readonly promptRenderedSha256: string;
      readonly promptInputsSha256: string;
      readonly implementationSha256: string;
    };
  };
  readonly launchAuthorization: { readonly mode: LaunchAuthorizationMode };
}

export interface RunManifestDocument {
  readonly manifest: RunManifest;
  readonly manifestHash: string;
}

export interface BuildRunManifestInput {
  readonly program: RlmProgram;
  readonly sources: Readonly<Record<string, string>>;
  readonly profile: Profile;
  readonly limits: BudgetLimits;
  readonly backend: InterpreterBackend;
  readonly controller: ControllerDriver;
  readonly extractor?: Extractor;
  readonly authorizationMode?: LaunchAuthorizationMode;
  readonly createRunNonce?: () => string;
  readonly dslVersion: string;
}

const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ownKeys = (value: object): readonly PropertyKey[] => Reflect.ownKeys(value);

/** Reject prototypes, accessors, symbols, non-enumerable fields, holes, and non-JSON values. */
const plainJson = (input: unknown, label: string): JsonValue => {
  const seen = new WeakSet<object>();
  const inspect = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    const object = value as object;
    if (seen.has(object)) throw new TypeError(`${label} is cyclic at ${path}`);
    seen.add(object);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} has a non-plain array at ${path}`);
        const keys = ownKeys(value);
        if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key))))
          throw new TypeError(`${label} has an invalid array field at ${path}`);
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            throw new TypeError(`${label} has an invalid array item at ${path}[${index}]`);
          inspect(descriptor.value, `${path}[${index}]`);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError(`${label} has a non-plain object at ${path}`);
      for (const key of ownKeys(object)) {
        if (typeof key !== "string") throw new TypeError(`${label} has a symbol field at ${path}`);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw new TypeError(`${label} has an invalid field at ${path}.${key}`);
        inspect(descriptor.value, `${path}.${key}`);
      }
    } finally {
      seen.delete(object);
    }
  };
  inspect(input, "$");
  const parsed = parseJsonValue(input);
  if (!parsed.ok) throw new TypeError(`${label} is not strict JSON at ${parsed.path}: ${parsed.reason}`);
  return parsed.value;
};

const record = <Required extends string, Optional extends string = never>(
  value: unknown,
  path: string,
  required: readonly Required[],
  optional: readonly Optional[] = [] as readonly Optional[],
): Record<Required | Optional, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
  const keys = Object.keys(value as object).sort();
  const allowed: readonly string[] = [...required, ...optional].sort();
  if (keys.length < required.length || keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key)))
    throw new TypeError(`${path} has invalid fields`);
  return value as Record<Required | Optional, unknown>;
};

const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${path} must be an array`);
  return value;
};
const string = (value: unknown, path: string, nonempty = true): string => {
  if (typeof value !== "string" || (nonempty && (value.length === 0 || value.trim() !== value)))
    throw new TypeError(`${path} must be ${nonempty ? "a normalized nonempty" : "a"} string`);
  return value;
};
const integer = (value: unknown, path: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`${path} must be a safe integer`);
  return value as number;
};
const hash = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${path} must be a lowercase SHA-256 hash`);
  return value;
};

const validateProgram = (value: unknown): RlmProgram => {
  const json = plainJson(value, "manifest program");
  const normalized = normalizeProgram(json);
  if (!normalized.ok || canonicalStringify(plainJson(normalized.value, "normalized manifest program")) !== canonicalStringify(json))
    throw new TypeError("manifest program is not a complete normalized RlmProgram");
  return normalized.value;
};

const PROFILE_FIELDS = [
  "name", "maxDepth", "maxFrames", "maxLogicalCalls", "maxAttempts", "maxControllerTurns", "maxConcurrency",
  "storedByteLimit", "wallMs", "cellWallMs", "memoryBytes", "previewHeadBytes", "previewTailBytes",
  "contextMaxReadBytes", "contextMaxLines", "contextMaxLineBytes", "contextMaxMatches", "contextMaxChunks",
  "contextMaxPatternBytes", "extractorEvidenceMaxBytes", "extractorValueMaxBytes", "extractorValuesMaxBytes",
  "extractorHandleHeadBytes", "extractorHandleTailBytes", "trajectory", "models",
] as const;
const LIMIT_FIELDS = [
  "maxDepth", "maxFrames", "maxLogicalCalls", "maxAttempts", "maxControllerTurns", "maxConcurrency", "storedByteLimit", "deadlineMs",
] as const;

const validateProfileJson = (value: unknown): Profile => {
  const profile = record(value, "manifest.profile", PROFILE_FIELDS, ["tokenLimit"]);
  string(profile.name, "manifest.profile.name");
  for (const field of PROFILE_FIELDS) {
    if (field === "name" || field === "trajectory" || field === "models") continue;
    integer(profile[field], `manifest.profile.${field}`);
  }
  if (profile.tokenLimit !== undefined) integer(profile.tokenLimit, "manifest.profile.tokenLimit", 1);
  const trajectory = record(profile.trajectory, "manifest.profile.trajectory", ["headEntries", "tailEntries", "codeHeadBytes", "codeTailBytes", "reasoningMaxBytes"]);
  for (const [field, value] of Object.entries(trajectory)) integer(value, `manifest.profile.trajectory.${field}`);
  const models = record(profile.models, "manifest.profile.models", ["small", "medium", "large"]);
  for (const [field, value] of Object.entries(models)) string(value, `manifest.profile.models.${field}`);
  validateProfile(profile as unknown as Profile);
  return profile as unknown as Profile;
};

const validateLimits = (value: unknown, profile: Profile): BudgetLimits => {
  const limits = record(value, "manifest.limits", LIMIT_FIELDS, ["tokenLimit"]);
  for (const field of LIMIT_FIELDS) integer(limits[field], `manifest.limits.${field}`);
  if (limits.tokenLimit !== undefined) integer(limits.tokenLimit, "manifest.limits.tokenLimit", 1);
  for (const field of LIMIT_FIELDS) {
    if (field !== "deadlineMs" && limits[field] !== profile[field]) throw new TypeError(`manifest.limits.${field} does not match profile`);
  }
  if (limits.tokenLimit !== profile.tokenLimit) throw new TypeError("manifest.limits.tokenLimit does not match profile");
  return limits as unknown as BudgetLimits;
};

const methodHash = (value: unknown): string =>
  sha256(typeof value === "function" ? Function.prototype.toString.call(value) : "none");

const safeNonce = (nonce: string): string => {
  if (!NONCE.test(nonce)) throw new TypeError("run nonce must be 1-128 safe identifier characters");
  return nonce;
};

const promptBindings = (
  program: RlmProgram,
  inputs: RunManifest["inputs"],
  profile: Profile,
  limits: BudgetLimits,
  controller: ControllerDriver,
  extractor?: Extractor,
): RunManifest["prompts"] => {
  const bindingInputs = plainJson({ program, inputs, profile, limits }, "prompt binding inputs");
  const descriptors = Object.create(null) as Record<string, unknown>;
  for (const input of inputs) descriptors[input.name] = {
    id: `manifest_${input.sha256}`,
    label: input.label,
    mimeType: input.mimeType,
    bytes: input.bytes,
    estimatedTokens: Math.ceil(input.bytes / 4),
    sha256: input.sha256,
  };
  const turn = buildTurnMessage({
    frameId: "manifest:f0",
    depth: 0,
    objective: program.objective,
    inputs: descriptors,
    variables: {},
    budget: {
      depth: 0,
      maxDepth: limits.maxDepth,
      logicalCallsUsed: 0,
      logicalCallsRemaining: limits.maxLogicalCalls,
      attemptsUsed: 0,
      attemptsRemaining: limits.maxAttempts,
      activeLeafCalls: 0,
      maxConcurrency: limits.maxConcurrency,
      controllerTurnsUsed: 0,
      controllerTurnsRemaining: limits.maxControllerTurns,
      reportedTokensUsed: 0,
      reportedInputTokensUsed: 0,
      reportedOutputTokensUsed: 0,
      reportedCostUsd: 0,
      providerDurationMs: 0,
      reportedTokensReserved: 0,
      ...(limits.tokenLimit !== undefined ? { reportedTokenLimit: limits.tokenLimit } : {}),
      storedBytesUsed: 0,
      storedByteLimit: limits.storedByteLimit,
      deadlineMs: limits.deadlineMs,
    },
    workspace: {},
    outputs: program.outputs,
    trajectory: { entries: [], omittedCount: 0 },
  } as unknown as FrameState);
  return {
    controller: {
      staticVersion: CONTROLLER_PROMPT_VERSION,
      staticRenderedSha256: sha256(buildBasePrompt()),
      turnVersion: CONTROLLER_TURN_VERSION,
      turnInputsSha256: sha256(canonicalStringify(bindingInputs)),
      turnRenderedSha256: sha256(turn),
      responseSchemaSha256: sha256(canonicalStringify(CELL_SCHEMA)),
      implementationSha256: methodHash(controller.next),
    },
    extractor: {
      enabled: extractor !== undefined,
      version: EXTRACTOR_PROMPT_VERSION,
      promptRenderedSha256: sha256(buildExtractorPromptContract([])),
      promptInputsSha256: sha256(canonicalStringify(bindingInputs)),
      implementationSha256: methodHash(extractor?.extract),
    },
  };
};

const computeManifestHash = (manifest: unknown): string =>
  sha256(canonicalStringify(plainJson(manifest, "run manifest")));

/** Build the complete canonical identity before any run-owned effect. */
export const buildRunManifest = (input: BuildRunManifestInput): RunManifestDocument => {
  if (input.dslVersion !== RLM_DSL_VERSION) throw new TypeError(`unsupported DSL version ${input.dslVersion}`);
  const program = validateProgram(input.program);
  const profile = validateProfileJson(plainJson(input.profile, "resolved profile"));
  const limits = validateLimits(plainJson(input.limits, "resolved limits"), profile);
  const nonce = safeNonce((input.createRunNonce ?? randomUUID)());
  const backendId = string(input.backend.id, "backend.id");
  const backendVersion = string(input.backend.version, "backend.version");
  const inputs = program.inputs.map((declared) => {
    const text = input.sources[declared.name] ?? "";
    return {
      name: declared.name,
      label: declared.name,
      mimeType: "text/plain",
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha256(text),
    };
  });
  const manifest: RunManifest = {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runtime: { package: "pi-rlm", packageVersion: RLM_RUNTIME_VERSION, dslVersion: RLM_DSL_VERSION },
    run: { nonce, id: `run_${nonce}` },
    program: plainJson(program, "normalized program"),
    inputs,
    profile: plainJson(profile, "resolved profile"),
    limits,
    backend: { id: backendId, version: backendVersion },
    prompts: promptBindings(program, inputs, profile, limits, input.controller, input.extractor),
    launchAuthorization: { mode: input.authorizationMode ?? "direct" },
  };
  return { manifest, manifestHash: computeManifestHash(manifest) };
};

export interface RunDirectoryFileHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
}

export interface RunDirectoryFileSystem {
  open(path: string, flags: string): Promise<RunDirectoryFileHandle>;
  readFile(path: string): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const nodeRunDirectoryFileSystem: RunDirectoryFileSystem = {
  open: async (path, flags) => open(path, flags),
  readFile: async (path) => readFile(path),
  readdir,
  rename,
  unlink,
};

export type RunDirectoryErrorCode =
  | "RUN_DIRECTORY_IN_USE"
  | "RUN_DIRECTORY_NOT_EMPTY"
  | "MANIFEST_WRITE_FAILED"
  | "MANIFEST_INVALID"
  | "MANIFEST_MISMATCH";

export class RunDirectoryError extends Error {
  override readonly name = "RunDirectoryError";
  constructor(readonly code: RunDirectoryErrorCode, message: string, override readonly cause?: unknown) {
    super(message);
  }
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
};

const closeAfter = async (handle: RunDirectoryFileHandle, operation: () => Promise<void>): Promise<void> => {
  let failed = false;
  let failure: unknown;
  try { await operation(); } catch (error) { failed = true; failure = error; }
  try { await handle.close(); } catch (error) { if (!failed) { failed = true; failure = error; } }
  if (failed) throw failure;
};

const syncDirectory = async (dir: string, fileSystem: RunDirectoryFileSystem): Promise<void> => {
  const handle = await fileSystem.open(dir, "r");
  await closeAfter(handle, () => handle.sync());
};

const cleanupTemp = async (path: string, fileSystem: RunDirectoryFileSystem): Promise<void> => {
  try { await fileSystem.unlink(path); } catch (error) { if (errorCode(error) !== "ENOENT") return; }
};

/** Permanently claim an empty run directory and atomically publish its manifest. */
export const claimRunDirectory = async (
  dir: string,
  document: RunManifestDocument,
  fileSystem: RunDirectoryFileSystem = nodeRunDirectoryFileSystem,
): Promise<void> => {
  const lockPath = join(dir, RUN_LOCK_FILE);
  let lock: RunDirectoryFileHandle;
  try {
    lock = await fileSystem.open(lockPath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new RunDirectoryError("RUN_DIRECTORY_IN_USE", "run directory is already claimed", error);
    throw new RunDirectoryError("MANIFEST_WRITE_FAILED", "failed to claim run directory", error);
  }

  try {
    await closeAfter(lock, async () => {
      const entries = (await fileSystem.readdir(dir)).filter((entry) => entry !== RUN_LOCK_FILE);
      if (entries.length > 0) throw new RunDirectoryError("RUN_DIRECTORY_NOT_EMPTY", "run directory contains existing state");
      await lock.writeFile(canonicalStringify({ runId: document.manifest.run.id, manifestHash: document.manifestHash }), "utf8");
      await lock.sync();
    });
  } catch (error) {
    // The exclusive create is never rolled back. Persist its directory entry
    // when possible so every later failure remains permanently fail-closed.
    try { await syncDirectory(dir, fileSystem); } catch { /* Preserve the primary fault. */ }
    if (error instanceof RunDirectoryError) throw error;
    throw new RunDirectoryError("MANIFEST_WRITE_FAILED", "failed to persist run directory claim", error);
  }

  const tempPath = join(dir, `.${RUN_MANIFEST_FILE}.${document.manifest.run.nonce}.tmp`);
  const manifestPath = join(dir, RUN_MANIFEST_FILE);
  let renamed = false;
  try {
    // Makes the exclusive lock directory entry durable before any valid manifest can appear.
    await syncDirectory(dir, fileSystem);
    const temp = await fileSystem.open(tempPath, "wx");
    try {
      await closeAfter(temp, async () => {
        await temp.writeFile(`${canonicalStringify(plainJson(document, "run manifest document"))}\n`, "utf8");
        await temp.sync();
      });
    } catch (error) {
      await cleanupTemp(tempPath, fileSystem);
      throw error;
    }
    try {
      await fileSystem.rename(tempPath, manifestPath);
      renamed = true;
    } catch (error) {
      await cleanupTemp(tempPath, fileSystem);
      throw error;
    }
    // Once rename succeeds, the file is complete and synced. A sync/close fault is
    // reported, but reopen may safely accept this exact document; the lock remains permanent.
    await syncDirectory(dir, fileSystem);
  } catch (error) {
    if (!renamed) await cleanupTemp(tempPath, fileSystem);
    throw new RunDirectoryError("MANIFEST_WRITE_FAILED", "failed to publish durable run manifest", error);
  }
};

const parseManifestDocument = (input: unknown): RunManifestDocument => {
  const snapshot = plainJson(input, "run manifest document");
  const document = record(snapshot, "manifest document", ["manifest", "manifestHash"]);
  hash(document.manifestHash, "manifestHash");
  const manifest = record(document.manifest, "manifest", [
    "schemaVersion", "runtime", "run", "program", "inputs", "profile", "limits", "backend", "prompts", "launchAuthorization",
  ]);
  if (manifest.schemaVersion !== RUN_MANIFEST_SCHEMA_VERSION) throw new TypeError("unsupported manifest schema version");
  const runtime = record(manifest.runtime, "manifest.runtime", ["package", "packageVersion", "dslVersion"]);
  if (runtime.package !== "pi-rlm" || runtime.packageVersion !== RLM_RUNTIME_VERSION || runtime.dslVersion !== RLM_DSL_VERSION)
    throw new TypeError("manifest runtime is incompatible");
  const run = record(manifest.run, "manifest.run", ["nonce", "id"]);
  const nonce = string(run.nonce, "manifest.run.nonce");
  if (!NONCE.test(nonce) || run.id !== `run_${nonce}`) throw new TypeError("manifest run identity is invalid");
  const program = validateProgram(manifest.program);
  const inputs = array(manifest.inputs, "manifest.inputs");
  if (inputs.length !== program.inputs.length) throw new TypeError("manifest inputs do not match program");
  inputs.forEach((entry, index) => {
    const value = record(entry, `manifest.inputs[${index}]`, ["name", "label", "mimeType", "bytes", "sha256"]);
    if (value.name !== program.inputs[index]?.name || value.label !== value.name || value.mimeType !== "text/plain")
      throw new TypeError(`manifest.inputs[${index}] does not match program`);
    string(value.name, `manifest.inputs[${index}].name`);
    integer(value.bytes, `manifest.inputs[${index}].bytes`);
    hash(value.sha256, `manifest.inputs[${index}].sha256`);
  });
  const profile = validateProfileJson(manifest.profile);
  validateLimits(manifest.limits, profile);
  const backend = record(manifest.backend, "manifest.backend", ["id", "version"]);
  string(backend.id, "manifest.backend.id");
  string(backend.version, "manifest.backend.version");
  const prompts = record(manifest.prompts, "manifest.prompts", ["controller", "extractor"]);
  const controller = record(prompts.controller, "manifest.prompts.controller", [
    "staticVersion", "staticRenderedSha256", "turnVersion", "turnInputsSha256", "turnRenderedSha256", "responseSchemaSha256", "implementationSha256",
  ]);
  string(controller.staticVersion, "manifest.prompts.controller.staticVersion");
  string(controller.turnVersion, "manifest.prompts.controller.turnVersion");
  for (const field of ["staticRenderedSha256", "turnInputsSha256", "turnRenderedSha256", "responseSchemaSha256", "implementationSha256"] as const)
    hash(controller[field], `manifest.prompts.controller.${field}`);
  const extractor = record(prompts.extractor, "manifest.prompts.extractor", [
    "enabled", "version", "promptRenderedSha256", "promptInputsSha256", "implementationSha256",
  ]);
  if (typeof extractor.enabled !== "boolean") throw new TypeError("manifest.prompts.extractor.enabled must be boolean");
  string(extractor.version, "manifest.prompts.extractor.version");
  for (const field of ["promptRenderedSha256", "promptInputsSha256", "implementationSha256"] as const)
    hash(extractor[field], `manifest.prompts.extractor.${field}`);
  const authorization = record(manifest.launchAuthorization, "manifest.launchAuthorization", ["mode"]);
  if (authorization.mode !== "confirmed" && authorization.mode !== "slash_command" && authorization.mode !== "direct")
    throw new TypeError("manifest launch authorization mode is invalid");
  const actualHash = computeManifestHash(manifest);
  if (actualHash !== document.manifestHash) throw new TypeError("manifest hash is stale or invalid");
  return snapshot as unknown as RunManifestDocument;
};

/** Read and strictly validate an existing compatible manifest. */
export const readRunManifest = async (
  dir: string,
  fileSystem: RunDirectoryFileSystem = nodeRunDirectoryFileSystem,
): Promise<RunManifestDocument> => {
  try {
    const parsed = JSON.parse((await fileSystem.readFile(join(dir, RUN_MANIFEST_FILE))).toString("utf8")) as unknown;
    return parseManifestDocument(parsed);
  } catch (error) {
    if (error instanceof RunDirectoryError) throw error;
    throw new RunDirectoryError("MANIFEST_INVALID", "stored run manifest is invalid", error);
  }
};

/** Validate both supplied documents before comparing their canonical identities. */
export const validateRunManifest = (
  expected: RunManifestDocument,
  actual: RunManifestDocument,
): { readonly ok: true } | { readonly ok: false; readonly error: RunDirectoryError } => {
  let expectedDocument: RunManifestDocument;
  let actualDocument: RunManifestDocument;
  try { expectedDocument = parseManifestDocument(expected); } catch (error) {
    return { ok: false, error: new RunDirectoryError("MANIFEST_INVALID", "expected run manifest is invalid", error) };
  }
  try { actualDocument = parseManifestDocument(actual); } catch (error) {
    return { ok: false, error: new RunDirectoryError("MANIFEST_INVALID", "actual run manifest is invalid", error) };
  }
  return expectedDocument.manifestHash === actualDocument.manifestHash
    ? { ok: true }
    : { ok: false, error: new RunDirectoryError("MANIFEST_MISMATCH", "run manifest does not match requested inputs") };
};
