#!/usr/bin/env bash
# Prepare GitHub Release body for a server tag.
# Usage: bash scripts/release/create-release-notes.sh <version>
# Output: dist/release-body.md
set -euo pipefail

VERSION="${1:?Usage: $0 <version>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

mkdir -p "$DIST_DIR"
echo "==> Preparing GitHub Release notes for server-v${VERSION}"

if [ -f "$DIST_DIR/server-manifest.json" ]; then
  bun -e "const m=require('${DIST_DIR}/server-manifest.json');process.stdout.write(m.notes||'See CHANGELOG.md for v${VERSION}');" \
    > "$DIST_DIR/release-body.md"
else
  echo "See CHANGELOG.md for v${VERSION}" > "$DIST_DIR/release-body.md"
fi

echo ""
echo "==> Artifacts:"
for f in \
  "$DIST_DIR/agent-tracker-server-v${VERSION}.tar.gz" \
  "$DIST_DIR/server-manifest.json" \
  "$DIST_DIR/agent-tracker-server-v${VERSION}.tar.gz.sha256"; do
  [ -f "$f" ] && echo "    $f ($(wc -c < "$f" | tr -d ' ') bytes)"
done
