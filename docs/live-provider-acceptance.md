# Live provider acceptance

The live suite is an operator-authorized, one-shot campaign against exactly two configured Pi routes. The normal test suite never constructs a live runtime or calls a provider. The campaign runs each route in a separate child process and publishes only a canonical numeric/allowlisted report.

## Invocation

```sh
bun run acceptance:live --consent /absolute/path/consent.json --output /absolute/path/report.json
```

Arguments are exact. Extra, reordered, missing, or same-path arguments are rejected. Invalid authority is rejected before the provider-capable suite is dynamically imported. The inherited environment is passed unchanged to route children; the runner never reads or prints credential values.

## Consent contract

Consent is canonical JSON: UTF-8, no whitespace outside JSON strings, object keys sorted recursively, no duplicate keys. Maximum size: 64 KiB. The file must be a current-user-owned regular file, exact mode `0600`, one link, and opened without following symlinks.

Exact identity fields:

- `purpose`: `pi-rlm-live-provider-acceptance`
- `version`: `1`
- `gitCommit`: lowercase 40-character commit hash
- `suiteDigest`: `eec3091ee4221054fc92bb34ba2481ff728c204ba1bb40b49295e5627bb28d9b`
- `fixtureDigest`: `af4c961a5d783e60f2116bb749bdef08e75c212190e3824bcb74ffd0b95405fb`
- `issuedAtMs`, `expiresAtMs`: nonnegative safe-integer Unix milliseconds; expiry follows issuance
- `nonce`: 32 to 128 URL-safe characters
- `routes`: exactly two `{ provider, model, apiFamily }` objects
- `bounds`: the five authority limits below

Routes require distinct exact provider/model identities. `apiFamily` is confirmed through exact model discovery. Prefer different providers and API families when two working credentialed routes are available, but two distinct models on one provider still satisfy this compatibility campaign. Route aliases are prohibited in consent. Do not put credentials, prompts, responses, errors, environment values, headers, or URLs in consent.

Bounds:

- `maxInvocations`: 1 to 10,000
- `maxOutputTokensPerInvocation`: 1 to 1,000,000
- `maxAggregateTokens`: 1 to 100,000,000
- `maxWallTimeMs`: 1 to 86,400,000
- `maxPiCatalogEstimateUsd`: 0 to 10,000

The fixed two-route plan currently requires at least 62 invocations, 1,024 output tokens per invocation, 413,282 estimated aggregate tokens, and 1,650,000 ms wall time. Use a deliberate catalog-estimate ceiling appropriate for the selected routes. The catalog estimate is post-reported from Pi usage metadata, not an actual or billed-cost guarantee.

Run the campaign from a clean git checkout with the exact pinned Pi dependencies installed. Construct consent offline, canonicalize with a trusted local tool, and set mode `0600`. The runner validates the package repository revision, tracked-file cleanliness, and installed dependency versions before consent, after consent, around each child, and before report publication. Each child repeats revision checks before importing scenarios and before publishing its result. The runner validates consent file identity before and after its bounded read, then atomically renames authority away before suite loading. Callback failure or process crash consumes authority. A normal completion removes the renamed file; a crash can leave a hidden consumed file for secure operator deletion. Never reuse or copy nonce-bearing consent.

## Fixed campaign

Each route runs the same committed fixtures: exact direct nonce; public `AgentSession` `/rlm` extension path; structured leaf; ordered four-item batch at observed concurrency two; one child recurse with one live leaf; provider-backed fallback extraction after deterministic controller exhaustion; low-cap truncation; in-flight cancellation after a Pi stream start; one authenticated request whose payload is replaced with a fixed invalid object and must produce an observed HTTP 4xx provider response; controller repair accounting; and one 192 KiB direct/RLM long-context pair.

The long-context threshold is one fixed campaign, not a statistical or p95 claim:

- exact correctness: 100%
- RLM attempts: at most 12
- token ratio: at most 6x direct
- Pi catalog-estimate ratio: at most 6x direct
- wall-latency ratio: at most 8x direct
- RLM wall time: at most 180 seconds
- full-source sentinel: present in the direct request and absent from every RLM provider request

The child enforces fixed per-case and route invocation/output caps before calls. If a provider reports more output than requested, `PiModelClient` fails the call as `OUTPUT_TRUNCATED`, charges the reported usage, and the truncation case records the bounded overshoot rather than accepting the text. Every settled runtime case reconciles observed completion boundaries, journal intents/settlements, and ledger attempts/usage. Cancellation may report `unknown_after_cancel`; unsettled provider work is never represented as zero usage. Token totals cover settled Pi-reported usage only. Cost is Pi's catalog estimate, not provider billing.

## Containment and report

The parent expands and verifies the full plan before spawning. Route children run serially with the current Bun executable, inherited environment, private `0700` roots inside the parent-owned suite tree, private canonical request/report files, bounded silent stdout/stderr drains, wall timeout, kill/reap, strict route binding, and cleanup in `finally`. The parent removes and verifies the complete tree after reaping, including when `SIGKILL` prevents worker cleanup. Any child stdout or stderr byte fails the campaign and is discarded.

The final report is at most 256 KiB, canonical JSON, and published as a same-directory atomic no-clobber `0600` file. It contains only fixed versions, aliases, digests, allowlisted case/code/verdict/usage-completeness values, booleans for committed thresholds, and bounded finite numeric accounting. Per-case records include calls, intents, settlements, attempts, tokens, Pi catalog estimate, provider/wall duration, output bytes, correctness ppm, concurrency, and source-sentinel hits. Provider/model names, prompts, source, raw outputs, errors, paths, URLs, headers, environment values, actual cost, and billed cost are rejected. Supplied secret canaries are checked against child and final canonical reports.

## Accepted evidence

Commit `d7dd195` passed both exact routes in one contained campaign. The report records 34 Pi completion boundaries, 62,209 settled reported tokens, a $0.2771525 Pi catalog estimate, one observed HTTP 4xx provider response per route, explicit cancellation usage `unknown_after_cancel`, and every benchmark threshold as true. See [`evidence/live-provider-acceptance-d7dd195.json`](evidence/live-provider-acceptance-d7dd195.json).

## CI policy

The manual workflow remains fail closed because CI cannot securely provision a current-user `0600` one-shot consent. It has no push, pull-request, or scheduled trigger and starts no provider-capable process. Do not add provider credentials until protected provisioning and environment approval exist.
