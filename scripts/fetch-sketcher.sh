#!/bin/sh
# 拉「画结构式」那块画板（JSME）到 vendor/jsme/。
# vendor/ 不进 git（体积 2.6MB+），换机器 / 清过目录时跑一次这个脚本即可。
# 用的是 npm registry 上的 tgz，不依赖 npm 客户端，也不需要联网之外的权限。
set -e
cd "$(dirname "$0")/.."
VER="2024.4.29"
TMP="$(mktemp -d)"
URL="https://registry.npmjs.org/jsme-editor/-/jsme-editor-${VER}.tgz"

echo "下载 JSME ${VER} …"
curl -fsSL -o "$TMP/jsme.tgz" "$URL"
mkdir -p vendor/jsme
tar xzf "$TMP/jsme.tgz" -C "$TMP"
# npm 包里文件都在 package/ 下，去掉它的 package.json（对我们没用）
cp -R "$TMP/package/." vendor/jsme/
rm -f vendor/jsme/package.json
rm -rf "$TMP"
echo "好了：vendor/jsme/（$(du -sh vendor/jsme | cut -f1)）"
echo "重启服务（或直接刷新页面）就能用「画结构式」。"
