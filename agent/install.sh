#!/usr/bin/env bash
# 一键安装 Network Planet Agent 为 systemd 服务。
# 用法：curl -fsSL $NP_HUB/agent/install.sh | sudo NP_HUB=... NP_ID=... NP_TOKEN=... bash
# 卸载：sudo systemctl disable --now np-agent && sudo rm /etc/systemd/system/np-agent.service /usr/local/bin/np-agent.sh /etc/np-agent.env
set -euo pipefail
: "${NP_HUB:?需要 NP_HUB}" "${NP_ID:?需要 NP_ID}" "${NP_TOKEN:?需要 NP_TOKEN}"
HUB="${NP_HUB%/}"
command -v curl >/dev/null || { echo "需要 curl"; exit 1; }

curl -fsSL "$HUB/agent/np-agent.sh" -o /usr/local/bin/np-agent.sh
chmod 755 /usr/local/bin/np-agent.sh

umask 077
cat > /etc/np-agent.env <<ENV
NP_HUB=$HUB
NP_ID=$NP_ID
NP_TOKEN=$NP_TOKEN
ENV

cat > /etc/systemd/system/np-agent.service <<UNIT
[Unit]
Description=Network Planet Agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/np-agent.env
ExecStart=/usr/local/bin/np-agent.sh
Restart=always
RestartSec=5
DynamicUser=yes
AmbientCapabilities=CAP_NET_RAW

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now np-agent
echo "✅ np-agent 已启动：systemctl status np-agent"
