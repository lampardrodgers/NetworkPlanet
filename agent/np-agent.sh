#!/usr/bin/env bash
# Network Planet Agent —— 纯 bash + curl（Linux）。可选依赖：ping（ICMP 测延迟）、iperf3（带宽测试）。
#
# 功能（各项开关和间隔都由 Hub 下发，在网页「设置 → 探针」里改，改完几秒内生效）：
#   - 每 interval 秒上报 CPU / 内存 / Swap / 磁盘 / 网速 / 累计流量 / 负载 / 连接数 / 进程数
#   - 每 peer_interval 秒测到其它服务器的延迟、丢包、抖动（ICMP 或 TCP）
#   - 每 target_interval 秒测到检测目标（三网 / 自定义 IP、域名）的延迟（ICMP / TCP / HTTP）
#   - 常驻一个长轮询，接收 Hub 安排的 iperf3 带宽测试任务
#
# 安全：Hub 只能下发上面这些固定格式的指令，所有参数都按白名单校验；Agent 不执行任何来自 Hub 的命令。
#
# 必需环境变量：NP_HUB、NP_ID、NP_TOKEN（由 install.sh 写入 /etc/np-agent.env）
# 可选：NP_IFACE（统计网速的网卡，默认取默认路由的网卡）
set -u
VERSION="0.2.0"
: "${NP_HUB:?需要 NP_HUB}" "${NP_ID:?需要 NP_ID}" "${NP_TOKEN:?需要 NP_TOKEN}"
HUB="${NP_HUB%/}"
RUN="${RUNTIME_DIRECTORY:-/tmp/np-agent.$$}"
mkdir -p "$RUN" && chmod 700 "$RUN"
IFACE="${NP_IFACE:-$(ip route show default 2>/dev/null | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')}"
IFACE="${IFACE:-eth0}"

# Hub 下发前的默认配置
C_INTERVAL=10 C_PEERS=1 C_PEER_INTERVAL=60 C_PEER_METHOD=icmp C_PEER_COUNT=4
C_TARGETS=1 C_TARGET_INTERVAL=60 C_TARGET_COUNT=4 C_BANDWIDTH=1
CFGV=""

log() { echo "[np-agent] $*" >&2; }
is_num() { [[ ${1:-} =~ ^[0-9]{1,6}$ ]]; }
is_host() { [[ ${1:-} =~ ^[A-Za-z0-9.:_-]{1,253}$ ]]; }
is_id() { [[ ${1:-} =~ ^[A-Za-z0-9_-]{1,40}$ ]]; }
# JSON 字符串转义（去掉控制字符）
jstr() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//[$'\t\r\n']/ }"; }
# IPv6 放进 URL 要加方括号
url_host() { [[ $1 == *:* ]] && printf '[%s]' "$1" || printf '%s' "$1"; }
has() { command -v "$1" >/dev/null 2>&1; }

curl_hub() { curl -fsS -m "${CURL_MAX:-15}" -H "X-NP-Token: $NP_TOKEN" "$@"; }

# ---------------- 应用 Hub 下发的配置 ----------------
apply_directives() {
  local kind a b c d peers="" targets="" got=0
  while read -r kind a b c d; do
    case "$kind" in
      same) return ;;
      v) CFGV="$a"; got=1 ;;
      cfg)
        case "$a" in
          interval) is_num "$b" && [ "$b" -ge 3 ] && C_INTERVAL=$b ;;
          peers) [[ $b == [01] ]] && C_PEERS=$b ;;
          peer_interval) is_num "$b" && [ "$b" -ge 10 ] && C_PEER_INTERVAL=$b ;;
          peer_method) [[ $b == icmp || $b == tcp ]] && C_PEER_METHOD=$b ;;
          peer_count) is_num "$b" && [ "$b" -ge 1 ] && [ "$b" -le 10 ] && C_PEER_COUNT=$b ;;
          targets) [[ $b == [01] ]] && C_TARGETS=$b ;;
          target_interval) is_num "$b" && [ "$b" -ge 10 ] && C_TARGET_INTERVAL=$b ;;
          target_count) is_num "$b" && [ "$b" -ge 1 ] && [ "$b" -le 10 ] && C_TARGET_COUNT=$b ;;
          bandwidth) [[ $b == [01] ]] && C_BANDWIDTH=$b ;;
        esac ;;
      peer) is_id "$a" && is_host "$b" && is_num "$c" && peers+="$a $C_PEER_METHOD $b $c"$'\n' ;;
      target) is_id "$a" && [[ $b =~ ^(icmp|tcp|http)$ ]] && is_host "$c" && is_num "$d" && targets+="$a $b $c $d"$'\n' ;;
    esac
  done
  if [ "$got" = 1 ]; then
    printf '%s' "$peers" > "$RUN/peers.list"
    printf '%s' "$targets" > "$RUN/targets.list"
  fi
}

