#!/usr/bin/env bash
# Send a fill-in-the-middle (FIM) prompt to a llama.cpp server.
#
#   ./repro/fim-curl.sh                 # defaults below
#   HOST=192.168.50.133 PORT=8181 ./repro/fim-curl.sh
#   ./repro/fim-curl.sh raw             # /completion with explicit FIM tokens
#
# The /infill endpoint wants the prefix and suffix separately and assembles the
# model's FIM tokens itself, so it only works on a server started with a model
# that advertises them (qwen2.5-coder, codellama, deepseek-coder, ...).

set -euo pipefail

HOST="${HOST:-192.168.50.133}"
PORT="${PORT:-8181}"
SCHEME="${SCHEME:-http}"
BASE="$SCHEME://$HOST:$PORT"

PREFIX="${PREFIX:-$'local function add(a, b)\n  return '}"
SUFFIX="${SUFFIX:-$'\nend\n'}"

case "${1:-infill}" in
infill)
  jq -n \
    --arg prefix "$PREFIX" \
    --arg suffix "$SUFFIX" \
    '{
       input_prefix: $prefix,
       input_suffix: $suffix,
       n_predict: 64,
       temperature: 0.1,
       top_p: 0.9,
       stream: false
     }' |
    curl -sS --fail-with-body -m 60 \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      "$BASE/infill"
  ;;
raw)
  # Fallback: build the FIM prompt by hand against /completion. Token names are
  # model-specific -- these are the qwen2.5-coder / codellama style sentinels.
  jq -n \
    --arg prefix "$PREFIX" \
    --arg suffix "$SUFFIX" \
    '{
       prompt: ("<|fim_prefix|>" + $prefix + "<|fim_suffix|>" + $suffix + "<|fim_middle|>"),
       n_predict: 64,
       temperature: 0.1,
       stream: false
     }' |
    curl -sS --fail-with-body -m 60 \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      "$BASE/completion"
  ;;
*)
  echo "usage: $0 [infill|raw]" >&2
  exit 2
  ;;
esac

echo
