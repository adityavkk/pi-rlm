/**
 * Run orchestrator (imperative shell): wires state, snapshots inputs, opens the
 * root frame, runs the controller loop, and applies fallback extraction on
 * turn exhaustion. The event journal is authoritative and flushed before the
 * result returns.
 */

import { createLedger, type Ledger, reserveBytes } from "../core/budget.ts";
import { identityHash } from "../core/ids.ts";
import type { JsonValue } from "../core/json.ts";
import { programIdentity, type RlmProgram } from "../core/program.ts";
import { projectTrajectory } from "../core/trajectory.ts";
import { ContextStore, type ContextDescriptor } from "../shell/context-store.ts";
import { type Clock, systemClock } from "../shell/clock.ts";
import { sha256 } from "../shell/hash.ts";
import type { InterpreterBackend } from "../shell/interpreter/backend.ts";
import { JournalStore } from "../shell/journal-store.ts";
import type { ModelClient } from "../shell/model/client.ts";
import type { ControllerDriver } from "./controller.ts";
import type { Extractor } from "./extractor.ts";
import { runFrame } from "./frame.ts";
import { contextStoreLimits, DEFAULT_PROFILE, type Profile, resolveLimits } from "./profile.ts";
import { Semaphore } from "./semaphore.ts";
import type { FrameRef, RunState } from "./state.ts";

export const RLM_DSL_VERSION = "0.1.0";

export interface RunInput {
  readonly program: RlmProgram;
  readonly sources: Readonly<Record<string, string>>;
  readonly controller: ControllerDriver;
  readonly model: ModelClient;
  readonly backend: InterpreterBackend;
  readonly dir: string;
  readonly clock?: Clock;
  readonly profile?: Profile;
  readonly extractor?: Extractor;
}

export interface RunResult {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly completionMode?: "answer" | "fallback_extract";
  readonly answer?: JsonValue;
  readonly error?: { readonly code: string; readonly message: string };
  readonly ledger: Ledger;
}

export const runProgram = async (input: RunInput): Promise<RunResult> => {
  const clock = input.clock ?? systemClock;
  const profile = input.profile ?? DEFAULT_PROFILE;
  const startMs = clock.now();
  const limits = resolveLimits(profile, startMs);
  const ledgerRef = { current: createLedger(limits) };

  const runId = `run_${sha256(`${startMs}:${input.program.objective}:${identityHash(sha256, programIdentity(input.program))}`).slice(0, 16)}`;

  const store = new ContextStore(input.dir, contextStoreLimits(profile));
  const inputs: Record<string, ContextDescriptor> = {};
  for (const declared of input.program.inputs) {
    const text = input.sources[declared.name] ?? "";
    const descriptor = await store.ingestText(declared.name, text);
    const reserved = reserveBytes(ledgerRef.current, descriptor.bytes);
    if (reserved.ok) ledgerRef.current = reserved.value;
    inputs[declared.name] = descriptor;
  }

  const journal = new JournalStore(input.dir);
  const manifestHash = sha256(
    JSON.stringify({
      program: programIdentity(input.program),
      profile: profile.name,
      dsl: RLM_DSL_VERSION,
      backend: input.backend.id,
    }),
  );
  await journal.append({ type: "run_started", runId, manifestHash, limits });

  const rootFrameId = `${runId}:f0`;
  await journal.append({ type: "frame_opened", frameId: rootFrameId, parentFrameId: null, depth: 0, objective: input.program.objective });

  const state: RunState = {
    runId,
    startMs,
    profile,
    clock,
    hasher: sha256,
    program: input.program,
    ledger: ledgerRef,
    store,
    artifacts: new Map(),
    model: input.model,
    journal,
    backend: input.backend,
    callCache: new Map(),
    inflight: new Map(),
    semaphore: new Semaphore(profile.maxConcurrency),
    contextSemaphore: new Semaphore(1),
    frameSeq: { current: 1 },
  };

  const rootFrame: FrameRef = {
    frameId: rootFrameId,
    depth: 0,
    objective: input.program.objective,
    inputs,
    outputs: input.program.outputs,
  };

  const result = await runFrame(state, rootFrame, input.controller);

  const finish = async (r: RunResult): Promise<RunResult> => {
    await journal.drain();
    return r;
  };

  if (result.terminal) {
    await journal.append({ type: "frame_closed", frameId: rootFrameId, state: "failed" });
    await journal.append({ type: "run_failed", runId, code: result.terminal.code, message: result.terminal.message });
    return finish({ runId, status: "failed", error: { code: result.terminal.code, message: result.terminal.message }, ledger: ledgerRef.current });
  }

  if (result.answer !== undefined) {
    await journal.append({ type: "frame_closed", frameId: rootFrameId, state: "answered" });
    await journal.append({ type: "run_completed", runId, completionMode: "answer" });
    return finish({ runId, status: "completed", completionMode: "answer", answer: result.answer, ledger: ledgerRef.current });
  }

  // Turn exhaustion: optional fallback extraction over bounded evidence.
  if (input.extractor) {
    const evidence = {
      outputContract: input.program.outputs,
      workspace: result.workspace ?? {},
      trajectory: projectTrajectory(result.entries ?? [], profile.trajectory),
    };
    const extracted = await input.extractor.extract(evidence);
    if (extracted.ok) {
      const ref = await store.derive({ key: `fallback:${rootFrameId}`, value: extracted.value });
      await journal.append({ type: "answer_committed", frameId: rootFrameId, completionMode: "fallback_extract", outputRef: ref.id });
      await journal.append({ type: "frame_closed", frameId: rootFrameId, state: "answered" });
      await journal.append({ type: "run_completed", runId, completionMode: "fallback_extract", outputRef: ref.id });
      return finish({ runId, status: "completed", completionMode: "fallback_extract", answer: extracted.value, ledger: ledgerRef.current });
    }
    await journal.append({ type: "frame_closed", frameId: rootFrameId, state: "failed" });
    await journal.append({ type: "run_failed", runId, code: extracted.code, message: extracted.message });
    return finish({ runId, status: "failed", error: { code: extracted.code, message: extracted.message }, ledger: ledgerRef.current });
  }

  await journal.append({ type: "frame_closed", frameId: rootFrameId, state: "failed" });
  await journal.append({ type: "run_failed", runId, code: "NO_ANSWER", message: "controller exhausted its turns without a valid answer" });
  return finish({ runId, status: "failed", error: { code: "NO_ANSWER", message: "controller exhausted without answer" }, ledger: ledgerRef.current });
};
