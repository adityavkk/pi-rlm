# TUI user journey

pi-rlm uses one compact workflow tray for live work, then focused views for retained runs and exact approvals. The hierarchy follows the useful parts of [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows): clear status markers, one primary identity, aligned accounting, and controls next to the view they affect.

The screenshots show production pi-rlm components inside a full Pi CLI session with the normal context, skills, prompts, extensions, model profile, and `catppuccin-mocha` theme. Pi loaded the committed [`full-pi-visual-extension.ts`](../src/extension/testing/full-pi-visual-extension.ts) fixture for deterministic run data. The fixture makes no provider request and needs no credential.

## Active run

The tray stays above the editor while the session remains usable. It shows the current phase and bounded accounting without source text, prompts, paths, or provider output.

![Active pi-rlm run showing the controller phase, calls, frames, tokens, and elapsed time](images/tui-user-journey/active-run.png)

## Completed result

Completion is a compact conversation entry rather than a raw metadata card. The bounded final answer stays visible below terminal status and accounting.

![Completed pi-rlm fallback result with its bounded final answer](images/tui-user-journey/completed-result.png)

## Run navigator

`/rlm runs` opens a focused run list. Selection and execution status use separate markers. Columns show only trusted state, activity, storage, and source metadata.

![Run navigator with two retained completed runs and one retained failed run](images/tui-user-journey/run-navigator.png)

## Run inspector

Enter opens the selected retained run. The left rail switches between summary, frames, cells, calls, budget, and errors. The right pane shows one bounded page. Arrow keys scroll local items; `n` and `p` move between authenticated backend pages.

![Run inspector with a view rail and bounded summary accounting](images/tui-user-journey/run-inspector.png)

## Exact agent approval

Delegation pauses at Pi's host-owned confirmation. The dialog groups routing, exact request hashes, task preview, and capability warning. Approval still applies to one exact request and remains timeout-bound.

![Delegated Pi agent approval grouped into routing, request, task, and capability sections](images/tui-user-journey/agent-approval.png)

Cancellation uses the same compact result language as completion: a status marker, operation, trusted code, and short message. `/rlm cancel <local-alias>` still requires the current process-local capability.

## Capture boundary

The images are cropped native terminal captures from a full Pi session running in Ghostty through Herdr. Cropping removes the Herdr sidebar, prior conversation rows, and empty terminal space. Displayed pi-rlm content is unchanged. Accounting values are synthetic fixture data. The fixture proves the interaction and rendering path, not provider output quality. Provider behavior remains covered by the release-bound live acceptance report.
