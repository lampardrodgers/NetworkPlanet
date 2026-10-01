// 右侧详情面板：服务器 / 站点（同城多台）/ 连线 三种视图，实时刷新。
import { store, serverById, statusOf, edgesOf, measuredBetween, cityName, linkHistory, bandwidthBetween, runningTask, targetsOf, alertsOf } from '../state.js';
import { haversineKm, estimateRttMs } from '../../shared/cities.js';
import {
  statusKey, STATUS_TEXT, fmtMs, fmtPct, fmtBps, fmtBytes, fmtBytesMB, fmtDT, fmtDuration, fmtQuota, fmtUptime, fmtAgo, fmtMbps, latencyColor, providerColor, esc,
} from '../format.js';
import { $, sparkline, copyText, toast } from './dom.js';
import { api } from '../api.js';
import { agentState, hubUrl } from './probe.js';
import { openHistory, drawCycleChart } from './history.js';

let handlers = {};
let historyCache = { id: null, points: [] };
let targetCache = { id: null, data: {}, seen: {} };
let cycleCache = { id: null, at: 0, data: null };

export function initDetail(h) {
  handlers = h;
  const root = $('#detail');
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const { act, id } = a.dataset;
    const sel = store.selection;
    switch (act) {
      case 'close': return handlers.onClose?.();
      case 'fly': return handlers.onFly?.(sel);
      case 'edit-server': return handlers.onEditServer?.(sel.id);
      case 'delete-server': return handlers.onDeleteServer?.(sel.id);
      case 'select-server': return handlers.onSelect?.({ type: 'server', id });
      case 'select-link': return handlers.onSelect?.({ type: 'link', id });
      case 'add-link': return handlers.onAddLink?.({ a: sel.id });
      case 'edit-link': return handlers.onEditLink?.(id);
      case 'delete-link': return handlers.onDeleteLink?.(id);
      case 'create-link': return handlers.onAddLink?.({ a: a.dataset.a, b: a.dataset.b });
      case 'copy': return copyText(a.dataset.text);
      case 'rotate-token': return handlers.onRotateToken?.(sel.id);
      case 'probe': return probeNow(sel.id, a);
      case 'bw-test': return startBandwidth(a.dataset.a, a.dataset.b, a);
      case 'bw-test-sel': {
        const b = $('[data-bw-peer]', root)?.value;
        return b ? startBandwidth(sel.id, b, a) : toast('先选择对端服务器', 'warn');
      }
      case 'calib': return calibrate(sel.id, a);
      case 'history': return openHistory(sel.id, { range: a.dataset.range || 'cycle' });
      case 'toggle-cmd': return $('.cmd-alt', root)?.classList.toggle('hidden');
    }
  });
}

async function startBandwidth(a, b, btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/bandwidth', { a, b });
    if (r.id) store.tasks.set(r.id, r);
    toast(r.queued ? `已排队（第 ${r.position} 个）` : '带宽测试已开始，约需 20~40 秒', 'ok');
    updateLive();
  } catch (e) {
    toast(e.message, 'error', 6000);
  } finally {
    btn.disabled = false;
  }
}

