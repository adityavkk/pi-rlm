#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
host_path=${PATH:?}
wrapper_tmp=""
cleanup() {
  if [[ -n "$wrapper_tmp" ]]; then
    chmod -R u+w "$wrapper_tmp" 2>/dev/null || true
    rm -rf "$wrapper_tmp"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

wrapper_tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-rlm-packed-isolation.XXXXXX")
sentinel="$wrapper_tmp/sentinel"
smoke_tmp="$wrapper_tmp/smoke-tmp"
mkdir -p \
  "$sentinel/home" \
  "$sentinel/config" \
  "$sentinel/cache" \
  "$sentinel/data" \
  "$sentinel/state" \
  "$sentinel/npm-cache" \
  "$sentinel/npm-config" \
  "$sentinel/npm-prefix" \
  "$sentinel/bun" \
  "$sentinel/bun-cache" \
  "$sentinel/bun-global" \
  "$sentinel/bun-transpiler-cache" \
  "$smoke_tmp"
: > "$sentinel/npm-config/user-npmrc"
: > "$sentinel/npm-config/global-npmrc"
chmod -R a-w "$sentinel"

snapshot() {
  env -i PATH="$host_path" HOME="$wrapper_tmp" \
    node "$root_dir/scripts/smoke-packed-install-parser.mjs" snapshot "$sentinel"
}
before="$wrapper_tmp/before.txt"
after="$wrapper_tmp/after.txt"
snapshot > "$before"

env -i \
  HOME="$sentinel/home" \
  PATH="$host_path" \
  XDG_CONFIG_HOME="$sentinel/config" \
  XDG_CACHE_HOME="$sentinel/cache" \
  XDG_DATA_HOME="$sentinel/data" \
  XDG_STATE_HOME="$sentinel/state" \
  npm_config_cache="$sentinel/npm-cache" \
  NPM_CONFIG_CACHE="$sentinel/npm-cache" \
  npm_config_userconfig="$sentinel/npm-config/user-npmrc" \
  NPM_CONFIG_USERCONFIG="$sentinel/npm-config/user-npmrc" \
  npm_config_globalconfig="$sentinel/npm-config/global-npmrc" \
  NPM_CONFIG_GLOBALCONFIG="$sentinel/npm-config/global-npmrc" \
  npm_config_prefix="$sentinel/npm-prefix" \
  NPM_CONFIG_PREFIX="$sentinel/npm-prefix" \
  BUN_INSTALL="$sentinel/bun" \
  BUN_INSTALL_CACHE_DIR="$sentinel/bun-cache" \
  BUN_INSTALL_GLOBAL_DIR="$sentinel/bun-global" \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH="$sentinel/bun-transpiler-cache" \
  TMPDIR="$smoke_tmp" \
  NODE_OPTIONS=--pi-rlm-smoke-must-strip-caller-node-options \
  bash "$root_dir/scripts/smoke-packed-install.sh"

snapshot > "$after"
if ! cmp -s "$before" "$after"; then
  echo "packed smoke changed external sentinel contents or metadata" >&2
  diff -u "$before" "$after" >&2 || true
  exit 1
fi
if [[ -n "$(find "$smoke_tmp" -mindepth 1 -print -quit)" ]]; then
  echo "packed smoke left a residual temporary fixture" >&2
  exit 1
fi

echo "packed smoke caller isolation, metadata, and cleanup passed"
