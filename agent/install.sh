#!/usr/bin/env bash
# 安装 / 升级 / 卸载 Network Planet Agent（systemd 服务 np-agent）。
#
# 一条命令通装（推荐，所有 VPS 用同一条，装完自动出现在地球上）：
#   curl -fsSL https://你的hub/agent/install.sh | sudo NP_HUB=https://你的hub NP_KEY=注册密钥 bash
# 指定某台已有服务器：
#   curl -fsSL https://你的hub/agent/install.sh | sudo NP_HUB=... NP_ID=srv_xxx NP_TOKEN=xxx bash
# 升级（沿用 /etc/np-agent.env 里的身份）：
#   curl -fsSL https://你的hub/agent/install.sh | sudo bash
# 卸载：
#   curl -fsSL https://你的hub/agent/install.sh | sudo bash -s -- uninstall
#
# 可选变量：NP_NAME（显示名，默认主机名）、NP_CITY（自动定位不准时指定城市，如 "Los Angeles"）、
#           NP_TAGS（逗号分隔）、NP_PROVIDER、NP_IFACE（统计网速的网卡）、NP_NO_DEPS=1（不自动安装 ping / iperf3）
set -euo pipefail

ENV_FILE=/etc/np-agent.env
BIN=/usr/local/bin/np-agent.sh
UNIT=/etc/systemd/system/np-agent.service

