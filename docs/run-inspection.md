# Managed run inspection pages

`inspectManagedRunPage(request, options?)` is the host-neutral, read-only projection API for inspector UIs, RPC handlers, and commands. It accepts a validated `run-<32 lowercase hex>` managed directory name, not a filesystem path. `ManagedRunStore` resolves the name beneath its configured root and validates the run before authority files are opened. Caller-owned `runProgram` directories are outside this API.

## Authority and paging

Each request reads the private canonical manifest, permanent lock, and a bounded `events.jsonl` prefix. The journal limit is 32 MiB. At most 100,000 committed events and 10,000 projected items are accepted. The semantic recovery fold validates run identity, manifest hash, frame ancestry, cells, call executions, attempts, answers, closures, and terminal state. `status.json` and context payloads are not inspection authority.

Pages default to 50 items and reject sizes outside 1 through 200. The serialized page limit is 256 KiB. Pagination returns fewer items when the requested count would cross that byte limit.

A next cursor is a canonical base64url version-1 envelope authenticated with HMAC-SHA-256. The default key is private to the current process. Hosts may inject a stable key of at least 32 bytes. The cursor binds the run ID, manifest hash, view, frame filter, event count, byte length, SHA-256 of the committed journal prefix, and next offset. Later pages read and validate only that exact prefix. Appends and torn bytes after the prefix do not change the page set. Prefix replacement, truncation, another run/view/filter, malformed encoding, or field modification returns `RUN_INSPECTION_INVALID_CURSOR`.

## Views and disclosure

Supported views are `summary`, `frames`, `cells`, `calls`, `budget`, and `errors`. Results contain bounded lifecycle state, deterministic IDs, counts, usage reports, limits, completion mode, and output size or hash metadata.

Guest and provider text does not enter the default projection. Phase names, call keys, untrusted error codes, and error messages become SHA-256 plus UTF-8 byte count. A fixed host-owned error taxonomy may also expose `trustedCode`. Pages exclude:

- source and input bytes
- program objectives and prompts
- controller reasoning and generated code
- phase and call-key text
- cell output previews and final answer values
- raw error messages and provider error strings
- context payloads and artifact paths

The budget view labels journal-derived values as observed lower bounds. `committedCalls` is not the tree-wide logical-call ledger. `observedControllerProviderAttempts` is not the controller-turn ledger. Exact recovered accounting requires the checkpoint format tracked under resume issue #85.

The API never writes, repairs a torn journal tail, acquires writer ownership, resumes a run, or changes `inspectRecoveredRun`. Same-user parent pathname replacement remains subject to the filesystem limits documented in run recovery and retention.
