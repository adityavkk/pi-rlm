import { isAbsolute } from "node:path";
import { isProxy } from "node:util/types";
import type { RuntimeComponentIdentity } from "../core/identity.ts";
import { sha256 } from "../shell/hash.ts";
import { cloneBoundedJson, isPlainRecord } from "../shell/delegation/bounded-json.ts";
import type {
  DelegationV2CallSpec,
  DelegationV2Outcome,
  DelegationV2RunOptions,
} from "../shell/delegation/index.ts";
import { waitForAbort } from "./abort.ts";

export const AGENT_DELEGATION_POLICY_VERSION = "pi-rlm.agent-policy.v2";
const MAX_AGENT_NAMES = 256;
const MAX_AGENT_NAME_BYTES = 128;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CWD_BYTES = 8 * 1024;
const MAX_POLICY_ID_BYTES = 1024;
const MAX_APPROVAL_ID_BYTES = 1024;
const MAX_APPROVAL_PREVIEW_BYTES = 4 * 1024;
const APPROVAL_HASH = /^[a-f0-9]{64}$/;

export interface AgentDelegator {
  readonly identity: RuntimeComponentIdentity;
  run(spec: DelegationV2CallSpec, options?: DelegationV2RunOptions): Promise<DelegationV2Outcome>;
}

export interface AgentApprovalRequest {
  readonly runId: string;
  readonly frameId: string;
  readonly callId: string;
  readonly agent: string;
  readonly taskSha256: string;
  readonly taskPreview: string;
  readonly context: "fresh" | "fork";
  readonly model?: string;
  readonly thinking?: string;
}

export interface AgentApprovalPolicy {
  /** Stable non-secret policy identity included in the run manifest. */
  readonly id: string;
  approve(request: AgentApprovalRequest, signal: AbortSignal): Promise<boolean>;
}

export interface AgentDelegationConfig {
  readonly client: AgentDelegator;
  readonly cwd: string;
  readonly allowedAgents?: readonly string[];
  readonly allowForkContext?: boolean;
  readonly approval?: AgentApprovalPolicy;
}

export interface PreparedAgentDelegation {
  readonly client: AgentDelegator;
  readonly delegate: AgentDelegator["run"];
  readonly cwd: string;
  readonly allowedAgents: readonly string[];
  readonly allowForkContext: boolean;
  readonly approval?: AgentApprovalPolicy;
  readonly identity: RuntimeComponentIdentity;
}

interface PendingAgentApproval {
  promise: Promise<boolean>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

export interface AgentDelegationRuntime extends PreparedAgentDelegation {
  readonly allowedAgentSet: ReadonlySet<string>;
  readonly pendingApprovals: Map<string, PendingAgentApproval>;
  readonly runSignal: AbortSignal;
}

const ownData = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new TypeError(`${key} must be an own data property`);
  return descriptor.value;
};

const ownOptionalData = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new TypeError(`${key} must be an own data property`);
  return descriptor.value;
};

const dataMethod = (value: object, key: string): ((...args: never[]) => unknown) => {
  let cursor: object | null = value;
  for (let depth = 0; cursor !== null && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function")
        throw new TypeError(`${key} must be a data method`);
      return descriptor.value as (...args: never[]) => unknown;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new TypeError(`${key} must be a data method`);
};

const boundedNormalizedString = (value: unknown, label: string, maxBytes: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || /[\r\n\0]/.test(value) || Buffer.byteLength(value, "utf8") > maxBytes)
    throw new TypeError(`${label} must be a bounded normalized string`);
  return value;
};

const componentIdentity = (value: unknown): RuntimeComponentIdentity => {
  if (!isPlainRecord(value))
    throw new TypeError("agent delegation client identity must be a plain object");
  const id = boundedNormalizedString(ownData(value, "id"), "agent delegation client identity id", 1024);
  const version = boundedNormalizedString(ownData(value, "version"), "agent delegation client identity version", 1024);
  const configuration = cloneBoundedJson(ownData(value, "configuration"), {
    maxBytes: 64 * 1024,
    maxNodes: 10_000,
    maxDepth: 100,
  });
  if (!configuration.ok) throw new TypeError("agent delegation client configuration must be bounded strict JSON");
  return { id, version, configuration: configuration.value };
};