async function calibrate(id, btn) {
  const input = $('[data-calib]', $('#detail'));
  const v = Number(input?.value);
  if (!input?.value || !Number.isFinite(v) || v < 0) return toast('请填写本周期已用流量（GB）', 'warn');
  btn.disabled = true;
  try {
    await api('POST', `/api/servers/${id}/traffic`, { usedGB: v });
    toast('已校准，几秒后刷新', 'ok');
    cycleCache.at = 0;
    input.value = '';
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function probeNow(id, btn) {
  btn.disabled = true;
  btn.textContent = '探测中…';
  try {
    const r = await api('POST', `/api/servers/${id}/probe`);
    btn.textContent = r.rtt == null ? '不可达' : `${r.rtt.toFixed(1)} ms`;
  } catch (e) {
    btn.textContent = e.message;
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '立即探测';
  }, 2500);
}

export async function renderDetail() {
  const root = $('#detail');
  const sel = store.selection;
  if (!sel) {
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');
  if (sel.type === 'server') {
    const s = serverById(sel.id);
    if (!s) return handlers.onClose?.();
    root.innerHTML = serverView(s);
    cycleCache.at = 0; // 编辑 / 校准后周期或额度可能变了
    if (historyCache.id !== s.id) {
      historyCache = { id: s.id, points: [] };
      targetCache = { id: s.id, data: {}, seen: {} };
      try {
        [historyCache.points, targetCache.data] = await Promise.all([api('GET', `/api/servers/${s.id}/history`), api('GET', `/api/servers/${s.id}/targets`)]);
      } catch {}
      if (store.selection?.id !== s.id) return;
    }
    updateLive();
  } else if (sel.type === 'site') {
    root.innerHTML = siteView(sel.id);
  } else if (sel.type === 'link') {
    root.innerHTML = linkView(sel.id);
    drawLinkChart(sel.id);
  }
}

/** 实时数据到达时只刷新「实时」区域，避免整个面板闪烁/丢失滚动位置 */
export function updateLive() {
  const sel = store.selection;
  const root = $('#detail');
  if (!sel || root.classList.contains('hidden')) return;
  if (sel.type === 'server') {
    const s = serverById(sel.id);
    if (!s) return;
    const st = statusOf(s.id);
    // 把推送的最新点并入本地历史
    const pts = historyCache.id === s.id ? historyCache.points : [];
    const t = st?.lastSeen || st?.lastProbe;
    if (t && (!pts.length || pts[pts.length - 1].t < t)) {
      pts.push({ t, hubRtt: st.hubRtt, cpu: st.agent?.cpu, mem: st.agent?.mem, rx: st.agent?.rxBps, tx: st.agent?.txBps });
      if (pts.length > 240) pts.shift();
    }
    const live = $('.live', root);
    if (live) live.innerHTML = liveBlock(s, st);
    const head = $('.detail-head .dot', root);
    if (head) head.className = `dot ${statusKey(st)}`;
    const peersEl = $('.peers', root);
    if (peersEl) peersEl.innerHTML = peersBlock(s);
    const linksEl = $('.links-list', root);
    if (linksEl) linksEl.innerHTML = linksBlock(s);
    for (const [sel2, fn] of [['.traffic', trafficBlock], ['.targets', targetsBlock], ['.bw', bwBlock], ['.bw-ctrl', bwCtrl], ['.agent-state', agentBlock], ['.alert-strip', alertStrip]]) {
      const el = $(sel2, root);
      if (el) {
        const html = fn(s);
        if (el._html !== html) el.innerHTML = el._html = html;
      }
    }
    mergeTargetHistory(s.id);
    drawMiniCycle(s);
    drawCharts(pts);
    drawTargetChart();
  } else if (sel.type === 'site') {
    const body = $('.site-list', root);
    if (body) body.innerHTML = siteMembers(sel.id);
  } else if (sel.type === 'link') {
    const body = $('.link-live', root);
    if (body) body.innerHTML = linkLive(sel.id);
    drawLinkChart(sel.id);
  }
}

// ---------------- 服务器 ----------------
function serverView(s) {
  const st = statusOf(s.id);
  const sp = s.specs || {};
  const hub = hubUrl();
  const cmd = `curl -fsSL ${hub}/agent/install.sh | sudo NP_HUB=${hub} NP_ID=${s.id} NP_TOKEN=${s.agentToken} bash`;
  const specRows = [
    ['CPU', sp.cpu ? `${sp.cpu} 核` : null],
    ['内存', sp.ramMB ? fmtBytesMB(sp.ramMB) : null],
    ['磁盘', sp.diskGB ? `${sp.diskGB} GB` : null],
    ['端口带宽', sp.bandwidthMbps ? fmtMbps(sp.bandwidthMbps) : null],
    ['流量额度', sp.trafficTB ? fmtQuota(sp.trafficTB) : null],
    ['套餐', sp.plan || null],
    ['系统', s.os || null],
    ['月费', s.monthlyCost != null ? `$${s.monthlyCost}` : null],
    ['到期', s.expiresAt || null],
    ['供应商状态', s.providerStatus || null],
  ].filter(([, v]) => v);
  return `
    <div class="detail-head">
      <div class="title-row"><i class="dot ${statusKey(st)}"></i><h2>${esc(s.name)}</h2><button class="icon-btn" data-act="close" title="关闭">✕</button></div>
      <div class="sub">
        <span class="badge" style="--c:${providerColor(s.provider)}">${esc(s.provider || '未指定')}</span>
        <span>📍 ${esc(cityName(s.city) || '未知')}${s.country ? ' · ' + esc(s.country) : ''}</span>
        ${s.demo ? '<span class="pill">演示</span>' : ''}
      </div>
      <div class="sub mono">
        ${s.ip ? `<span class="copy" data-act="copy" data-text="${esc(s.ip)}" title="复制">${esc(s.ip)} ⧉</span>` : ''}
        ${s.host ? `<span class="copy" data-act="copy" data-text="${esc(s.host)}">${esc(s.host)} ⧉</span>` : ''}
        <span class="muted">${s.lat?.toFixed(3)}, ${s.lon?.toFixed(3)}</span>
      </div>
      <div class="head-actions">
        <button class="btn sm" data-act="fly">◎ 定位</button>
        <button class="btn sm" data-act="probe">立即探测</button>
        <button class="btn sm" data-act="edit-server">✎ 编辑</button>
        <button class="btn sm danger" data-act="delete-server">删除</button>
      </div>
    </div>
    <div class="detail-body">
      <div class="alert-strip">${alertStrip(s)}</div>
      <section class="live">${liveBlock(s, st)}</section>
      <section>
        <h4>实时 <button class="btn xs" data-act="history" data-range="24h">📈 历史图表</button></h4>
        <div class="charts">
          <div class="chart"><label>Hub 延迟</label><canvas data-chart="hubRtt"></canvas></div>
          <div class="chart"><label>CPU <i style="color:#a78bfa">━</i> / 内存 <i style="color:#f472b6">━</i></label><canvas data-chart="cpu"></canvas></div>
          <div class="chart"><label>网络 ↓ <i style="color:#34d399">━</i> ↑ <i style="color:#fbbf24">━</i></label><canvas data-chart="net"></canvas></div>
        </div>
      </section>
      <section>
        <h4>本周期流量 <button class="btn xs" data-act="history" data-range="cycle">📊 按时间段查看</button></h4>
        <div class="traffic">${trafficBlock(s)}</div>
        <div class="tchart mini" data-c="mini-cycle"></div>
        ${s.demo ? '' : `<div class="row-actions calib"><input class="input sm" data-calib type="number" min="0" step="any" placeholder="与服务商面板不一致？填本周期已用 GB" /><button class="btn xs" data-act="calib">校准</button></div>`}
      </section>
      <section>
        <h4>三网 / 检测目标 <span class="hint">Agent 每 ${store.settings.probe?.targets?.intervalSec ?? 60}s 测一次</span></h4>
        <div class="targets">${targetsBlock(s)}</div>
        <div class="chart"><canvas data-chart="targets" style="height:70px"></canvas></div>
      </section>
      <section>
        <h4>带宽测试 <span class="hint">iperf3，需两端都装 Agent</span></h4>
        <div class="bw">${bwBlock(s)}</div>
        <div class="bw-ctrl">${bwCtrl(s)}</div>
      </section>
      <section>
        <h4>连接 <button class="btn xs" data-act="add-link">＋ 添加</button></h4>
        <div class="links-list">${linksBlock(s)}</div>
      </section>
      <section>
        <h4>到其它服务器的实测延迟 <span class="hint">来自 Agent ping</span></h4>
        <div class="peers">${peersBlock(s)}</div>
      </section>
      ${specRows.length ? `<section><h4>配置</h4><div class="kv">${specRows.map(([k, v]) => `<span>${k}</span><b>${esc(v)}</b>`).join('')}</div></section>` : ''}
      ${s.tags?.length || s.notes ? `<section><h4>标签 / 备注</h4>${s.tags?.length ? `<div class="tags">${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}</section>` : ''}
      <section>
        <h4>Agent</h4>
        <div class="agent-state">${agentBlock(s)}</div>
        ${s.demo ? '' : `
        <p class="hint">推荐用顶栏「⤓ 安装探针」里的通用命令（所有 VPS 同一条，按 IP 自动认领这台）。也可以用这台专属的命令：</p>
        <div class="row-actions">
          <button class="btn xs" data-act="toggle-cmd">显示专属命令</button>
          <button class="btn xs" data-act="rotate-token">重置 Token</button>
        </div>
        <div class="cmd-alt hidden">
          <pre class="cmd">${esc(cmd)}</pre>
          <button class="btn xs" data-act="copy" data-text="${esc(cmd)}">复制命令</button>
        </div>`}
      </section>
    </div>`;
}

function liveBlock(s, st) {
  const ag = st?.agent;
  const key = statusKey(st);
  const cells = [
    ['状态', `<span class="st ${key}">${STATUS_TEXT[key]}</span>`],
    ['Hub 延迟', `<span style="color:${latencyColor(st?.hubRtt)}">${fmtMs(st?.hubRtt)}</span>`],
    ['运行', fmtUptime(ag?.uptimeSec)],
    [`CPU${ag?.cores ? ` · ${ag.cores}核` : ''}`, meter(ag?.cpu)],
    [`内存${ag?.memTotalMB ? ` · ${fmtBytesMB(ag.memTotalMB)}` : ''}`, meter(ag?.mem)],
    [`磁盘${ag?.diskTotalGB ? ` · ${Math.round(ag.diskTotalGB)}G` : ''}`, meter(ag?.disk)],
    ['下行 ↓', fmtBps(ag?.rxBps)],
    ['上行 ↑', fmtBps(ag?.txBps)],
    ['Swap', ag?.swap == null ? '—' : meter(ag.swap)],
    ['负载', ag?.load1 == null ? '—' : `${ag.load1}${ag.load5 != null ? ` <span class="muted">${ag.load5} ${ag.load15}</span>` : ''}`],
    ['TCP 连接', ag?.conns ?? '—'],
    ['进程', ag?.procs ?? '—'],
  ];
  return `
    <div class="metrics">${cells.map(([k, v]) => `<div class="metric"><label>${k}</label><div>${v}</div></div>`).join('')}</div>
    <div class="hint">探测端口 ${s.probePort || 22}：${fmtAgo(st?.lastProbe)}${ag ? ` · Agent 上报：${fmtAgo(st.lastSeen)}` : ''}</div>`;
}

function alertStrip(s) {
  const list = alertsOf(s.id);
  return list.length ? `<div class="warn-box">⚠ ${list.map((a) => esc(a.ruleName)).join('、')}</div>` : '';
}

function agentBlock(s) {
  const st = statusOf(s.id);
  const ag = st?.agent;
  const a = agentState(s);
  if (!ag) return `<p class="hint">${a.key === 'stale' ? `<span class="ag stale">${esc(a.text)}</span>` : s.demo ? '演示服务器的数据为模拟生成。' : '未安装。装上后可以看到 CPU / 网速 / 流量 / 三网延迟 / 带宽测试。'}</p>`;
  const rows = [
    ['版本', `<span class="ag ${a.key}">${esc(a.text)}</span>${a.key === 'old' ? ' <span class="hint">重新运行安装命令即可升级</span>' : ''}`],
    ['系统', `${esc(ag.os || '')} ${esc(ag.arch || '')}`],
    ['内核', esc(ag.kernel || '')],
    ['主机名', esc(ag.hostname || '')],
    ['iperf3', ag.iperf ? '已安装' : '<span class="muted">未安装（带宽测试不可用）</span>'],
    ['指令通道', s.demo ? '—' : st.poll ? '<span style="color:var(--ok)">已连接</span>' : '<span class="muted">未连接</span>'],
  ];
  return `<div class="kv">${rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('')}</div>`;
}

function trafficBlock(s) {
  const tr = statusOf(s.id)?.traffic;
  if (!tr) return `<p class="hint">${s.demo ? '' : '装上 Agent 后自动统计。重置时间、额度和计费方式在「编辑」里按这台机器单独设置。'}</p>`;
  const MODE = { sum: '双向合计', out: '只算出站', in: '只算入站', max: '取较大方向' };
  const pct = tr.pct;
  const c = pct == null ? 'var(--accent)' : pct >= 90 ? 'var(--lat-bad)' : pct >= 75 ? 'var(--lat-warn)' : 'var(--accent)';
  const over = tr.limit && tr.projected && tr.projected > tr.limit;
  return `
    <div class="traffic-main">
      <b>${fmtBytes(tr.used)}</b>${tr.limit ? ` <span class="muted">/ ${fmtBytes(tr.limit)}</span> <span style="color:${c}">${pct}%</span>` : ' <span class="muted">（未设置流量额度）</span>'}
    </div>
    ${tr.limit ? `<div class="tbar"><i style="width:${Math.min(100, pct)}%;background:${c}"></i>${tr.nextReset ? `<em style="left:${Math.min(100, ((Date.now() - tr.cycleStart) / (tr.nextReset - tr.cycleStart)) * 100)}%" title="周期已过去的比例"></em>` : ''}</div>` : ''}
    <div class="hint">↓ ${fmtBytes(tr.rx)} · ↑ ${fmtBytes(tr.tx)} · ${MODE[tr.mode] || tr.mode}</div>
    <div class="hint">${fmtDT(tr.cycleStart)} → ${tr.nextReset ? `${fmtDT(tr.nextReset)}（还剩 ${fmtDuration(tr.nextReset - Date.now())}）` : '不重置'}${tr.cycleInherit ? '' : ' · 单独设置'}</div>
    ${tr.dailyAvg != null ? `<div class="hint">日均 ${fmtBytes(tr.dailyAvg)}${tr.projected ? ` · 预计周期末 <span style="color:${over ? 'var(--lat-bad)' : 'inherit'}">${fmtBytes(tr.projected)}${over ? ' ⚠ 会超额' : ''}</span>` : ''}</div>` : ''}
`;
}

/** 详情里的周期累计小图：选中时拉一次，之后每 5 分钟刷新 */
async function drawMiniCycle(s) {
  const el = $('#detail [data-c=mini-cycle]');
  if (!el) return;
  const tr = statusOf(s.id)?.traffic;
  if (!tr) return el.classList.add('hidden');
  el.classList.remove('hidden');
  if (cycleCache.id === s.id && Date.now() - cycleCache.at < 300_000) {
    if (!el.querySelector('canvas') && cycleCache.data) drawCycleChart(el, s.id, cycleCache.data.cycles[0], cycleCache.data.mode, { compact: true }).catch(() => {});
    return;
  }
  cycleCache = { id: s.id, at: Date.now(), data: null };
  try {
    const data = await api('GET', `/api/servers/${s.id}/cycles?n=1`);
    if (store.selection?.id !== s.id || !data.cycles[0]) return;
    cycleCache.data = data;
    await drawCycleChart(el, s.id, data.cycles[0], data.mode, { compact: true });
  } catch {}
}

const GROUP_COLORS = { 电信: '#38bdf8', 联通: '#fb923c', 移动: '#34d399', 公共: '#a78bfa' };
const groupColor = (g) => GROUP_COLORS[g] || '#94a3b8';

function targetsBlock(s) {
  const res = targetsOf(s.id);
  const targets = (store.settings.targets || []).filter((t) => t.enabled);
  if (!targets.length) return '<p class="hint">没有启用的检测目标（⚙ 设置 →「检测目标」）。</p>';
  if (!Object.keys(res).length) return `<p class="hint">${s.demo ? '等待数据…' : '还没有数据。装上 Agent 并在设置里开启「检测目标」后，会自动测到三网的延迟。'}</p>`;
  const max = Math.max(1, ...targets.map((t) => res[t.id]?.rtt || 0));
  return targets
    .map((t) => {
      const r = res[t.id];
      const down = r && r.rtt == null;
      return `<div class="peer-row tgt">
        <span class="pn" title="${esc(t.host)}"><i class="gdot" style="background:${groupColor(t.group)}"></i>${esc(t.name)}</span>
        <span class="bar"><i style="width:${!r ? 0 : down ? 100 : (r.rtt / max) * 100}%;background:${down ? 'var(--lat-bad)' : latencyColor(r?.rtt)}"></i></span>
        <span class="pv">${!r ? '<span class="muted">—</span>' : down ? '<span class="bad">不通</span>' : fmtMs(r.rtt)}${r?.loss ? ` <span class="bad">${Math.round(r.loss)}%</span>` : ''}</span>
      </div>`;
    })
    .join('');
}

function bwBlock(s) {
  const results = (store.status.bandwidth || []).filter((r) => r.a === s.id || r.b === s.id);
  const rows = results
    .sort((x, y) => y.ts - x.ts)
    .map((r) => {
      const other = r.a === s.id ? r.b : r.a;
      const bw = bandwidthBetween(s.id, other);
      const o = serverById(other);
      return `<div class="bw-row" data-act="select-server" data-id="${other}"><span class="pn">${esc(o?.name || other)}</span>
        <span class="mono">↑ ${fmtMbps(bw.up)}</span><span class="mono">↓ ${fmtMbps(bw.down)}</span><span class="muted">${fmtAgo(bw.ts)}</span></div>`;
    })
    .join('');
  return rows || '<p class="hint">还没有测试结果。↑ 为本机发往对端，↓ 为对端发往本机。</p>';
}

function bwCtrl(s) {
  const running = runningTask(s.id);
  const peers = store.servers.filter((o) => o.id !== s.id && !o.demo && statusOf(o.id)?.agent);
  const linked = new Set(store.links.filter((l) => l.a === s.id || l.b === s.id).map((l) => (l.a === s.id ? l.b : l.a)));
  peers.sort((x, y) => linked.has(y.id) - linked.has(x.id) || x.name.localeCompare(y.name));
  return s.demo
    ? ''
    : running
      ? `<div class="loading-inline"><div class="spinner sm"></div>正在测试 ${esc(running.aName)} ⇄ ${esc(running.bName)}…</div>`
      : peers.length
        ? `<div class="row-actions"><select class="input sm" data-bw-peer style="flex:1">${peers.map((o) => `<option value="${o.id}">${linked.has(o.id) ? '⇄ ' : ''}${esc(o.name)} · ${esc(cityName(o.city))}</option>`).join('')}</select>
           <button class="btn xs primary" data-act="bw-test-sel">测速</button></div>`
        : '<p class="hint">需要至少另一台装了 Agent 的服务器。</p>';
}

/** 把 SSE 推来的最新目标结果并入本地历史，用于折线图 */
function mergeTargetHistory(id) {
  if (targetCache.id !== id) return;
  for (const [tid, r] of Object.entries(targetsOf(id))) {
    if (targetCache.seen[tid] === r.ts) continue;
    targetCache.seen[tid] = r.ts;
    const arr = (targetCache.data[tid] ||= []);
    if (!arr.length || arr[arr.length - 1].t < r.ts) arr.push({ t: r.ts, rtt: r.rtt, loss: r.loss });
    if (arr.length > 120) arr.shift();
  }
}

function drawTargetChart() {
  const c = $('#detail [data-chart=targets]');
  if (!c) return;
  const targets = (store.settings.targets || []).filter((t) => t.enabled && targetCache.data[t.id]?.length);
  const series = targets.map((t) => ({ color: groupColor(t.group), values: targetCache.data[t.id].slice(-60).map((p) => p.rtt) }));
  if (!series.length) return sparkline(c, [], {});
  const max = Math.max(1, ...series.flatMap((x) => x.values.filter((v) => v != null))) * 1.1;
  sparkline(c, series[0].values, { color: series[0].color, max, fill: false });
  for (const x of series.slice(1)) overlay(c, x.values, x.color, max);
}

function meter(v) {
  if (v == null) return '—';
  const c = v > 90 ? 'var(--lat-bad)' : v > 70 ? 'var(--lat-warn)' : 'var(--accent)';
  return `<span class="meter"><i style="width:${Math.min(100, v)}%;background:${c}"></i></span><span class="mv">${fmtPct(v)}</span>`;
}

function linksBlock(s) {
  const edges = edgesOf(s.id);
  if (!edges.length) return '<p class="hint">暂无手动连接。点「添加」把这台和其它服务器连起来，或在下方实测列表里一键创建。</p>';
  return edges
    .map(({ link, other, measured, estimate }) => {
      const o = serverById(other);
      const rtt = measured?.rtt;
      return `
      <div class="link-row" data-act="select-link" data-id="${pairKey(link.a, link.b)}">
        <div class="lr-main"><b>${esc(o?.name || other)}</b><span class="muted">${esc(cityName(o?.city))}${link.label ? ' · ' + esc(link.label) : ''}</span></div>
        <div class="lr-vals">
          <span style="color:${latencyColor(rtt)}">${measured ? fmtMs(rtt) : `≈${fmtMs(estimate)}`}</span>
          ${measured?.loss ? `<span class="bad">${measured.loss.toFixed(1)}%</span>` : ''}
          ${link.bandwidthMbps ? `<span class="muted">${fmtMbps(link.bandwidthMbps)}</span>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

function peersBlock(s) {
  const rows = store.servers
    .filter((o) => o.id !== s.id)
    .map((o) => ({ o, m: measuredBetween(s.id, o.id) }))
    .filter((r) => r.m)
    .sort((a, b) => (a.m.rtt ?? 1e9) - (b.m.rtt ?? 1e9));
  if (!rows.length) return '<p class="hint">还没有实测数据。在这台和其它服务器上安装 Agent 后，会自动互相 ping。</p>';
  const max = Math.max(...rows.map((r) => r.m.rtt || 0), 1);
  const linked = new Set(store.links.filter((l) => l.a === s.id || l.b === s.id).map((l) => (l.a === s.id ? l.b : l.a)));
  return rows
    .map(({ o, m }) => `
      <div class="peer-row">
        <span class="pn" data-act="select-server" data-id="${o.id}" title="${esc(o.name)}">${esc(o.name)}</span>
        <span class="bar"><i style="width:${m.rtt == null ? 100 : (m.rtt / max) * 100}%;background:${m.rtt == null ? 'var(--lat-bad)' : latencyColor(m.rtt)}"></i></span>
        <span class="pv">${m.rtt == null ? '<span class="bad">不通</span>' : fmtMs(m.rtt)}${m.loss ? ` <span class="bad">${m.loss.toFixed(0)}%</span>` : ''}</span>
        ${linked.has(o.id) ? '<span class="pl" title="已连接">⇄</span>' : `<button class="pl add" data-act="create-link" data-a="${s.id}" data-b="${o.id}" title="创建连接">＋</button>`}
      </div>`)
    .join('');
}

function drawCharts(pts) {
  const root = $('#detail');
  const c1 = $('[data-chart=hubRtt]', root);
  const c2 = $('[data-chart=cpu]', root);
  const c3 = $('[data-chart=net]', root);
  if (!c1) return;
  const last = pts.slice(-120);
  sparkline(c1, last.map((p) => p.hubRtt), { color: '#38bdf8' });
  sparkline(c2, last.map((p) => p.cpu), { color: '#a78bfa', max: 100 });
  overlay(c2, last.map((p) => p.mem), '#f472b6', 100);
  const netMax = Math.max(1, ...last.map((p) => Math.max(p.rx || 0, p.tx || 0))) * 1.15;
  sparkline(c3, last.map((p) => p.rx), { color: '#34d399', max: netMax });
  overlay(c3, last.map((p) => p.tx), '#fbbf24', netMax);
}

function overlay(canvas, values, color, max) {
  const g = canvas.getContext('2d');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const n = values.length;
  if (n < 2) return;
  g.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v == null) return (started = false);
    const x = (i / (n - 1)) * w;
    const y = h - 2 - (v / max) * (h - 4);
    started ? g.lineTo(x, y) : g.moveTo(x, y);
    started = true;
  });
  g.strokeStyle = color;
  g.lineWidth = 1.2;
  g.stroke();
}

// ---------------- 站点（同城多台） ----------------
function siteView(siteId) {
  const site = handlers.getSite?.(siteId);
  if (!site) return '';
  return `
    <div class="detail-head">
      <div class="title-row"><h2>📍 ${esc(site.name)}</h2><button class="icon-btn" data-act="close">✕</button></div>
      <div class="sub"><span>${site.servers.length} 台服务器</span><span class="muted">${site.lat.toFixed(2)}, ${site.lon.toFixed(2)}</span></div>
      <div class="head-actions"><button class="btn sm" data-act="fly">◎ 放大查看</button></div>
    </div>
    <div class="detail-body"><section><div class="site-list">${siteMembers(siteId)}</div></section>
    <p class="hint">提示：放大地球（滚轮）到城市级别后，同一城市的多台服务器会自动散开，可以直接点选。</p></div>`;
}

function siteMembers(siteId) {
  const site = handlers.getSite?.(siteId);
  if (!site) return '';
  return site.servers
    .map((s) => {
      const st = statusOf(s.id);
      const key = statusKey(st);
      return `
      <div class="srv-item" data-act="select-server" data-id="${s.id}">
        <i class="dot ${key}"></i>
        <div class="srv-main"><div class="srv-name">${esc(s.name)}</div><div class="srv-sub">${esc(s.provider || '')} · ${esc(s.ip || '')}</div></div>
        <div class="srv-rtt">
          <span style="color:${latencyColor(st?.hubRtt)}">${key === 'offline' ? '离线' : fmtMs(st?.hubRtt)}</span>
          <small class="muted">CPU ${fmtPct(st?.agent?.cpu)} · ↓${fmtBps(st?.agent?.rxBps)}</small>
        </div>
      </div>`;
    })
    .join('');
}

// ---------------- 连线 ----------------
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function linkView(key) {
  const [a, b] = key.split('|');
  const sa = serverById(a);
  const sb = serverById(b);
  if (!sa || !sb) return '';
  const link = store.links.find((l) => pairKey(l.a, l.b) === key);
  const km = haversineKm(sa.lat, sa.lon, sb.lat, sb.lon);
  return `
    <div class="detail-head">
      <div class="title-row"><h2>⇄ 连接</h2><button class="icon-btn" data-act="close">✕</button></div>
      <div class="link-ends">
        <span class="end" data-act="select-server" data-id="${sa.id}"><b>${esc(sa.name)}</b><small>${esc(cityName(sa.city))}</small></span>
        <span class="arrow">⟷</span>
        <span class="end" data-act="select-server" data-id="${sb.id}"><b>${esc(sb.name)}</b><small>${esc(cityName(sb.city))}</small></span>
      </div>
      <div class="head-actions">
        <button class="btn sm" data-act="fly">◎ 定位</button>
        ${link ? `<button class="btn sm" data-act="edit-link" data-id="${link.id}">✎ 编辑</button><button class="btn sm danger" data-act="delete-link" data-id="${link.id}">删除连接</button>` : `<button class="btn sm primary" data-act="create-link" data-a="${a}" data-b="${b}">＋ 保存为连接</button>`}
      </div>
    </div>
    <div class="detail-body">
      <section class="link-live">${linkLive(key)}</section>
      <section><div class="chart"><label>实测延迟历史</label><canvas data-chart="link"></canvas></div></section>
      <section><h4>信息</h4><div class="kv">
        <span>大圆距离</span><b>${Math.round(km).toLocaleString()} km</b>
        <span>理论估算</span><b>≈ ${fmtMs(estimateRttMs(sa, sb))}</b>
        ${link?.label ? `<span>备注</span><b>${esc(link.label)}</b>` : ''}
        ${link?.bandwidthMbps ? `<span>标称带宽</span><b>${fmtMbps(link.bandwidthMbps)}</b>` : ''}
        <span>类型</span><b>${link ? '手动连接' : 'Agent 实测'}</b>
      </div></section>
    </div>`;
}

function linkLive(key) {
  const [a, b] = key.split('|');
  const m = measuredBetween(a, b);
  const link = store.links.find((l) => pairKey(l.a, l.b) === key);
  const cells = [
    ['延迟 RTT', m ? `<span style="color:${latencyColor(m.rtt)}">${m.rtt == null ? '中断' : fmtMs(m.rtt)}</span>` : '<span class="muted">无实测</span>'],
    ['丢包', m ? `<span class="${m.loss ? 'bad' : ''}">${m.loss == null ? '—' : m.loss.toFixed(1) + '%'}</span>` : '—'],
    ['抖动', m?.jitter != null ? fmtMs(m.jitter) : '—'],
    ['标称带宽', link?.bandwidthMbps ? fmtMbps(link.bandwidthMbps) : '—'],
  ];
  const bw = bandwidthBetween(a, b);
  const sa = serverById(a);
  const sb = serverById(b);
  const running = runningTask(a, b);
  const demo = sa?.demo || sb?.demo;
  return `<div class="metrics four">${cells.map(([k, v]) => `<div class="metric"><label>${k}</label><div>${v}</div></div>`).join('')}</div>
    <div class="hint">${m ? `延迟更新于 ${fmtAgo(m.ts)}` : '两端都安装 Agent 后会自动测量；当前颜色/数值为按距离估算。'}</div>
    <h4 style="margin-top:12px">实测带宽 <span class="hint">iperf3</span></h4>
    ${bw ? `<div class="metrics four">
        <div class="metric"><label>${esc(sa?.name)} → ${esc(sb?.name)}</label><div>${fmtMbps(bw.up)}</div></div>
        <div class="metric"><label>${esc(sb?.name)} → ${esc(sa?.name)}</label><div>${fmtMbps(bw.down)}</div></div>
      </div><div class="hint">测于 ${fmtAgo(bw.ts)}</div>` : '<p class="hint">还没有测过。</p>'}
    ${demo ? '' : running ? `<div class="loading-inline"><div class="spinner sm"></div>测试中…（约 ${(store.settings.probe?.bandwidth?.durationSec || 5) * 2 + 10} 秒）</div>`
      : `<div class="row-actions"><button class="btn xs primary" data-act="bw-test" data-a="${a}" data-b="${b}">${bw ? '重新测速' : '开始测速'}</button><span class="hint">会消耗两端流量</span></div>`}`;
}

function drawLinkChart(key) {
  const c = $('#detail [data-chart=link]');
  if (!c) return;
  const arr = linkHistory.get(key) || [];
  sparkline(c, arr.map((p) => p.rtt), { color: '#38bdf8' });
}
