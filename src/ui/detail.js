// 右侧详情面板：服务器 / 站点（同城多台）/ 连线 三种视图，实时刷新。
import { store, serverById, statusOf, edgesOf, measuredBetween, cityName, linkHistory } from '../state.js';
import { haversineKm, estimateRttMs } from '../../shared/cities.js';
import {
  statusKey, STATUS_TEXT, fmtMs, fmtPct, fmtBps, fmtBytesMB, fmtUptime, fmtAgo, fmtMbps, latencyColor, providerColor, esc,
} from '../format.js';
import { $, sparkline, copyText } from './dom.js';
import { api } from '../api.js';

let handlers = {};
let historyCache = { id: null, points: [] };

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
    }
  });
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
    if (historyCache.id !== s.id) {
      historyCache = { id: s.id, points: [] };
      try {
        historyCache.points = await api('GET', `/api/servers/${s.id}/history`);
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
    drawCharts(pts);
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
  const hub = store.settings.publicUrl || location.origin;
  const cmd = `curl -fsSL ${hub}/agent/install.sh | sudo NP_HUB=${hub} NP_ID=${s.id} NP_TOKEN=${s.agentToken} bash`;
  const specRows = [
    ['CPU', sp.cpu ? `${sp.cpu} 核` : null],
    ['内存', sp.ramMB ? fmtBytesMB(sp.ramMB) : null],
    ['磁盘', sp.diskGB ? `${sp.diskGB} GB` : null],
    ['端口带宽', sp.bandwidthMbps ? fmtMbps(sp.bandwidthMbps) : null],
    ['月流量', sp.trafficTB ? `${sp.trafficTB} TB` : null],
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
      <section class="live">${liveBlock(s, st)}</section>
      <section>
        <div class="charts">
          <div class="chart"><label>Hub 延迟</label><canvas data-chart="hubRtt"></canvas></div>
          <div class="chart"><label>CPU / 内存</label><canvas data-chart="cpu"></canvas></div>
          <div class="chart"><label>网络 ↓↑</label><canvas data-chart="net"></canvas></div>
        </div>
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
        <h4>Agent 安装 <span class="hint">在该 VPS 上以 root 执行</span></h4>
        ${s.demo ? '<p class="hint">演示服务器的数据为模拟生成，无需安装。</p>' : `
        <pre class="cmd">${esc(cmd)}</pre>
        <div class="row-actions">
          <button class="btn xs" data-act="copy" data-text="${esc(cmd)}">复制命令</button>
          <button class="btn xs" data-act="rotate-token">重置 Token</button>
        </div>
        <p class="hint">Agent 每 10 秒上报 CPU/内存/磁盘/网速，每 60 秒 ping 其它服务器生成互联延迟。Hub 地址可在 ⚙ 设置中修改（需能被 VPS 访问）。</p>`}
      </section>
    </div>`;
}

function liveBlock(s, st) {
  const ag = st?.agent;
  const key = statusKey(st);
  const cells = [
    ['状态', `<span class="st ${key}">${STATUS_TEXT[key]}</span>`],
    ['Hub 延迟', `<span style="color:${latencyColor(st?.hubRtt)}">${fmtMs(st?.hubRtt)}</span>`],
    ['CPU', meter(ag?.cpu)],
    ['内存', meter(ag?.mem)],
    ['磁盘', meter(ag?.disk)],
    ['负载', ag?.load1 ?? '—'],
    ['下行 ↓', fmtBps(ag?.rxBps)],
    ['上行 ↑', fmtBps(ag?.txBps)],
    ['运行', fmtUptime(ag?.uptimeSec)],
  ];
  return `
    <div class="metrics">${cells.map(([k, v]) => `<div class="metric"><label>${k}</label><div>${v}</div></div>`).join('')}</div>
    <div class="hint">Agent：${ag ? `${fmtAgo(st.lastSeen)} · ${esc(ag.hostname || '')} ${esc(ag.kernel || '')}` : '未安装或未上报'} · 探测端口 ${s.probePort || 22}：${fmtAgo(st?.lastProbe)}</div>`;
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
    ['吞吐', m?.mbps != null ? fmtMbps(m.mbps) : link?.bandwidthMbps ? `${fmtMbps(link.bandwidthMbps)}（标称）` : '—'],
  ];
  return `<div class="metrics four">${cells.map(([k, v]) => `<div class="metric"><label>${k}</label><div>${v}</div></div>`).join('')}</div>
    <div class="hint">${m ? `更新于 ${fmtAgo(m.ts)}` : '两端都安装 Agent 后会自动测量；当前颜色/数值为按距离估算。'}</div>`;
}

function drawLinkChart(key) {
  const c = $('#detail [data-chart=link]');
  if (!c) return;
  const arr = linkHistory.get(key) || [];
  sparkline(c, arr.map((p) => p.rtt), { color: '#38bdf8' });
}
