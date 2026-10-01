// 「流量与历史」弹窗：任意时间段的流量用量（按小时 / 天的柱状图）、计费周期累计曲线与历史周期、
// 以及 CPU / 内存 / 磁盘 / 负载 / 网速 / 延迟的历史曲线。数据来自 Hub 的 /metrics 与 /cycles。
import { store, serverById, statusOf } from '../state.js';
import { api } from '../api.js';
import { openModal, $, $$, toast } from './dom.js';
import { timeChart } from './chart.js';
import { fmtBytes, fmtBps, fmtPct, fmtMs, fmtDT, fmtDuration, tzLabel } from '../format.js';
import { TRAFFIC_MODE_OPTS } from './settings.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = () => -new Date().getTimezoneOffset();
const MODE = Object.fromEntries(TRAFFIC_MODE_OPTS);
const C = { rx: '#34d399', tx: '#fbbf24', cpu: '#a78bfa', mem: '#f472b6', disk: '#38bdf8', load: '#fb923c', rtt: '#5eead4', limit: '#fb7185', used: '#38bdf8' };

export const usedBy = (rx, tx, mode) => (mode === 'out' ? tx : mode === 'in' ? rx : mode === 'max' ? Math.max(rx, tx) : rx + tx);

/** 按时间跨度选粒度：图表点数控制在几百以内 */
const metricStep = (span) => (span <= 2 * DAY ? 300 : span <= 45 * DAY ? 3600 : 86400);
const trafficStep = (span) => (span <= 8 * DAY ? 3600 : 86400);

function xFmt(step, span) {
  if (step >= 86400 || span > 3 * DAY) return (t) => fmtDT(t, { time: false });
  if (span <= DAY + HOUR) return (t) => fmtDT(t).split(' ')[1];
  return (t) => fmtDT(t);
}
const tipX = (step) => (t) => (step >= 86400 ? fmtDT(t, { time: false, year: true }) : `${fmtDT(t)} – ${fmtDT(t + step * 1000).split(' ')[1]}`);

export function metricsUrl(id, from, to, step) {
  return `/api/servers/${id}/metrics?from=${Math.round(from)}&to=${Math.round(to)}&step=${step}&tz=${TZ()}`;
}

/**
 * 周期累计曲线：已用（实线）+ 按当前速度外推到周期末（虚线）+ 额度参考线。
 * 详情面板和弹窗共用。cycle 来自 /cycles。
 */
export async function drawCycleChart(wrap, srvId, cycle, mode, { compact = false } = {}) {
  const now = Date.now();
  const end = cycle.end || now;
  const span = end - cycle.start;
  const step = span > 3 * DAY ? 86400 : 3600;
  const r = await api('GET', metricsUrl(srvId, cycle.start, Math.min(now, end), step));
  // 补上周期剩余部分的空桶，横轴覆盖整个周期
  const t = [...r.t];
  const stepMs = step * 1000;
  while (t.length && t[t.length - 1] + stepMs < end) t.push(t[t.length - 1] + stepMs);
  let crx = 0;
  let ctx = 0;
  // 手动校准的部分（周期已用 − 历史桶合计）放在起点，曲线终点才和「本周期已用」对得上
  const offset = Math.max(0, cycle.used - usedBy(r.rx.reduce((a, v) => a + (v || 0), 0), r.tx.reduce((a, v) => a + (v || 0), 0), mode));
  const used = [];
  for (let i = 0; i < t.length; i++) {
    if (i < r.t.length) {
      crx += r.rx[i] || 0;
      ctx += r.tx[i] || 0;
      used.push(usedBy(crx, ctx, mode) + offset);
    } else used.push(null);
  }
  const last = r.t.length - 1;
  const proj = t.map(() => null);
  const elapsed = now - cycle.start;
  if (cycle.end && elapsed > 6 * HOUR && last >= 0 && last < t.length - 1) {
    const rate = cycle.used / elapsed;
    for (let i = last; i < t.length; i++) proj[i] = i === last ? used[last] : rate * (Math.min(end, t[i] + stepMs) - cycle.start);
  }
  timeChart(wrap, {
    t,
    xFmt: (x) => fmtDT(x, { time: step < 86400 }),
    tipXFmt: (x) => (step >= 86400 ? fmtDT(x, { time: false, year: true }) + ' 结束时' : fmtDT(x + stepMs)),
    yFmt: (v) => fmtBytes(v).replace(/\.0+ /, ' '),
    series: [
      { name: '已用', values: used, color: C.used, type: 'area', fmt: fmtBytes },
      { name: '按当前速度预计', values: proj, color: '#94a3b8', type: 'line', dash: [4, 4], fmt: fmtBytes },
    ],
    refs: cycle.limit ? [{ value: cycle.limit, color: C.limit, label: compact ? '' : `额度 ${fmtBytes(cycle.limit)}` }] : [],
  });
}

