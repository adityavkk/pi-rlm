/** Deterministic, bounded fallback-extractor evidence construction. */

import { types as utilTypes } from "node:util";
import { MAX_JSON_DEPTH, type JsonValue } from "../core/json.ts";
import type { RlmOutputField } from "../core/program.ts";
import { byteLength, headTailPreview } from "../core/preview.ts";
import {
  projectTrajectory,
  type ProjectedEntry,
  type ProjectionOptions,
  type TrajectoryEntry,
} from "../core/trajectory.ts";
import type { ContextDescriptor, ContextStore } from "../shell/context-store.ts";
import { prepareCanonicalJson } from "../shell/canonical-json.ts";
import { throwIfAborted } from "./abort.ts";
import type { Profile } from "./profile.ts";
import type { ArtifactDescriptor } from "./state.ts";

export const EXTRACTOR_EVIDENCE_VERSION = "1.3.0";

/** ECMAScript UTF-16 code-unit order; independent of host locale and ICU data. */
export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export interface ExtractorVariableDescriptor {
  readonly name: string;
  readonly adapter: string;
  readonly description: string;
  readonly constraints?: string;
  readonly type: "context";
  readonly handleId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export interface ExtractorExactValue {
  /** Absent when the exact JSON value is not substantive. */
  readonly evidenceId?: string;
  readonly key: string;
  readonly value: JsonValue;
  readonly exact: true;
  readonly required: boolean;
  readonly bytes: number;
}

export interface ExtractorAnswerCandidate {
  /** Absent when the exact JSON value is not substantive. */
  readonly evidenceId?: string;
  readonly iteration: number;
  readonly value: JsonValue;
  readonly exact: true;
  /** Invalid submissions are optional; a valid unpersisted answer is required. */
  readonly required: boolean;
  readonly bytes: number;
  readonly validationErrors: readonly string[];
}

export interface ExtractorHandleProjection {
  /** Absent when the represented preview has zero source-content bytes. */
  readonly evidenceId?: string;
  readonly id: string;
  readonly kind: "context" | "artifact";
  readonly sha256: string;
  readonly bytes: number;
  readonly preview: string;
  readonly previewBytes: number;
  readonly previewStrategy: "exact" | "head-tail";
  readonly omittedBytes: number;
  readonly truncated: boolean;
  /** Required handles are represented exactly, never by a preview. */
  readonly required: boolean;
  readonly references: readonly string[];
}

export interface ExtractorProjectedEntry extends ProjectedEntry {
  /** Absent when reasoning, code, and output all contain zero represented bytes. */
  readonly evidenceId?: string;
}

export interface ExtractorTrajectoryProjection {
  readonly entries: readonly ExtractorProjectedEntry[];
  readonly omittedCount: number;
  readonly total: number;
}

export interface ExtractorEvidenceProjection {
  readonly version: typeof EXTRACTOR_EVIDENCE_VERSION;
  readonly outputContract: readonly RlmOutputField[];
  readonly variables: readonly ExtractorVariableDescriptor[];
  readonly answerCandidates: readonly ExtractorAnswerCandidate[];
  readonly workspaceValues: readonly ExtractorExactValue[];
  readonly handles: readonly ExtractorHandleProjection[];
  readonly trajectory: ExtractorTrajectoryProjection;
  readonly maxBytes: number;
  readonly serializedBytes: number;
  readonly omittedBytes: number;
  readonly omittedItems: number;
  readonly truncatedItems: number;
  readonly omittedWorkspaceValues: number;
  readonly omittedAnswerCandidates: number;
  readonly omittedHandles: number;
  readonly omittedTrajectoryEntries: number;
  /** Count of represented exact values or content-bearing bounded previews. */
  readonly substantiveItems: number;
  readonly truncated: boolean;
}

export interface ExtractorEvidenceMetadata {
  readonly projectionVersion: string;
  readonly projectionHash: string;
  readonly projectedBytes: number;
  readonly maxBytes: number;
  readonly omittedBytes: number;
  readonly omittedItems: number;
  readonly truncatedItems: number;
  readonly evidenceIdCount: number;
  readonly evidenceIdsHash: string;
  readonly truncated: boolean;
}

export class ExtractorEvidenceDeadlineError extends Error {
  readonly code = "BUDGET_DEADLINE";
  constructor() {
    super("run deadline reached while constructing fallback evidence");
    this.name = "ExtractorEvidenceDeadlineError";
  }
}

interface EvidenceInput {
  readonly program: {
    readonly inputs: readonly {
      readonly name: string;
      readonly adapter: string;
      readonly description: string;
      readonly constraints?: string;
    }[];
    readonly outputs: readonly RlmOutputField[];
  };
  readonly variables: Readonly<Record<string, ContextDescriptor>>;
  readonly workspace: unknown;
  readonly entries: readonly TrajectoryEntry[];
  readonly store: ContextStore;
  readonly artifacts: ReadonlyMap<string, { readonly descriptor: ArtifactDescriptor; readonly text: string }>;
  readonly profile: Profile;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly now: () => number;
}

export type EvidenceBuildResult =
  | { readonly ok: true; readonly projection: ExtractorEvidenceProjection; readonly metadata: ExtractorEvidenceMetadata }
  | { readonly ok: false; readonly code: "FALLBACK_EVIDENCE_TRUNCATED"; readonly message: string };

type SafeJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: string };

