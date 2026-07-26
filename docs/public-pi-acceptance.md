# Public Pi acceptance boundary

Pinned Pi version: `@earendil-works/pi-coding-agent` 0.80.10.

Packed-package acceptance runs two independent cases with separate clean
HOME/XDG/npm/Bun directories. The direct case invokes the pinned Pi CLI with
`-e <worktree>/index.ts`; it never substitutes the installed tarball copy. The
installed-discovery case puts the installed package directory in isolated Pi
settings, validates its packed `pi.extensions` manifest, and invokes Pi without
`-e`; Pi alone resolves the extension entry. Every npm, Bun, Node, and Pi helper
runs from an explicit `env -i` allowlist. Registry network remains available
only for temporary dependency installation. Pi runtime runs with its public
`--offline` flag and loopback proxy tripwires inside an OS-enforced network-deny
boundary: `sandbox-exec` with `(deny network*)` on macOS, or a fresh network
namespace through `bwrap`/`unshare` on Linux. The smoke fails closed when no
supported network-denial backend is available. This process-level acceptance
control is separate from, and does not broaden, pi-rlm's QuickJS security claim.

Each case uses an explicit isolated session file. Its strict bounded JSONL parser
accepts only the session header, one `pi-rlm-result` custom append, and one exact
matching custom `message_start`/`message_end`. It requires the typed failed
projection with `error.code: RLM_SOURCE_REQUIRED`, then reads the persisted
session JSONL and matches its header/state chain, durable custom entry, and custom
message. Any prose,
duplicate result/start, agent lifecycle, stderr, or additional output record
fails. The outer wrapper starts the smoke under `env -i`, uses sentinel caller
HOME/XDG/npm/Bun paths, compares their contents and metadata, and verifies full
temporary cleanup. Run `bun run smoke:packed` directly or
`bun run test:smoke-isolation` for the outer caller-environment check.

Credential-free integration uses Pi's public `CreateAgentSessionRuntimeFactory`, `createAgentSessionServices`, `createAgentSessionFromServices`, and `createAgentSessionRuntime` APIs. `resourceLoaderOptions.extensionFactories` injects `createRlmExtension` with its public `executeRun` seam; no provider call or credential is used. For every extension mode binding (`tui`, `rpc`, `json`, and `print`), the real `AgentSession` and `ExtensionRunner` path is observed through public `session.subscribe()`: exactly one matching `pi-rlm-result` `message_start`, `message_end`, and session entry are required.

## Offline provider/runtime fixture

`src/extension/testing/offline-provider-runtime.ts` is the reusable credential-independent full-path fixture. It creates Pi's public `ModelRuntime` with `InMemoryCredentialStore`, `InMemoryModelsStore`, `modelsPath: null`, and `allowModelNetwork: false`; registers static controller/host models and a deterministic custom `streamSimple`; and injects `PiModelClient(ModelRuntime)` through `createRlmExtension` runtime dependencies. An optional host script emits valid Pi `toolcall_start`, `toolcall_delta`, `toolcall_end`, and final `toolUse` content. The real `AgentSession` selects `pi-rlm-offline/host`, with an explicit `rlm_run`-only tool allowlist. Existing command/controller cases use the same fixture without a host script. The extension then uses the production `ModelController`, `QuickJsBackend`, `runProgram`, managed private run storage, authoritative journal, and `ExtensionAPI.sendMessage()` path. A global fetch tripwire throws and records every attempt; all acceptance outcomes require a zero count. No host credential, environment key, socket, HTTP server, or network request is used.

The pinned Pi 0.80.10 `ModelRuntime` publicly exports `registerProvider(providerId, ProviderConfigInput)`. It does not export `registerNativeProvider` or accept the native `Provider` returned by pi-ai `createProvider`. The fixture therefore uses `registerProvider` with a fixed non-secret auth/base-URL metadata marker required by that public validation shape; its custom stream owns dispatch and the tripwire proves the marker is never used for transport. The compile-time guard in `src/extension/offline-provider.e2e.test.ts` binds registration to `ModelRuntime["registerProvider"]`.

Deterministic modes cover a valid one-cell controller response, a typed Pi error stream, and a stream that settles only after its request `AbortSignal`. Success and provider failure each produce exactly one bounded durable `pi-rlm-result` session entry whose full schema, content, terminal metadata, and ledger accounting are asserted. Tests also assert exact routing/options/context, `maxRetries: 0`, provider request identity, journal sequence, output reference, and attempts/tokens/cost/duration settlement.

