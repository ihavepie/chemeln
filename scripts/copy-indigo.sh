#!/bin/sh
# 把 indigo-ketcher 的 WASM 拷到 vendor/indigo/（画「带基团缩写的结构」时才用，11 MB，不进 git）。
# 换机器 / 清过 vendor 之后跑一次；没拷过去时缩写结构会退回 openchemlib 渲染（缩写会被展开）。
set -e
cd "$(dirname "$0")/.."
SRC=$(ls node_modules/indigo-ketcher/*.wasm 2>/dev/null | grep -v norender | head -1)
if [ -z "$SRC" ]; then
  echo "没找到 node_modules/indigo-ketcher/*.wasm，先 npm install"
  exit 1
fi
mkdir -p vendor/indigo
cp "$SRC" vendor/indigo/
echo "好了：vendor/indigo/$(basename "$SRC")（$(du -sh vendor/indigo | cut -f1)）"
