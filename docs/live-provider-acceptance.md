# Live provider acceptance

Phase 1 defines authority, reporting, and a fail-closed parent runner. The live suite is not implemented yet. A valid consent is consumed before the runner dynamically imports the suite seam, which currently fails with `SUITE_NOT_IMPLEMENTED`. No provider call should occur in this phase.

## Invocation

```sh
bun run acceptance:live --consent /absolute/path/consent.json --output /absolute/path/report.json
```

Arguments are exact. Extra, reordered, missing, or same-path arguments are rejected. Invalid authority is rejected before any suite or provider-capable module import. A report is published only after a suite returns a valid report within the consumed authority.

## Consent contract

Consent is canonical JSON: UTF-8, no whitespace outside JSON strings, object keys sorted recursively, no duplicate keys. Maximum size: 64 KiB. The file must be a current-user-owned regular file, exact mode `0600`, one link, and opened without following symlinks.

Exact top-level fields:

- `purpose`: `pi-rlm-live-provider-acceptance`
- `version`: `1`
- `gitCommit`: lowercase 40-character commit hash
- `suiteDigest`: `0be38bf0ffe26c9e5affc9071bcc0c415c2f63073a0ff0d04beca92bd43de514`
- `fixtureDigest`: `c116e7ff4037956b274a3c5e102759db5a35eb69b4b550451e5756e21b643480`
- `issuedAtMs`, `expiresAtMs`: nonnegative safe-integer Unix milliseconds; expiry must follow issuance
- `nonce`: 32 to 128 URL-safe characters
- `routes`: exactly two `{ provider, model, apiFamily }` objects
- `bounds`: the five authority limits below

Routes must have distinct provider/model identities, distinct providers, and distinct expected API families. `apiFamily` is the exact value discovery must confirm. Route aliases are prohibited in consent. Provider, model, and API-family values are bounded identifiers, not URLs or headers.

Bounds:

- `maxInvocations`: 1 to 10,000
- `maxOutputTokensPerInvocation`: 1 to 1,000,000
- `maxAggregateTokens`: 1 to 100,000,000 and not below the per-invocation output limit
- `maxWallTimeMs`: 1 to 86,400,000
- `maxPiCatalogEstimateUsd`: 0 to 10,000

Construct the JSON offline, canonicalize it with a trusted local tool, and set mode `0600` before invocation. Do not put credentials, prompts, responses, errors, environment values, headers, or URLs in consent.

The runner validates file identity before and after its bounded read, validates time/commit/digests, then atomically renames the authority away from its original path before suite loading. Callback failure and process crash after rename consume authority. A normal callback completion or failure removes the renamed file; a crash can leave a hidden consumed file for the operator to delete securely. Never reuse or copy a nonce-bearing consent.

## Report contract

Maximum canonical JSON size: 256 KiB. Publication is a same-directory, atomic no-clobber link from a synced exact-mode `0600` temporary file. Existing output is never replaced.

Reports contain only:

- fixed version and allowlisted result/cancellation codes
- git, suite, fixture, and route digests
- `route-1` and `route-2` aliases
- bounded finite numeric timestamps, durations, counts, token usage, and estimates

All other keys are rejected. In particular, provider/model names, prompts, source, raw errors, environment values, headers, URLs, actual cost, and billed cost are prohibited. Callers supply secret canaries to both report validation and publication; any canary match rejects publication.

Cost is named `piCatalogEstimateUsd`. It is only an estimate from Pi's model catalog, never actual or billed cost. Invocation/token/cost totals must reconcile with both route records. Cancellation usage is one of:

- `{ "status": "not_cancelled" }`
- `{ "status": "known", "aggregateTokens": N }`
- `{ "status": "unknown_after_cancel" }`

Unsettled provider work must use `unknown_after_cancel`; it must not be represented as zero.

## Security limits

- Phase 1 does not implement provider discovery, calls, cancellation, scenarios, or credential loading.
- Post-run accounting validation detects excess but cannot undo provider work. Phase 2 orchestration must enforce bounds before and during calls.
- Filesystem checks reduce symlink, mode, owner, size, and replacement risk on local POSIX filesystems. Do not place consent or output on network, shared, or filesystem implementations with weak rename/link semantics.
- Consent contains route metadata and authority. Keep it private even though credentials are forbidden.
- The runner emits only typed failure codes. It never prints consent or arbitrary provider errors.
- The manual GitHub workflow intentionally fails closed. CI has no secure one-shot `0600` consent provisioning mechanism yet and does not pretend to run the suite. Do not add provider credentials until protected provisioning and environment approval are designed and reviewed.
