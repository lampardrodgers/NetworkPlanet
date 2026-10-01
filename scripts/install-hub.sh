#!/usr/bin/env bash
# 安装 / 升级 / 卸载 Network Planet Hub（systemd 服务 network-planet）。
#
# 从一台已经在跑的 Hub 安装（代码包由那台 Hub 现场打包提供）：
#   curl -fsSL http://已有的hub:50000/hub/install.sh | sudo bash
# 从开发机部署 / 升级到某台服务器（本地打包 → 上传 → 执行本脚本）：
#   npm run deploy -- root@1.2.3.4
# 卸载（保留数据目录 /var/lib/network-planet）：
#   curl -fsSL http://hub/hub/install.sh | sudo bash -s -- uninstall
#
# 可选变量：PORT（默认 50000）、ADMIN_TOKEN（默认随机生成）、NP_PUBLIC_URL（Hub 公网地址，默认 http://公网IP:端口）、
#           NP_NODE_MIRROR（Node.js 下载镜像，默认 https://nodejs.org/dist）
# 代码装在 /opt/network-planet，数据在 /var/lib/network-planet，配置在 /etc/network-planet.env。
set -euo pipefail

NP_SRC="${NP_SRC:-__NP_SRC__}"
APP=/opt/network-planet
DATA=/var/lib/network-planet
ENV_FILE=/etc/network-planet.env
UNIT=/etc/systemd/system/network-planet.service
NODE_DIR=/opt/network-planet-node
NODE_VER=v22.12.0

say() { echo -e "\033[36m[network-planet]\033[0m $*"; }
die() { echo -e "\033[31m[network-planet] $*\033[0m" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 运行（sudo）"

if [ "${1:-}" = uninstall ]; then
  systemctl disable --now network-planet 2>/dev/null || true
  rm -rf "$UNIT" "$APP" "$NODE_DIR"
  systemctl daemon-reload 2>/dev/null || true
  say "已卸载。数据保留在 $DATA，配置在 $ENV_FILE，不需要可以手动删除"
  exit 0
fi

command -v systemctl >/dev/null || die "需要 systemd"
command -v curl >/dev/null || die "需要 curl"
command -v tar >/dev/null || die "需要 tar"
[[ $NP_SRC != __NP_SRC__ ]] || die "需要 NP_SRC（代码包的 URL 或本地路径）"

# ---------------- Node.js（≥ 18.17；没有就装官方二进制到 $NODE_DIR，不动系统包） ----------------
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)' 2>/dev/null; }
NODE=""
if [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then NODE="$NODE_DIR/bin/node"
elif command -v node >/dev/null && node_ok "$(command -v node)"; then NODE="$(command -v node)"
else
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "不支持的架构 $(uname -m)，请先自己装 Node.js ≥ 18.17" ;;
  esac
  MIRROR="${NP_NODE_MIRROR:-https://nodejs.org/dist}"
  say "安装 Node.js $NODE_VER（$ARCH）…"
  TMPN=$(mktemp -d)
  curl -fsSL "$MIRROR/$NODE_VER/node-$NODE_VER-linux-$ARCH.tar.xz" -o "$TMPN/node.tar.xz" ||
    curl -fsSL "$MIRROR/$NODE_VER/node-$NODE_VER-linux-$ARCH.tar.gz" -o "$TMPN/node.tar.gz" ||
    die "下载 Node.js 失败，可以设置 NP_NODE_MIRROR=https://npmmirror.com/mirrors/node 再试"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xf "$TMPN"/node.tar.* -C "$NODE_DIR" --strip-components=1 || die "解压 Node.js 失败（.tar.xz 需要 xz）"
  rm -rf "$TMPN"
  NODE="$NODE_DIR/bin/node"
fi
say "Node.js $("$NODE" -v)（$NODE）"

# ---------------- 代码 ----------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [[ $NP_SRC =~ ^https?:// ]]; then
  say "下载代码包 $NP_SRC …"
  curl -fsSL "$NP_SRC" -o "$TMP/app.tar.gz" || die "下载失败：$NP_SRC"
else
  cp "$NP_SRC" "$TMP/app.tar.gz" || die "找不到代码包：$NP_SRC"
fi
mkdir "$TMP/app"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" || die "代码包损坏"
[ -f "$TMP/app/server/index.js" ] && [ -f "$TMP/app/dist/index.html" ] || die "代码包不完整（缺 server/ 或 dist/）"
rm -rf "$APP.new" && mv "$TMP/app" "$APP.new"
rm -rf "$APP.old" && { [ -d "$APP" ] && mv "$APP" "$APP.old" || true; }
mv "$APP.new" "$APP"
rm -rf "$APP.old"
mkdir -p "$DATA"

# ---------------- 配置（升级时保留） ----------------
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="${ADMIN_TOKEN:-$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)}"
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=${PORT:-50000}
ADMIN_TOKEN=$TOKEN
NP_DATA_DIR=$DATA
NP_DEMO=0
EOF
  umask 022
  NEW=1
fi
PORT=$(sed -n 's/^PORT=//p' "$ENV_FILE")

cat > "$UNIT" <<EOF
[Unit]
Description=Network Planet Hub
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP
ExecStart=$NODE $APP/server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable network-planet >/dev/null 2>&1
systemctl restart network-planet

# ---------------- 防火墙：只在 ufw / firewalld 已启用时放行端口 ----------------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow "$PORT"/tcp >/dev/null && say "ufw 已放行 $PORT/tcp"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd -q --permanent --add-port="$PORT"/tcp && firewall-cmd -q --reload && say "firewalld 已放行 $PORT/tcp"
fi

# ---------------- 等待启动 ----------------
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/agent/install.sh" 2>/dev/null && break
  sleep 0.5
done
systemctl is-active --quiet network-planet || die "服务没有启动成功：journalctl -u network-planet -n 50"

TOKEN=$(sed -n 's/^ADMIN_TOKEN=//p' "$ENV_FILE")
URL="${NP_PUBLIC_URL:-}"
if [ -z "$URL" ]; then
  IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || curl -fsS -m 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  URL="http://$IP:$PORT"
fi
# 首次安装：把 Hub 公网地址写进设置，探针安装命令直接可用
if [ "${NEW:-0}" = 1 ]; then
  curl -fsS -o /dev/null -X PUT -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    --data "{\"publicUrl\":\"$URL\"}" "http://127.0.0.1:$PORT/api/settings" ||
    say "自动设置 Hub 公网地址失败，请在网页 ⚙ 设置里手动填 $URL"
fi

say "✅ Hub 已运行（systemctl status network-planet 查看，journalctl -u network-planet -f 看日志）"
echo
echo "  网页地址：  $URL"
echo "  访问口令：  $TOKEN    （保存在 $ENV_FILE）"
echo
echo "  各台 VPS 装探针：打开网页 → 顶栏「⤓ 安装探针」复制命令"
echo "  在别的机器装一份同样的 Hub：curl -fsSL $URL/hub/install.sh | sudo bash"
[ "$PORT" = 50000 ] && echo "  如果云厂商有安全组，记得放行 TCP $PORT"
exit 0
