#!/usr/bin/env bash
# 打包 vnts2-cf 项目（含 .git 历史与文档）为 public/vnts2-cf.zip
# 用法：bash scripts/package.sh
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="public/vnts2-cf.zip"
rm -f "$OUT"
zip -r "$OUT" . \
  -x "node_modules/*" \
  -x ".wrangler/*" \
  -x ".dev.vars" \
  -x "public/vnts2-cf.zip" \
  -x "*.log" \
  -x ".DS_Store"
SIZE=$(du -h "$OUT" | cut -f1)
echo "已生成 $OUT ($SIZE)"
