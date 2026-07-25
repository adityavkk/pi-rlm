#!/usr/bin/env bash
set -euo pipefail

tmp_dir=""
cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    chmod -R u+w "$tmp_dir" 2>/dev/null || true
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
host_path=$PATH
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-rlm-packed-smoke.XXXXXX")
pack_home="$tmp_dir/pack/home"
pack_config="$tmp_dir/pack/config"
pack_cache="$tmp_dir/pack/cache"
pack_state="$tmp_dir/pack/state"
pack_npm_cache="$tmp_dir/pack/npm-cache"
pack_bun="$tmp_dir/pack/bun"
pack_bun_cache="$tmp_dir/pack/bun-cache"
pack_bun_transpiler_cache="$tmp_dir/pack/bun-transpiler-cache"
pack_tmp="$tmp_dir/pack/tmp"
mkdir -p "$pack_home" "$pack_config" "$pack_cache" "$pack_state" \
  "$pack_npm_cache" "$pack_bun" "$pack_bun_cache" \
  "$pack_bun_transpiler_cache" "$pack_tmp"
: > "$tmp_dir/pack/npmrc"
: > "$tmp_dir/pack/global-npmrc"

pack_json="$tmp_dir/pack/pack.json"
env -i \
  HOME="$pack_home" \
  PATH="$host_path" \
  XDG_CONFIG_HOME="$pack_config" \
  XDG_CACHE_HOME="$pack_cache" \
  XDG_STATE_HOME="$pack_state" \
  npm_config_cache="$pack_npm_cache" \
  NPM_CONFIG_CACHE="$pack_npm_cache" \
  npm_config_userconfig="$tmp_dir/pack/npmrc" \
  NPM_CONFIG_USERCONFIG="$tmp_dir/pack/npmrc" \
  npm_config_globalconfig="$tmp_dir/pack/global-npmrc" \
  NPM_CONFIG_GLOBALCONFIG="$tmp_dir/pack/global-npmrc" \
  BUN_INSTALL="$pack_bun" \
  BUN_INSTALL_CACHE_DIR="$pack_bun_cache" \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH="$pack_bun_transpiler_cache" \
  TMPDIR="$pack_tmp" \
  npm pack "$root_dir" --json --pack-destination "$tmp_dir" > "$pack_json"
tarball_name=$(node -e 'const result = require(process.argv[1]); if (result.length !== 1) process.exit(1); process.stdout.write(result[0].filename);' "$pack_json")
tarball="$tmp_dir/$tarball_name"

prepare_case() {
  local case_name=$1
  local case_dir="$tmp_dir/$case_name"
  local fixture="$case_dir/fixture"
  mkdir -p \
    "$case_dir/home" \
    "$case_dir/config" \
    "$case_dir/cache" \
    "$case_dir/state" \
    "$case_dir/npm-cache" \
    "$case_dir/bun" \
    "$case_dir/bun-cache" \
    "$case_dir/bun-transpiler-cache" \
    "$case_dir/tmp" \
    "$fixture"
  : > "$case_dir/npmrc"
  : > "$case_dir/global-npmrc"

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

  if ! env -i \
    HOME="$case_dir/home" \
    PATH="$host_path" \
    XDG_CONFIG_HOME="$case_dir/config" \
    XDG_CACHE_HOME="$case_dir/cache" \
    XDG_STATE_HOME="$case_dir/state" \
    npm_config_cache="$case_dir/npm-cache" \
    NPM_CONFIG_CACHE="$case_dir/npm-cache" \
    npm_config_userconfig="$case_dir/npmrc" \
    NPM_CONFIG_USERCONFIG="$case_dir/npmrc" \
    npm_config_globalconfig="$case_dir/global-npmrc" \
    NPM_CONFIG_GLOBALCONFIG="$case_dir/global-npmrc" \
    BUN_INSTALL="$case_dir/bun" \
    BUN_INSTALL_CACHE_DIR="$case_dir/bun-cache" \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH="$case_dir/bun-transpiler-cache" \
    TMPDIR="$case_dir/tmp" \
    npm install \
      --prefix "$fixture" \
      --ignore-scripts \
      --install-strategy=nested \
      --no-audit \
      --no-fund \
      --no-package-lock \
      --omit=dev > "$case_dir/npm-install.log" 2>&1; then
    echo "$case_name dependency install failed" >&2
    exit 1
  fi

  # Pi owns its runtime packages. The packed pi-rlm must not install a private copy.
  test ! -e "$fixture/node_modules/pi-rlm/node_modules/@earendil-works/pi-coding-agent"
}