# ---------------- 延迟测量：输出「rtt loss jitter」，测不到的输出 null ----------------
measure_icmp() { # host count
  local res loss avg mdev
  res=$(LC_ALL=C ping -c "$2" -i 0.3 -W 2 -q "$1" 2>/dev/null)
  loss=$(sed -n 's/.* \([0-9.]*\)% packet loss.*/\1/p' <<< "$res")
  # rtt min/avg/max/mdev = 1.1/2.2/3.3/0.4 ms（busybox 没有 mdev）
  read -r avg mdev < <(awk -F'= ' '/rtt|round-trip/ {split($2,a,"/"); print a[2], (a[4]==""?"null":a[4]+0)}' <<< "$res")
  echo "${avg:-null} ${loss:-100} ${mdev:-null}"
}

# TCP / HTTP：用 curl 的 time_connect / time_starttransfer。连上后对方说什么都无所谓，所以对 SSH 等端口同样有效。
measure_curl() {
  local method=$1 host=$2 port=$3 count=$4 i t vals="" scheme=http
  [ "$method" = http ] && [ "$port" = 443 ] && scheme=https
  for ((i = 0; i < count; i++)); do
    if [ "$method" = http ]; then
      t=$(curl -s -o /dev/null -k --connect-timeout 2 -m 5 -w '%{http_code} %{time_starttransfer}' "$scheme://$(url_host "$host"):$port/" 2>/dev/null)
      [[ ${t%% *} != 000 ]] && vals+="${t#* } "
    else
      t=$(curl -s -o /dev/null --connect-timeout 2 -m 2 -w '%{time_connect}' "http://$(url_host "$host"):$port/" 2>/dev/null)
      vals+="$t "
    fi
    [ "$i" -lt $((count - 1)) ] && sleep 0.2
  done
  awk -v n="$count" -v v="$vals" 'BEGIN {
    k = split(v, a, " "); m = 0; s = 0
    for (i = 1; i <= k; i++) if (a[i] + 0 > 0) { m++; x[m] = a[i] * 1000; s += x[m] }
    if (!m) { print "null 100 null"; exit }
    avg = s / m; d = 0
    for (i = 1; i <= m; i++) d += (x[i] - avg) ^ 2
    printf "%.2f %.1f %.2f\n", avg, (n - m) * 100 / n, sqrt(d / m)
  }'
}

measure() { # method host port count
  if [ "$1" = icmp ] && has ping; then measure_icmp "$2" "$4"
  elif [ "$1" = icmp ]; then measure_curl tcp "$2" 22 "$4" # 没装 ping 时退回 TCP 22
  else measure_curl "$1" "$2" "$3" "$4"; fi
}

# 后台并发测一批目标，结果写到 $RUN/<name>.json，主循环下次上报时带上
run_batch() { # name listfile count
  local name=$1 list=$2 count=$3
  (
    local id method host port n=0 out="" rtt loss jit
    rm -f "$RUN/$name".r.*
    while read -r id method host port; do
      [ -z "$id" ] && continue
      measure "$method" "$host" "$port" "$count" > "$RUN/$name.r.$id" &
      n=$((n + 1))
      [ $((n % 16)) -eq 0 ] && wait # 最多 16 个并发
    done < "$list"
    wait
    for f in "$RUN/$name".r.*; do
      [ -e "$f" ] || continue
      read -r rtt loss jit < "$f"
      out+="{\"id\":\"${f##*.r.}\",\"rtt\":${rtt:-null},\"loss\":${loss:-100},\"jitter\":${jit:-null}},"
      rm -f "$f"
    done
    printf '[%s]' "${out%,}" > "$RUN/$name.json.tmp" && mv "$RUN/$name.json.tmp" "$RUN/$name.json"
  ) &
}

# ---------------- 带宽测试（iperf3） ----------------
task_post() { curl_hub -X POST -H "Content-Type: application/json" --data "$1" "$HUB/api/agent/task" >/dev/null || log "任务回报失败"; }
task_error() { task_post "{\"id\":\"$NP_ID\",\"task\":\"$1\",\"state\":\"error\",\"error\":\"$(jstr "$2")\"}"; }

