# pi-rlm architecture

pi-rlm is a functional core wrapped in an imperative shell. The core is pure,
deterministic, and heavily unit-tested. The shell performs all effects and is
kept thin so the risky parts stay small and observable.

## Layers

```mermaid
flowchart TD
  U[User] -->|/rlm or rlm_run| EXT[Extension index.ts]
  EXT -->|launch grant + program| RUN[runtime: runProgram]
  RUN --> FRAME[runtime: frame loop]
  FRAME -->|one cell per turn| CTRL[ModelController]
  CTRL -->|completion| MODEL[(Pi model runtime)]
  FRAME -->|transform + execute| QJS[shell: QuickJS backend]
  QJS -->|host calls| BROKER[runtime: broker]
  BROKER --> STORE[shell: context store]
  BROKER --> MODEL
  BROKER -->|recurse| FRAME
  FRAME --> JOURNAL[shell: journal store]
  JOURNAL --> STATUS[[events.jsonl authoritative]]
```

## Modules

Core (`src/core`, pure):

- `result.ts` typed success/failure union used everywhere.
- `json.ts` JSON model, canonical stringify, strict validation.
- `errors.ts` call, DSL, and interpreter error taxonomies.
- `preview.ts` UTF-8-safe head/tail previews with omitted-byte accounting.
- `ids.ts` content-addressed call identity from a hasher.
- `usage.ts` per-call usage accounting.
- `program.ts` `RlmProgram` normalization, reserved names, shorthand, identity.
- `workspace.ts` workspace value validation (JSON plus tagged handles).
- `cell.ts` acorn-based cell validation and last-expression transform.
- `schema.ts` minimal JSON-schema validator.
- `budget.ts` the tree-wide budget ledger reducer.
- `grant.ts` single-use launch-grant state machine.
- `trajectory.ts` immutable entries and bounded head/tail projection.
- `journal.ts` event union and the authoritative status fold.

Shell (`src/shell`, effects):

- `hash.ts`, `clock.ts` sha256 and an injectable clock.
- `context-store.ts` content-addressed snapshots with profile-bounded read, lines,
  literal grep, and chunk operations, plus derive and concat. Regex/RE2 syntax is
  deferred in v1 rather than emulated with host `RegExp`.
- `interpreter/backend.ts` the backend protocol.
- `interpreter/preamble.ts` the guest globals and DSL shims.
- `interpreter/quickjs.ts` the QuickJS backend (bun-safe async bridge).
- `journal-store.ts` append-only `events.jsonl` with fsync and torn-write
  recovery, plus a rebuildable `status.json`.
- `run-recovery.ts` bounded read-only validation of the manifest, permanent
  lock, journal history, and referenced content. It does not use `status.json`
  as authority. See [Run recovery](run-recovery.md).
- `model/client.ts`, `model/mock.ts`, `model/pi-model.ts` the model boundary.
- `delegation/` the bounded public `pi-subagents` version 2 event client.

Runtime (`src/runtime`, coordinator):

- `profile.ts` budgets, interpreter limits, previews, and model routes.
- `state.ts` shared mutable run state.
- `call-result.ts` guest-facing result shapes.
- `semaphore.ts` leaf-concurrency bound.
- `broker.ts` the single trusted place guest calls become effects.
- `agent-call.ts`, `agent-delegation.ts` delegated call normalization, approval,
  context handoff, caching, and host policy identity.
- `controller.ts`, `controller-prompt.ts`, `model-controller.ts` the driver.
- `mock-controller.ts` a scripted driver for tests.
- `frame.ts` the per-frame controller loop and recursion.
- `extractor.ts` the fallback-extraction contract.
- `run.ts` orchestration, input snapshotting, and completion.

## Launch authorization boundary

Launcher prompt guidance and natural-language phrases are not authority. The
extension records the public Pi 0.80.10 `input` and `turn_start` events in
host-owned closure state, uses `sessionManager.getSessionId()` for the real
session identity, and derives the turn binding from Pi's `turnIndex` and
`timestamp`. The originating input correlation survives provider continuation
turns after other tools; a new input, successful consumption, agent end, expiry,
or session shutdown clears it. `rlm_run` always requires dialog-capable UI and
confirmation of the canonical normalized request. Headless tool calls fail
closed regardless of prompt content.

