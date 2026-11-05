#!/bin/bash
# 双击运行：同时起「数据服务」（4780）和「Vue 开发服务器」（5173），然后打开 5173 预览。
# 这一步只在试用新框架时用；日常用还是 start.command。
cd "$(dirname "$0")" || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没找到 node。先装一个：brew install node"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -ge 22 ]; then
  export NODE_OPTIONS="--disable-warning=ExperimentalWarning"
fi

if [ ! -d node_modules ]; then
  echo "  第一次跑，先装依赖…"
  npm install --cache ./.npm-cache || exit 1
fi

# 数据服务：已经在跑就复用
if curl -s -o /dev/null http://127.0.0.1:4780/api/bootstrap; then
  echo "  数据服务已经在 4780 上跑着，直接复用。"
else
  echo "  启动数据服务 4780…"
  node server/index.js > /tmp/eln-data.log 2>&1 &
  for _ in $(seq 1 40); do
    curl -s -o /dev/null http://127.0.0.1:4780/api/bootstrap && break
    sleep 0.25
  done
fi

echo "  启动 Vue 预览 5173…（关掉这个窗口就都停了）"
sleep 1
( sleep 2; open "http://127.0.0.1:5173/" ) &
exec npx vite --port 5173