Pending command cancellation uses public `AgentSessionRuntime.newSession()` after provider start. Session replacement intentionally suppresses result delivery into the replacement session: the authoritative retained managed journal, not replacement-session history, contains the single `run_cancelled` terminal. Cross-session result contamination is forbidden.

Issue #56 adds the interactive tool-loop counterpart through the public Pi 0.80.10 `AgentSession` and its real `ExtensionRunner`. A prompt explicitly requests pi-rlm. The scripted host emits one fixed `rlm_run` call; deterministic TUI-mode confirmation consumes and audits one exact grant bound to session, turn, prompt hash, request hash, and tool-call ID. Production `PiModelClient -> ModelRuntime -> ModelController -> QuickJS -> journal` execution completes once. Repeating the identical host tool-call ID produces a second durable tool result with `RLM_GRANT_REPLAY`, without another confirmation, grant, managed run, or controller request.

The cancellation case calls public `AgentSession.abort()` only after the pending controller provider starts. Pi propagates cancellation to the provider signal once, retains one exact accounting attempt and one `run_cancelled` terminal, and appends the bounded cancelled `rlm_run` result to a real session JSONL. A fresh public `SessionManager.open()` must recover the two replay results or cancellation result plus the launch-grant audit from that file. Pi 0.80.10 then makes one final host-model request containing the cancelled tool result; the script returns terminal assistant text and emits no second tool call. The hostile provider then dispatches a second terminal event sequence after its stream ended; Pi's event stream accepts that dispatch, while the completed runtime leaves the managed run tree, journal, accounting, live messages, and persisted session bytes unchanged. Both cases require zero fetch attempts and empty provider environment-key sets. Non-cancellable fixture setup and disposal are awaited directly; bind, prompt/abort, idle, and observation waits retain explicit test bounds.

The same fixture runs through actual public `runPrintMode` text/JSON and `runRpcMode` success/failure adapters. Subprocesses have wall-clock termination, bounded stdout/stderr while reading, bounded RPC records/content, and deterministic cleanup. Their result files retain bounded provider observations and fetch-attempt counts. Text mode keeps command-only custom results in session history but prints no assistant text. JSON and RPC expose the custom-message lifecycle. Terminal `InteractiveMode` remains the boundary described below.

The actual public `runPrintMode()` adapter is exercised in both text and JSON modes. JSON exposes the custom-message lifecycle. Pi's text adapter owns output policy and prints only a final assistant message, so a command-only custom result remains durable in the session but is not written to text stdout. The actual public `runRpcMode()` adapter is exercised in a subprocess through its JSON stdin/stdout protocol; the test observes the custom event, reads the durable entry with `get_entries`, closes stdin, and requires deterministic process shutdown.

`AgentSessionRuntime` can receive injected resource loaders and extension factories through its public factory. Remaining limits are adapter-owned I/O and lifecycle: `runRpcMode()` owns process stdin/stdout and exits the process on shutdown; print mode owns its output/disposal lifecycle; and `InteractiveMode` requires a real terminal/TUI event loop. The grant matrix binds a real public `AgentSession`/`ExtensionRunner` with `mode: "tui"` and a deterministic public `ExtensionUIContext.confirm`; this exercises actual mode binding, UI authorization, host model streaming, tool execution, and session persistence. It is not the terminal-bound `InteractiveMode` adapter and makes no visual-TUI claim. Actual print, JSON, and RPC adapters are headless and cannot supply an approving human confirmation for `rlm_run`; their bounded `RLM_OPT_IN_REQUIRED` denial is already covered by extension mode tests. `/rlm` remains their direct host-action path. `ExtensionAPI.sendMessage()` also returns `void`, so Pi 0.80.10 exposes no awaited message-persistence acknowledgement to extensions.

## #22 evidence added by #56

- Exact interactive authorization: one deterministic confirmation, one consumed launch-grant audit reopened from session JSONL, and replay rejection for the same request/tool-call ID.
- Full credential-free execution: public host `AgentSession` through production controller, QuickJS, managed journal, and Pi tool-result history reopened from the persisted session file.
- Cancellation: public `AgentSession.abort()`, one provider abort/accounting attempt/managed terminal, durable current-session cancellation, and no late mutation.
- Mode boundary: real headless TUI-mode binding is distinguished from terminal `InteractiveMode`; print/JSON/RPC denial behavior remains explicit.
