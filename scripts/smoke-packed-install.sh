#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-rlm-packed-smoke.XXXXXX")
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

pack_json="$tmp_dir/pack.json"
npm pack "$root_dir" --json --pack-destination "$tmp_dir" > "$pack_json"
tarball_name=$(node -e 'const result = require(process.argv[1]); if (result.length !== 1) process.exit(1); process.stdout.write(result[0].filename);' "$pack_json")
tarball="$tmp_dir/$tarball_name"
fixture="$tmp_dir/fixture"
mkdir -p "$fixture"

node - "$tarball" > "$fixture/package.json" <<'NODE'
const tarball = process.argv[2];
process.stdout.write(JSON.stringify({
  private: true,
  type: "module",
  dependencies: {
    "@earendil-works/pi-coding-agent": "0.80.10",
    "pi-rlm": `file:${tarball}`,
  },
}, null, 2));
NODE

npm install \
  --prefix "$fixture" \
  --ignore-scripts \
  --install-strategy=nested \
  --no-audit \
  --no-fund \
  --no-package-lock \
  --omit=dev

# Pi owns its runtime packages. The fixture supplies the pinned host package;
# pi-rlm must not install a private copy.
test ! -e "$fixture/node_modules/pi-rlm/node_modules/@earendil-works/pi-coding-agent"

(
  cd "$fixture"
  bun --eval '
    const extension = await import("pi-rlm");
    const core = await import("pi-rlm/core");
    const runtime = await import("pi-rlm/runtime");
    if (typeof extension.default !== "function") throw new Error("extension default export missing");
    if (!core.compileShorthand({ objective: "packed smoke" }).ok) throw new Error("core smoke failed");
    if (typeof runtime.runProgram !== "function") throw new Error("runtime export missing");
    console.log("packed install/import smoke passed");
  '
)