export const isAgentName = (value: unknown): value is string =>
  typeof value === "string" && AGENT_NAME.test(value) && Buffer.byteLength(value, "utf8") <= MAX_AGENT_NAME_BYTES;

const normalizeAllowedAgents = (input: readonly string[] | undefined): readonly string[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input) || isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > MAX_AGENT_NAMES) throw new TypeError("agent allowlist must be a bounded plain array");
  const names: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError("agent allowlist must contain own data strings");
    const name = boundedNormalizedString(descriptor.value, `agent allowlist entry ${index}`, MAX_AGENT_NAME_BYTES);
    if (!isAgentName(name)) throw new TypeError(`agent allowlist entry ${index} must be an agent identifier`);
    names.push(name);
  }
  return [...new Set(names)].sort();
};

export const prepareAgentDelegation = (config: AgentDelegationConfig | undefined): PreparedAgentDelegation | undefined => {
  if (config === undefined) return undefined;
  if (!isPlainRecord(config)) throw new TypeError("agent delegation config must be a plain object");
  const client = ownData(config, "client");
  if (!client || typeof client !== "object" || isProxy(client))
    throw new TypeError("agent delegation client must be an object");
  const runMethod = dataMethod(client, "run") as unknown as AgentDelegator["run"];
  const delegate: AgentDelegator["run"] = (spec, options) =>
    Reflect.apply(runMethod, client, [spec, options]) as Promise<DelegationV2Outcome>;
  const cwd = boundedNormalizedString(ownData(config, "cwd"), "agent delegation cwd", MAX_CWD_BYTES);
  if (!isAbsolute(cwd)) throw new TypeError("agent delegation cwd must be absolute");
  const allowedAgents = normalizeAllowedAgents(ownOptionalData(config, "allowedAgents") as readonly string[] | undefined);
  const allowForkContext = ownOptionalData(config, "allowForkContext") ?? false;
  if (typeof allowForkContext !== "boolean") throw new TypeError("allowForkContext must be boolean");
  let approval: AgentApprovalPolicy | undefined;
  const configuredApproval = ownOptionalData(config, "approval");
  if (configuredApproval !== undefined) {
    if (!isPlainRecord(configuredApproval)) throw new TypeError("agent approval policy must be a plain object");
    const id = boundedNormalizedString(ownData(configuredApproval, "id"), "agent approval policy id", MAX_POLICY_ID_BYTES);
    const approve = ownData(configuredApproval, "approve");
    if (typeof approve !== "function") throw new TypeError("agent approval policy must implement approve");
    approval = { id, approve: approve as AgentApprovalPolicy["approve"] };
  }
  const clientIdentity = componentIdentity(ownData(client, "identity"));
  const identity: RuntimeComponentIdentity = {
    id: "pi-rlm/agent-delegation",
    version: AGENT_DELEGATION_POLICY_VERSION,
    configuration: {
      client: { id: clientIdentity.id, version: clientIdentity.version, configuration: clientIdentity.configuration },
      cwdSha256: sha256(cwd),
      allowedAgents: [...allowedAgents],
      allowForkContext,
      approvalPolicy: approval?.id ?? null,
    },
  };
  return {
    client: client as AgentDelegator,
    delegate,
    cwd,
    allowedAgents,
    allowForkContext,
    ...(approval ? { approval } : {}),
    identity,
  };
};

export const bindAgentDelegationRuntime = (
  prepared: PreparedAgentDelegation | undefined,
  runSignal: AbortSignal,
): AgentDelegationRuntime | undefined => prepared ? {
  ...prepared,
  allowedAgentSet: new Set(prepared.allowedAgents),
  pendingApprovals: new Map(),
  runSignal,
} : undefined;

