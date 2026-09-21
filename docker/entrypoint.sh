#!/bin/sh
# docker/entrypoint.sh — clean-environment boot for the Web UI container.
#
# The container deliberately shares NOTHING with the host home directory: no
# credential mounts, no session stores. Instead, the MiniMax API key is taken
# from the environment and materialized into a fresh ~/.minimax/config.yaml:
#
#   MINIMAX_CN_API_KEY  -> region cn (api.minimaxi.com)
#   MINIMAX_API_KEY     -> region global (api.minimax.io)
#   MAVIS_REGION        -> explicit region override (cn|en), wins if set
#
# Each collaborator runs with their own key; `docker compose up` always starts
# from a factory-fresh state, so models/tools/sessions can never leak between
# machines. Remove the container to reset everything.

set -eu

HOME_DIR="${HOME:-/root}"
CONFIG="$HOME_DIR/.minimax/config.yaml"

key=""
region=""
if [ -n "${MINIMAX_CN_API_KEY:-}" ]; then
  key="$MINIMAX_CN_API_KEY"
  region="cn"
elif [ -n "${MINIMAX_API_KEY:-}" ]; then
  key="$MINIMAX_API_KEY"
  region="en"
fi

if [ -n "$key" ] && [ ! -f "$CONFIG" ]; then
  if [ -z "${MAVIS_REGION:-}" ]; then
    MAVIS_REGION="$region"
    export MAVIS_REGION
  fi
  mkdir -p "$(dirname "$CONFIG")"
  {
    echo "# seeded by docker/entrypoint.sh from MINIMAX_API_KEY env"
    echo "minimaxModelSource: minimax_api_key"
    echo "minimax_api:"
    echo "  apiKey: $key"
    echo "defaultModel: minimax_api/MiniMax-M3"
  } > "$CONFIG"
  chmod 600 "$CONFIG"
  echo "[entrypoint] seeded $CONFIG (region=${MAVIS_REGION}, key from env, not echoed)"
fi

if [ -z "$key" ] && [ ! -f "$CONFIG" ]; then
  echo "[entrypoint] no MINIMAX_CN_API_KEY / MINIMAX_API_KEY and no existing config:" \
       "chat will have no model credentials until one is provided"
fi

exec "$@"