say() { echo -e "\033[36m[np-agent]\033[0m $*"; }
die() { echo -e "\033[31m[np-agent] $*\033[0m" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 运行（sudo）"

if [ "${1:-}" = uninstall ]; then
  systemctl disable --now np-agent 2>/dev/null || true
  rm -f "$UNIT" "$BIN" "$ENV_FILE"
  systemctl daemon-reload 2>/dev/null || true
  say "已卸载。（服务器记录仍在 Hub 上，需要的话在网页里删除）"
  exit 0
fi

command -v systemctl >/dev/null || die "需要 systemd（暂不支持 OpenRC 等其它 init）"
command -v curl >/dev/null || die "需要 curl"

# 升级时沿用已有配置
if [ -f "$ENV_FILE" ]; then
  OLD_HUB=$(sed -n 's/^NP_HUB=//p' "$ENV_FILE")
  OLD_ID=$(sed -n 's/^NP_ID=//p' "$ENV_FILE")
  OLD_TOKEN=$(sed -n 's/^NP_TOKEN=//p' "$ENV_FILE")
  OLD_IFACE=$(sed -n 's/^NP_IFACE=//p' "$ENV_FILE")
fi
NP_HUB="${NP_HUB:-${OLD_HUB:-}}"
[ -n "$NP_HUB" ] || die "需要 NP_HUB（Hub 地址，如 https://planet.example.com）"
HUB="${NP_HUB%/}"
[[ $HUB =~ ^https?://[^[:space:]\'\"\`\$\\]+$ ]] || die "NP_HUB 格式不对：$HUB"
NP_IFACE="${NP_IFACE:-${OLD_IFACE:-}}"

# ---------------- 依赖：ping、iperf3（可选，装不上不影响基础功能） ----------------
install_pkgs() {
  if command -v apt-get >/dev/null; then
    echo "iperf3 iperf3/start_daemon boolean false" | debconf-set-selections 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1 ||
      { apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1; }
  elif command -v dnf >/dev/null; then dnf install -y -q "$@" >/dev/null 2>&1
  elif command -v yum >/dev/null; then yum install -y -q "$@" >/dev/null 2>&1
  elif command -v zypper >/dev/null; then zypper -n -q install "$@" >/dev/null 2>&1
  elif command -v pacman >/dev/null; then pacman -S --noconfirm --needed "$@" >/dev/null 2>&1
  else return 1; fi
}
if [ "${NP_NO_DEPS:-0}" != 1 ]; then
  if ! command -v ping >/dev/null; then
    say "安装 ping…"
    install_pkgs iputils-ping || install_pkgs iputils || say "ping 安装失败，将使用 TCP 方式测延迟"
  fi
  if ! command -v iperf3 >/dev/null; then
    say "安装 iperf3（用于服务器之间带宽测试）…"
    install_pkgs iperf3 || say "iperf3 安装失败，带宽测试不可用（其它功能正常）"
  fi
fi

# ---------------- 下载 Agent ----------------
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$HUB/agent/np-agent.sh" -o "$TMP" || die "下载 Agent 失败：$HUB/agent/np-agent.sh"
bash -n "$TMP" || die "下载的 Agent 脚本不完整"
install -m 755 "$TMP" "$BIN"
VER=$(sed -n 's/^VERSION="\(.*\)"/\1/p' "$BIN")

# ---------------- 确定身份：显式 ID/TOKEN > 已有配置 > 用注册密钥自动注册 ----------------
jstr() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//[$'\t\r\n']/ }"; }
ID="${NP_ID:-}"
TOKEN="${NP_TOKEN:-}"
if [ -n "${NP_KEY:-}" ] && [ -z "$ID" ]; then
  MID=""
  [ -r /etc/machine-id ] && MID=$(sha256sum /etc/machine-id | cut -c1-40)
  IPS=$(ip -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); printf "\"%s\",", a[1]}')
  OS=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-$NAME}") || uname -s)
  RAM=$(awk '/^MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
  DISK=$(df -P -k / | awk 'NR==2 {printf "%d", $2/1048576 + 0.5}')
  BODY=$(printf '{"key":"%s","machineId":"%s","hostname":"%s","name":"%s","city":"%s","tags":"%s","provider":"%s","os":"%s","cores":%s,"ramMB":%s,"diskGB":%s,"ips":[%s]}' \
    "$(jstr "$NP_KEY")" "$MID" "$(jstr "$(hostname)")" "$(jstr "${NP_NAME:-}")" "$(jstr "${NP_CITY:-}")" "$(jstr "${NP_TAGS:-}")" \
    "$(jstr "${NP_PROVIDER:-}")" "$(jstr "$OS")" "$(nproc 2>/dev/null || echo 1)" "${RAM:-0}" "${DISK:-0}" "${IPS%,}")
  say "向 Hub 注册…"
  RESP=$(curl -sS -m 30 -X POST -H "Content-Type: application/json" --data "$BODY" -w '\n%{http_code}' "$HUB/api/agent/register") || die "连不上 Hub：$HUB"
  CODE=${RESP##*$'\n'}
  RESP=${RESP%$'\n'*}
  [ "$CODE" = 200 ] || die "注册失败（HTTP $CODE）：$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' <<< "$RESP")"
  ID=$(sed -n 's/^NP_ID=//p' <<< "$RESP")
  TOKEN=$(sed -n 's/^NP_TOKEN=//p' <<< "$RESP")
  say "已注册为 $(sed -n 's/^NP_NAME=//p' <<< "$RESP")（$ID）"
fi
ID="${ID:-${OLD_ID:-}}"
TOKEN="${TOKEN:-${OLD_TOKEN:-}}"
[[ $ID =~ ^[A-Za-z0-9_-]+$ ]] || die "缺少身份：请提供 NP_KEY（自动注册），或 NP_ID + NP_TOKEN"
[[ $TOKEN =~ ^[A-Za-z0-9_-]+$ ]] || die "NP_TOKEN 格式不对"

umask 077
cat > "$ENV_FILE" <<ENV
NP_HUB=$HUB
NP_ID=$ID
NP_TOKEN=$TOKEN
${NP_IFACE:+NP_IFACE=$NP_IFACE}
ENV

cat > "$UNIT" <<'UNITFILE'
[Unit]
Description=Network Planet Agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/np-agent.env
ExecStart=/usr/local/bin/np-agent.sh
Restart=always
RestartSec=5
# 以临时的无特权用户运行，只额外给 ping 需要的 CAP_NET_RAW
DynamicUser=yes
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
RuntimeDirectory=np-agent
RuntimeDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNITFILE

systemctl daemon-reload
systemctl enable np-agent >/dev/null 2>&1
systemctl restart np-agent
sleep 1
if systemctl is-active --quiet np-agent; then
  say "✅ np-agent $VER 已运行（systemctl status np-agent 查看，journalctl -u np-agent -f 看日志）"
  command -v iperf3 >/dev/null && say "带宽测试需要放行 iperf3 端口（默认 TCP 5201，可在网页设置里改）"
else
  die "服务没有启动成功：journalctl -u np-agent -n 50"
fi
