/** Closure-backed extension boundary around a managed writer lease. No path or raw writer token is exposed. */

import {
  ManagedRunStore,
  type ManagedResumeWriterIdentity,
  type ManagedRunStoreOptions,
} from "../runtime/run-retention.ts";
import {
  inspectResumableManagedRun,
  resumeProgram,
  type ResumableManagedRunInspection,
  type ResumeInput,
} from "../runtime/run-resume.ts";
import type { RunResult } from "../runtime/run.ts";

export type ManagedResumeExecutionInput = Omit<ResumeInput, "dir" | "runLifecycle">;

export interface ManagedResumeLease {
  readonly managedName: string;
  writerIdentity(): ManagedResumeWriterIdentity;
  inspect(input: ManagedResumeExecutionInput): Promise<ResumableManagedRunInspection>;
  resume(input: ManagedResumeExecutionInput): Promise<RunResult>;
  finish(result: RunResult): Promise<void>;
  abandon(): Promise<void>;
}

export const acquireManagedResumeLease = async (
  managedName: string,
  options: ManagedRunStoreOptions = {},
): Promise<ManagedResumeLease> => {
  const lease = await new ManagedRunStore(options).openForResume(managedName);
  return Object.freeze({
    managedName: lease.name,
    writerIdentity: () => lease.resumeWriterIdentity(),
    inspect: (input: ManagedResumeExecutionInput) => inspectResumableManagedRun({
      ...input,
      dir: lease.dir,
      runLifecycle: lease.lifecycle,
    }),
    resume: (input: ManagedResumeExecutionInput) => resumeProgram({
      ...input,
      dir: lease.dir,
      runLifecycle: lease.lifecycle,
    }),
    finish: (result: RunResult) => lease.finish(result.status, result.runId),
    abandon: () => lease.abandon(),
  });
};
