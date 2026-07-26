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

This repository is an honest Phase 0 and Phase 1 foundation, not a finished
product.

What works and is tested (102 tests, run offline with no provider):

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
- The Pi extension wiring: the `/rlm` command, the `rlm_run` tool, and a
  host-side launch gate that refuses unsolicited runs.

What is not done yet:

- The live provider path (real model calls through Pi) is implemented against
  the SDK and type-checks, but it needs configured model auth and has not been
  run end to end here. Treat it as interactive-use code pending live testing.
- `agent()` delegation to pi-subagents, `tools.call()`, the TUI inspector,
  cross-process resume, and the security-probe suite are designed but not built.
  See the roadmap.

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
appends an authoritative journal event. Every controller, leaf, repair, child,
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
per cell. Every run consumes one host-owned grant created by `/rlm` or an exact-
request UI confirmation and bound to its Pi session, host turn identity,
originating-input hash, normalized request hash, and exact tool call. The model
cannot create authority with prompt wording, submit a grant ID, or reuse a
consumed call. Do not rely on this
to run untrusted code against secrets; it is a bounded capability layer, not a
security boundary.

## Testing

```bash
bun test                     # full suite (offline, no provider needed)
bun run typecheck            # strict TypeScript
bun run smoke:packed         # packed imports plus both Pi package-loading paths
bun run test:smoke-isolation # same smoke; caller environment and cleanup check
```

The packed smoke uses clean, separate HOME/XDG/npm/Bun directories for two
credential-free cases: the worktree entry loaded directly with
`pi -e <worktree>/index.ts /rlm`, and an installed packed package discovered
from Pi settings without `-e`. Both require the exact bounded and durable
`RLM_SOURCE_REQUIRED` custom result lifecycle without an agent/provider turn.

## Roadmap

- Phase 2: `agent()` delegation through `pi-subagents`, background runs, and the
  TUI inspector, widget, and approvals.
- Phase 3: allowlisted `tools.call()`, checkpoints, and the security probe suite.
- Phase 4: provider-backed evaluations comparing pi-rlm against direct Pi,
  compaction, and ordinary subagent fan-out.

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
