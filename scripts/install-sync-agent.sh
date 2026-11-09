#!/bin/bash
# 装一个「定时单向同步」的 launchd 任务（本机 → 服务器）
#
#   bash scripts/install-sync-agent.sh            # 每天 12:30 和 20:30 各同步一次
#   bash scripts/install-sync-agent.sh --hourly   # 每小时同步一次
#   bash scripts/install-sync-agent.sh --remove   # 卸载
#
# 用 launchd 而不是 cron：Mac 休眠错过时间后，launchd 会在唤醒时补跑一次。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

ROOT=$(pwd)
LABEL="local.eln.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM=$(id -u)

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
  exit 0
fi

if [ "${1:-}" = "--hourly" ]; then
  SCHEDULE='<key>StartInterval</key><integer>3600</integer>'
else
  SCHEDULE='<key>StartCalendarInterval</key><array><dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict><dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>30</integer></dict></array>'
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/sync-server.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/opt/anaconda3/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  $SCHEDULE
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$ROOT/.cache/sync.log</string>
  <key>StandardErrorPath</key><string>$ROOT/.cache/sync.log</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"

echo "已安装：$PLIST"
echo "计划：$( [ "${1:-}" = "--hourly" ] && echo '每小时' || echo '每天 12:30 / 20:30' )（错过时间唤醒后会补跑）"
echo "日志：$ROOT/.cache/sync.log"
echo
echo "想立刻试一次：  ./scripts/sync-server.sh"
echo "想卸载：        bash scripts/install-sync-agent.sh --remove"
