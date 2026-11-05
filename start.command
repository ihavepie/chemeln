#!/bin/bash
# 双击运行：启动记录本并在浏览器里打开。（关闭这个终端窗口即停止）
cd "$(dirname "$0")" || exit 1

# Finder 双击启动时 PATH 可能找不到 node，补齐常见位置
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没找到 node。"
  echo "  先装一个：brew install node    （或到 nodejs.org 下载 LTS）"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -ge 22 ]; then
  export NODE_OPTIONS="--disable-warning=ExperimentalWarning"
fi

export ELN_OPEN=1
exec node server/index.js
