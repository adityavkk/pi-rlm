# Agent delegation

Version 1 delegates full agent work through the public
`pi-subagents/delegation` version 2 event protocol. pi-rlm does not start its own
agent process and does not use private pi-subagents modules.

## Installation

Install `pi-subagents` as an active Pi package alongside pi-rlm:

```bash
pi install npm:pi-subagents@0.36.0
pi install /path/to/pi-rlm
```

pi-rlm declares `pi-subagents` 0.36.0 as an optional peer and pins it as a test
dependency. The peer supplies public TypeScript contracts. It does not activate
the pi-subagents extension. Pi must load the separately installed package so
that something handles delegation events. If no handler starts a request within
one second, pi-rlm cancels it and returns `UNAVAILABLE_CONTEXT`.

## Protocol boundary

pi-rlm uses these public channels:

- `prompt-template:subagent:request`
- `prompt-template:subagent:started`
- `prompt-template:subagent:update`
- `prompt-template:subagent:response`
- `prompt-template:subagent:cancel`

Each request binds `requestId`, `ownerRunId`, and `nodeId`. A terminal response
must match that identity. pi-rlm subscribes before sending the request, accepts
one terminal response, removes every listener and timer, and ignores later
responses. Cancellation sends one version 2 cancellation event with the same
identity.

The adapter rejects accessors, proxies, cycles, non-JSON structured values,
unknown terminal fields, unsafe accounting numbers, and oversized data. The
pinned pi-subagents bridge limits text and structured results to 1 MiB. The
pi-rlm client keeps a separate 2 MiB defensive ceiling, plus node and depth
limits. Update payloads are optional and bounded. Provider error
text is not returned through the adapter.

## Guest and host policy

The controller calls `agent()` with a stable key, agent name, task, optional
context handles, and optional model tier, result schema, timeout, Pi context,
turn budget, or tool budget. Version 1 caps one delegated call at 40 turns, 4
grace turns, 100 tool calls, the remaining run deadline, and the tree-wide run
budgets. Guest values may only narrow these call limits.

The standard extension denies an agent name unless either condition is true:

- The host lists the exact name in `PI_RLM_AGENT_ALLOWLIST`.
- In TUI mode, the host may approve one exact immutable request. The approval binds the run, frame, call, agent, task hash, context, model, and thinking route. It expires after the configured bounded timeout, is never reused by agent name, and is dismissed on run or session cancellation. RPC, print, and JSON modes deny opaque agents without prompting.

Approval records contain the policy identity, bounded agent identifier, call
identity, and decision. They do not record task or source payloads. Agent names
must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Forked Pi conversation context is
disabled by default. Custom embedders may enable it through the manifest-bound
agent policy.

Before launch, pi-rlm verifies every selected context payload and adds its
absolute path, hash, size, MIME type, and context ID to a JSON manifest in the
delegated task. The files remain private run-owned files with mode `0600`.
Node has no `openat` capability, so this handoff does not prevent a same-user
pathname swap after verification. The child and run directory must share the
same trusted user boundary.

Each uncached launch reserves one logical call, one attempt, and one leaf slot.
Reported input, output, cache, cost, and duration usage settles through the
central accounting boundary before the slot is released. The journal records
the approval, exact request hash, attempt outcome, usage, and successful call
commit. Only successful calls enter the durable call cache. Failed calls retain
their key binding and may retry with a new request attempt ID.

This event protocol is a coordination boundary, not an operating system
sandbox. The delegated agent receives the capabilities configured in
pi-subagents and Pi.

## Direct host tools

Direct Pi tool calls are outside version 1. The QuickJS guest has no
`tools.call()` global. A later version may accept an explicit list of host
functions, similar to DSPy's `RLM(tools=[...])`. It will not discover ambient Pi
tools or call private Pi runner APIs.
