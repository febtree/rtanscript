#!/usr/bin/env sh
# 打包成可分发的 zip（chrome://extensions 里可直接拖入 zip 安装）
set -e
cd "$(dirname "$0")/.."
OUT="ytt-follow.zip"
rm -f "$OUT"
if command -v zip >/dev/null 2>&1; then
  zip -r "$OUT" manifest.json src icons README.md -x '*/.DS_Store' >/dev/null
  echo "已生成 $OUT"
else
  echo "未找到 zip 命令，可手动压缩：manifest.json src icons README.md" >&2
  exit 1
fi