When `rlm_run.execute` starts, it atomically reserves the surviving correlation
for that exact tool-call ID and request hash. After confirmation, a grant binds
the session, current continuation turn, originating-input hash, request hash,
and tool call. It expires and is synchronously removed before runtime or
backend initialization. Consumed metadata is persisted as a
`pi-rlm-launch-grant` custom entry without source contents.

Pi 0.80.10 does not expose an opaque turn nonce or the current user entry from a
tool's `execute` context. Therefore `turnIndex:timestamp` is the strictest
public host turn identity available, correlated through lifecycle events; it is
not described as a Pi-issued nonce. Missing correlation fails closed. `/rlm`
bypasses the agent turn lifecycle, so the command handler creates a unique
host-owned command nonce and immediately consumes its bound grant.

## Command source and result boundary

The command boundary accepts only strict inline JSON, trusted relative project
files, or the active compaction-aware session branch. It completes source
capture, completeness checks, UTF-8 and aggregate bounds before request hashing,
grant creation, launch audit, component initialization, or managed-directory
allocation. File capture never records the submitted path. Session projection
includes role-delimited user/assistant text, compaction and branch summaries,
and labeled textual custom messages; system messages, thinking, tools and tool
results, images, settings, and extension details/data are excluded.

A completed runtime result carries the full `ctx_<sha256>` descriptor from the
authoritative root `answer_committed` event. Command and tool surfaces share one
bounded projection: full canonical answer through 64 KiB, otherwise a
deterministic UTF-8 head/tail preview with omitted-byte metadata. Command
results use public `appendEntry` for metadata and `sendMessage` for one visible,
non-triggering custom message. Tool results are already durable Pi tool results
and do not send a second message. Notifications are not used for terminal data.

Pi 0.80.10 exposes synchronous `sendMessage` failures but not later asynchronous
persistence failures. Synchronous failure gets one bounded metadata audit and
never retries the run; ephemeral sessions remain durable only for their process
lifetime.

## Invariants

- Full source content never enters a model request unless a bounded slice was
  selected explicitly.
- One controller response yields at most one committed cell.
- Budget errors are catchable `CallResult` values; spec errors throw inside the
  guest; interpreter faults fail the cell and cannot be caught.
- The event journal is the source of truth; status is a pure fold of events.
- Content-addressed identity makes duplicate calls cache and makes replay
  idempotent.

## Stored-byte accounting scope

`storedByteLimit` bounds logical payload bytes retained for a run. The tree-wide
ledger reserves the exact unique delta before mutation, then commits or rolls
back with the mutation. Included producers:

- UTF-8 context payloads: initial source batches, derive, concat, chunks,
  artifact-to-context conversion, and direct/fallback answer snapshots. A SHA
  already present in the same `ContextStore` has zero delta, including duplicate
  chunks. Independent stores sharing a contexts directory each charge the exact
  run-local unique bytes once, even when their physical final file deduplicates.
- UTF-8 artifact payloads retained by artifact id. Duplicate content in the
  artifact map has zero delta; a separate context snapshot is a separate
  logical producer.
- Canonical JSON bytes for each distinct `GuestCallResult` retained in the call
  cache. In-flight provider values are transient and become chargeable only if
  cache insertion commits.

The logical payload is charged once even when `ContextStore` keeps both an
in-memory byte array and its durable content-addressed file. A transaction owns
only its random temporary pathname. Once its final content address is published,
that name is shareable across processes and rollback never unlinks it. A rolled
back publisher therefore retains one full run-local charge as a valid orphan;
hard-link temporary aliases add no second charge. Returned views, bounded
previews, workspace/trajectory objects, and serialization buffers are transient
and not additional charges. `events.jsonl`, rebuildable `status.json`,
run-manifest hashes, and control metadata are excluded: this journal is the
authoritative control plane and must remain writable to record exhaustion and
terminal state. Version-1 runtime checkpoints are control-plane snapshots and
are excluded from the hydrated retained-byte ledger; every runtime context and
artifact in the checkpoint remains charged exactly. Provider-token accounting
remains separate from stored bytes.

## Context filesystem boundary

