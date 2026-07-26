import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentApprovalRequest, AgentDelegationConfig } from "../runtime/agent-delegation.ts";
import { waitForAbort } from "../runtime/abort.ts";
import { DelegationV2Client } from "../shell/delegation/client.ts";

export interface ExtensionAgentPolicy {
  readonly allowedAgents?: readonly string[];
  readonly allowForkContext?: boolean;
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

const preview = (value: string, limit = 512): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length} characters)`;

export const createExtensionAgentDelegation = (pi: ExtensionAPI) => {
  const client = new DelegationV2Client(pi.events);
  return (
    ctx: ExtensionContext,
    sessionId: string,
    generation: number,
    sessionGuard: ExtensionSessionGuard,
    policy?: ExtensionAgentPolicy,
  ): AgentDelegationConfig => {
    const approval = ctx.hasUI ? {
      id: "pi-ui.agent-confirm.v1",
      approve: async (request: AgentApprovalRequest, signal: AbortSignal): Promise<boolean> => {
        if (!sessionGuard(sessionId, generation, signal, ctx)) return false;
        const details = [
          `Agent: ${request.agent}`,
          `Context: ${request.context}`,
          ...(request.model ? [`Model: ${request.model}`] : []),
          ...(request.thinking ? [`Thinking: ${request.thinking}`] : []),
          `Task SHA-256: ${request.taskSha256}`,
          `Task preview: ${preview(request.taskPreview)}`,
          "The delegated agent receives the capabilities configured for that pi-subagents agent and may mutate files.",
        ].join("\n");
        const approved = await waitForAbort(
          ctx.ui.confirm("Approve delegated Pi agent for this RLM run?", details),
          signal,
        );
        return approved && sessionGuard(sessionId, generation, signal, ctx);
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