const approvalRequestSnapshot = (request: AgentApprovalRequest): Readonly<AgentApprovalRequest> => {
  if (!request || typeof request !== "object" || isProxy(request))
    throw new TypeError("agent approval request must be an object");
  const runId = boundedNormalizedString(ownData(request, "runId"), "agent approval run id", MAX_APPROVAL_ID_BYTES);
  const frameId = boundedNormalizedString(ownData(request, "frameId"), "agent approval frame id", MAX_APPROVAL_ID_BYTES);
  const callId = boundedNormalizedString(ownData(request, "callId"), "agent approval call id", MAX_APPROVAL_ID_BYTES);
  const agent = boundedNormalizedString(ownData(request, "agent"), "agent approval agent", MAX_AGENT_NAME_BYTES);
  if (!isAgentName(agent)) throw new TypeError("agent approval agent must be an agent identifier");
  const taskSha256 = boundedNormalizedString(ownData(request, "taskSha256"), "agent approval task hash", 64);
  if (!APPROVAL_HASH.test(taskSha256)) throw new TypeError("agent approval task hash must be SHA-256");
  const taskPreview = ownData(request, "taskPreview");
  if (typeof taskPreview !== "string" || Buffer.byteLength(taskPreview, "utf8") > MAX_APPROVAL_PREVIEW_BYTES)
    throw new TypeError("agent approval task preview must be a bounded string");
  const context = ownData(request, "context");
  if (context !== "fresh" && context !== "fork") throw new TypeError("agent approval context must be fresh or fork");
  const modelValue = ownOptionalData(request, "model");
  const thinkingValue = ownOptionalData(request, "thinking");
  const model = modelValue === undefined
    ? undefined
    : boundedNormalizedString(modelValue, "agent approval model", MAX_APPROVAL_ID_BYTES);
  const thinking = thinkingValue === undefined
    ? undefined
    : boundedNormalizedString(thinkingValue, "agent approval thinking", MAX_APPROVAL_ID_BYTES);
  return Object.freeze({
    runId, frameId, callId, agent, taskSha256, taskPreview, context,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  });
};

const approvalKey = (request: Readonly<AgentApprovalRequest>): string => sha256(JSON.stringify([
  "pi-rlm.agent-approval-request.v1",
  request.runId,
  request.frameId,
  request.callId,
  request.agent,
  request.taskSha256,
  request.context,
  request.model ?? null,
  request.thinking ?? null,
]));

/** Getter-free exact identity. The preview is display-only; taskSha256 binds its authoritative task. */
export const agentApprovalRequestSha256 = (request: AgentApprovalRequest): string =>
  approvalKey(approvalRequestSnapshot(request));

export type AgentApprovalDecision = "allowlisted" | "approved" | "denied";

export const authorizeAgent = async (
  runtime: AgentDelegationRuntime,
  request: AgentApprovalRequest,
  callerSignal: AbortSignal,
): Promise<AgentApprovalDecision> => {
  let snapshot: Readonly<AgentApprovalRequest>;
  let key: string;
  try {
    snapshot = approvalRequestSnapshot(request);
    key = approvalKey(snapshot);
  } catch {
    return "denied";
  }
  if (runtime.allowedAgentSet.has(snapshot.agent)) return "allowlisted";
  const approval = runtime.approval;
  if (!approval) return "denied";
  let pending = runtime.pendingApprovals.get(key);
  if (!pending) {
    const controller = new AbortController();
    const created: PendingAgentApproval = {
      controller,
      waiters: 0,
      settled: false,
      promise: Promise.resolve(false),
    };
    created.promise = Promise.resolve()
      .then(() => approval.approve(snapshot, AbortSignal.any([runtime.runSignal, controller.signal])))
      .then((approved) => approved === true, () => false)
      .finally(() => { created.settled = true; });
    pending = created;
    runtime.pendingApprovals.set(key, pending);
  }
  pending.waiters += 1;
  try {
    const approved = await waitForAbort(
      pending.promise,
      AbortSignal.any([runtime.runSignal, callerSignal]),
    );
    return approved && !runtime.runSignal.aborted && !callerSignal.aborted ? "approved" : "denied";
  } finally {
    pending.waiters -= 1;
    if (pending.waiters === 0) {
      if (!pending.settled) pending.controller.abort(new Error("agent approval has no live waiters"));
      if (runtime.pendingApprovals.get(key) === pending) runtime.pendingApprovals.delete(key);
    }
  }
};
