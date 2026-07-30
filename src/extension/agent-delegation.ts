import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  agentApprovalRequestSha256,
  type AgentApprovalRequest,
  type AgentDelegationConfig,
} from "../runtime/agent-delegation.ts";
import { waitForAbort } from "../runtime/abort.ts";
import { DelegationV2Client } from "../shell/delegation/client.ts";
import type { OwnedAgentApprovalHandle } from "./run-coordinator.ts";
import { sanitizeDisplayText } from "./run-display.ts";

export const AGENT_APPROVAL_TIMEOUT_MS = 60_000;
export const AGENT_APPROVAL_TIMEOUT_MAX_MS = 120_000;
export const AGENT_APPROVAL_DIALOG_MAX_BYTES = 4 * 1024;

export interface ExtensionAgentPolicy {
  readonly allowedAgents?: readonly string[];
  readonly allowForkContext?: boolean;
  readonly approvalTimeoutMs?: number;
}

export interface ExtensionAgentApprovalOwnership {
  begin(request: AgentApprovalRequest, requestSha256: string): OwnedAgentApprovalHandle | undefined;
}

export type ExtensionSessionGuard = (
  sessionId: string,
  generation: number,
  signal: AbortSignal,
  ctx: ExtensionContext,
) => boolean;

const environmentAllowlist = (): readonly string[] => {
  const configured = process.env["PI_RLM_AGENT_ALLOWLIST"];
  if (!configured) return [];
  return configured.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
};

const timeoutFor = (configured: number | undefined): number =>
  Number.isSafeInteger(configured) && configured! > 0
    ? Math.min(configured!, AGENT_APPROVAL_TIMEOUT_MAX_MS)
    : AGENT_APPROVAL_TIMEOUT_MS;

const field = (value: unknown, maxBytes: number, fallback = "(agent default)"): string =>
  sanitizeDisplayText(value, maxBytes) || fallback;

export const agentApprovalConfirmationMessage = (
  request: AgentApprovalRequest,
  requestSha256: string,
): string => {
  const lines = [
    "Delegated agent",
    `  Agent       ${field(request.agent, 128, "(invalid)")}`,
    `  Routing     ${field(request.model, 256)} · ${field(request.thinking, 256)} · ${field(request.context, 16, "(invalid)")}`,
    "",
    "Exact request",
    `  Call        ${field(request.callId, 256, "(invalid)")}`,
    `  Request SHA ${field(requestSha256, 64, "(invalid)")}`,
    `  Task SHA    ${field(request.taskSha256, 64, "(invalid)")}`,
    "",
    "Task preview",
    `  ${field(request.taskPreview, 1024, "(empty)")}`,
    "",
    "Capability",
    "  This configured pi-subagents agent may receive tools that mutate files.",
  ];
  let output = "";
  for (const line of lines) {
    const addition = `${output ? "\n" : ""}${line}`;
    if (Buffer.byteLength(output + addition, "utf8") > AGENT_APPROVAL_DIALOG_MAX_BYTES) break;
    output += addition;
  }
  return output;
};

export const createExtensionAgentDelegation = (pi: ExtensionAPI) => {
  const client = new DelegationV2Client(pi.events);
  return (
    ctx: ExtensionContext,
    sessionId: string,
    generation: number,
    sessionGuard: ExtensionSessionGuard,
    ownership: ExtensionAgentApprovalOwnership,
    policy?: ExtensionAgentPolicy,
  ): AgentDelegationConfig => {
    const approvalTimeoutMs = timeoutFor(policy?.approvalTimeoutMs);
    const approval = ctx.mode === "tui" ? {
      id: `pi-ui.agent-confirm.v2.timeout-${approvalTimeoutMs}`,
      approve: async (request: AgentApprovalRequest, signal: AbortSignal): Promise<boolean> => {
        if (!sessionGuard(sessionId, generation, signal, ctx)) return false;
        let requestSha256: string;
        try { requestSha256 = agentApprovalRequestSha256(request); } catch { return false; }
        const pending = ownership.begin(request, requestSha256);
        if (!pending) return false;
        try {
          if (!sessionGuard(sessionId, generation, signal, ctx)) return false;
          const approved = await waitForAbort(ctx.ui.confirm(
            "Approve delegated Pi agent?",
            agentApprovalConfirmationMessage(request, requestSha256),
            { signal, timeout: approvalTimeoutMs },
          ), signal);
          return approved === true && sessionGuard(sessionId, generation, signal, ctx);
        } catch {
          return false;
        } finally {
          pending.settle();
        }
      },
    } : undefined;
    return {
      client,
      cwd: ctx.cwd,
      allowedAgents: policy?.allowedAgents ?? environmentAllowlist(),
      allowForkContext: policy?.allowForkContext ?? false,
      ...(approval ? { approval } : {}),
    };
  };
};
