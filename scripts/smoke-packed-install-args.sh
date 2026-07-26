#!/usr/bin/env bash

build_pi_args() {
  local case_name=$1
  local root_dir=$2
  local session_file=$3
  pi_args=(
    --mode json
    --offline
    --session "$session_file"
    --no-skills
    --no-prompt-templates
    --no-themes
    --no-context-files
    --no-builtin-tools
  )
  case "$case_name" in
    direct)
      pi_args+=(--no-extensions -e "$root_dir/index.ts")
      ;;
    installed)
      ;;
    *)
      echo "unknown packed smoke case: $case_name" >&2
      return 1
      ;;
  esac
  pi_args+=(/rlm)
}