run_pi() {
  local case_name=$1
  shift
  local case_dir="$tmp_dir/$case_name"
  local fixture="$case_dir/fixture"
  local output="$case_dir/pi-output.jsonl"
  local stderr_log="$case_dir/pi-stderr.log"

  if ! (
    cd "$fixture"
    env -i \
      HOME="$case_dir/home" \
      PATH="$host_path" \
      XDG_CONFIG_HOME="$case_dir/config" \
      XDG_CACHE_HOME="$case_dir/cache" \
      XDG_STATE_HOME="$case_dir/state" \
      npm_config_cache="$case_dir/npm-cache" \
      NPM_CONFIG_CACHE="$case_dir/npm-cache" \
      npm_config_userconfig="$case_dir/npmrc" \
      NPM_CONFIG_USERCONFIG="$case_dir/npmrc" \
      npm_config_globalconfig="$case_dir/global-npmrc" \
      NPM_CONFIG_GLOBALCONFIG="$case_dir/global-npmrc" \
      BUN_INSTALL="$case_dir/bun" \
      BUN_INSTALL_CACHE_DIR="$case_dir/bun-cache" \
      BUN_RUNTIME_TRANSPILER_CACHE_PATH="$case_dir/bun-transpiler-cache" \
      TMPDIR="$case_dir/tmp" \
      NO_COLOR=1 \
      PI_OFFLINE=1 \
      PI_TELEMETRY=0 \
      PI_SKIP_VERSION_CHECK=1 \
      "$fixture/node_modules/.bin/pi" --mode json "$@" "/rlm" > "$output" 2> "$stderr_log"
  ); then
    echo "$case_name Pi invocation failed" >&2
    exit 1
  fi

  node - "$output" "$stderr_log" "$case_name" <<'NODE'
const fs = require("node:fs");
const [outputPath, stderrPath, caseName] = process.argv.slice(2);
const raw = fs.readFileSync(outputPath, "utf8");
const stderr = fs.readFileSync(stderrPath, "utf8");
if (Buffer.byteLength(raw, "utf8") > 128 * 1024) throw new Error(`${caseName} Pi output was not bounded`);
if (Buffer.byteLength(stderr, "utf8") > 128 * 1024) throw new Error(`${caseName} Pi stderr was not bounded`);
if (/api key|authenticate|provider|network|fetch|ECONN|ENETUNREACH|offline mode/i.test(stderr))
  throw new Error(`${caseName} attempted provider or network access`);
const records = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const messages = records.filter((record) =>
  (record.type === "message_start" || record.type === "message_end")
  && record.message?.role === "custom"
  && record.message?.customType === "pi-rlm-result");
if (messages.length !== 2) throw new Error(`${caseName} did not emit one custom-message lifecycle`);
if (!messages.every((record) => typeof record.message.content === "string"
  && record.message.content.includes("RLM_SOURCE_REQUIRED")))
  throw new Error(`${caseName} did not expose RLM_SOURCE_REQUIRED`);
if (records.some((record) => record.type === "agent_start"))
  throw new Error(`${caseName} unexpectedly started a provider-backed agent turn`);
console.log(`${caseName} package discovery/command smoke passed`);
NODE
}

# Case A: Pi's documented -e package tryout path. The package directory, not its
# extension entry file, is supplied explicitly.
prepare_case direct
(
  cd "$tmp_dir/direct/fixture"
  env -i \
    HOME="$tmp_dir/direct/home" \
    PATH="$host_path" \
    XDG_CONFIG_HOME="$tmp_dir/direct/config" \
    XDG_CACHE_HOME="$tmp_dir/direct/cache" \
    XDG_STATE_HOME="$tmp_dir/direct/state" \
    BUN_INSTALL="$tmp_dir/direct/bun" \
    BUN_INSTALL_CACHE_DIR="$tmp_dir/direct/bun-cache" \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH="$tmp_dir/direct/bun-transpiler-cache" \
    TMPDIR="$tmp_dir/direct/tmp" \
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
run_pi direct -e "$tmp_dir/direct/fixture/node_modules/pi-rlm"

# Case B: Pi's documented local-package settings path. Validate the installed
# manifest declares exactly one extension, but leave discovery of that entry to Pi.
prepare_case installed
installed_package="$tmp_dir/installed/fixture/node_modules/pi-rlm"
node - "$installed_package/package.json" <<'NODE'
const manifest = require(process.argv[2]);
const extensions = manifest.pi?.extensions;
if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string")
  throw new Error("installed pi.extensions manifest is invalid");
NODE
mkdir -p "$tmp_dir/installed/home/.pi/agent"
node - "$installed_package" > "$tmp_dir/installed/home/.pi/agent/settings.json" <<'NODE'
const installedPackage = process.argv[2];
process.stdout.write(JSON.stringify({
  packages: [installedPackage],
  enableInstallTelemetry: false,
}, null, 2));
NODE
run_pi installed
