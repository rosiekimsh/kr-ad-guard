#!/usr/bin/env bash
# 배포용 zip 생성: dist/kr-ad-guard-v<버전>.zip (manifest.json 이 zip 루트에 위치)
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
OUT="dist/kr-ad-guard-v${VER}.zip"
rm -f "$OUT"
(cd extension && zip -qr "../$OUT" . -x '*.DS_Store')
echo "만들어짐: $OUT ($(du -h "$OUT" | cut -f1))"
