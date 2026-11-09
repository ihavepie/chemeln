#!/bin/bash
# 单向同步：本机 data/ → 服务器（本机是主库，服务器只是副本）
#
#   ./scripts/sync-server.sh            # 真同步
#   ./scripts/sync-server.sh --dry-run  # 只看会做什么
#
# 连接信息可用环境变量覆盖（默认就是下面这台）：
#   ELN_SYNC_HOST=root@123.56.150.128
#   ELN_SYNC_KEY=<本机路径>/<私钥>.pem
#   ELN_SYNC_KNOWN=<本机路径>/.ssh_known_hosts
#   ELN_SYNC_AUTH=<用户>:<密码>        # 同步完用它核对条数
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

HOST=${ELN_SYNC_HOST:-root@123.56.150.128}
KEY=${ELN_SYNC_KEY:-<本机路径>/<私钥>.pem}
KNOWN=${ELN_SYNC_KNOWN:-<本机路径>/.ssh_known_hosts}
AUTH=${ELN_SYNC_AUTH:-<用户>:<密码>}
REMOTE_DATA=${ELN_SYNC_DATA:-/var/lib/eln}
SITE=${ELN_SYNC_SITE:-http://${HOST#*@}}   # 默认就用同步的那台机器，别指到本机
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SSHOPTS=(-i "$KEY" -o BatchMode=yes -o ConnectTimeout=10)
[ -f "$KNOWN" ] && SSHOPTS+=(-o "UserKnownHostsFile=$KNOWN")
SSH=(ssh "${SSHOPTS[@]}" "$HOST")
SCP=(scp -q "${SSHOPTS[@]}")

say() { printf '  %s\n' "$*"; }

echo "ELN 同步（本机 → ${HOST}）"
echo

# 0) 连通性
if ! "${SSH[@]}" true 2>/dev/null; then
  echo "✗ 连不上 ${HOST}（检查网络 / 密钥 ${KEY}）"; exit 1
fi

# 1) 本机一致性快照（WAL 安全，不用停本机服务）
TMP=$(mktemp -t eln-sync).db
trap 'rm -f "${TMP}"' EXIT
sqlite3 data/eln.db ".backup '${TMP}'"
LOCAL_STAT=$(sqlite3 "${TMP}" "select (select count(*) from experiments)||'/'||(select count(*) from compounds)||'/'||(select count(*) from attachments)")
say "本机快照：$(du -h "${TMP}" | cut -f1)　实验/化合物/附件 = ${LOCAL_STAT}"

if [ "$DRY" = 1 ]; then
  say "（dry-run）将要：停服务 → 传库 → rsync 附件与化合物文件 → 改属主 → 启动 → 核对条数"
  exit 0
fi

# 2) 服务器先停后端，避免边写边换库
say "停止服务器后端…"
"${SSH[@]}" 'systemctl stop eln'

# 3) 传库 + 文件
say "上传数据库…"
"${SCP[@]}" "${TMP}" "$HOST:$REMOTE_DATA/eln.db"
say "同步附件 / 化合物文件…"
rsync -a --delete -e "ssh ${SSHOPTS[*]}" data/attachments data/compounds "$HOST:$REMOTE_DATA/"

# 4) 属主 + 启动
say "启动服务器后端…"
"${SSH[@]}" "chown -R eln:eln $REMOTE_DATA; rm -f $REMOTE_DATA/eln.db-wal $REMOTE_DATA/eln.db-shm; systemctl start eln; sleep 1; systemctl is-active eln" >/dev/null

# 5) 核对（顺带确认认证还在）
REMOTE_STAT=$(curl -s -m 15 -u "${AUTH}" "${SITE}/api/experiments" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); items=d.get('experiments') or d.get('items') or []
    print(len(items))
except Exception:
    print('?')
" 2>/dev/null || echo '?')
REMOTE_CMP=$(curl -s -m 15 -u "${AUTH}" "${SITE}/api/compounds" | python3 -c "
import json,sys
d=json.load(sys.stdin); print(len(d.get('compounds') or d.get('items') or []))
" 2>/dev/null || echo '?')

echo
if [ "${REMOTE_STAT}" = "$(echo "${LOCAL_STAT}" | cut -d/ -f1)" ]; then
  echo "✓ 同步完成：服务器 $(curl -s -o /dev/null -w '%{http_code}' -u "${AUTH}" "${SITE}/") 在线，实验 ${REMOTE_STAT} 条 / 化合物 ${REMOTE_CMP} 个（本机 ${LOCAL_STAT}）"
else
  echo "⚠ 传完了但对不上：服务器实验 ${REMOTE_STAT} 条、化合物 ${REMOTE_CMP} 个；本机 ${LOCAL_STAT}"
  exit 1
fi
