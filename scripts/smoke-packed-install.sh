#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/smoke-packed-install-args.sh
source "$root_dir/scripts/smoke-packed-install-args.sh"
host_path=${PATH:?}
env_bin=/usr/bin/env
uname_bin=/usr/bin/uname
id_bin=/usr/bin/id
if [[ ! -x "$env_bin" || ! -x "$uname_bin" || ! -x "$id_bin" ]]; then
  echo "packed smoke requires trusted env, uname, and id executables" >&2
  exit 1
fi
tmp_dir=""
active_group_pid=""
terminate_active_group() {
  if [[ -z "$active_group_pid" ]]; then return; fi
  /bin/kill -TERM "-$active_group_pid" 2>/dev/null || true
  for _ in {1..50}; do
    if ! /bin/kill -0 "-$active_group_pid" 2>/dev/null; then break; fi
    /bin/sleep 0.1
  done
  /bin/kill -KILL "-$active_group_pid" 2>/dev/null || true
  wait "$active_group_pid" 2>/dev/null || true
  active_group_pid=""
}
cleanup() {
  terminate_active_group
  if [[ -n "$tmp_dir" ]]; then
    chmod -R u+w "$tmp_dir" 2>/dev/null || true
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-rlm-packed-smoke.XXXXXX")

prepare_roots() {
  local base=$1
  mkdir -p "$base/home" "$base/config" "$base/cache" "$base/data" "$base/state" \
    "$base/npm-cache" "$base/npm-prefix" "$base/bun" "$base/bun-cache" \
    "$base/bun-global" "$base/bun-transpiler-cache" "$base/tmp"
  : > "$base/npmrc"
  : > "$base/global-npmrc"
}

isolated() {
  local base=$1
  shift
  "$env_bin" -i \
    HOME="$base/home" \
    PATH="$host_path" \
    XDG_CONFIG_HOME="$base/config" \
    XDG_CACHE_HOME="$base/cache" \
    XDG_DATA_HOME="$base/data" \
    XDG_STATE_HOME="$base/state" \
    npm_config_cache="$base/npm-cache" \
    NPM_CONFIG_CACHE="$base/npm-cache" \
    npm_config_userconfig="$base/npmrc" \
    NPM_CONFIG_USERCONFIG="$base/npmrc" \
    npm_config_globalconfig="$base/global-npmrc" \
    NPM_CONFIG_GLOBALCONFIG="$base/global-npmrc" \
    npm_config_prefix="$base/npm-prefix" \
    NPM_CONFIG_PREFIX="$base/npm-prefix" \
    BUN_INSTALL="$base/bun" \
    BUN_INSTALL_CACHE_DIR="$base/bun-cache" \
    BUN_INSTALL_GLOBAL_DIR="$base/bun-global" \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH="$base/bun-transpiler-cache" \
    TMPDIR="$base/tmp" \
    "$@"
}

root_network_denied() {
  local base=$1
  shift
  local sudo_bin=/usr/bin/sudo
  local unshare_bin=/usr/bin/unshare
  local setpriv_bin=/usr/bin/setpriv
  if [[ ! -x "$sudo_bin" || ! -x "$unshare_bin" || ! -x "$setpriv_bin" ]]; then
    echo "packed smoke root network denial prerequisites are unavailable" >&2
    return 1
  fi
  "$sudo_bin" -n "$unshare_bin" --net -- "$setpriv_bin" \
    --reuid="$($id_bin -u)" --regid="$($id_bin -g)" --init-groups \
    "$env_bin" -i \
      HOME="$base/home" \
      PATH="$host_path" \
      XDG_CONFIG_HOME="$base/config" \
      XDG_CACHE_HOME="$base/cache" \
      XDG_DATA_HOME="$base/data" \
      XDG_STATE_HOME="$base/state" \
      npm_config_cache="$base/npm-cache" \
      NPM_CONFIG_CACHE="$base/npm-cache" \
      npm_config_userconfig="$base/npmrc" \
      NPM_CONFIG_USERCONFIG="$base/npmrc" \
      npm_config_globalconfig="$base/global-npmrc" \
      NPM_CONFIG_GLOBALCONFIG="$base/global-npmrc" \
      npm_config_prefix="$base/npm-prefix" \
      NPM_CONFIG_PREFIX="$base/npm-prefix" \
      BUN_INSTALL="$base/bun" \
      BUN_INSTALL_CACHE_DIR="$base/bun-cache" \
      BUN_INSTALL_GLOBAL_DIR="$base/bun-global" \
      BUN_RUNTIME_TRANSPILER_CACHE_PATH="$base/bun-transpiler-cache" \
      TMPDIR="$base/tmp" \
      "$@"
}

runtime_network_denied() {
  local base=$1
  shift
  case "$("$uname_bin" -s)" in
    Darwin)
      if [[ ! -x /usr/bin/sandbox-exec ]]; then
        echo "packed smoke requires sandbox-exec for runtime network denial" >&2
        return 1
      fi
      isolated "$base" /usr/bin/sandbox-exec \
        -p '(version 1) (allow default) (deny network*)' \
        "$@"
      ;;
    Linux)
      if [[ ${PI_RLM_ROOT_NETWORK_DENIAL:-0} == 1 ]]; then
        root_network_denied "$base" "$@"
      elif command -v bwrap >/dev/null 2>&1; then
        isolated "$base" bwrap --unshare-net --bind / / -- "$@"
      elif command -v unshare >/dev/null 2>&1; then
        isolated "$base" unshare --user --map-root-user --net -- "$@"
      else
        echo "packed smoke requires bwrap or unshare for runtime network denial" >&2
        return 1
      fi
      ;;
    *)
      echo "packed smoke has no network-denial backend for $("$uname_bin" -s)" >&2
      return 1
      ;;
  esac
}

