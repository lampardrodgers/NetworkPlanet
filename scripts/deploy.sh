#!/usr/bin/env bash
# 从开发机把 Hub 部署 / 升级到一台服务器：本地构建打包 → scp 上传 → 远端执行 install-hub.sh。
#   npm run deploy -- root@1.2.3.4            # 默认 ssh 端口 22
#   npm run deploy -- root@1.2.3.4 2222       # 指定 ssh 端口
# 首次安装会随机生成访问口令并打印出来；升级时保留原有配置和数据。
set -euo pipefail
TARGET="${1:?用法：npm run deploy -- user@host [ssh端口]}"
SSH_PORT="${2:-22}"
cd "$(dirname "$0")/.."

echo "[deploy] 构建前端…"
npm run build >/dev/null
PKG=$(mktemp -d)/network-planet.tar.gz
COPYFILE_DISABLE=1 tar -czf "$PKG" package.json server shared agent dist scripts README.md docs
echo "[deploy] 上传 $(du -h "$PKG" | cut -f1) 到 $TARGET …"
scp -q -P "$SSH_PORT" "$PKG" scripts/install-hub.sh "$TARGET:/tmp/"
SUDO=""
[[ $TARGET == root@* ]] || SUDO="sudo"
ssh -p "$SSH_PORT" "$TARGET" "$SUDO env NP_SRC=/tmp/network-planet.tar.gz bash /tmp/install-hub.sh; rm -f /tmp/network-planet.tar.gz /tmp/install-hub.sh"
rm -f "$PKG"