iperf_mbps() { # host port dur [-R]；输出接收端 Mbits/sec，失败时输出空并把错误写到 $RUN/iperf.err
  local out
  out=$(timeout $(($3 + 20)) iperf3 -c "$1" -p "$2" -t "$3" -f m ${4:-} 2>&1)
  awk '/receiver/ {for (i = 1; i <= NF; i++) if ($i == "Mbits/sec") v = $(i - 1)} END {print v}' <<< "$out"
  grep -m1 -i 'error' <<< "$out" > "$RUN/iperf.err" || true
}

handle_task() { # id action args...
  local id=$1 act=$2 a=${3:-} b=${4:-} c=${5:-} pid up down
  case "$act" in
    iperf-server)
      is_num "$a" && is_num "$b" || return
      [ "$C_BANDWIDTH" = 1 ] || { task_error "$id" "这台机器关闭了带宽测试"; return; }
      has iperf3 || { task_error "$id" "没有安装 iperf3"; return; }
      timeout "$b" iperf3 -s -p "$a" >/dev/null 2>&1 &
      pid=$!
      echo "$pid" > "$RUN/iperf.$id.pid"
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then task_post "{\"id\":\"$NP_ID\",\"task\":\"$id\",\"state\":\"ready\"}"
      else task_error "$id" "iperf3 服务端启动失败（端口 $a 被占用？）"; fi ;;
    stop)
      [ -e "$RUN/iperf.$id.pid" ] && { kill "$(cat "$RUN/iperf.$id.pid")" 2>/dev/null; rm -f "$RUN/iperf.$id.pid"; } ;;
    iperf-client)
      is_host "$a" && is_num "$b" && is_num "$c" || return
      [ "$C_BANDWIDTH" = 1 ] || { task_error "$id" "这台机器关闭了带宽测试"; return; }
      has iperf3 || { task_error "$id" "没有安装 iperf3"; return; }
      up=$(iperf_mbps "$a" "$b" "$c")
      sleep 1
      down=$(iperf_mbps "$a" "$b" "$c" -R)
      if [ -z "$up$down" ]; then task_error "$id" "连不上对方 iperf3 端口 $b（检查防火墙）$(head -c 120 "$RUN/iperf.err" 2>/dev/null)"
      else task_post "{\"id\":\"$NP_ID\",\"task\":\"$id\",\"state\":\"done\",\"up\":${up:-null},\"down\":${down:-null}}"; fi ;;
  esac
}

# 长轮询：Hub 有指令时立即返回
poll_loop() {
  local resp kind tid act a b c
  while true; do
    if ! resp=$(CURL_MAX=70 curl_hub "$HUB/api/agent/poll?id=$NP_ID" 2>/dev/null); then
      sleep 15
      continue
    fi
    while read -r kind tid act a b c; do
      case "$kind" in
        refresh) touch "$RUN/refresh" ;;
        task) is_id "$tid" && [[ $act =~ ^(iperf-server|iperf-client|stop)$ ]] && handle_task "$tid" "$act" "$a" "$b" "$c" & ;;
      esac
    done <<< "$resp"
  done
}

# ---------------- 系统指标 ----------------
cpu_sample() { awk '/^cpu / {idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print total, idle}' /proc/stat; }
# 计数很大时 /proc/net/dev 里会变成 "eth0:123456"（冒号后无空格），先把冒号换成空格
net_sample() { awk -v ifc="$IFACE" '{sub(":", " ")} $1==ifc {print $2, $10}' /proc/net/dev; }
tcp_established() { cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4 == "01" {n++} END {print n + 0}'; }
proc_count() { local p=(/proc/[0-9]*); echo "${#p[@]}"; }

OS=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-$NAME}") || uname -s)
ARCH=$(uname -m)
CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)

trap 'kill 0 2>/dev/null' EXIT
poll_loop &

read -r C_T0 C_I0 < <(cpu_sample)
read -r RX0 TX0 < <(net_sample || echo "0 0")
T0=$(date +%s)
LAST_PEER=0
LAST_TARGET=0
sleep 2

