# pi-rlm

A Recursive Language Model runtime for [Pi](https://github.com/earendil-works/pi).

pi-rlm lets a controller model work through a large problem by writing small
JavaScript cells instead of holding everything in its own context window. The
big inputs stay on the host. Each cell runs in a locked-down QuickJS sandbox and
can call a plain model, a full Pi agent, or a smaller child RLM, then write
results into a durable workspace. Only the final answer and a short summary go
back to the conversation.

This is the opposite of stuffing a whole repository or document set into one
prompt. The model sees metadata and bounded previews, asks for the exact slices
it needs, and does the heavy joining, counting, and fan-out in code.

## Status

This repository implements the version 1 runtime and Pi extension. The default
suite remains offline and deterministic. A separate one-shot campaign validates
configured providers only after exact operator consent.

What works and is tested offline with no provider credentials:

- The pure functional core: program normalization, cell parsing and transform,
  the tree-wide budget ledger, launch grants, the trajectory projection, the
  event-journal fold, workspace validation, and a small JSON-schema validator.
- The QuickJS interpreter backend, including a bun-safe async host bridge, CPU
  and memory limits, fresh-context-per-cell isolation, and clean disposal.
- The coordinator: the controller loop, the call broker with caching and
  budgets, recursion into child frames, structured-output validation with one
  repair, and fallback extraction on turn exhaustion.
- A one-response controller driver (LLM-backed) exercised end to end with a mock
  model, plus the durable event journal with torn-write recovery.
- The Pi extension wiring: strict `/rlm` launch and managed-run commands, the
  `rlm_run` tool, and separate host-side launch/resume gates that refuse
  unsolicited execution.
- `agent()` through the public `pi-subagents` version 2 protocol, including
  context-file references, approval, cancellation, accounting, caching, and
  credential-free public `AgentSession` acceptance.

Live provider evidence:

- Commit `d7dd195` passed the one-shot campaign on two distinct configured
  OpenAI Codex model routes through Pi 0.80.10.
- Both routes passed direct completion, the public `AgentSession` `/rlm` path,
  structured output, ordered batch concurrency, recursion, provider fallback,
  truncation, cancellation, provider failure, retry accounting, containment,
  and a 192 KiB direct-versus-RLM comparison.
- The campaign made 34 observed Pi completions and reconciled 62,209 settled,
  reported tokens. Pi's catalog estimate was $0.2771525. Cancellation usage
  after abort remains unknown, and the estimate is not a billed-cost claim.
- The canonical numeric report is
  [`docs/evidence/live-provider-acceptance-d7dd195.json`](docs/evidence/live-provider-acceptance-d7dd195.json).
  It contains aliases, hashes, allowlisted outcomes, and numbers only.

The current evidence uses two models on one provider and one API family. It
proves route-level compatibility, not cross-provider diversity. Exact checkpoint
resume remains covered by deterministic fresh-process tests rather than a paid
live interruption campaign.

## Install

Requires [bun](https://bun.sh). Try the repository as a Pi package for one
run:

```bash
pi -e /path/to/pi-rlm/index.ts
```

Or install the local package through Pi's documented package mechanism. Pi
records the directory in `~/.pi/agent/settings.json` under `packages` and reads
the package's `pi.extensions` manifest on later runs:

```bash
pi install /path/to/pi-rlm
pi
```

Version 1 agent delegation also requires the separately active, pinned bridge:

```bash
pi install npm:pi-subagents@0.36.0
```

The optional package peer provides public protocol types but does not activate
that extension. See [agent delegation](docs/agent-delegation.md).

## Usage

Start a run explicitly. pi-rlm never escalates an ordinary task on its own.

- Slash command (host initiated), using one of these exact forms:

  ```text
  /rlm {"objective":"Summarize contradictions","context":"inline notes..."}
  /rlm {"program":{"objective":"...","inputs":[],"outputs":[{"name":"answer","schema":{"type":"string"}}],"profile":"default"}}
  /rlm --file "relative/path.md" -- Summarize contradictions
  /rlm --session -- Summarize the active conversation branch
  ```

  Bare objectives, trailing arguments, malformed JSON, and incomplete sources
  fail with a typed `RLM_SOURCE_*` result before authorization or runtime setup.
  Inline and file sources are capped at 64 MiB UTF-8. Session projection is
  compaction-aware and capped at 16 MiB and 10,000 active entries.

- Managed host operations use only these exact forms:

  ```text
  /rlm runs
  /rlm inspect run-<32 lowercase hex>
  /rlm resume run-<32 lowercase hex>
  /rlm cleanup --dry-run
  /rlm cleanup
  /rlm cleanup --force
  /rlm cancel <current local alias>
  ```

  Malformed reserved prefixes never become launch input. `runs`, `inspect`, and
  cleanup are textual and safe in TUI, RPC, print, and JSON modes; TUI also keeps
  the interactive navigator/inspector. Results contain bounded metadata only,
  never paths, source/output text, checkpoint payloads, lifecycle owners, raw
  writer tokens, or exception text. Cleanup apply/force requires a durable audit
  before the shared retention protocol mutates anything; dry-run is advisory.

  Resume accepts an exact managed name only, never a path, run ID, local alias,
  or custom directory. TUI requires exact confirmation. Non-TUI modes fail closed
  unless the embedding host supplies the explicit `authorizeResume` policy to
  `createRlmExtension`. A terminal, ambiguous, incompatible, checkpoint-less, or
  expired run remains inspect-only.

- Tool call (model initiated): `rlm_run` accepts either a non-empty
  `{ objective, context }` or a typed `{ program, sources }`. A typed program
  may omit `sources` only when it declares zero inputs; every declared input
  otherwise requires a present, non-whitespace string. Interactive modes always
  display the normalized objective, program shape, source identity, and exact request hash
  for host confirmation. Prompt text, including phrases such as "use pi-rlm",
  is guidance only and never authorizes spend. Every headless `rlm_run` call
  fails with `RLM_OPT_IN_REQUIRED`; there is no phrase or environment bypass.

Command results are delivered as bounded, visible `pi-rlm-result` custom
messages plus metadata-only custom entries. Tool results use the same bounded
projection directly and never inject another message. Answers at most 64 KiB
are included in full; larger answers use a deterministic head/tail preview and
the content-addressed output descriptor remains authoritative.

Completed, failed, and cancelled extension runs are retained under a private,
host-owned state root for future recovery and bounded by age, count, and exact
aggregate-byte policy. See [managed run retention](docs/run-retention.md) for
platform paths, defaults, active-lease safety, and the explicit dry-run/force
cleanup API. Retention is filesystem deletion, not secure erasure.

Model routing is configured with environment variables (all default to a single
model):

```bash
export PI_RLM_MODEL="anthropic/claude-sonnet-4-5"   # default for every tier
export PI_RLM_MODEL_SMALL="..."                      # optional per-tier overrides
export PI_RLM_MODEL_MEDIUM="..."
export PI_RLM_MODEL_LARGE="..."                      # controller uses the large tier
```

Delegated agent names are denied unless the host approves them during the run
or includes them in an exact comma-separated allowlist:

```bash
export PI_RLM_AGENT_ALLOWLIST="reviewer,worker"
```

The allowlist grants the configured Pi capabilities of those named agents.
Forked Pi conversation context remains disabled in the standard extension.

## How it works

pi-rlm is built as a functional core with an imperative shell.

- The **core** (`src/core`) is pure and deterministic. It has no I/O and never
  throws for expected failures; it returns typed `Result` values. This is where
  identity, budgets, journaling, trajectory shaping, and validation live, which
  makes them exhaustively unit-testable.
- The **shell** (`src/shell`) holds the effects: the QuickJS backend, the
  filesystem-backed context store, the durable journal, hashing, the clock, and
  the model client.
- The **runtime** (`src/runtime`) is the coordinator that threads shared state
  through the controller loop, the call broker, and recursion.
- The **extension** (`index.ts`) is the thin Pi boundary.

The controller loop is deliberately strict. Each iteration reserves one
controller turn separately from provider attempts, asks the driver for exactly one cell, transforms it (a trailing
expression becomes an implicit return so the model sees a REPL-style value),
runs it in a fresh QuickJS context, records an immutable trajectory entry, and
appends an authoritative journal event. Every controller, model leaf, delegated agent, repair, child,
and fallback completion crosses one atomic accounting boundary; see the model
invocation accounting matrix in `docs/ARCHITECTURE.md`. Lexical variables do not leak between
cells; durable state goes in the `workspace` object, which is validated as JSON
or content-addressed handles so a run can be replayed.

Async bridge note: on bun, QuickJS Asyncify deadlocks and the file-based wasm
variant fails to resolve from the global cache. pi-rlm therefore uses the
single-file synchronous variant and models async host calls with guest promise
deferreds plus a single centralized job-pump loop. See
[docs/PHASE0-FINDINGS.md](docs/PHASE0-FINDINGS.md).

## Security model

QuickJS, fresh contexts, budgets, and tool filtering are capability controls,
not an operating-system sandbox. The guest has no `process`, `require`, dynamic
import, network, timers, `Date`, or `Math.random`. CPU time and heap are capped
per cell. Every new run consumes one host-owned launch grant created by `/rlm` or an
exact-request UI confirmation and bound to its Pi session, host turn identity,
originating-input hash, normalized request hash, and exact tool call. Resume uses
an independent fresh one-shot grant bound to session and authorization generation,
command nonce and origin, managed name/run ID, manifest and checkpoint identities,
writer ordinal and a one-way writer-token hash, host mode, and TTL. It is consumed
immediately before hydration and continuation. Session switch/fork/resume/shutdown,
abort, denial, expiry, mismatch, and replay invalidate resume authority. The model
cannot create authority with prompt wording, submit a grant ID, or reuse a
consumed call. A delegated Pi agent runs outside QuickJS with the tools and
filesystem access configured for that named agent. Unknown names require a
separate per-run confirmation unless the host allowlists them. Do not rely on
this to run untrusted code against secrets; it is a bounded capability layer,
not a security boundary.

## Testing

```bash
bun test                     # full suite (offline, no provider needed)
bun run typecheck            # strict TypeScript
bun run smoke:packed         # packed imports plus both Pi package-loading paths
bun run test:smoke-isolation # same smoke; caller environment and cleanup check
```

Configured-provider acceptance is separate and never runs from `bun test`:

```bash
bun run acceptance:live --consent /private/consent.json --output /private/report.json
```

See [live provider acceptance](docs/live-provider-acceptance.md) before creating
consent. Credentials are necessary but never authorize the campaign.

The packed smoke uses clean, separate HOME/XDG/npm/Bun directories for direct
worktree loading, installed-package discovery, managed-command acceptance, and
an active optional `pi-subagents` package. It runs with credentials removed and
OS network denial. Beyond the exact durable `RLM_SOURCE_REQUIRED` lifecycle, it
seeds managed runs through exported runtime APIs and checks metadata-only
list/inspect, terminal rejection before factories, offline checkpoint
continuation, cleanup dry-run/apply, and writer contention across public Pi mode
bindings.

### Manual InteractiveMode visual acceptance

Run the packed, credential-free fixture in a real terminal:

```bash
scripts/run-interactive-tui-acceptance.sh
```

The launcher packs the current worktree, installs the tarball and pinned public
Pi peers under isolated HOME/XDG/cache/tmp roots, disables model networking,
and starts the runtime under an OS network-denial sandbox. The first `/rlm`
starts automatically and remains active for 30 seconds unless cancelled.

Herdr checklist (type commands in the Pi editor, then press Enter):

1. Confirm the above-editor active-run widget displays `#visual_1` while the
   initial foreground fixture runs.
2. After it completes, enter `/rlm-active-fixture`. Note the notified alias,
   confirm the active widget returns, then enter `/rlm cancel <alias>`. Confirm
   the detached widget disappears and cancellation is acknowledged without
   provider activity.
3. Enter `/rlm {"objective":"Fallback view","context":"offline"}`; confirm a
   completed `fallback_extract` result. Repeat once; confirm deterministic
   `VISUAL_FAILURE`. Later runs alternate these outcomes.
4. Enter `/rlm runs`. Use Up/Down, Enter to inspect, `r` to refresh,
   and Escape to close. Confirm the injected managed completed run is
   present.
5. Enter `/rlm inspect run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`. Use Tab and
   Shift+Tab (or Left/Right) across summary, frames, cells, calls, budget, and
   errors. Use `n`/`p` for the next/previous cursor page; use Escape to close.
6. Enter `/rlm-approval-fixture`. Confirm the exact delegated-agent dialog has
   sanitized Agent, Call ID, request/task hashes, routing, preview, and
   capability warning fields. Accept with `y`/Enter or decline with `n`/Escape.
7. Exit with Ctrl+D.

Evidence checklist: terminal size and platform; packed-install success; active
widget screenshots for foreground and detached runs; cancellation result;
fallback and failure results; managed navigator; all six inspector views plus
next/previous page; approval dialog; confirmation that no credentials were
provided and provider/network access was not attempted.

## Roadmap

- Phase 2: the TUI inspector, widget, completed-run views, and cancellation controls are complete.
- Phase 3: read-only recovery, writer fencing, checkpoints, cross-process
  continuation, and host lifecycle commands are complete.
- Phase 4: provider-backed conformance and direct-versus-RLM evaluation are
  complete. Compaction remains Pi-owned, and ordinary subagent fan-out is
  covered through the public delegation protocol.

Direct host tools are outside the version 1 scope. A later version may accept
an explicit list of host functions, similar to DSPy's `RLM(tools=[...])`. It
will not discover or execute arbitrary registered Pi tools through private Pi
internals.

The full design lives in the
[agent-spells design suite](https://github.com/adityavkk/agent-spells/blob/main/docs/design/pi-rlm.md).

## Pi 0.80.10 limitations

Node does not expose an `openat`-style directory capability. File capture checks
real containment, stable non-symlink parents, `O_NOFOLLOW` where available,
regular-file/single-link metadata, size stability, and fatal UTF-8 decoding, but
a same-user adversary can still race pathname components between checks.
Project file sources therefore require Pi project trust and are not an OS
sandbox.

`pi.sendMessage()` reports synchronous delivery failures only. Pi 0.80.10 does
not expose later asynchronous session-persistence failures to extensions, and
in-memory/ephemeral sessions cannot make a result durable across process exit.
A synchronous failure is audited without retrying or rerunning the RLM.

## Downside

Recursive execution can cost more and take longer than a single direct Pi call,
and provider token and cost figures can be late or missing. Use pi-rlm when a
task genuinely exceeds one context window or needs verifiable fan-out, not for
everyday questions.

## License

MIT. See [LICENSE](LICENSE).
