/** Source-bound run identity, durable directory claim, and resume-validation hooks. */

import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { canonicalStringify, parseJsonValue, type JsonValue } from "../core/json.ts";
import { programIdentity, type RlmProgram } from "../core/program.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import type { ControllerDriver } from "./controller.ts";
import { buildBasePrompt, buildTurnMessage, CELL_SCHEMA } from "./controller-prompt.ts";
import { buildExtractorModelRequest, type Extractor } from "./extractor.ts";
import type { Profile } from "./profile.ts";

export const RUN_MANIFEST_SCHEMA_VERSION = 1;
export const RLM_RUNTIME_VERSION = "0.0.1";
export const CONTROLLER_PROMPT_VERSION = "1";
export const EXTRACTOR_PROMPT_VERSION = "1";
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
  readonly programIdentity: JsonValue;
  readonly inputs: readonly {
    readonly name: string;
    readonly label: string;
    readonly mimeType: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly profile: JsonValue;
  readonly backend: { readonly id: string; readonly version: string };
  readonly prompts: {
    readonly controller: {
      readonly version: string;
      readonly basePromptSha256: string;
      readonly cellSchemaSha256: string;
      readonly rendererSha256: string;
      readonly driverSha256: string;
    };
    readonly extractor: {
      readonly version: string;
      readonly rendererSha256: string;
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
  readonly backend: InterpreterBackend;
  readonly controller: ControllerDriver;
  readonly extractor?: Extractor;
  readonly authorizationMode?: LaunchAuthorizationMode;
  readonly createRunNonce?: () => string;
  readonly dslVersion: string;
}

const strictJson = (value: unknown, label: string): JsonValue => {
  const parsed = parseJsonValue(value);
  if (!parsed.ok) throw new TypeError(`${label} is not strict JSON at ${parsed.path}: ${parsed.reason}`);
  return parsed.value;
};

const safeNonce = (nonce: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nonce))
    throw new TypeError("run nonce must be 1-128 safe identifier characters");
  return nonce;
};

const methodHash = (value: unknown): string =>
  sha256(typeof value === "function" ? Function.prototype.toString.call(value) : "none");

/** Build the complete canonical identity before any run-owned effect. */
export const buildRunManifest = (input: BuildRunManifestInput): RunManifestDocument => {
  const nonce = safeNonce((input.createRunNonce ?? randomUUID)());
  const runId = `run_${nonce}`;
  const backendVersion = (input.backend as InterpreterBackend & { readonly version?: unknown }).version;
  const manifest: RunManifest = {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runtime: { package: "pi-rlm", packageVersion: RLM_RUNTIME_VERSION, dslVersion: input.dslVersion },
    run: { nonce, id: runId },
    programIdentity: programIdentity(input.program),
    inputs: input.program.inputs.map((declared) => {
      const text = input.sources[declared.name] ?? "";
      return {
        name: declared.name,
        label: declared.name,
        mimeType: "text/plain",
        bytes: Buffer.byteLength(text, "utf8"),
        sha256: sha256(text),
      };
    }),
    profile: strictJson(input.profile, "resolved profile"),
    backend: {
      id: input.backend.id,
      version: typeof backendVersion === "string" && backendVersion.length > 0 ? backendVersion : input.backend.id,
    },
    prompts: {
      controller: {
        version: CONTROLLER_PROMPT_VERSION,
        basePromptSha256: sha256(buildBasePrompt()),
        cellSchemaSha256: sha256(canonicalStringify(CELL_SCHEMA)),
        rendererSha256: methodHash(buildTurnMessage),
        driverSha256: methodHash(input.controller.next),
      },
      extractor: {
        version: EXTRACTOR_PROMPT_VERSION,
        rendererSha256: methodHash(buildExtractorModelRequest),
        implementationSha256: methodHash(input.extractor?.extract),
      },
    },
    launchAuthorization: { mode: input.authorizationMode ?? "direct" },
  };
  return { manifest, manifestHash: sha256(canonicalStringify(strictJson(manifest, "run manifest"))) };
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
}

export const nodeRunDirectoryFileSystem: RunDirectoryFileSystem = {
  open: async (path, flags) => open(path, flags),
  readFile: async (path) => readFile(path),
  readdir,
  rename,
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

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const syncDirectory = async (dir: string, fileSystem: RunDirectoryFileSystem): Promise<void> => {
  const handle = await fileSystem.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
    if (errorCode(error) === "EEXIST")
      throw new RunDirectoryError("RUN_DIRECTORY_IN_USE", "run directory is already claimed", error);
    throw new RunDirectoryError("MANIFEST_WRITE_FAILED", "failed to claim run directory", error);
  }

  try {
    const entries = (await fileSystem.readdir(dir)).filter((entry) => entry !== RUN_LOCK_FILE);
    if (entries.length > 0)
      throw new RunDirectoryError("RUN_DIRECTORY_NOT_EMPTY", "run directory contains existing state");
    await lock.writeFile(canonicalStringify({ runId: document.manifest.run.id }), "utf8");
    await lock.sync();
  } catch (error) {
    if (error instanceof RunDirectoryError) throw error;
    throw new RunDirectoryError("MANIFEST_WRITE_FAILED", "failed to persist run directory claim", error);
  } finally {
    try { await lock.close(); } catch { /* The durable claim remains fail-closed. */ }
  }

  const tempPath = join(dir, `.${RUN_MANIFEST_FILE}.${document.manifest.run.nonce}.tmp`);
  const manifestPath = join(dir, RUN_MANIFEST_FILE);
  try {
    await syncDirectory(dir, fileSystem);
    const temp = await fileSystem.open(tempPath, "wx");
    try {
      await temp.writeFile(`${canonicalStringify(strictJson(document, "run manifest document"))}\n`, "utf8");
      await temp.sync();
    } finally {
      await temp.close();
    }
    await fileSystem.rename(tempPath, manifestPath);
    await syncDirectory(dir, fileSystem);
  } catch (error) {
    throw new RunDirectoryError("MANIFEST_WRITE_FAILED", "failed to publish durable run manifest", error);
  }
};

/** Read and cryptographically validate an existing manifest for future resume work. */
export const readRunManifest = async (
  dir: string,
  fileSystem: RunDirectoryFileSystem = nodeRunDirectoryFileSystem,
): Promise<RunManifestDocument> => {
  try {
    const parsed = JSON.parse((await fileSystem.readFile(join(dir, RUN_MANIFEST_FILE))).toString("utf8")) as unknown;
    const json = strictJson(parsed, "stored run manifest");
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw new TypeError("manifest document is not an object");
    const document = json as unknown as RunManifestDocument;
    if (!document.manifest || typeof document.manifestHash !== "string") throw new TypeError("manifest document fields are missing");
    const actualHash = sha256(canonicalStringify(strictJson(document.manifest, "stored manifest")));
    if (actualHash !== document.manifestHash) throw new TypeError("stored manifest hash is invalid");
    return document;
  } catch (error) {
    if (error instanceof RunDirectoryError) throw error;
    throw new RunDirectoryError("MANIFEST_INVALID", "stored run manifest is invalid", error);
  }
};

/** Exact expected/actual hook for #25; this does not reopen or resume a run. */
export const validateRunManifest = (
  expected: RunManifestDocument,
  actual: RunManifestDocument,
): { readonly ok: true } | { readonly ok: false; readonly error: RunDirectoryError } =>
  expected.manifestHash === actual.manifestHash
    ? { ok: true }
    : { ok: false, error: new RunDirectoryError("MANIFEST_MISMATCH", "run manifest does not match requested inputs") };
