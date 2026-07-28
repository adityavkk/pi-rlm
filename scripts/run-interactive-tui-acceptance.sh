#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run-interactive-tui-acceptance.sh

Pack the current pi-rlm worktree, install pinned public peers in an isolated
temporary home, and start the credential-free, network-denied TUI fixture.
EOF
}
if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then usage; exit 0; fi
if [[ $# -ne 0 ]]; then usage >&2; exit 2; fi
if [[ ! -t 0 || ! -t 1 ]]; then
  echo "interactive TUI acceptance requires a terminal (try --help for usage)" >&2
  exit 2
fi

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
host_path=${PATH:?}
env_bin=/usr/bin/env
uname_bin=/usr/bin/uname
[[ -x "$env_bin" && -x "$uname_bin" ]] || { echo "trusted env/uname required" >&2; exit 1; }
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-rlm-interactive-tui.XXXXXX")
cleanup() { chmod -R u+w "$tmp_dir" 2>/dev/null || true; rm -rf "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM

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
  "$env_bin" -i HOME="$base/home" PATH="$host_path" \
    XDG_CONFIG_HOME="$base/config" XDG_CACHE_HOME="$base/cache" \
    XDG_DATA_HOME="$base/data" XDG_STATE_HOME="$base/state" \
    npm_config_cache="$base/npm-cache" NPM_CONFIG_CACHE="$base/npm-cache" \
    npm_config_userconfig="$base/npmrc" NPM_CONFIG_USERCONFIG="$base/npmrc" \
    npm_config_globalconfig="$base/global-npmrc" NPM_CONFIG_GLOBALCONFIG="$base/global-npmrc" \
    npm_config_prefix="$base/npm-prefix" NPM_CONFIG_PREFIX="$base/npm-prefix" \
    BUN_INSTALL="$base/bun" BUN_INSTALL_CACHE_DIR="$base/bun-cache" \
    BUN_INSTALL_GLOBAL_DIR="$base/bun-global" \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH="$base/bun-transpiler-cache" \
    TMPDIR="$base/tmp" "$@"
}

pack_root="$tmp_dir/pack"
runtime_root="$tmp_dir/runtime"
prepare_roots "$pack_root"
prepare_roots "$runtime_root"
pack_json="$pack_root/pack.json"
isolated "$pack_root" npm pack "$root_dir" --json --pack-destination "$tmp_dir" > "$pack_json"
tarball_name=$(isolated "$pack_root" node -e '
  const result = require(process.argv[1]);
  if (result.length !== 1 || typeof result[0]?.filename !== "string") process.exit(1);
  process.stdout.write(result[0].filename);
' "$pack_json")
tarball="$tmp_dir/$tarball_name"
fixture="$runtime_root/fixture"
mkdir -p "$fixture"
isolated "$runtime_root" node - "$tarball" > "$fixture/package.json" <<'NODE'
const tarball = process.argv[2];
process.stdout.write(JSON.stringify({
  private: true,
  type: "module",
  dependencies: {
    "@earendil-works/pi-agent-core": "0.80.10",
    "@earendil-works/pi-ai": "0.80.10",
    "@earendil-works/pi-coding-agent": "0.80.10",
    "@earendil-works/pi-tui": "0.80.10",
    "pi-rlm": `file:${tarball}`,
    "pi-subagents": "0.36.0",
    "typebox": "1.1.38"
  }
}, null, 2));
NODE
isolated "$runtime_root" npm install --prefix "$fixture" --ignore-scripts \
  --install-strategy=nested --no-audit --no-fund --no-package-lock --omit=dev

test -f "$fixture/node_modules/pi-rlm/src/extension/testing/interactive-tui-fixture.ts"
test ! -e "$fixture/node_modules/pi-rlm/node_modules/@earendil-works/pi-coding-agent"
cd "$fixture"
common_env=(
  HOME="$runtime_root/home" PATH="$host_path" TERM="${TERM:-xterm-256color}"
  XDG_CONFIG_HOME="$runtime_root/config" XDG_CACHE_HOME="$runtime_root/cache"
  XDG_DATA_HOME="$runtime_root/data" XDG_STATE_HOME="$runtime_root/state"
  BUN_INSTALL="$runtime_root/bun" BUN_INSTALL_CACHE_DIR="$runtime_root/bun-cache"
  BUN_INSTALL_GLOBAL_DIR="$runtime_root/bun-global"
  BUN_RUNTIME_TRANSPILER_CACHE_PATH="$runtime_root/bun-transpiler-cache"
  TMPDIR="$runtime_root/tmp" PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1
  HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9
  ALL_PROXY=http://127.0.0.1:9 NO_PROXY=
)
case $("$uname_bin" -s) in
  Darwin)
    [[ -x /usr/bin/sandbox-exec ]] || { echo "sandbox-exec required" >&2; exit 1; }
    "$env_bin" -i "${common_env[@]}" /usr/bin/sandbox-exec \
      -p '(version 1) (allow default) (deny network*)' \
      bun node_modules/pi-rlm/src/extension/testing/interactive-tui-fixture.ts
    ;;
  Linux)
    if command -v bwrap >/dev/null 2>&1; then
      "$env_bin" -i "${common_env[@]}" bwrap --unshare-net --bind / / -- \
        bun node_modules/pi-rlm/src/extension/testing/interactive-tui-fixture.ts
    elif command -v unshare >/dev/null 2>&1; then
      "$env_bin" -i "${common_env[@]}" unshare --user --map-root-user --net -- \
        bun node_modules/pi-rlm/src/extension/testing/interactive-tui-fixture.ts
    else
      echo "bwrap or unshare required for runtime network denial" >&2
      exit 1
    fi
    ;;
  *) echo "no network-denial backend for $("$uname_bin" -s)" >&2; exit 1 ;;
esac
