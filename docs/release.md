# Version 0.1.0 source release

Version 0.1.0 is published as an annotated Git tag and a GitHub release. GitHub provides the source archives. The release does not publish an npm package or a separate compiled artifact.

Install the exact source tag through Pi. The tag includes `package-lock.json`, and every runtime dependency uses an exact version. Pi's npm install step therefore resolves the same runtime graph on later installs.

```bash
pi install git:github.com/adityavkk/pi-rlm@v0.1.0
```

The unscoped `pi-rlm` name on npm belongs to another project. This repository sets `private: true` in `package.json` so npm publication fails closed.

## Release checks

Pull requests and `main` run the offline release workflow. It uses Bun 1.3.14 and the frozen lockfile. The workflow runs these checks:

- Strict TypeScript checking.
- The complete offline test suite on Linux and macOS.
- A dependency audit that rejects high severity advisories.
- A source package manifest and public evidence check.
- A full history secret scan.
- Packed Pi loading, managed command, active delegation, network denial, caller environment isolation, and cleanup tests.

The release operator also runs the interactive TUI checklist in `README.md`. The operator tests a clean Pi Git install from the exact tag in a private temporary home. The numeric live provider report for the exact tag is attached to the GitHub release as `live-provider-acceptance-v0.1.0.json`. The report contains no provider names, model names, prompts, responses, errors, paths, credentials, or environment values.

## Local release candidate validation

The release candidate passed the following checks on Darwin 26.4.1 arm64 with Bun 1.3.14 and Pi 0.80.10:

- 933 offline tests, 0 failures, 3 snapshots, and 10,769 expectations.
- Strict TypeScript checking.
- Bun and npm dependency audits with no known advisories.
- The source package check with 236 tracked files and 231 packed files.
- Packed loading through both Pi package paths. All 10 managed command tests and all 4 active delegation tests passed.
- Caller environment isolation, operating system network denial, and temporary file cleanup.
- A clean npm install from the committed source lock, followed by type checking and extension imports.
- Interactive TUI acceptance in Herdr. The active widget, cancellation, fallback completion, typed failure, managed run navigator, all six inspector tabs, next and previous pages, and the exact agent approval dialog passed without credentials or provider access.

The GitHub workflow and exact Git source install are checked again after the release candidate is pushed. The live report is produced only from the final clean release commit.

## Security boundaries

Pi extensions run with the user's system access. QuickJS limits controller cells, but it is not an operating system sandbox. A delegated agent has the tools and file access configured for that named Pi agent.

Managed run state can contain objectives, source fragments, model reasoning, progress text, and answer previews. The runtime stores it in private user-owned directories. Do not upload these directories with logs, diagnostics, bug reports, or CI artifacts. Retention deletes files but does not provide secure erasure.

The live acceptance parent gives each route a private temporary home. It copies only that route's stored credential and forwards a fixed environment allowlist that mirrors Pi 0.80.10. It removes the complete route tree after the child exits. The runner verifies the exact source commit and the installed dependency bytes at every provider boundary. File descriptor checks reject content changes during each read. Node does not provide `openat`, so a hostile process running as the same user can still race directory entries. Live acceptance therefore requires a trusted host.

## Release dispositions

- The release uses Git source because the npm package name is unavailable.
- The runtime identity changes from 0.0.2 to 0.1.0. Retained 0.0.2 runs remain inspect-only and fail resume with the typed incompatible result. The release never replays or upgrades them automatically.
- The source archive includes tests and acceptance fixtures. This is deliberate for a source release and makes the offline checks reproducible. It is larger than a minimal runtime artifact.
- The live campaign validates two models through one provider and one API family. It does not prove compatibility across providers.
- The byte-level dependency check for live acceptance is pinned to Darwin on arm64. Offline runtime and package tests also run on Linux in CI.
- Direct arbitrary host tool calls remain outside version 1.
- Delegation context files still have the receiver-verification limitation tracked in issue #72.
- Node does not provide the directory capability needed to remove the documented same-user pathname replacement race.
- Pi 0.80.10 does not report asynchronous custom-message persistence failures to extensions. Ephemeral sessions cannot promise persistence after process exit.
