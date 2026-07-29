#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bun_bin=$(command -v bun)
if [[ "$bun_bin" != /* || ! -x "$bun_bin" ]]; then
  echo "LIVE_RUNTIME_INVALID" >&2
  exit 1
fi

# Bun must not load caller-selected code before the consent boundary.
unset BUN_OPTIONS NODE_OPTIONS BUN_RUNTIME_TRANSPILER_CACHE_PATH LD_PRELOAD
while IFS= read -r name; do
  case "$name" in
    BUN_CONFIG_*|DYLD_*) unset "$name" ;;
  esac
done < <(compgen -v)

cd /
exec "$bun_bin" --no-env-file --config=/dev/null \
  "$root_dir/scripts/live-provider-acceptance.ts" "$@"
