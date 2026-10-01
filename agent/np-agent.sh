#!/usr/bin/env bash
# Network Planet Agent —— 纯 bash + curl，无其它依赖（Linux）。
# 每 INTERVAL 秒上报 CPU / 内存 / 磁盘 / 网卡速率；每 PEER_INTERVAL 秒 ping 其它服务器并上报延迟/丢包。
#
# 必需环境变量：NP_HUB（如 https://planet.example.com）、NP_ID、NP_TOKEN
# 可选：NP_INTERVAL（默认 10）、NP_PEER_INTERVAL（默认 60）、NP_IFACE（默认自动探测）
set -u
VERSION="0.1.0"
: "${NP_HUB:?需要 NP_HUB}" "${NP_ID:?需要 NP_ID}" "${NP_TOKEN:?需要 NP_TOKEN}"
INTERVAL="${NP_INTERVAL:-10}"
PEER_INTERVAL="${NP_PEER_INTERVAL:-60}"
IFACE="${NP_IFACE:-$(ip route show default 2>/dev/null | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')}"
IFACE="${IFACE:-eth0}"
HUB="${NP_HUB%/}"

cpu_sample() { awk '/^cpu / {idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print total, idle}' /proc/stat; }
# 计数很大时 /proc/net/dev 里会变成 "eth0:123456"（冒号后无空格），先把冒号换成空格
net_sample() { awk -v ifc="$IFACE" '{sub(":", " ")} $1==ifc {print $2, $10}' /proc/net/dev; }

read -r C_T0 C_I0 < <(cpu_sample)
read -r RX0 TX0 < <(net_sample || echo "0 0")
T0=$(date +%s)
PEERS_JSON="[]"
LAST_PEER=0

ping_peers() {
  local list out="" id ip res loss avg mdev
  list=$(curl -fsS -m 10 -H "X-NP-Token: $NP_TOKEN" "$HUB/api/agent/peers?id=$NP_ID") || return
  while read -r id ip; do
    [ -z "$id" ] && continue
    res=$(LC_ALL=C ping -c 4 -i 0.3 -W 2 -q "$ip" 2>/dev/null)
    loss=$(echo "$res" | sed -n 's/.* \([0-9.]*\)% packet loss.*/\1/p')
    # rtt min/avg/max/mdev = 1.1/2.2/3.3/0.4 ms
    read -r avg mdev < <(echo "$res" | awk -F'= ' '/rtt|round-trip/ {split($2,a,"/"); print a[2], a[4]+0}')
    out="$out{\"id\":\"$id\",\"rtt\":${avg:-null},\"loss\":${loss:-100},\"jitter\":${mdev:-null}},"
  done <<< "$list"
  PEERS_JSON="[${out%,}]"
}

while true; do
  sleep "$INTERVAL"
  read -r C_T1 C_I1 < <(cpu_sample)
  read -r RX1 TX1 < <(net_sample || echo "0 0")
  T1=$(date +%s)
  DT=$(( T1 - T0 )); [ "$DT" -le 0 ] && DT=1
  CPU=$(awk -v t0="$C_T0" -v i0="$C_I0" -v t1="$C_T1" -v i1="$C_I1" 'BEGIN{dt=t1-t0; if(dt<=0){print 0}else{printf "%.1f", (1-(i1-i0)/dt)*100}}')
  RXBPS=$(( (RX1 - RX0) * 8 / DT ))
  TXBPS=$(( (TX1 - TX0) * 8 / DT ))
  C_T0=$C_T1; C_I0=$C_I1; RX0=$RX1; TX0=$TX1; T0=$T1

  read -r MEM_TOTAL MEM_PCT < <(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {printf "%d %.1f\n", t/1024, (t-a)/t*100}' /proc/meminfo)
  DISK=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
  LOAD=$(cut -d' ' -f1 /proc/loadavg)
  UPTIME=$(cut -d. -f1 /proc/uptime)

  PEERS_FIELD=""
  if [ $(( T1 - LAST_PEER )) -ge "$PEER_INTERVAL" ]; then
    ping_peers
    LAST_PEER=$T1
    PEERS_FIELD=",\"peers\":$PEERS_JSON"
  fi

  BODY=$(printf '{"id":"%s","version":"%s","cpu":%s,"mem":%s,"memTotalMB":%s,"disk":%s,"rxBps":%s,"txBps":%s,"load1":%s,"uptimeSec":%s,"hostname":"%s","kernel":"%s"%s}' \
    "$NP_ID" "$VERSION" "$CPU" "$MEM_PCT" "$MEM_TOTAL" "${DISK:-null}" "$RXBPS" "$TXBPS" "$LOAD" "$UPTIME" "$(hostname)" "$(uname -r)" "$PEERS_FIELD")
  curl -fsS -m 10 -X POST -H "Content-Type: application/json" -H "X-NP-Token: $NP_TOKEN" \
    --data "$BODY" "$HUB/api/agent/report" >/dev/null || echo "[np-agent] 上报失败 $(date)" >&2
done
