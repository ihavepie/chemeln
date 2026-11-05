#!/bin/sh
# 打包「画结构式」用的 Ketcher（vendor-build/ketcher → vendor/ketcher）。
# 产物 vendor/ketcher/ 不进 git（几 MB）；源码 vendor-build/ketcher/ 是进仓库的，
# 换机器 / 清过目录时跑一次这个脚本重新编。
set -e
cd "$(dirname "$0")/.."

echo "安装依赖（第一次要几十秒，node_modules 不进 git）…"
cd vendor-build/ketcher
npm install --cache ../../.npm-cache --logs-dir "${TMPDIR:-/tmp}/eln-npm-logs" --no-audit --no-fund

echo "打包 → vendor/ketcher/ …"
npx vite build

cd ../..
echo "好了：vendor/ketcher/（$(du -sh vendor/ketcher | cut -f1)，含 Indigo WASM 与 Raphael）"