Context publication uses exclusive temporary creation, file sync, a verified
post-write re-read, atomic no-clobber hard-link publication, temporary unlink,
and directory sync. Existing `contexts` symlinks/non-directories are rejected.
Payload opens use `O_NOFOLLOW` where available and require a regular file with
exactly one link before length/SHA-256 verification. Real paths are revalidated
against the trusted run root around publication and restart loads.

Node does not expose an `openat`-style directory capability. These checks reject
stable symlink, hard-link, and containment attacks, but they are not an OS
sandbox against a same-user adversary swapping directory entries in the narrow
interval between pathname checks and operations. Run directories must remain
same-user trusted.

## Model invocation accounting

`src/runtime/provider.ts` is the only production location that calls
`ModelClient.complete`. It validates the complete request, estimates all system,
prompt, context, canonical structured-schema, and enforced-output tokens, then
atomically reserves the logical operation (on its first attempt), attempt, tokens, and concurrency slot. It then derives and syncs a deterministic `operation_intended` identity before entering the provider. Every result is linked exactly once by `operation_settled` with finite reported tokens, cost, and duration; `finally` releases token and concurrency reservations. Reported token overshoot remains charged and blocks later reservations. A durable intent without settlement is an ambiguous external effect and is never an automatic retry signal.

| Path | Logical operations | Attempts | Usage ownership |
| --- | ---: | ---: | --- |
| Controller turn, valid primary | 1 | 1 | controller trajectory, operation intent/settlement, tree ledger |
| Controller malformed primary + repair | 1 | 2 | two settled intents combined on the same turn operation |
| Leaf `llm`, valid primary | 1 | 1 | `CallResult`, `call_committed`, operation intent/settlement, tree ledger |
| Leaf structured repair | 1 | 2 | two settled intents combined on the same leaf operation |
| Delegated `agent`, uncached | 1 | 1 | `agent_approval`, reported child usage, operation intent/settlement, successful `call_committed`, tree ledger |
| Provider fallback extractor | 1 | provider completions | extractor provider events and tree ledger |
| External custom extractor | 1 | 1 explicit opaque operation | zero reported tokens/cost, measured host duration; no nested completion capability |
| `recurse` | 1 frame operation | 0 itself | parent-lineage-scoped identity; subtree provider usage copied into its result, never re-settled |
| Child-frame controller/leaf | their own operations | each provider completion | tree ledger once; propagated to ancestor recurse scopes |
| Successful cache/coalesced waiter | 0 additional | 0 additional | cached committed result; failed recurse results remain retryable |

Controller turns and provider attempts are independent limits. A controller
turn is not entered when no attempt remains. `maxAttempts: 0` therefore invokes
neither the controller nor a provider. A repair reserves its second attempt
before spend.

Delegated agents enter the same reservation and settlement boundary through
`runExternalReported`. The adapter supplies bounded child usage and an exact
hash of the version 2 request, including its attempt identity and context-file
paths. Invalid reported usage settles measured host duration instead and marks
the attempt `invalid_result`. The runtime never invents child tokens or cost
when pi-subagents omits usage.

Extractor implementations declare `accountingMode`. `provider` extractors must
use the supplied completion capability and fail if they return without doing
so. `external` extractors receive no completion capability while holding their
leaf slot; because arbitrary external code cannot report internal provider
accounting, the runtime charges one explicit logical operation and attempt.
Settlement and scoped aggregation happen once before the authoritative settlement append, so a typed journal failure cannot charge the opaque operation twice. The synced intent still makes a missing settlement recover as `RECOVERY_AMBIGUOUS`. This is an opaque-operation contract, not a claim about hidden transport token usage.

Recurse call identity and key binding include the deterministic parent controller
lineage. Equal calls under one parent coalesce, while equal keys in separate
parent frames have independent results and cancellation. Only successful child
results enter `callCache`; failed attempts are journaled but may retry against
the durable key binding.

Pi 0.80.10's public `ModelRuntime.completeSimple` options support `maxRetries`.
`PiModelClient` sets it to `0`, verified with an adapter fake, so one boundary
attempt maps to one Pi transport request. Provider-side processing or replay
below the SDK boundary remains unobservable; the ledger reports only usage Pi
returns and never invents transport attempts.
