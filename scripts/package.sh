#!/bin/bash
# 打一个「绿色包」：解压 → 双击就能用（只需装 Node 22+，不用 npm install、不用 Docker）
#
#   ./scripts/package.sh            → dist-pkg/eln-<版本>-<平台>.zip
#   ./scripts/package.sh --no-build → 跳过前端构建（public/ 已是新的）
#
# 运行时零依赖：server/ 只用 Node 内置模块（node:sqlite 等），前端是构建产物，
# 画板（Ketcher）和结构渲染（Indigo WASM）是 vendor/ 里的静态文件。
set -e
cd "$(dirname "$0")/.." || exit 1

VERSION=$(node -p "require('./package.json').version")
OS=$(uname -s | tr 'A-Z' 'a-z')
NAME="eln-$VERSION-$OS"
OUT="dist-pkg"
STAGE="$OUT/$NAME"

if [ "$1" != "--no-build" ]; then
  echo "→ 构建前端…"
  npm run build >/dev/null
fi

echo "→ 收集文件到 $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/data"

cp -R public server vendor "$STAGE"/
cp start.command start.bat "$STAGE"/
[ "$OS" = "darwin" ] && rm -f "$STAGE/start.bat.offer"

# package.json 也带上：万一以后要再 build / 看版本
cp package.json "$STAGE"/

cat > "$STAGE/启动说明.txt" <<'TXT'
方法学实验记录 —— 绿色包
=========================

1) 先装 Node.js（22 或更新的 LTS）：https://nodejs.org
2) 双击 start.command（macOS）或 start.bat（Windows）
   终端/黑窗口里会打印地址，浏览器自动打开 http://127.0.0.1:4780
3) 数据全部在这个文件夹的 data/ 里：备份 = 拷走 data/，换电脑 = 连 data/ 一起搬

说明
- 不需要 npm install，也不需要联网（只有「按名字查试剂」会去 PubChem）。
- macOS：PDF 生成 / 长图导出 / 图片文字识别 可用；
  Windows / Linux：这三项不可用（缺系统能力），其余功能都正常。
- 端口被占用会自动往后找（4780 → 4781 …），以窗口里打印的地址为准。
- 单人单机使用；要让手机访问，见应用内「设置 → 手机 / 局域网访问」。
TXT

echo "→ 压缩"
ZIP="$OUT/$NAME.zip"
rm -f "$ZIP"
if command -v ditto >/dev/null 2>&1; then
  ditto -c -k --keepParent "$STAGE" "$ZIP"          # macOS：中文名不乱码
else
  (cd "$OUT" && zip -r -q "$(basename "$ZIP")" "$NAME")
fi

echo ""
echo "完成：$ZIP  ($(du -h "$ZIP" | cut -f1))"
echo "解压后双击 start.command / start.bat 即可（需要 Node 22+，无需 npm install）"