/** Clone strict JSON through own data descriptors only; reject proxies before reflection. */
export const snapshotExtractorJson = (
  input: unknown,
  checkpoint: () => void = () => {},
): SafeJsonResult => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): SafeJsonResult => {
    checkpoint();
    if (depth > MAX_JSON_DEPTH) return { ok: false, reason: "maximum JSON depth exceeded" };
    if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
    if (typeof value === "number")
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: "non-finite number" };
    if (typeof value !== "object") return { ok: false, reason: `${typeof value} is not JSON` };
    if (utilTypes.isProxy(value)) return { ok: false, reason: "proxy values are not evidence" };
    if (seen.has(value)) return { ok: false, reason: "cyclic value" };
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (!Number.isSafeInteger(length) || length < 0) return { ok: false, reason: "invalid array length" };
        const out: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          if (!property || !("value" in property)) return { ok: false, reason: "array hole or accessor" };
          const child = walk(property.value, depth + 1);
          if (!child.ok) return child;
          out.push(child.value);
        }
        return { ok: true, value: out };
      }
      const out = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.getOwnPropertyNames(value).sort(compareCodeUnits)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property?.enumerable) continue;
        if (!("value" in property)) return { ok: false, reason: "accessor property" };
        const child = walk(property.value, depth + 1);
        if (!child.ok) return child;
        out[key] = child.value;
      }
      return { ok: true, value: out };
    } finally {
      seen.delete(value);
    }
  };
  return walk(input, 0);
};

const jsonBytes = (value: JsonValue, checkpoint: () => void): number =>
  prepareCanonicalJson(value, checkpoint).bytes;

const contentEvidenceId = (kind: string, item: unknown, checkpoint: () => void): string =>
  `ev_${prepareCanonicalJson({ version: EXTRACTOR_EVIDENCE_VERSION, kind, item } as JsonValue, checkpoint).sha256}`;