while true; do
  read -r C_T1 C_I1 < <(cpu_sample)
  read -r RX1 TX1 < <(net_sample || echo "0 0")
  RX1=${RX1:-0} TX1=${TX1:-0}
  T1=$(date +%s)
  DT=$((T1 - T0)); [ "$DT" -le 0 ] && DT=1
  CPU=$(awk -v t0="$C_T0" -v i0="$C_I0" -v t1="$C_T1" -v i1="$C_I1" 'BEGIN{dt=t1-t0; if(dt<=0){print 0}else{printf "%.1f", (1-(i1-i0)/dt)*100}}')
  RXBPS=$(((RX1 - RX0) * 8 / DT)); [ "$RXBPS" -lt 0 ] && RXBPS=0
  TXBPS=$(((TX1 - TX0) * 8 / DT)); [ "$TXBPS" -lt 0 ] && TXBPS=0
  C_T0=$C_T1 C_I0=$C_I1 RX0=$RX1 TX0=$TX1 T0=$T1

  read -r MEM_TOTAL MEM_PCT SWAP_PCT < <(awk '/^MemTotal/ {t=$2} /^MemAvailable/ {a=$2} /^SwapTotal/ {st=$2} /^SwapFree/ {sf=$2}
    END {printf "%d %.1f %s\n", t/1024, (t-a)/t*100, (st>0 ? sprintf("%.1f", (st-sf)/st*100) : "null")}' /proc/meminfo)
  read -r DISK DISK_GB < <(df -P -k / | awk 'NR==2 {gsub("%","",$5); printf "%s %.1f\n", $5, $2/1048576}')
  read -r L1 L5 L15 _ < /proc/loadavg
  UPTIME=$(cut -d. -f1 /proc/uptime)

  # 到点了就在后台跑一轮延迟测量（上一轮没跑完就跳过）
  if [ "$C_PEERS" = 1 ] && [ $((T1 - LAST_PEER)) -ge "$C_PEER_INTERVAL" ] && [ -s "$RUN/peers.list" ] && ! kill -0 "${PEER_PID:-0}" 2>/dev/null; then
    run_batch peers "$RUN/peers.list" "$C_PEER_COUNT"; PEER_PID=$!; LAST_PEER=$T1
  fi
  if [ "$C_TARGETS" = 1 ] && [ $((T1 - LAST_TARGET)) -ge "$C_TARGET_INTERVAL" ] && [ -s "$RUN/targets.list" ] && ! kill -0 "${TARGET_PID:-0}" 2>/dev/null; then
    run_batch targets "$RUN/targets.list" "$C_TARGET_COUNT"; TARGET_PID=$!; LAST_TARGET=$T1
  fi
  EXTRA=""
  for name in peers targets; do
    if [ -s "$RUN/$name.json" ]; then EXTRA+=",\"$name\":$(cat "$RUN/$name.json")"; rm -f "$RUN/$name.json"; fi
  done
  has iperf3 && IPERF=1 || IPERF=0

  BODY=$(printf '{"id":"%s","version":"%s","cfgv":"%s","cpu":%s,"cores":%s,"mem":%s,"memTotalMB":%s,"swap":%s,"disk":%s,"diskTotalGB":%s,"rxBps":%s,"txBps":%s,"rxBytes":%s,"txBytes":%s,"load1":%s,"load5":%s,"load15":%s,"uptimeSec":%s,"conns":%s,"procs":%s,"iperf":%s,"hostname":"%s","kernel":"%s","os":"%s","arch":"%s"%s}' \
    "$NP_ID" "$VERSION" "$CFGV" "$CPU" "${CORES:-null}" "$MEM_PCT" "$MEM_TOTAL" "$SWAP_PCT" "${DISK:-null}" "${DISK_GB:-null}" \
    "$RXBPS" "$TXBPS" "$RX1" "$TX1" "$L1" "$L5" "$L15" "$UPTIME" "$(tcp_established)" "$(proc_count)" "$IPERF" \
    "$(jstr "$(hostname)")" "$(jstr "$(uname -r)")" "$(jstr "$OS")" "$(jstr "$ARCH")" "$EXTRA")
  if RESP=$(curl_hub -X POST -H "Content-Type: application/json" --data "$BODY" "$HUB/api/agent/report"); then
    apply_directives <<< "$RESP"
  else
    log "上报失败 $(date '+%F %T')"
  fi

  # 等待下一轮；收到 refresh（配置变更）时提前结束等待并强制拉全量配置
  for ((i = 0; i < C_INTERVAL; i++)); do
    sleep 1
    if [ -e "$RUN/refresh" ]; then rm -f "$RUN/refresh"; CFGV=""; break; fi
  done
done
