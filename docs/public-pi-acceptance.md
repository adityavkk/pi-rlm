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

`src/extension/testing/offline-provider-runtime.ts` is the reusable credential-independent full-path fixture. It creates Pi's public `ModelRuntime` with `InMemoryCredentialStore`, `InMemoryModelsStore`, `modelsPath: null`, and `allowModelNetwork: false`; registers static controller/host models and a deterministic custom `streamSimple`; and injects `PiModelClient(ModelRuntime)` through `createRlmExtension` runtime dependencies. The extension then uses the production `ModelController`, `QuickJsBackend`, `runProgram`, managed private run storage, authoritative journal, and `ExtensionAPI.sendMessage()` path. A global fetch tripwire throws and records every attempt; all acceptance outcomes require a zero count. No host credential, environment key, socket, HTTP server, or network request is used.

The pinned Pi 0.80.10 `ModelRuntime` publicly exports `registerProvider(providerId, ProviderConfigInput)`. It does not export `registerNativeProvider` or accept the native `Provider` returned by pi-ai `createProvider`. The fixture therefore uses `registerProvider` with a fixed non-secret auth/base-URL metadata marker required by that public validation shape; its custom stream owns dispatch and the tripwire proves the marker is never used for transport. The compile-time guard in `src/extension/offline-provider.e2e.test.ts` binds registration to `ModelRuntime["registerProvider"]`.

Deterministic modes cover a valid one-cell controller response, a typed Pi error stream, and a stream that settles only after its request `AbortSignal`. Success and provider failure each produce exactly one bounded durable `pi-rlm-result` session entry whose full schema, content, terminal metadata, and ledger accounting are asserted. Tests also assert exact routing/options/context, `maxRetries: 0`, provider request identity, journal sequence, output reference, and attempts/tokens/cost/duration settlement.

Pending cancellation uses public `AgentSessionRuntime.newSession()` after provider start. Session replacement intentionally suppresses result delivery into the replacement session: the authoritative retained managed journal, not replacement-session history, contains the single `run_cancelled` terminal. Releasing the late-emission gate must leave journal bytes, events, and accounting unchanged. Real `AgentSession` tool-cancellation history is separate work tracked by #56; cross-session result contamination is forbidden.

The same fixture runs through actual public `runPrintMode` text/JSON and `runRpcMode` success/failure adapters. Subprocesses have wall-clock termination, bounded stdout/stderr while reading, bounded RPC records/content, and deterministic cleanup. Their result files retain bounded provider observations and fetch-attempt counts. Text mode keeps command-only custom results in session history but prints no assistant text. JSON and RPC expose the custom-message lifecycle. Terminal `InteractiveMode` and grant replay remain the boundaries described below.

The actual public `runPrintMode()` adapter is exercised in both text and JSON modes. JSON exposes the custom-message lifecycle. Pi's text adapter owns output policy and prints only a final assistant message, so a command-only custom result remains durable in the session but is not written to text stdout. The actual public `runRpcMode()` adapter is exercised in a subprocess through its JSON stdin/stdout protocol; the test observes the custom event, reads the durable entry with `get_entries`, closes stdin, and requires deterministic process shutdown.

`AgentSessionRuntime` can receive injected resource loaders and extension factories through its public factory. Remaining limits are adapter-owned I/O and lifecycle: `runRpcMode()` owns process stdin/stdout and exits the process on shutdown; print mode owns its output/disposal lifecycle; and `InteractiveMode` requires a real terminal/TUI event loop. The headless suite therefore tests the real `AgentSession` plus `ExtensionRunner` with `mode: "tui"`, but does not claim to execute the terminal-bound `InteractiveMode` adapter. `ExtensionAPI.sendMessage()` also returns `void`, so Pi 0.80.10 exposes no awaited message-persistence acknowledgement to extensions.
