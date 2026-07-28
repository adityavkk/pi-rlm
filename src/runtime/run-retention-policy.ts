/** Pure deterministic managed-run retention selection. */

import type {
  ManagedRunActivity,
  RunCleanupOptions,
  RunLifecycleMetadata,
  RunRetentionPolicy,
} from "./run-retention.ts";

export interface RetentionPolicyRun {
  readonly name: string;
  readonly bytes: number;
  readonly activity: ManagedRunActivity;
  readonly metadata: RunLifecycleMetadata;
}

const removable = (run: RetentionPolicyRun): boolean =>
  run.activity === "inactive" || run.activity === "stale";

export const selectRetentionCandidates = (
  runs: readonly RetentionPolicyRun[],
  policy: RunRetentionPolicy,
  now: number,
  options: RunCleanupOptions,
): ReadonlySet<string> => {
  const terminal = runs
    .filter((run) => run.metadata.status !== "active")
    .sort((a, b) => (a.metadata.terminalAtMs! - b.metadata.terminalAtMs!) || a.name.localeCompare(b.name));
  const selected = new Set<string>();
  for (const run of terminal) {
    if (removable(run) && (options.force || now - run.metadata.terminalAtMs! >= policy.terminalMaxAgeMs))
      selected.add(run.name);
  }
  let remainingCount = terminal.length - selected.size;
  for (const run of terminal) {
    if (remainingCount <= policy.maxTerminalRuns) break;
    if (!selected.has(run.name) && removable(run)) { selected.add(run.name); remainingCount--; }
  }
  let remainingBytes = terminal.reduce((sum, run) => sum + (selected.has(run.name) ? 0 : run.bytes), 0);
  for (const run of terminal) {
    if (remainingBytes <= policy.maxTerminalBytes) break;
    if (!selected.has(run.name) && removable(run)) { selected.add(run.name); remainingBytes -= run.bytes; }
  }
  const abandoned = runs
    .filter((run) => run.metadata.status === "active" && removable(run)
      && now - run.metadata.updatedAtMs >= policy.abandonedGraceMs)
    .sort((a, b) => (a.metadata.updatedAtMs - b.metadata.updatedAtMs) || a.name.localeCompare(b.name));
  for (const run of abandoned) selected.add(run.name);
  return selected;
};