/** Deterministic top-level test for exact JSON values that can support a citation. */
export const isSubstantiveJsonEvidence = (value: JsonValue): boolean => {
  if (value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

const substantiveTrajectoryEntry = (entry: ProjectedEntry): boolean =>
  byteLength(entry.reasoning) > 0
  || entry.codePreview.originalBytes - entry.codePreview.omittedBytes > 0
  || byteLength(entry.outputPreview) > 0;

const projectExtractorTrajectory = (
  entries: readonly TrajectoryEntry[],
  options: ProjectionOptions,
  checkpoint: () => void,
): ExtractorTrajectoryProjection => {
  const projected = projectTrajectory(entries, options);
  return {
    ...projected,
    entries: projected.entries.map((entry) => substantiveTrajectoryEntry(entry)
      ? { ...entry, evidenceId: contentEvidenceId("trajectory", entry, checkpoint) }
      : entry),
  };
};

/** IDs that may be cited by an extractor, in deterministic projection order. */
export const extractorSubstantiveEvidenceIds = (projection: ExtractorEvidenceProjection): readonly string[] => [
  ...projection.answerCandidates.flatMap((item) => item.evidenceId === undefined ? [] : [item.evidenceId]),
  ...projection.workspaceValues.flatMap((item) => item.evidenceId === undefined ? [] : [item.evidenceId]),
  ...projection.handles.flatMap((item) => item.evidenceId === undefined ? [] : [item.evidenceId]),
  ...projection.trajectory.entries.flatMap((item) => item.evidenceId === undefined ? [] : [item.evidenceId]),
];

const saturatingAdd = (left: number, right: number): number =>
  left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;

const taggedHandle = (value: JsonValue): { kind: "context" | "artifact"; id: string } | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "contextId" && typeof value["contextId"] === "string")
    return { kind: "context", id: value["contextId"] };
  if (keys[0] === "artifactId" && typeof value["artifactId"] === "string")
    return { kind: "artifact", id: value["artifactId"] };
  return undefined;
};

interface HandleRequest {
  readonly kind: "context" | "artifact";
  readonly id: string;
  readonly priority: number;
  readonly required: boolean;
  /** Descriptor size retained even when the backing handle is unavailable. */
  readonly knownBytes?: number;
  readonly references: Set<string>;
}

const freezeDeep = (value: unknown): void => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property && "value" in property) freezeDeep(property.value);
  }
  Object.freeze(value);
};

export const extractorEvidenceIdentity = (profile: Profile): JsonValue => ({
  version: EXTRACTOR_EVIDENCE_VERSION,
  maxBytes: profile.extractorEvidenceMaxBytes,
  valueMaxBytes: profile.extractorValueMaxBytes,
  valuesMaxBytes: profile.extractorValuesMaxBytes,
  handleHeadBytes: profile.extractorHandleHeadBytes,
  handleTailBytes: profile.extractorHandleTailBytes,
});

