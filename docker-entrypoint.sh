#!/bin/sh
set -eu

case "${RUNMARK_API_KEY-${AGENT_TRACKER_API_KEY-}}" in
  ""|dev-key-change-me)
    echo "ERROR: RUNMARK_API_KEY must be set to a strong secret" >&2
    exit 1
    ;;
esac

exec "$@"
