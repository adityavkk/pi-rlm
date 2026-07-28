# Run recovery

`inspectRecoveredRun(dir)` reads an existing run without changing it. The function does not read `status.json`. It treats the manifest, permanent run lock, journal, and referenced content as authority.

## Validation

Inspection performs these checks in order:

1. It opens `manifest.json`, `.pi-rlm-run.lock`, and `events.jsonl` without following a final symlink.
2. Each authority file must be a private regular file with one hard link. Inspection reads through a pre-sized bounded loop. The manifest is limited to 2 MiB. The lock is limited to 4 KiB. The journal is limited to 32 MiB.
3. The manifest and lock must use their canonical JSON forms. Their run IDs and manifest hashes must match.
4. The journal must begin with one `run_started` event that matches the manifest, limits, and input references.
5. Frame ancestry, cell order, key bindings, calls, answers, closures, and the sole terminal must form one valid event history. External operation attempts require a strict version-1 `operation_intended` followed by exactly one linked `operation_settled`. Orphan, duplicate, or conflicting settlements fail as `RECOVERY_SEMANTIC_CORRUPTION`; any durable intent missing its settlement fails as `RECOVERY_AMBIGUOUS`.
6. Every input, workspace, call result, and answer reference is loaded through `ContextStore`. Run and content directories must be private. Each payload must be a private regular file with one hard link. The store checks its size before a bounded read, then checks stable file metadata, digest, and byte count. Distinct referenced bytes may not exceed the manifest stored byte limit or the 256 MiB recovery cap. JSON content must use its canonical form.
7. A completed terminal must refer to one root answer. That answer must satisfy the output schema in the manifest.
8. Inspection reads the journal again after content validation. A changed journal returns `RECOVERY_UNSTABLE`.

An incomplete final JSONL record is not authoritative. Inspection ignores that tail and leaves it unchanged. A future writer may repair the tail only after it owns the resume lease. A complete malformed line fails as `RECOVERY_JOURNAL_CORRUPT`.

## Results

Completed runs return the exact answer and content identity from the authoritative answer event. Failed and cancelled runs return their durable error. A stable journal without a terminal returns `nonterminal` only when every external intent is settled. An unresolved intent returns `RECOVERY_AMBIGUOUS`; inspection never interprets it as retryable. This status does not mean that the former writer is dead or that the run is safe to resume. A manifest whose start never became durable returns `RECOVERY_ORPHAN`. Unsupported manifest, runtime, DSL, or prompt versions return `RECOVERY_INCOMPATIBLE` instead of a corruption error.

Terminal inspection does not invoke a model, controller, interpreter, delegated agent, or retention write. Terminal runs remain immutable.

## Limits

This API does not acquire writer ownership or continue execution. Issues #83 to #86 add the writer lease, operation intents, state checkpoint, runtime hydration, authorization, and host commands.

Node cannot open a path relative to a retained directory descriptor through `openat`. The code checks the opened file descriptor and rereads the journal, but a process with the same user account can still replace a parent pathname between checks. This extension does not claim to be an operating system sandbox.
