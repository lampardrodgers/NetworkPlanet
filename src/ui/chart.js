// 轻量 canvas 时间序列图：坐标轴、折线 / 面积 / 堆叠柱、参考线（如流量额度）、悬停提示。
// 数据是列式的：t[] 为每个桶的起点，series[].values[] 与之对齐，null 表示缺数据（折线断开）。
//
// timeChart(wrap, {
//   t, xFmt, tipXFmt, yFmt, yMax, yMin,
//   series: [{ name, values, color, type: 'line' | 'area' | 'bar', stack, dash, fmt }],
//   refs: [{ value, color, label }],
// })
// wrap 是一个 .tchart 容器，里面放 canvas 和提示框；重复调用会原地重画。

const PAD = { l: 60, r: 10, t: 8, b: 20 };

export function timeChart(wrap, opts) {
  let canvas = wrap.querySelector('canvas');
  if (!canvas) {
    wrap.innerHTML = '<canvas></canvas><div class="tchart-tip hidden"></div>';
    canvas = wrap.querySelector('canvas');
    canvas.addEventListener('mousemove', (e) => {
      const st = canvas._st;
      if (!st) return;
      const r = canvas.getBoundingClientRect();
      const i = Math.floor(((e.clientX - r.left - PAD.l) / st.pw) * st.n);
      if (i === st.hover) return;
      st.hover = i >= 0 && i < st.n ? i : -1;
      draw(canvas, st);
      tip(wrap, st, e.clientX - r.left);
    });
    canvas.addEventListener('mouseleave', () => {
      const st = canvas._st;
      if (!st) return;
      st.hover = -1;
      draw(canvas, st);
      wrap.querySelector('.tchart-tip').classList.add('hidden');
    });
  }
  canvas._st = { ...opts, n: opts.t.length, hover: -1 };
  draw(canvas, canvas._st);
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function draw(canvas, st) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const { t, series, refs = [], n } = st;
  const pw = (st.pw = w - PAD.l - PAD.r);
  const ph = h - PAD.t - PAD.b;
  g.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';

  // y 轴范围：堆叠柱按每个桶的合计
  let hi = 0;
  const stacks = {};
  for (const s of series) {
    s.values.forEach((v, i) => {
      if (v == null) return;
      if (s.stack) {
        const k = `${s.stack}|${i}`;
        stacks[k] = (stacks[k] || 0) + v;
        hi = Math.max(hi, stacks[k]);
      } else hi = Math.max(hi, v);
    });
  }
  for (const r of refs) if (r.value != null) hi = Math.max(hi, r.value);
  const yMax = st.yMax ?? niceMax(hi * 1.08);
  const yMin = st.yMin ?? 0;
  const X = (i) => PAD.l + ((i + 0.5) / n) * pw;
  const Y = (v) => PAD.t + ph - ((v - yMin) / (yMax - yMin || 1)) * ph;
  const yFmt = st.yFmt || ((v) => String(Math.round(v)));

  // 网格与 y 轴刻度
  g.strokeStyle = 'rgba(148,163,184,.12)';
  g.fillStyle = 'rgba(159,179,204,.75)';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const v = yMin + ((yMax - yMin) * k) / 4;
    const y = Math.round(Y(v)) + 0.5;
    g.beginPath();
    g.moveTo(PAD.l, y);
    g.lineTo(w - PAD.r, y);
    g.stroke();
    g.fillText(yFmt(v), PAD.l - 6, y);
  }
  // x 轴标签：大约每 70px 一个
  g.textAlign = 'center';
  g.textBaseline = 'top';
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 70))));
  for (let i = 0; i < n; i += every) g.fillText(st.xFmt(t[i]), X(i), h - PAD.b + 5);

  if (!series.some((s) => s.values.some((v) => v != null))) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('这段时间没有数据', PAD.l + pw / 2, PAD.t + ph / 2);
    return;
  }

  // 悬停列高亮
  if (st.hover >= 0) {
    g.fillStyle = 'rgba(56,189,248,.08)';
    g.fillRect(PAD.l + (st.hover / n) * pw, PAD.t, pw / n, ph);
  }

  // 柱
  const bw = Math.max(1, (pw / n) * 0.72);
  const base = {};
  for (const s of series) {
    if (s.type !== 'bar') continue;
    g.fillStyle = s.color;
    s.values.forEach((v, i) => {
      if (v == null || v <= 0) return;
      const k = `${s.stack || s.name}|${i}`;
      const b0 = base[k] || 0;
      const y1 = Y(b0 + v);
      g.fillRect(X(i) - bw / 2, y1, bw, Y(b0) - y1);
      base[k] = b0 + v;
    });
  }
  // 线 / 面积
  for (const s of series) {
    if (s.type === 'bar') continue;
    const segs = [];
    let cur = null;
    s.values.forEach((v, i) => {
      if (v == null) return (cur = null);
      if (!cur) segs.push((cur = []));
      cur.push([X(i), Y(v)]);
    });
    for (const seg of segs) {
      if (seg.length === 1) {
        g.fillStyle = s.color;
        g.fillRect(seg[0][0] - 1.5, seg[0][1] - 1.5, 3, 3);
        continue;
      }
      g.beginPath();
      seg.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.setLineDash(s.dash || []);
      g.strokeStyle = s.color;
      g.lineWidth = s.width || 1.5;
      g.stroke();
      g.setLineDash([]);
      if (s.type === 'area') {
        g.lineTo(seg[seg.length - 1][0], Y(yMin));
        g.lineTo(seg[0][0], Y(yMin));
        g.closePath();
        const grd = g.createLinearGradient(0, PAD.t, 0, PAD.t + ph);
        grd.addColorStop(0, s.color + '44');
        grd.addColorStop(1, s.color + '00');
        g.fillStyle = grd;
        g.fill();
      }
    }
  }
  // 参考线
  for (const r of refs) {
    if (r.value == null || r.value > yMax) continue;
    const y = Math.round(Y(r.value)) + 0.5;
    g.setLineDash([5, 4]);
    g.strokeStyle = r.color;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD.l, y);
    g.lineTo(w - PAD.r, y);
    g.stroke();
    g.setLineDash([]);
    if (r.label) {
      g.fillStyle = r.color;
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText(r.label, PAD.l + 4, y - 2);
    }
  }
}

function tip(wrap, st, mx) {
  const el = wrap.querySelector('.tchart-tip');
  const i = st.hover;
  if (i < 0) return el.classList.add('hidden');
  const rows = st.series
    .filter((s) => !s.noTip)
    .map((s) => {
      const v = s.values[i];
      return `<div><i style="background:${s.color}"></i>${s.name}<b>${v == null ? '—' : (s.fmt || st.yFmt || String)(v)}</b></div>`;
    })
    .join('');
  el.innerHTML = `<div class="tt">${(st.tipXFmt || st.xFmt)(st.t[i], i)}</div>${rows}${st.tipExtra ? st.tipExtra(i) : ''}`;
  el.classList.remove('hidden');
  const w = wrap.clientWidth;
  const left = mx + 14 + el.offsetWidth > w ? mx - 14 - el.offsetWidth : mx + 14;
  el.style.left = `${Math.max(0, left)}px`;
}
