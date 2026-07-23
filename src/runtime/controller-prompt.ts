/**
 * Controller prompt construction (pure).
 *
 * Two layers: a stable base (role, DSL reference, completion contract) and a
 * dynamic turn message (objective, variables, budget, workspace keys, last
 * outcome, bounded trajectory). The full DSL lives only here on the dedicated
 * controller, never on an ordinary Pi turn.
 */

import type { JsonObject } from "./../core/json.ts";
import { isJsonObject } from "./../core/json.ts";
import type { FrameState } from "./controller.ts";

export const CELL_SCHEMA: JsonObject = {
  type: "object",
  required: ["reasoning", "code"],
  additionalProperties: false,
  properties: {
    reasoning: { type: "string" },
    code: { type: "string" },
  },
};

export const DSL_REFERENCE = `You drive an RLM by emitting ONE JavaScript cell per turn.
Each cell is ES2023 executed as a fresh async function. The value of the final
expression is echoed back to you as an observation. Lexical declarations do NOT
persist across cells; persist state by assigning to the \`workspace\` object.

Available globals:
- objective: string, inputs: { name: ContextRef }, input: ContextRef (single-input runs).
- ContextRef: { id, label, bytes, sha256 } with async read({offsetBytes,lengthBytes}),
  lines({startLine,count}), grep({pattern,maxMatches}), chunks({targetTokens,maxChunks,overlapTokens}).
- workspace: mutable object of JSON or { contextId } / { artifactId } handles; persists across cells.
- budget: read-only remaining calls, attempts, tokens, depth, deadline.
- await llm({ key, prompt, context?, model?, schema? }) -> CallResult (r.ok, r.value | r.error).
- await llm.batch({ key, items:[llmSpec...] }) -> CallResult[] in order.
- await agent({ key, agent, task, context? }) -> CallResult (may be UNAVAILABLE in this build).
- await recurse({ key, objective, context }) -> CallResult with the child's answer.
- contexts.derive/concat/open, artifacts.write/open/asContext for host-backed data.
- phase(name), emit({message}), console.log(...) for progress (synchronous).
- answer(value): submit the final result. It must contain every declared output.

Rules:
- Inspect before acting; verify empty or surprising results.
- Use code for structural work (chunking, counting, joining); use llm for semantics.
- Keep large data in workspace/contexts; never paste whole sources back to yourself.
- Reuse stable keys so repeated calls are cached. Call answer() exactly once when done.
- A cell that throws, fails to await bridge work, or writes non-serializable workspace
  values is reported back as a recoverable error; correct course on the next cell.`;

export const buildBasePrompt = (): string =>
  `You are the pi-rlm controller. ${DSL_REFERENCE}\n\nRespond ONLY with JSON: {"reasoning": string, "code": string}.`;

const summarizeInputs = (state: FrameState): string => {
  const lines: string[] = [];
  for (const [name, desc] of Object.entries(state.inputs))
    lines.push(`  - ${name}: ${desc.label} (${desc.bytes} bytes, ~${desc.estimatedTokens} tokens, sha ${desc.sha256.slice(0, 8)})`);
  return lines.length > 0 ? lines.join("\n") : "  (none)";
};

const summarizeOutputs = (state: FrameState): string => {
  if (state.outputs.length === 0) return "  answer(value): any JSON value";
  return state.outputs
    .map((o) => `  - ${o.name}${o.description ? `: ${o.description}` : ""} (schema: ${JSON.stringify(o.schema)})`)
    .join("\n");
};

const summarizeTrajectory = (state: FrameState): string => {
  if (state.trajectory.entries.length === 0) return "  (no cells yet)";
  const parts: string[] = [];
  if (state.trajectory.omittedCount > 0) parts.push(`  ... ${state.trajectory.omittedCount} earlier cells omitted ...`);
  for (const e of state.trajectory.entries) {
    const err = e.error ? ` ERROR ${e.error.code}: ${e.error.message}` : "";
    parts.push(`  #${e.iteration}: ${e.reasoning}\n    -> ${e.outputPreview || "(no value)"}${err}`);
  }
  return parts.join("\n");
};

/** The dynamic per-turn message assembled from committed state. */
export const buildTurnMessage = (state: FrameState): string => {
  const workspaceKeys = isJsonObject(state.workspace) ? Object.keys(state.workspace) : [];
  const last = state.lastOutcome ? `${state.lastOutcome.kind}: ${state.lastOutcome.preview ?? state.lastOutcome.message ?? ""}` : "(none)";
  return [
    `Objective: ${state.objective}`,
    `Depth: ${state.depth}`,
    `Inputs:\n${summarizeInputs(state)}`,
    `Required outputs:\n${summarizeOutputs(state)}`,
    `Budget: ${state.budget.logicalCallsRemaining} calls, ${state.budget.attemptsRemaining} attempts, ${state.budget.controllerTurnsRemaining} controller turns left.`,
    `Workspace keys: ${workspaceKeys.length > 0 ? workspaceKeys.join(", ") : "(empty)"}`,
    `Last observation: ${last}`,
    `Trajectory:\n${summarizeTrajectory(state)}`,
    `Emit the next cell as JSON now.`,
  ].join("\n\n");
};
