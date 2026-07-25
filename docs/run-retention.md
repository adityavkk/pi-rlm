# Managed run retention

The extension owns persistent run state so a later resume implementation can reopen a run. The default root is:

- macOS: `~/Library/Application Support/pi-rlm/runs`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/pi-rlm/runs`
- Windows: `%LOCALAPPDATA%/pi-rlm/runs`

`RlmRuntimeDependencies.runRetention.root` can inject another absolute root for hosts and tests. The root and each random `run-<nonce>` directory use mode `0700`; lifecycle, lease, manifest, journal, status, and context payload files use `0600`. Custom `createRunDirectory` injections remain caller-owned and are not included in managed listing or retention.

## Lifecycle and activity

`.pi-rlm-lifecycle.json` contains only schema version, state, random lease owner, created/updated/terminal timestamps, and the manifest `runId` after publication. It never contains source text, grants, provider credentials, or other secrets. `.pi-rlm-active.json` is a separate live lease with PID, random owner, and start timestamp. The durable `.pi-rlm-run.lock` remains a permanent directory claim and is never interpreted as process liveness.

A same-process registry protects leases before and during marker publication. After restart, a live PID is retained. Unsupported checks, permission errors, malformed markers, current-PID owner ambiguity, and possible PID reuse all fail conservatively by retaining the directory. A definitely dead or missing marker can make a nonterminal run abandoned only after the longer grace period.

## Default policy

Terminal runs are swept before and after extension runs, deterministically oldest-first:

- maximum age: 30 days
- maximum count: 100
- maximum aggregate bytes: 1 GiB
- abandoned nonterminal grace: 90 days
- exact tree scan bound: 100,000 entries and 64 directory levels

Age, count, and aggregate-byte limits are independently enforced. Live or ambiguous runs are never automatically deleted. A blocked bound or cleanup fault raises a typed `RunRetentionError`; it is not silently ignored. Tree scans reject unexpected root entries, non-directories, malformed metadata, changed root/run identities, and symlinks. Recursive removal is restricted to a validated direct child of the stable managed root and never follows symlinks.

## Host API

`ManagedRunStore.list()` and `listManagedRuns()` return lifecycle metadata, activity classification, exact bytes, and typed issues for TUI/host consumption. `ManagedRunStore.cleanup()` and `cleanupManagedRuns()` support `{ dryRun: true }` and `{ force: true }`. Force includes all safely inactive terminal runs, but still preserves live, ambiguous, malformed, and not-yet-abandoned nonterminal runs.

Retention is ordinary filesystem deletion. pi-rlm makes no secure-erasure claim; storage snapshots, journals, and flash translation layers may retain prior blocks.