if [[ ${1:-} == "--isolation-probe" ]]; then
  probe_dir="$tmp_dir/isolation-probe"
  prepare_roots "$probe_dir"
  runtime_network_denied "$probe_dir" "$env_bin" node -e '
    if (process.env.NODE_OPTIONS !== undefined) throw new Error("caller NODE_OPTIONS crossed isolation");
    if (Object.keys(process.env).some((key) => key.startsWith("BASH_FUNC_env")))
      throw new Error("caller exported env function crossed isolation");
  '
  echo "packed smoke trusted-env and network-denial probe passed"
  exit 0
fi

pack_dir="$tmp_dir/pack"
prepare_roots "$pack_dir"
pack_json="$pack_dir/pack.json"
isolated "$pack_dir" npm pack "$root_dir" --json --pack-destination "$tmp_dir" > "$pack_json"
tarball_name=$(isolated "$pack_dir" node -e '
  const result = require(process.argv[1]);
  if (result.length !== 1 || typeof result[0]?.filename !== "string") process.exit(1);
  process.stdout.write(result[0].filename);
' "$pack_json")
tarball="$tmp_dir/$tarball_name"

prepare_case() {
  local case_name=$1
  local case_dir="$tmp_dir/$case_name"
  local fixture="$case_dir/fixture"
  prepare_roots "$case_dir"
  mkdir -p "$fixture"

  isolated "$case_dir" node - "$tarball" > "$fixture/package.json" <<'NODE'
const tarball = process.argv[2];
process.stdout.write(JSON.stringify({
  private: true,
  type: "module",
  dependencies: {
    "@earendil-works/pi-agent-core": "0.80.10",
    "@earendil-works/pi-ai": "0.80.10",
    "@earendil-works/pi-coding-agent": "0.80.10",
    "@earendil-works/pi-tui": "0.80.10",
    "typebox": "1.1.38",
    "pi-rlm": `file:${tarball}`,
    "pi-subagents": "0.36.0",
  },
}, null, 2));
NODE

  if ! isolated "$case_dir" npm install \
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

  # Pi owns its runtime packages. The packed package must not install a private host.
  test ! -e "$fixture/node_modules/pi-rlm/node_modules/@earendil-works/pi-coding-agent"
}

run_pi() {
  local case_name=$1
  local case_dir="$tmp_dir/$case_name"
  local fixture="$case_dir/fixture"
  local output="$case_dir/pi-output.jsonl"
  local stderr_log="$case_dir/pi-stderr.log"
  local session_file="$case_dir/session.jsonl"
  local session_id
  case "$case_name" in
    direct) session_id="00000000-0000-7000-8000-000000000001" ;;
    installed) session_id="00000000-0000-7000-8000-000000000002" ;;
  esac
  isolated "$case_dir" node - "$session_id" "$fixture" > "$session_file" <<'NODE'
