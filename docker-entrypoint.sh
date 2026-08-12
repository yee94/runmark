#!/bin/sh
set -eu

case "${AGENT_TRACKER_API_KEY:-}" in
  ""|dev-key-change-me)
    echo "ERROR: AGENT_TRACKER_API_KEY must be set to a strong secret" >&2
    exit 1
    ;;
esac

exec "$@"
