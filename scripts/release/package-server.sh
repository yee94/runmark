#!/usr/bin/env bash
# 打包 Server workspace 最小可运行 tar.gz
# 用法: bash scripts/release/package-server.sh <version>
# 输出: dist/agent-tracker-server-v<version>.tar.gz
set -euo pipefail

VERSION="${1:?Usage: $0 <version>}"
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then echo "ERROR: Invalid semver: ${VERSION}"; exit 1; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"; ARCHIVE_NAME="agent-tracker-server-v${VERSION}.tar.gz"
WORK_DIR="$(mktemp -d)"; STAGING="$WORK_DIR/agent-tracker-server"
cleanup() { rm -rf "$WORK_DIR"; }; trap cleanup EXIT

echo "==> Packaging server v${VERSION}"
mkdir -p "$STAGING"

# 根目录文件
cp "$ROOT_DIR/package.json" "$STAGING/"
cp "$ROOT_DIR/bun.lock" "$STAGING/"
cp "$ROOT_DIR/tsconfig.json" "$STAGING/"

# packages/shared：递归复制（排除 tests/data/dist/node_modules）
if [ -d "$ROOT_DIR/packages/shared" ]; then
  mkdir -p "$STAGING/packages/shared"
  tar -C "$ROOT_DIR/packages/shared" \
    --exclude='./__tests__' --exclude='./dist' --exclude='./node_modules' --exclude='./data' \
    -cf - . | tar -C "$STAGING/packages/shared" -xf -
fi

# packages/server：递归复制 src + public（排除 tests/data/dist/node_modules）
if [ -d "$ROOT_DIR/packages/server" ]; then
  mkdir -p "$STAGING/packages/server"
  [ ! -f "$ROOT_DIR/packages/server/package.json" ] || cp "$ROOT_DIR/packages/server/package.json" "$STAGING/packages/server/"
  [ ! -f "$ROOT_DIR/packages/server/tsconfig.json" ] || cp "$ROOT_DIR/packages/server/tsconfig.json" "$STAGING/packages/server/"
  if [ -d "$ROOT_DIR/packages/server/src" ]; then
    mkdir -p "$STAGING/packages/server/src"
    tar -C "$ROOT_DIR/packages/server/src" --exclude='./__tests__' -cf - . | tar -C "$STAGING/packages/server/src" -xf -
  fi
  if [ -d "$ROOT_DIR/packages/server/public" ]; then
    mkdir -p "$STAGING/packages/server/public"
    tar -C "$ROOT_DIR/packages/server/public" --exclude='./data' -cf - . | tar -C "$STAGING/packages/server/public" -xf -
  fi
fi

rm -f "$STAGING/bun.lock"
# Bun 1.4+：`--production --lockfile-only` 不写 lockfile；生成完整 lock，安装仍走 --production
(cd "$STAGING" && bun install --lockfile-only)
[ -s "$STAGING/bun.lock" ] || { echo "ERROR: bun.lock was not generated"; exit 1; }
(cd "$STAGING" && bun install --production --frozen-lockfile)

# 打包
mkdir -p "$DIST_DIR"
tar -czf "$DIST_DIR/$ARCHIVE_NAME" --exclude 'node_modules' --exclude '__tests__' --exclude 'data' --exclude '*.db' --exclude '*.log' --exclude 'dist' -C "$WORK_DIR" "agent-tracker-server"

SHA256=""; command -v sha256sum >/dev/null 2>&1 && SHA256=$(sha256sum "$DIST_DIR/$ARCHIVE_NAME" | awk '{print $1}')
[ -z "$SHA256" ] && SHA256=$(shasum -a 256 "$DIST_DIR/$ARCHIVE_NAME" | awk '{print $1}')
SIZE=$(wc -c < "$DIST_DIR/$ARCHIVE_NAME" | tr -d ' ')
echo "==> Package created: dist/$ARCHIVE_NAME"
echo "    SHA256: $SHA256"; echo "    Size:   $SIZE bytes"
echo "$SHA256  $ARCHIVE_NAME" > "$DIST_DIR/${ARCHIVE_NAME}.sha256"
echo "done"
