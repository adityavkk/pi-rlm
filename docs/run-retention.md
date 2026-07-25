# Managed run retention

The extension owns persistent run state so a later resume implementation can reopen a run. The default root is:

- macOS: `~/Library/Application Support/pi-rlm/runs`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/pi-rlm/runs`
- Windows: `%LOCALAPPDATA%/pi-rlm/runs`

`RlmRuntimeDependencies.runRetention.root` can inject another absolute root for hosts and tests. The root and each random `run-<nonce>` directory use mode `0700`; lifecycle, lease, manifest, journal, status, and context payload files use `0600`. Custom `createRunDirectory` injections remain caller-owned and are not included in managed listing or retention.

## Lifecycle and activity

`.pi-rlm-lifecycle.json` contains only schema version, state, random lease owner, created/updated/terminal timestamps, and the manifest `runId` after publication. It never contains source text, grants, provider credentials, or other secrets. `.pi-rlm-active.json` is a separate live lease with PID, random owner, and start timestamp. The durable `.pi-rlm-run.lock` remains a permanent directory claim and is never interpreted as process liveness.

A same-process registry protects leases before and during marker publication. Lease publication, manifest binding, terminal publication, abandonment, and cleanup decisions share a private per-run `.pi-rlm-lifecycle.claim` created with `O_EXCL`. An existing or ambiguous claim always causes cleanup to retain rather than race it. After restart, a live PID is retained. Unsupported checks, permission errors, malformed markers, current-PID owner ambiguity, and possible PID reuse all fail conservatively by retaining the directory. A definitely dead or missing marker can make a nonterminal run abandoned only after the longer grace period.

Terminal lifecycle metadata is accepted for deletion only when its `runId` matches both a strictly validated manifest and the sole authoritative terminal in the validated event journal, including the terminal status. `finish` applies the same check. A thrown run without that evidence releases its lease as active/incomplete; it is eligible only for abandoned-run handling after grace, never terminal retention.

## Default policy

Terminal runs are swept before and after extension runs, deterministically oldest-first:

- maximum age: 30 days
- maximum count: 100
- maximum aggregate bytes: 1 GiB
- abandoned nonterminal grace: 90 days
- streamed tree scan bounds: 100,000 globally charged entries, 64 directory levels, 16 KiB UTF-8 paths, 2 GiB per file, and 4 GiB aggregate examined bytes

Age, count, and aggregate-byte limits are independently enforced. Live or ambiguous runs are never automatically deleted. A blocked bound or cleanup fault raises a typed `RunRetentionError`; it is not silently ignored. Scans use `opendir` iteration rather than unbounded `readdir`; the one global entry budget is charged before every root or nested entry is inspected, including invalid entries. Tree scans reject unexpected root entries, non-directories, malformed metadata, changed root/run identities, oversized paths/files/trees, and symlinks.

Immediately before removal, cleanup reacquires the lifecycle claim, rereads lifecycle and lease state, revalidates root/run device and inode identity, and atomically renames the run to a random root-contained quarantine name. It verifies the same inode after rename before recursive removal. A replacement at the old run name is therefore outside the removal target and survives. Identity mismatch or removal failure retains the path or quarantine and returns a typed failure with bounded survivor metadata.

Pre-run cleanup fails closed. Once `runProgram` returns an authoritative completed, failed, or cancelled result, lifecycle-finalization and post-run-sweep faults cannot replace it. The result receives a bounded `RETENTION_METADATA_FAILED` or `RETENTION_CLEANUP_FAILED` warning, which host summaries and audit entries expose.

## Host API

`ManagedRunStore.list()` and `listManagedRuns()` return lifecycle metadata, activity classification, exact bytes, and typed issues for TUI/host consumption. `ManagedRunStore.cleanup()` and `cleanupManagedRuns()` support `{ dryRun: true }` and `{ force: true }`. Force includes all safely inactive terminal runs, but still preserves live, ambiguous, malformed, and not-yet-abandoned nonterminal runs.

Retention is ordinary filesystem deletion. pi-rlm makes no secure-erasure claim; storage snapshots, journals, and flash translation layers may retain prior blocks.

Node does not expose `openat`/`renameat`-style directory-handle-relative operations. Random quarantine names, no-follow checks, lifecycle claims, and repeated inode validation narrow path-swap windows but cannot eliminate malicious same-user filesystem swaps. This is retention hardening, not an OS sandbox or a claim that pi-rlm isolates hostile local processes.
