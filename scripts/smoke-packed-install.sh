#!/usr/bin/env bash
set -euo pipefail

tmp_dir=""
cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-rlm-packed-smoke.XXXXXX")
export HOME="$tmp_dir/home"
export XDG_CONFIG_HOME="$tmp_dir/config"
export XDG_CACHE_HOME="$tmp_dir/cache"
export XDG_STATE_HOME="$tmp_dir/state"
export npm_config_cache="$tmp_dir/npm-cache"
export NPM_CONFIG_CACHE="$npm_config_cache"
export npm_config_userconfig="$tmp_dir/npmrc"
export NPM_CONFIG_USERCONFIG="$npm_config_userconfig"
export npm_config_globalconfig="$tmp_dir/global-npmrc"
export NPM_CONFIG_GLOBALCONFIG="$npm_config_globalconfig"
export BUN_INSTALL="$tmp_dir/bun"
export BUN_INSTALL_CACHE_DIR="$tmp_dir/bun-cache"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="$tmp_dir/bun-transpiler-cache"
export TMPDIR="$tmp_dir/tmp"
mkdir -p \
  "$HOME" \
  "$XDG_CONFIG_HOME" \
  "$XDG_CACHE_HOME" \
  "$XDG_STATE_HOME" \
  "$npm_config_cache" \
  "$BUN_INSTALL" \
  "$BUN_INSTALL_CACHE_DIR" \
  "$BUN_RUNTIME_TRANSPILER_CACHE_PATH" \
  "$TMPDIR"
: > "$NPM_CONFIG_USERCONFIG"
: > "$NPM_CONFIG_GLOBALCONFIG"

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
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

# Resolve the installed extension through its public Pi package manifest, then
# ask Pi's public JSON adapter to execute a provider-free missing-source command.
manifest="$fixture/node_modules/pi-rlm/package.json"
extension_path=$(node - "$manifest" <<'NODE'
const path = require("node:path");
const manifestPath = process.argv[2];
const manifest = require(manifestPath);
const extensions = manifest.pi?.extensions;
if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string")
  throw new Error("installed pi.extensions manifest is invalid");
process.stdout.write(path.resolve(path.dirname(manifestPath), extensions[0]));
NODE
)
smoke_output="$tmp_dir/pi-output.jsonl"
(
  cd "$fixture"
  NO_COLOR=1 "$fixture/node_modules/.bin/pi" --mode json -e "$extension_path" "/rlm" > "$smoke_output"
)
node - "$smoke_output" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const raw = fs.readFileSync(path, "utf8");
if (Buffer.byteLength(raw, "utf8") > 128 * 1024) throw new Error("packed Pi output was not bounded");
const records = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const messages = records.filter((record) =>
  (record.type === "message_start" || record.type === "message_end")
  && record.message?.role === "custom"
  && record.message?.customType === "pi-rlm-result");
if (messages.length !== 2) throw new Error("packed Pi command did not emit one custom-message lifecycle");
if (!messages.every((record) => typeof record.message.content === "string"
  && record.message.content.includes("RLM_SOURCE_REQUIRED")))
  throw new Error("packed Pi command did not expose RLM_SOURCE_REQUIRED");
console.log("packed Pi discovery/command smoke passed");
NODE
