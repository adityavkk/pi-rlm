/** Closure-backed extension boundary around a managed candidate writer. No path or raw writer token is exposed. */

import {
  ManagedRunStore,
  type ManagedResumeWriterIdentity,
  type ManagedRunLease,
  type ManagedRunStoreOptions,
} from "../runtime/run-retention.ts";
import {
  resumeProgram,
  type ConsumedResumeExpectedIdentity,
  type ResumeInput,
} from "../runtime/run-resume.ts";
import type { RunResult } from "../runtime/run.ts";

export type ManagedResumeExecutionInput = Omit<ResumeInput, "dir" | "runLifecycle" | "expectedIdentity">;

export interface ManagedResumeLease {
  readonly managedName: string;
  writerIdentity(): ManagedResumeWriterIdentity;
  /** Publish active lifecycle ownership only after one-shot authority consumption. */
  adopt(signal: AbortSignal): Promise<void>;
  resume(input: ManagedResumeExecutionInput, expected: ConsumedResumeExpectedIdentity): Promise<RunResult>;
  finish(result: RunResult): Promise<void>;
  abandon(): Promise<void>;
}

export const acquireManagedResumeLease = async (
  managedName: string,
  options: ManagedRunStoreOptions = {},
): Promise<ManagedResumeLease> => {
  const candidate = await new ManagedRunStore(options).openResumeCandidate(managedName);
  let active: ManagedRunLease | undefined;
  return Object.freeze({
    managedName: candidate.name,
    writerIdentity: () => active ? active.resumeWriterIdentity() : candidate.writerIdentity(),
    adopt: async (signal: AbortSignal): Promise<void> => {
      if (active) throw new Error("managed resume lease was already adopted");
      active = await candidate.adopt(signal);
    },
    resume: (input: ManagedResumeExecutionInput, expected: ConsumedResumeExpectedIdentity) => {
      if (!active) return Promise.reject(new Error("managed resume lease has not adopted active lifecycle"));
      return resumeProgram({
        ...input,
        expectedIdentity: expected,
        dir: active.dir,
        runLifecycle: active.lifecycle,
      });
    },
    finish: (result: RunResult) => {
      if (!active) return Promise.reject(new Error("managed resume lease has not adopted active lifecycle"));
      return active.finish(result.status, result.runId);
    },
    abandon: () => active ? active.abandon() : candidate.release(),
  });
};
