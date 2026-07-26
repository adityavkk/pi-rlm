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
unknown terminal fields, unsafe accounting numbers, and oversized data. Result text
is limited to 2 MiB. Structured results use the same encoded byte limit, plus
node and depth limits. Update payloads are optional and bounded. Provider error
text is not returned through the adapter.

This event protocol is a coordination boundary, not an operating system
sandbox. The delegated agent receives the capabilities configured in
pi-subagents and Pi. Version 1 therefore requires a host policy for which agent
names the guest may request. The broker integration owns that policy, budget
settlement, caching, journaling, and context-file manifests.

## Direct host tools

Direct Pi tool calls are outside version 1. The QuickJS guest has no
`tools.call()` global. A later version may accept an explicit list of host
functions, similar to DSPy's `RLM(tools=[...])`. It will not discover ambient Pi
tools or call private Pi runner APIs.
