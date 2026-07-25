#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
wrapper_tmp=""
cleanup() {
  if [[ -n "$wrapper_tmp" ]]; then
    chmod -R u+w "$wrapper_tmp" 2>/dev/null || true
    rm -rf "$wrapper_tmp"
  fi
}
trap cleanup EXIT

wrapper_tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-rlm-packed-isolation.XXXXXX")
sentinel="$wrapper_tmp/sentinel"
smoke_tmp="$wrapper_tmp/smoke-tmp"
mkdir -p \
  "$sentinel/home" \
  "$sentinel/config" \
  "$sentinel/cache" \
  "$sentinel/state" \
  "$sentinel/npm-cache" \
  "$sentinel/npm-config" \
  "$sentinel/bun" \
  "$sentinel/bun-cache" \
  "$sentinel/bun-transpiler-cache" \
  "$smoke_tmp"

before="$wrapper_tmp/before.txt"
after="$wrapper_tmp/after.txt"
find "$sentinel" -print | LC_ALL=C sort > "$before"
chmod -R a-w "$sentinel"

env \
  HOME="$sentinel/home" \
  XDG_CONFIG_HOME="$sentinel/config" \
  XDG_CACHE_HOME="$sentinel/cache" \
  XDG_STATE_HOME="$sentinel/state" \
  npm_config_cache="$sentinel/npm-cache" \
  NPM_CONFIG_CACHE="$sentinel/npm-cache" \
  npm_config_userconfig="$sentinel/npm-config/user-npmrc" \
  NPM_CONFIG_USERCONFIG="$sentinel/npm-config/user-npmrc" \
  npm_config_globalconfig="$sentinel/npm-config/global-npmrc" \
  NPM_CONFIG_GLOBALCONFIG="$sentinel/npm-config/global-npmrc" \
  BUN_INSTALL="$sentinel/bun" \
  BUN_INSTALL_CACHE_DIR="$sentinel/bun-cache" \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH="$sentinel/bun-transpiler-cache" \
  TMPDIR="$smoke_tmp" \
  bash "$root_dir/scripts/smoke-packed-install.sh"

find "$sentinel" -print | LC_ALL=C sort > "$after"
if ! cmp -s "$before" "$after"; then
  echo "packed smoke wrote outside its isolated temporary fixture" >&2
  diff -u "$before" "$after" >&2 || true
  exit 1
fi
if [[ -n "$(find "$smoke_tmp" -mindepth 1 -print -quit)" ]]; then
  echo "packed smoke left a residual temporary fixture" >&2
  exit 1
fi

echo "packed smoke caller-environment isolation and cleanup passed"
