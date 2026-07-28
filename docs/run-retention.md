# Managed run retention

The extension owns persistent run state so a later resume implementation can reopen a run. The default root is:

- macOS: `~/Library/Application Support/pi-rlm/runs`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/pi-rlm/runs`
- Windows: `%LOCALAPPDATA%/pi-rlm/runs`

`RlmRuntimeDependencies.runRetention.root` can inject another absolute root for hosts and tests. The root and each random `run-<nonce>` directory use mode `0700`; lifecycle, lease, manifest, journal, status, and context payload files use `0600`. Custom `createRunDirectory` injections remain caller-owned and are not included in managed listing or retention.

## Lifecycle and activity

`.pi-rlm-lifecycle.json` contains only schema version, state, random lease owner, created/updated/terminal timestamps, and the manifest `runId` after publication. It never contains source text, grants, provider credentials, or other secrets. `.pi-rlm-active.json` is a separate live lease with PID, random owner, and start timestamp. The durable `.pi-rlm-run.lock` remains a permanent directory claim and is never interpreted as process liveness.

A fresh managed allocation syncs its managed-root entry, then publishes ordinal-one writer genesis in its private `.pi-rlm-arbitration` namespace. That writer owns manifest publication, lifecycle binding, journals, contexts, and lifecycle mutations through an internal lease-bound persistence capability. Genesis is complete only after `run_started` is known durable. Earlier failure uses exact writer authority to quarantine the incomplete allocation; an exact bare genesis left by process death is reclaimed through a retention successor, while live or ambiguous bare genesis remains untouched. Append-only generation and release records provide the shared order for later writers and retention; the active marker remains UI/liveness metadata, not mutation or deletion authority. Only definite owner absence or an explicit durable release permits a successor. Live owners, permission failures, unsupported checks, malformed authority, current-PID ambiguity, and possible PID reuse all fail conservatively.

Terminal lifecycle metadata is accepted for deletion only when its `runId` matches both a strictly validated manifest and the sole authoritative terminal in the validated event journal, including the terminal status. `finish` applies the same check. Active-marker removal occurs while writer authority is still held, then the writer publishes its durable release. If marker unlink fails, release atomically renames it to an owner-bound `.pi-rlm-inactive-<owner>.json` tombstone and syncs the directory; scanners never interpret that tombstone as live. If both unlink and fallback fail, the typed bounded error remains observable and other processes conservatively retain any surviving active marker. A thrown run after manifest binding remains active/incomplete and is eligible only for abandoned-run handling after grace. Failure before manifest binding quarantines and removes the unexposed writer genesis instead of stranding a metadata-less run.

## Default policy

Terminal runs are swept before and after extension runs, deterministically oldest-first:

- maximum age: 30 days
- maximum count: 100
- maximum aggregate bytes: 1 GiB
- abandoned nonterminal grace: 90 days
- streamed tree scan bounds: 100,000 globally charged entries, 64 directory levels, 16 KiB UTF-8 paths, 2 GiB per file, and 4 GiB aggregate examined bytes

Age, count, and aggregate-byte limits are independently enforced. Live or ambiguous runs are never automatically deleted. A blocked bound or cleanup fault raises a typed `RunRetentionError`; it is not silently ignored. Scans use `opendir` iteration rather than unbounded `readdir`; the one global entry budget is charged before every root or nested entry is inspected, including invalid entries. Tree scans reject unexpected root entries, non-directories, malformed metadata, changed root/run identities, oversized paths/files/trees, and symlinks.

Immediately before removal, cleanup acquires a retention successor in the same writer arbitration chain, rereads lifecycle/activity and terminal evidence, recomputes global age/count/byte selection, and revalidates root/run device and inode identity. Ordinal `M` is irreversible retirement: publication and recovery each receive a fresh preflight, and a crash-stranded `M` is adopted only after definite owner death. The terminal transition atomically renames the run to a deterministic quarantine name bound to the retention generation and bigint run inode, then syncs and revalidates the exact `0700` managed-root descriptor and pathname. Rename-applied-then-thrown is reconciled by exact inode; known quarantines are validated and scavenged before ordinary cleanup. A replacement at the old run name is outside the removal target and survives. A candidate still owned by another writer or already removed appears in `skipped` with `already_claimed` or `already_removed`. Missing lifecycle, manifest, or journal evidence while the run still exists is a typed retained failure, never a deletion. Identity mismatch, residual quarantine, or an uninspectable removal fault remains typed and includes bounded survivor metadata.

Pre-run cleanup fails closed. Once `runProgram` returns an authoritative completed, failed, or cancelled result, lifecycle-finalization and post-run-sweep faults cannot replace it. The result receives a bounded `RETENTION_METADATA_FAILED` or `RETENTION_CLEANUP_FAILED` warning, which host summaries and audit entries expose.

## Host API

`ManagedRunStore.list()` and `listManagedRuns()` return lifecycle metadata, activity classification, exact bytes, and typed issues for TUI/host consumption. `ManagedRunStore.cleanup()` and `cleanupManagedRuns()` support `{ dryRun: true }` and `{ force: true }`. Force includes all safely inactive terminal runs, but still preserves live, ambiguous, malformed, and not-yet-abandoned nonterminal runs.

`ManagedRunStore.openForResume(exactRunName)` acquires a writer successor only for an active, manifest-bound managed run. It refreshes the owner marker while holding pinned writer authority and returns the same finalization/abandon lifecycle used by fresh runs. Terminal lifecycle state, custom directories, unsafe names, live or ambiguous writers, and changed metadata are rejected.

Retention is ordinary filesystem deletion. pi-rlm makes no secure-erasure claim; storage snapshots, journals, and flash translation layers may retain prior blocks.

Node does not expose `openat`/`renameat`-style directory-handle-relative operations. Deterministic inode-bound quarantines, no-follow checks, pinned identities, and pre/post operation validation narrow path-swap windows but cannot eliminate malicious same-user filesystem swaps. This is retention hardening, not an OS sandbox or a claim that pi-rlm isolates hostile local processes.