const [id, cwd] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({
  type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd,
})}\n`);
NODE
  build_pi_args "$case_name" "$root_dir" "$session_file"

  if ! (
    cd "$fixture"
    runtime_network_denied "$case_dir" "$env_bin" \
      NO_COLOR=1 \
      PI_OFFLINE=1 \
      PI_TELEMETRY=0 \
      PI_SKIP_VERSION_CHECK=1 \
      HTTP_PROXY=http://127.0.0.1:9 \
      HTTPS_PROXY=http://127.0.0.1:9 \
      ALL_PROXY=http://127.0.0.1:9 \
      NO_PROXY= \
      "$fixture/node_modules/.bin/pi" "${pi_args[@]}" > "$output" 2> "$stderr_log"
  ); then
    echo "$case_name Pi invocation failed" >&2
    exit 1
  fi

  isolated "$case_dir" node "$root_dir/scripts/smoke-packed-install-parser.mjs" \
    validate "$output" "$stderr_log" "$session_file" "$case_name"
}

prepare_case direct
(
  cd "$tmp_dir/direct/fixture"
  isolated "$tmp_dir/direct" bun --eval '
    const extension = await import("pi-rlm");
    const core = await import("pi-rlm/core");
    const runtime = await import("pi-rlm/runtime");
    if (typeof extension.default !== "function") throw new Error("extension default export missing");
    if (!core.compileShorthand({ objective: "packed smoke" }).ok) throw new Error("core smoke failed");
    if (typeof runtime.runProgram !== "function") throw new Error("runtime export missing");
    console.log("packed install/import smoke passed");
  '
)
run_pi direct

prepare_case installed
installed_package="$tmp_dir/installed/fixture/node_modules/pi-rlm"
isolated "$tmp_dir/installed" node - "$installed_package/package.json" <<'NODE'
const manifest = require(process.argv[2]);
const extensions = manifest.pi?.extensions;
if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== "./index.ts")
  throw new Error("installed pi.extensions manifest is invalid");
NODE
mkdir -p "$tmp_dir/installed/home/.pi/agent"
isolated "$tmp_dir/installed" node - "$installed_package" > "$tmp_dir/installed/home/.pi/agent/settings.json" <<'NODE'
const installedPackage = process.argv[2];
process.stdout.write(JSON.stringify({
  packages: [installedPackage],
  enableInstallTelemetry: false,
}, null, 2));
NODE
run_pi installed

prepare_case managed-commands
(
  cd "$tmp_dir/managed-commands/fixture"
  runtime_network_denied "$tmp_dir/managed-commands" "$env_bin" \
    NO_COLOR=1 \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    bun test "$tmp_dir/managed-commands/fixture/node_modules/pi-rlm/src/extension/managed-commands.public.integration.test.ts"
)

prepare_case active-subagents
set -m
(
  cd "$tmp_dir/active-subagents/fixture"
  runtime_network_denied "$tmp_dir/active-subagents" "$env_bin" \
    NO_COLOR=1 \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_RLM_TEST_PI_BIN="$tmp_dir/active-subagents/fixture/node_modules/.bin/pi" \
    bun test "$tmp_dir/active-subagents/fixture/node_modules/pi-rlm/src/extension/active-subagents.integration.test.ts"
) &
active_group_pid=$!
set +e
wait "$active_group_pid"
active_status=$?
set -e
terminate_active_group
set +m
if [[ $active_status -ne 0 ]]; then
  echo "active pi-subagents packed fixture failed" >&2
  exit "$active_status"
fi