export const buildExtractorEvidence = async (input: EvidenceInput): Promise<EvidenceBuildResult> => {
  const checkpoint = (): void => {
    throwIfAborted(input.signal);
    if (input.now() >= input.deadlineMs) throw new ExtractorEvidenceDeadlineError();
  };
  const fail = (message: string): EvidenceBuildResult => ({
    ok: false,
    code: "FALLBACK_EVIDENCE_TRUNCATED",
    message,
  });
  checkpoint();

  const contractSnapshot = snapshotExtractorJson(input.program.outputs, checkpoint);
  const workspaceSnapshot = snapshotExtractorJson(input.workspace, checkpoint);
  if (!contractSnapshot.ok) return fail("fallback output contract is unavailable as safe JSON");
  if (!workspaceSnapshot.ok || typeof workspaceSnapshot.value !== "object" || workspaceSnapshot.value === null || Array.isArray(workspaceSnapshot.value))
    return fail("committed workspace is unavailable as safe JSON");

  const variables: ExtractorVariableDescriptor[] = [];
  const handleRequests = new Map<string, HandleRequest>();
  const requestHandle = (
    kind: "context" | "artifact",
    id: string,
    reference: string,
    priority: number,
    required: boolean,
    knownBytes?: number,
  ): void => {
    const mapKey = `${kind}:${id}`;
    const existing = handleRequests.get(mapKey);
    if (existing) {
      existing.references.add(reference);
      if (priority < existing.priority || (required && !existing.required)
        || (existing.knownBytes === undefined && knownBytes !== undefined))
        handleRequests.set(mapKey, {
          ...existing,
          priority: Math.min(priority, existing.priority),
          required: required || existing.required,
          ...(existing.knownBytes === undefined && knownBytes !== undefined ? { knownBytes } : {}),
        });
    } else handleRequests.set(mapKey, {
      kind, id, priority, required, ...(knownBytes !== undefined ? { knownBytes } : {}), references: new Set([reference]),
    });
  };

  for (const declared of input.program.inputs) {
    checkpoint();
    const descriptor = input.variables[declared.name];
    if (!descriptor) return fail("a declared input descriptor is unavailable");
    variables.push({
      name: declared.name,
      adapter: declared.adapter,
      description: declared.description,
      ...(declared.constraints !== undefined ? { constraints: declared.constraints } : {}),
      type: "context",
      handleId: descriptor.id,
      sha256: descriptor.sha256,
      bytes: descriptor.bytes,
      mimeType: descriptor.mimeType,
    });
    requestHandle("context", descriptor.id, `input:${declared.name}`, 3, false, descriptor.bytes);
  }

  const answerCandidates: ExtractorAnswerCandidate[] = [];
  const workspaceValues: ExtractorExactValue[] = [];
  const handles: ExtractorHandleProjection[] = [];
  const emptyTrajectory: ExtractorTrajectoryProjection = {
    entries: [], omittedCount: input.entries.length, total: input.entries.length,
  };
  const projection = Object.assign(Object.create(null), {
    version: EXTRACTOR_EVIDENCE_VERSION,
    outputContract: contractSnapshot.value,
    variables,
    answerCandidates,
    workspaceValues,
    handles,
    trajectory: emptyTrajectory,
    maxBytes: input.profile.extractorEvidenceMaxBytes,
    serializedBytes: 0,
    omittedBytes: 0,
    omittedItems: 0,
    truncatedItems: 0,
    omittedWorkspaceValues: 0,
    omittedAnswerCandidates: 0,
    omittedHandles: 0,
    omittedTrajectoryEntries: input.entries.length,
    substantiveItems: 0,
    truncated: input.entries.length > 0,
  }) as unknown as ExtractorEvidenceProjection;

  const fits = (): boolean => {
    const candidate = { ...projection,
      serializedBytes: input.profile.extractorEvidenceMaxBytes,
      omittedBytes: Number.MAX_SAFE_INTEGER,
      omittedItems: Number.MAX_SAFE_INTEGER,
      truncatedItems: Number.MAX_SAFE_INTEGER,
      omittedWorkspaceValues: Number.MAX_SAFE_INTEGER,
      omittedAnswerCandidates: Number.MAX_SAFE_INTEGER,
      omittedHandles: Number.MAX_SAFE_INTEGER,
      omittedTrajectoryEntries: Number.MAX_SAFE_INTEGER,
      substantiveItems: Number.MAX_SAFE_INTEGER,
      truncated: true,
    } as unknown as JsonValue;
    return jsonBytes(candidate, checkpoint) <= input.profile.extractorEvidenceMaxBytes;
  };
  if (!fits()) return fail("output contract and variable descriptors exceed fallback evidence budget");

  let exactValueBytes = 0;
  let omittedBytes = 0;
  let omittedItems = 0;
  let truncatedItems = 0;
  let omittedWorkspaceValues = 0;
  let omittedAnswerCandidates = 0;
  let omittedHandles = 0;
  const outputNames = new Set(input.program.outputs.map((field) => field.name));

  const candidates = input.entries
    .filter((entry) => entry.answerCandidate !== undefined)
    .sort((left, right) => right.iteration - left.iteration);
  for (const entry of candidates) {
    checkpoint();
    const validationErrors = [...(entry.answerCandidate?.validationErrors ?? [])];
    const required = validationErrors.length === 0;
    const snapshot = snapshotExtractorJson(entry.answerCandidate?.value, checkpoint);
    if (!snapshot.ok) {
      omittedItems++;
      omittedAnswerCandidates++;
      if (required) return fail("a required answer candidate is unavailable as safe JSON");
      continue;
    }
    const bytes = jsonBytes(snapshot.value, checkpoint);
    const candidateContent = {
      iteration: entry.iteration,
      value: snapshot.value,
      exact: true as const,
      required,
      bytes,
      validationErrors,
    };
    const candidate: ExtractorAnswerCandidate = isSubstantiveJsonEvidence(snapshot.value)
      ? { evidenceId: contentEvidenceId("answerCandidate", candidateContent, checkpoint), ...candidateContent }
      : candidateContent;
    if (bytes > input.profile.extractorValueMaxBytes || bytes > input.profile.extractorValuesMaxBytes - exactValueBytes) {
      omittedBytes = saturatingAdd(omittedBytes, bytes);
      omittedItems++;
      omittedAnswerCandidates++;
      if (required) return fail("a required answer candidate exceeds safe exact-evidence limits");
      continue;
    }
    answerCandidates.push(candidate);
    if (!fits()) {
      answerCandidates.pop();
      omittedBytes = saturatingAdd(omittedBytes, bytes);
      omittedItems++;
      omittedAnswerCandidates++;
      if (required) return fail("a required answer candidate does not fit the aggregate evidence limit");
      continue;
    }
    exactValueBytes += bytes;
  }

  const workspace = workspaceSnapshot.value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(workspace).sort((left, right) => {
    const leftPriority = outputNames.has(left) ? 0 : /answer|candidate|final|result/i.test(left) ? 1 : 2;
    const rightPriority = outputNames.has(right) ? 0 : /answer|candidate|final|result/i.test(right) ? 1 : 2;
    return leftPriority - rightPriority || compareCodeUnits(left, right);
  });
  for (const key of keys) {
    checkpoint();
    const value = workspace[key] as JsonValue;
    const handle = taggedHandle(value);
    const required = outputNames.has(key);
    if (handle) {
      const knownBytes = handle.kind === "context"
        ? input.store.get(handle.id)?.bytes
        : input.artifacts.get(handle.id)?.descriptor.bytes;
      requestHandle(
        handle.kind,
        handle.id,
        `workspace:${key}`,
        required ? 0 : /answer|candidate|final|result/i.test(key) ? 1 : 2,
        required,
        knownBytes,
      );
      continue;
    }
    const bytes = jsonBytes(value, checkpoint);
    const itemContent = { key, value, exact: true as const, required, bytes };
    const item: ExtractorExactValue = isSubstantiveJsonEvidence(value)
      ? { evidenceId: contentEvidenceId("workspaceValue", itemContent, checkpoint), ...itemContent }
      : itemContent;
    if (bytes <= input.profile.extractorValueMaxBytes
      && bytes <= input.profile.extractorValuesMaxBytes - exactValueBytes) {
      workspaceValues.push(item);
      if (fits()) {
        exactValueBytes += bytes;
        continue;
      }
      workspaceValues.pop();
    }
    omittedBytes = saturatingAdd(omittedBytes, bytes);
    omittedItems++;
    omittedWorkspaceValues++;
    if (required) return fail(`workspace output candidate ${key} exceeds safe exact-evidence limits`);
  }

  const makeHandle = (request: HandleRequest, headBytes: number, tailBytes: number): ExtractorHandleProjection | undefined => {
    checkpoint();
    if (request.kind === "context") {
      const descriptor = input.store.get(request.id);
      if (!descriptor) return undefined;
      const exact = request.required || descriptor.bytes <= headBytes + tailBytes;
      let preview = "";
      let selected = 0;
      if (exact) {
        const read = input.store.read(descriptor.id, { lengthBytes: descriptor.bytes }, { checkpoint });
        preview = read.text;
        selected = read.endByte - read.startByte;
      } else {
        const head = input.store.read(descriptor.id, { lengthBytes: headBytes }, { checkpoint });
        const tail = input.store.read(descriptor.id, {
          offsetBytes: Math.max(0, descriptor.bytes - tailBytes),
          lengthBytes: tailBytes,
        }, { checkpoint });
        selected = (head.endByte - head.startByte) + (tail.endByte - tail.startByte);
        preview = `${head.text}\n... [${descriptor.bytes - selected} bytes omitted] ...\n${tail.text}`;
      }
      const content = {
        id: descriptor.id, kind: "context" as const, sha256: descriptor.sha256, bytes: descriptor.bytes,
        preview, previewBytes: selected, previewStrategy: exact ? "exact" as const : "head-tail" as const,
        omittedBytes: descriptor.bytes - selected, truncated: !exact,
        required: request.required,
        references: [...request.references].sort(compareCodeUnits),
      };
      return selected > 0
        ? { evidenceId: contentEvidenceId("handlePreview", content, checkpoint), ...content }
        : content;
    }
    const artifact = input.artifacts.get(request.id);
    if (!artifact) return undefined;
    const preview = request.required
      ? headTailPreview(artifact.text, { headBytes: artifact.descriptor.bytes, tailBytes: 0 })
      : headTailPreview(artifact.text, { headBytes, tailBytes });
    const previewBytes = artifact.descriptor.bytes - preview.omittedBytes;
    const content = {
      id: artifact.descriptor.id, kind: "artifact" as const, sha256: artifact.descriptor.sha256,
      bytes: artifact.descriptor.bytes, preview: preview.text,
      previewBytes,
      previewStrategy: preview.truncated ? "head-tail" as const : "exact" as const,
      omittedBytes: preview.omittedBytes, truncated: preview.truncated,
      required: request.required,
      references: [...request.references].sort(compareCodeUnits),
    };
    return previewBytes > 0
      ? { evidenceId: contentEvidenceId("handlePreview", content, checkpoint), ...content }
      : content;
  };

  const sortedHandles = [...handleRequests.values()].sort((left, right) =>
    left.priority - right.priority || compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.id, right.id));
  for (const request of sortedHandles) {
    checkpoint();
    let headBytes = Math.min(input.profile.extractorHandleHeadBytes, input.profile.contextMaxReadBytes);
    let tailBytes = Math.min(input.profile.extractorHandleTailBytes, input.profile.contextMaxReadBytes);
    if (request.required && request.kind === "context"
      && request.knownBytes !== undefined && request.knownBytes > input.profile.contextMaxReadBytes)
      return fail("a required workspace handle exceeds the exact context read limit");
    let item = makeHandle(request, headBytes, tailBytes);
    const knownBytes = item?.bytes ?? request.knownBytes;
    if (!item) {
      omittedBytes = saturatingAdd(omittedBytes, knownBytes ?? 0);
      omittedItems++;
      omittedHandles++;
      if (request.required) return fail("a required workspace handle is unavailable exactly");
      continue;
    }
    for (;;) {
      handles.push(item);
      if (fits()) break;
      handles.pop();
      if (request.required) return fail("a required workspace handle does not fit exactly in the aggregate evidence limit");
      if (headBytes + tailBytes <= 2) {
        item = undefined;
        break;
      }
      headBytes = Math.max(headBytes > 0 ? 1 : 0, Math.floor(headBytes / 2));
      tailBytes = Math.max(tailBytes > 0 ? 1 : 0, Math.floor(tailBytes / 2));
      item = makeHandle(request, headBytes, tailBytes);
      if (!item) break;
    }
    if (!item) {
      omittedBytes = saturatingAdd(omittedBytes, knownBytes ?? 0);
      omittedItems++;
      omittedHandles++;
      continue;
    }
    if (request.required && (item.truncated || item.omittedBytes !== 0))
      return fail("a required workspace handle is not represented exactly");
    omittedBytes = saturatingAdd(omittedBytes, item.omittedBytes);
    if (item.truncated) truncatedItems++;
  }

  let trajectory = projectExtractorTrajectory(input.entries, input.profile.trajectory, checkpoint);
  (projection as { trajectory: ExtractorTrajectoryProjection }).trajectory = trajectory;
  while (!fits() && (trajectory.entries.length > 0)) {
    const nextCount = trajectory.entries.length - 1;
    const headEntries = Math.min(input.profile.trajectory.headEntries, Math.ceil(nextCount / 2));
    const tailEntries = Math.max(0, nextCount - headEntries);
    trajectory = projectExtractorTrajectory(
      input.entries,
      { ...input.profile.trajectory, headEntries, tailEntries },
      checkpoint,
    );
    (projection as { trajectory: ExtractorTrajectoryProjection }).trajectory = trajectory;
  }
  if (!fits()) {
    trajectory = emptyTrajectory;
    (projection as { trajectory: ExtractorTrajectoryProjection }).trajectory = trajectory;
  }
  const projectedIterations = new Set(trajectory.entries.map((entry) => entry.iteration));
  for (const entry of input.entries) {
    const projected = trajectory.entries.find((candidate) => candidate.iteration === entry.iteration);
    if (!projectedIterations.has(entry.iteration) || !projected) {
      omittedBytes = saturatingAdd(omittedBytes,
        byteLength(entry.reasoning) + byteLength(entry.code) + (entry.outputBytes ?? byteLength(entry.outputPreview)));
      continue;
    }
    const reasoningOmitted = Math.max(0, byteLength(entry.reasoning) - byteLength(projected.reasoning));
    const entryOmitted = reasoningOmitted + projected.codePreview.omittedBytes + (entry.outputOmittedBytes ?? 0);
    omittedBytes = saturatingAdd(omittedBytes, entryOmitted);
    if (entryOmitted > 0) truncatedItems++;
  }
  omittedItems += trajectory.omittedCount;

  const substantiveItems = answerCandidates.filter((candidate) => candidate.evidenceId !== undefined).length
    + workspaceValues.filter((item) => item.evidenceId !== undefined).length
    + handles.filter((handle) => handle.evidenceId !== undefined).length
    + trajectory.entries.filter((entry) => entry.evidenceId !== undefined).length;
  Object.assign(projection, {
    omittedBytes,
    omittedItems,
    truncatedItems,
    omittedWorkspaceValues,
    omittedAnswerCandidates,
    omittedHandles,
    omittedTrajectoryEntries: trajectory.omittedCount,
    substantiveItems,
    truncated: omittedBytes > 0 || omittedItems > 0 || truncatedItems > 0,
  });
  if (substantiveItems === 0)
    return fail("fallback evidence contains no substantive exact value or bounded content preview");
  let serializedBytes = 0;
  for (let iteration = 0; iteration < 8; iteration++) {
    (projection as { serializedBytes: number }).serializedBytes = serializedBytes;
    const measured = jsonBytes(projection as unknown as JsonValue, checkpoint);
    if (measured === serializedBytes) break;
    serializedBytes = measured;
  }
  (projection as { serializedBytes: number }).serializedBytes = serializedBytes;
  const prepared = prepareCanonicalJson(projection as unknown as JsonValue, checkpoint);
  if (prepared.bytes > input.profile.extractorEvidenceMaxBytes)
    return fail("fallback evidence projection exceeds its aggregate byte limit");
  if (prepared.bytes !== serializedBytes) {
    serializedBytes = prepared.bytes;
    (projection as { serializedBytes: number }).serializedBytes = serializedBytes;
  }
  const final = prepareCanonicalJson(projection as unknown as JsonValue, checkpoint);
  if (final.bytes > input.profile.extractorEvidenceMaxBytes)
    return fail("fallback evidence projection exceeds its aggregate byte limit");
  freezeDeep(projection);
  const evidenceIds = extractorSubstantiveEvidenceIds(projection);
  const metadata: ExtractorEvidenceMetadata = {
    projectionVersion: EXTRACTOR_EVIDENCE_VERSION,
    projectionHash: final.sha256,
    projectedBytes: final.bytes,
    maxBytes: input.profile.extractorEvidenceMaxBytes,
    omittedBytes,
    omittedItems,
    truncatedItems,
    evidenceIdCount: evidenceIds.length,
    evidenceIdsHash: prepareCanonicalJson(evidenceIds as JsonValue, checkpoint).sha256,
    truncated: projection.truncated,
  };
  checkpoint();
  return { ok: true, projection, metadata };
};