export async function openHistory(id, { range = 'cycle' } = {}) {
  const s = serverById(id);
  if (!s) return;
  const m = openModal({
    title: `流量与历史：${s.name}`,
    wide: 'xl',
    content: `
      <div class="hist">
        <div class="hist-bar">
          <div class="seg" data-range>
            ${[['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天'], ['cycle', '本周期'], ['prev', '上个周期'], ['custom', '自定义']].map(([k, t]) => `<button type="button" data-r="${k}">${t}</button>`).join('')}
          </div>
          <div class="custom hidden" data-custom>
            <input class="input sm" type="datetime-local" data-from /> <span class="muted">—</span>
            <input class="input sm" type="datetime-local" data-to />
            <button type="button" class="btn sm primary" data-apply>查看</button>
          </div>
          <span class="hint" data-range-label></span>
        </div>
        <div class="hist-cards" data-cards></div>
        <section>
          <h4>流量 <span class="hint" data-traffic-hint></span><span class="legend"><i style="background:${C.rx}"></i>入站 ↓ <i style="background:${C.tx}"></i>出站 ↑</span></h4>
          <div class="tchart tall" data-c="traffic"></div>
        </section>
        <div class="hist-grid2">
          <section>
            <h4>本计费周期 <span class="hint" data-cycle-hint></span></h4>
            <div class="tchart" data-c="cycle"></div>
          </section>
          <section>
            <h4>历史周期 <span class="hint">点一行查看那个周期</span></h4>
            <div class="cycles" data-cycles><div class="loading-inline"><div class="spinner sm"></div>加载中…</div></div>
          </section>
        </div>
        <h4>资源与网络 <span class="hint" data-metric-hint></span></h4>
        <div class="hist-grid2">
          <section><h5>网速 <span class="legend"><i style="background:${C.rx}"></i>↓ 平均 <i style="background:${C.tx}"></i>↑ 平均 <i class="dash" style="border-color:${C.rx}"></i>峰值</span></h5><div class="tchart" data-c="net"></div></section>
          <section><h5>CPU <span class="legend"><i style="background:${C.cpu}"></i>平均 <i class="dash" style="border-color:${C.cpu}"></i>峰值</span></h5><div class="tchart" data-c="cpu"></div></section>
          <section><h5>内存 <span class="legend"><i style="background:${C.mem}"></i>平均 <i class="dash" style="border-color:${C.mem}"></i>峰值</span></h5><div class="tchart" data-c="mem"></div></section>
          <section><h5>磁盘已用</h5><div class="tchart" data-c="disk"></div></section>
          <section><h5>负载 / TCP 连接</h5><div class="tchart" data-c="load"></div></section>
          <section><h5>Hub 延迟 <span class="legend"><i style="background:${C.rtt}"></i>延迟 <i style="background:${C.limit}"></i>不在线比例</span></h5><div class="tchart" data-c="rtt"></div></section>
        </div>
      </div>`,
  });
  const root = m.el;
  const wrap = (k) => $(`[data-c=${k}]`, root);
  let cycles = null;
  let mode = statusOf(id)?.traffic?.mode || store.settings.probe?.traffic?.mode || 'sum';
  let cur = { range };

  const toLocalInput = (ts) => {
    const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
  };

  function bounds(r) {
    const now = Date.now();
    if (r === '24h') return [now - DAY, now];
    if (r === '7d') return [now - 7 * DAY, now];
    if (r === '30d') return [now - 30 * DAY, now];
    const cs = cycles?.cycles || [];
    if (r === 'cycle' && cs[0]) return [cs[0].start, now];
    if (r === 'prev' && cs[1]) return [cs[1].start, cs[1].end];
    if (r.startsWith('c:')) {
      const c = cs.find((x) => String(x.start) === r.slice(2));
      if (c) return [c.start, Math.min(now, c.end || now)];
    }
    if (r === 'custom' && cur.from) return [cur.from, cur.to];
    return [now - DAY, now];
  }

  async function loadCycles() {
    cycles = await api('GET', `/api/servers/${id}/cycles?n=12`);
    mode = cycles.mode;
    const def = cycles.def;
    const c0 = cycles.cycles[0];
    const typeText = def.type === 'none' ? '不重置' : def.type === 'days' ? `每 ${def.days} 天重置` : '每月重置';
    $('[data-cycle-hint]', root).textContent = c0
      ? `${fmtDT(c0.start, { tz: def.tz })} → ${c0.end ? fmtDT(c0.end, { tz: def.tz }) : '不重置'}（${tzLabel(def.tz)}）· ${typeText}${def.inherit ? '（全局设置）' : ''} · ${MODE[mode]}`
      : '';
    $('[data-cycles]', root).innerHTML = cycles.cycles.length
      ? `<table class="table cyc"><thead><tr><th>周期</th><th>已用</th><th>额度</th><th></th><th>覆盖</th></tr></thead><tbody>${cycles.cycles
          .map((c) => {
            const pct = c.pct;
            const col = pct == null ? 'var(--accent)' : pct >= 100 ? 'var(--lat-bad)' : pct >= 80 ? 'var(--lat-warn)' : 'var(--accent)';
            return `<tr data-cyc="${c.start}" class="${cur.range === 'c:' + c.start || (c.current && cur.range === 'cycle') ? 'on' : ''}">
              <td>${fmtDT(c.start, { tz: def.tz, time: false })} – ${c.end ? fmtDT(c.end, { tz: def.tz, time: false }) : '至今'}${c.current ? ' <span class="pill">当前</span>' : ''}${c.partial ? ' <span class="muted" title="这个周期开始时还没有数据">部分</span>' : ''}</td>
              <td class="mono">${fmtBytes(c.used)}</td>
              <td class="mono muted">${c.limit ? fmtBytes(c.limit) : '—'}</td>
              <td style="width:28%">${c.limit ? `<div class="tbar"><i style="width:${Math.min(100, pct)}%;background:${col}"></i></div><span class="mono" style="color:${col}">${pct}%</span>` : ''}</td>
              <td class="mono muted" title="有效采样时长占比">${fmtPct(c.coverage)}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : '<p class="hint">还没有流量数据。</p>';
    if (c0) await drawCycleChart(wrap('cycle'), id, c0, mode);
  }

  async function load() {
    const [from, to] = bounds(cur.range);
    const span = to - from;
    $$('[data-range] button', root).forEach((b) => b.classList.toggle('on', b.dataset.r === cur.range));
    $('[data-custom]', root).classList.toggle('hidden', cur.range !== 'custom');
    $('[data-range-label]', root).textContent = `${fmtDT(from, { year: true })} → ${fmtDT(to, { year: true })}（${fmtDuration(span)}）`;
    $$('[data-cyc]', root).forEach((tr) => tr.classList.toggle('on', cur.range === 'c:' + tr.dataset.cyc));
    const ms = metricStep(span);
    const ts = trafficStep(span);
    let met;
    let tr;
    try {
      [met, tr] = await Promise.all([api('GET', metricsUrl(id, from, to, ms)), ms === ts ? null : api('GET', metricsUrl(id, from, to, ts))]);
    } catch (e) {
      return toast(e.message, 'error');
    }
    tr ||= met;
    if (!document.body.contains(root)) return;

    // ---- 汇总卡片 ----
    const sum = (a) => a.reduce((x, v) => x + (v || 0), 0);
    const rx = sum(tr.rx);
    const tx = sum(tr.tx);
    const used = usedBy(rx, tx, mode);
    let peak = -1;
    tr.t.forEach((_, i) => {
      if (peak < 0 || (tr.rx[i] || 0) + (tr.tx[i] || 0) > (tr.rx[peak] || 0) + (tr.tx[peak] || 0)) peak = i;
    });
    const covSec = sum(tr.cov);
    const dailyAvg = covSec >= 3600 ? (used / covSec) * 86400 : null;
    const avgOf = (a) => {
      const v = a.filter((x) => x != null);
      return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
    };
    const maxOf = (a) => {
      const v = a.filter((x) => x != null);
      return v.length ? Math.max(...v) : null;
    };
    const card = (k, v, sub = '') => `<div class="metric"><label>${k}</label><div>${v}</div>${sub ? `<small>${sub}</small>` : ''}</div>`;
    $('[data-cards]', root).innerHTML = [
      card(`用量（${MODE[mode]}）`, fmtBytes(used), `↓ ${fmtBytes(rx)} · ↑ ${fmtBytes(tx)}`),
      card('有效时段日均', dailyAvg == null ? '—' : fmtBytes(dailyAvg), '按有采样的时长折算'),
      card('最高时段', peak >= 0 && (tr.rx[peak] || tr.tx[peak]) ? fmtBytes((tr.rx[peak] || 0) + (tr.tx[peak] || 0)) : '—', peak >= 0 ? tipX(tr.step)(tr.t[peak]) : ''),
      card('采样覆盖', fmtPct(Math.min(100, (covSec / (span / 1000)) * 100)), '空缺不算作 0'),
      card('CPU 平均 / 峰值', `${fmtPct(avgOf(met.cpu))} / ${fmtPct(maxOf(met.cpuMax))}`),
      card('内存 平均 / 峰值', `${fmtPct(avgOf(met.mem))} / ${fmtPct(maxOf(met.memMax))}`),
      card('在线率', fmtPct(avgOf(met.online)), `Hub 平均延迟 ${fmtMs(avgOf(met.rtt))}`),
    ].join('');
    $('[data-traffic-hint]', root).textContent = `每${tr.step >= 86400 ? '天' : '小时'}的收发量 · 由累计计数的增量按时长分摊`;
    $('[data-metric-hint]', root).textContent = `每 ${met.step >= 86400 ? '天' : met.step >= 3600 ? '小时' : '5 分钟'} 一个点`;

    // ---- 图表 ----
    const pctFmt = (v) => `${Math.round(v)}%`;
    timeChart(wrap('traffic'), {
      t: tr.t,
      xFmt: xFmt(tr.step, span),
      tipXFmt: tipX(tr.step),
      yFmt: (v) => fmtBytes(v).replace(/\.0+ /, ' '),
      series: [
        { name: '入站 ↓', values: tr.rx, color: C.rx, type: 'bar', stack: 'b', fmt: fmtBytes },
        { name: '出站 ↑', values: tr.tx, color: C.tx, type: 'bar', stack: 'b', fmt: fmtBytes },
      ],
      tipExtra: (i) => `<div class="sum">合计<b>${fmtBytes((tr.rx[i] || 0) + (tr.tx[i] || 0))}</b></div>${tr.cov[i] != null && tr.step ? `<div class="sum">采样覆盖<b>${fmtPct(Math.min(100, (tr.cov[i] / tr.step) * 100))}</b></div>` : ''}`,
    });
    const X = xFmt(met.step, span);
    const TX = tipX(met.step);
    timeChart(wrap('net'), {
      t: met.t, xFmt: X, tipXFmt: TX, yFmt: fmtBps,
      series: [
        { name: '↓ 平均', values: met.rxRate, color: C.rx, type: 'area' },
        { name: '↑ 平均', values: met.txRate, color: C.tx, type: 'line' },
        { name: '↓ 峰值', values: met.rxMax, color: C.rx, type: 'line', dash: [3, 3], width: 1 },
        { name: '↑ 峰值', values: met.txMax, color: C.tx, type: 'line', dash: [3, 3], width: 1 },
      ],
    });
    timeChart(wrap('cpu'), {
      t: met.t, xFmt: X, tipXFmt: TX, yFmt: pctFmt, yMax: 100,
      series: [
        { name: '平均', values: met.cpu, color: C.cpu, type: 'area' },
        { name: '峰值', values: met.cpuMax, color: C.cpu, type: 'line', dash: [3, 3], width: 1 },
      ],
    });
    timeChart(wrap('mem'), {
      t: met.t, xFmt: X, tipXFmt: TX, yFmt: pctFmt, yMax: 100,
      series: [
        { name: '平均', values: met.mem, color: C.mem, type: 'area' },
        { name: '峰值', values: met.memMax, color: C.mem, type: 'line', dash: [3, 3], width: 1 },
      ],
    });
    timeChart(wrap('disk'), { t: met.t, xFmt: X, tipXFmt: TX, yFmt: pctFmt, yMax: 100, series: [{ name: '已用', values: met.disk, color: C.disk, type: 'area' }] });
    const maxConns = Math.max(1, ...met.conns.filter((v) => v != null));
    const maxLoad = Math.max(0.5, ...met.load.filter((v) => v != null));
    timeChart(wrap('load'), {
      t: met.t, xFmt: X, tipXFmt: TX, yFmt: (v) => v.toFixed(v < 10 ? 1 : 0),
      series: [
        { name: '负载', values: met.load, color: C.load, type: 'area', fmt: (v) => v.toFixed(2) },
        // 连接数缩放到负载的坐标里显示，提示框里显示原值
        { name: 'TCP 连接', values: met.conns.map((v) => (v == null ? null : (v / maxConns) * maxLoad)), color: '#94a3b8', type: 'line', width: 1, fmt: (v) => Math.round((v / maxLoad) * maxConns) },
      ],
    });
    timeChart(wrap('rtt'), {
      t: met.t, xFmt: X, tipXFmt: TX, yFmt: (v) => `${Math.round(v)}`,
      series: [
        { name: '延迟', values: met.rtt, color: C.rtt, type: 'area', fmt: fmtMs },
        { name: '不在线比例', values: met.online.map((v) => (v == null || v >= 100 ? null : ((100 - v) / 100) * Math.max(10, ...met.rtt.filter((x) => x != null)))), color: C.limit, type: 'bar', noTip: true },
      ],
      tipExtra: (i) => `<div class="sum">在线率<b>${fmtPct(met.online[i])}</b></div>`,
    });
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (b) {
      cur.range = b.dataset.r;
      if (cur.range === 'custom' && !cur.from) {
        const [f, t] = bounds('7d');
        $('[data-from]', root).value = toLocalInput(f);
        $('[data-to]', root).value = toLocalInput(t);
        cur.from = f;
        cur.to = t;
      }
      return load();
    }
    if (e.target.closest('[data-apply]')) {
      const f = new Date($('[data-from]', root).value).getTime();
      const t = new Date($('[data-to]', root).value).getTime();
      if (!(t > f)) return toast('结束时间要晚于开始时间', 'warn');
      if (Date.now() - f > 400 * DAY) return toast('最多保留 400 天的历史', 'warn');
      Object.assign(cur, { range: 'custom', from: f, to: Math.min(t, Date.now()) });
      return load();
    }
    const row = e.target.closest('[data-cyc]');
    if (row) {
      const c = cycles.cycles.find((x) => String(x.start) === row.dataset.cyc);
      cur.range = c?.current ? 'cycle' : `c:${row.dataset.cyc}`;
      return load();
    }
  });

  try {
    await loadCycles();
  } catch (e) {
    toast(e.message, 'error');
  }
  if (cur.range === 'prev' && !cycles?.cycles[1]) cur.range = '30d';
  await load();
}
