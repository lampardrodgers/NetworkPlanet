// 平面视图：点阵世界地图 + 弧线连线，纯 canvas 2D。
//  - 等距圆柱投影，经度方向无限循环（拖到日期变更线另一侧也连续），初次加载自动选一个让所有服务器最紧凑的中心经度
//  - 陆地用点阵表示，点的间距按缩放级别切换，屏幕上始终约 8px；服务器附近的点被染成该服务器的颜色，夜半球的点更暗（晨昏线）
//  - 屏幕上靠得太近的服务器合并成一个节点；点击后拉近，拉不开（同机房）时就在屏幕上环形展开
//  - 连线是向上拱起的二次贝塞尔曲线：颜色 = 实测延迟，流动点的速度 ∝ 延迟，光点数量 ∝ 吞吐；中点放「标签 · 延迟」胶囊
//  - 标签按优先级贪心避让，放不下的就不画
//  - 锁定模式（setLocked）：只有一份世界地图、不再左右循环。仍可拖动 / 缩放，但左右边缘就是极限，
//    最小缩放 = 整张图刚好铺满面板之间；跨接缝的连线在左右边缘裁开
//  - 线路模式（setRouteView）：从一个起点扇出到每台 VPS，经中转的线路按段画，建议的中转用虚线
// 底图点阵缓存在离屏 canvas 里，只在视角 / 数据变化时重画；每帧只画连线、节点和标签。
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import countries from 'world-atlas/countries-50m.json';
import { cityName } from '../state.js';
import { STATUS_COLORS, statusKey, latencyColor, LAT_COLORS, fmtMs, fmtMbps, providerColor } from '../format.js';

const MASK_W = 4096;
const MASK_H = 2048;
const K_MAX = 120; // 每度最多 120px，再大陆地掩膜就糊了
const CLUSTER_PX = 16;
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

let MASK = null;
function landMask() {
  if (MASK) return MASK;
  const c = document.createElement('canvas');
  c.width = MASK_W;
  c.height = MASK_H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const proj = geoEquirectangular()
    .scale(MASK_W / (2 * Math.PI))
    .translate([MASK_W / 2, MASK_H / 2]);
  g.beginPath();
  geoPath(proj, g)(feature(countries, countries.objects.land));
  g.fillStyle = '#fff';
  g.fill();
  const d = g.getImageData(0, 0, MASK_W, MASK_H).data;
  MASK = new Uint8Array(MASK_W * MASK_H);
  for (let i = 0; i < MASK.length; i++) MASK[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return MASK;
}

function isLand(lon, lat) {
  const y = Math.floor(((90 - lat) / 180) * MASK_H);
  if (y < 0 || y >= MASK_H) return false;
  const x = Math.floor(((((lon + 180) / 360) % 1) + 1) % 1 * MASK_W);
  return MASK[y * MASK_W + x] === 1;
}

/** 太阳直射点（近似，足够画晨昏线） */
function subsolar(ts) {
  const d = new Date(ts);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const day = (ts - start) / 86_400_000;
  const dec = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10));
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60;
  return { lat: dec, lon: (12 - hours) * 15 };
}

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export class FlatMap {
  /**
   * handlers: { onSelect(hit|null), onHover(hit|null, event), onPickLocation({lat,lon}), isPicking() }
   */
  constructor(container, handlers) {
    this.container = container;
    this.h = handlers;
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.base = document.createElement('canvas'); // 点阵底图缓存
    this.v = { lon: 110, lat: 25, k: 4 };
    this.servers = [];
    this.statusMap = {};
    this.edges = [];
    this.selection = null;
    this.hover = null;
    this.showLabels = true;
    this.showLinkLabels = false;
    this.expanded = null; // 被手动展开的节点 key
    this.locked = false;
    this.worldCenter = 110; // 锁定时世界地图的中心经度
    this.rv = null; // 线路模式：{ origin, segments, info: Map(serverId → { text, color }) }
    this.active = false;
    this.dirty = true;
    this.fitted = false;
    this.time = 0;
    this.textW = new Map();
    this.hits = { nodes: [], labels: [], arcs: [] };
    this.flight = null;
    this.bind();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------- 生命周期 ----------------
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.container.classList.toggle('hidden', !on);
    if (!on) return cancelAnimationFrame(this.raf);
    landMask();
    this.resize();
    if (!this.fitted && this.servers.length) this.fitAll(false);
    let last = performance.now();
    const loop = (now) => {
      this.time += clamp((now - last) / 1000, 0, 0.1); // rAF 的时间戳可能比 setActive 时的 performance.now() 还早
      last = now;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  resize() {
    if (!this.active) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = this.container.clientWidth;
    this.H = this.container.clientHeight;
    this.dpr = dpr;
    for (const c of [this.canvas, this.base]) {
      c.width = this.W * dpr;
      c.height = this.H * dpr;
    }
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.v.k = clamp(this.v.k, this.kMin(), K_MAX);
    this.dirty = true;
    if (this.locked) this.v = this.clampView({ ...this.v });
  }

  setLocked(on) {
    if (on === this.locked) return;
    this.locked = on;
    this.expanded = null;
    this.dirty = true;
    if (!this.active) return;
    if (on) this.fitWorld({ around: this.rv?.origin?.lon ?? null });
    else this.v = this.clampView({ ...this.v });
  }

  /** 锁定时世界地图在屏幕上的左右边界 */
  worldX() {
    const x0 = this.W / 2 + (this.worldCenter - 180 - this.v.lon) * this.v.k;
    return [x0, x0 + 360 * this.v.k];
  }

  /** 整张世界地图（北纬 82° ~ 南纬 58°）刚好放进未被面板遮挡区域时的缩放 */
  worldK() {
    const ins = this.insets();
    return Math.min(Math.max(200, this.W - ins.l - ins.r) / 360, Math.max(160, this.H - ins.t - ins.b) / 140);
  }

  kMin() {
    // 锁定时最多缩到整张图刚好铺满；不锁定时可以再缩一点，看到循环的接缝
    return this.worldK() * (this.locked ? 1 : 0.85);
  }

  // ---------------- 数据 ----------------
  setData(servers, statusMap) {
    this.servers = servers.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    this.statusMap = statusMap || {};
    this.dirty = true;
    if (this.active && !this.fitted && this.servers.length) this.fitAll(false);
  }

  refreshStatus(statusMap) {
    this.statusMap = statusMap || {};
    this.dirty = true;
  }

  setEdges(edges) {
    this.edges = edges;
  }

  setRouteView(rv) {
    const changed = Boolean(rv) !== Boolean(this.rv) || rv?.origin?.key !== this.rv?.origin?.key;
    this.rv = rv;
    if (changed) this.dirty = true;
  }

  setSelection(sel) {
    this.selection = sel;
    if (!sel) this.expanded = null;
  }

  colorOf(srv) {
    const st = statusKey(this.statusMap[srv.id]);
    return st === 'offline' ? STATUS_COLORS.offline : st === 'unknown' ? STATUS_COLORS.unknown : providerColor(srv.provider);
  }

  // ---------------- 坐标 ----------------
  /** 经度展开到离视图中心最近的那一份 */
  unwrap(lon) {
    // 锁定时以世界地图中心为准，保证每台都落在地图范围内
    const c = this.locked ? this.worldCenter : this.v.lon;
    return lon - Math.round((lon - c) / 360) * 360;
  }
  toScreen(lon, lat) {
    return { x: this.W / 2 + (this.unwrap(lon) - this.v.lon) * this.v.k, y: this.H / 2 - (lat - this.v.lat) * this.v.k };
  }
  latLonAt(x, y) {
    let lon = this.v.lon + (x - this.W / 2) / this.v.k;
    const lat = this.v.lat - (y - this.H / 2) / this.v.k;
    if (Math.abs(lat) > 90) return null;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    return { lat, lon };
  }
  clampView(v) {
    v.k = clamp(v.k, this.kMin(), K_MAX);
    const half = this.H / 2 / v.k;
    v.lat = half >= 85 ? 0 : clamp(v.lat, -85 + half, 85 - half);
    if (this.locked) {
      // 左右极限：世界地图的边缘不能拉进面板之间的可视区域；图比可视区域窄时居中
      const ins = this.insets();
      const aw = this.W - ins.l - ins.r;
      const lo = this.worldCenter - 180 + (this.W / 2 - ins.l) / v.k; // 世界左边缘贴着可视区左边时的中心
      const hi = this.worldCenter + 180 - (this.W - ins.r - this.W / 2) / v.k;
      v.lon = 360 * v.k <= aw ? (lo + hi) / 2 : clamp(v.lon, lo, hi);
      return v;
    }
    v.lon = ((((v.lon + 180) % 360) + 360) % 360) - 180;
    return v;
  }

  /** 面板遮住的区域：左侧服务器列表、右侧详情、顶栏和底部视图条 */
  insets() {
    const side = document.querySelector('#sidebar');
    const l = side && !side.classList.contains('collapsed') ? side.getBoundingClientRect().right + 16 : 60;
    let r = 24;
    for (const el of document.querySelectorAll('#detail, #routepanel')) if (!el.classList.contains('hidden')) r = Math.max(r, this.W - el.getBoundingClientRect().left + 16);
    return { l: Math.min(l, this.W * 0.4), r: Math.min(r, this.W * 0.45), t: 84, b: 70 };
  }

  // ---------------- 视角 ----------------
  flyTo(target, duration = 750) {
    const to = this.clampView({ ...this.v, ...target });
    if (!this.active || !duration) {
      this.v = to;
      this.dirty = true;
      return;
    }
    // 经度走近路（锁定时只有一份世界，不能绕过去）
    const from = { ...this.v };
    if (!this.locked) to.lon = from.lon + ((((to.lon - from.lon + 180) % 360) + 360) % 360) - 180;
    this.flight = { from, to, t0: performance.now(), duration };
  }

  zoomBy(f, cx = this.W / 2, cy = this.H / 2, duration = 300) {
    const ll = { lon: this.v.lon + (cx - this.W / 2) / this.v.k, lat: this.v.lat - (cy - this.H / 2) / this.v.k };
    const k = clamp(this.v.k * f, this.kMin(), K_MAX);
    this.flyTo({ k, lon: ll.lon - (cx - this.W / 2) / k, lat: ll.lat + (cy - this.H / 2) / k }, duration);
  }

  /** 让一组经纬度点落在未被面板遮挡的区域里 */
  fit(points, { maxK = 28, animate = true, around = null } = {}) {
    if (!points.length) return;
    this.fitted = true;
    if (this.locked) around ??= this.worldCenter;
    if (around != null) {
      // 线路模式：以起点为中心展开经度，和弧线「走近路」的方向一致
      const un = points.map((p) => p.lon - Math.round((p.lon - around) / 360) * 360);
      return this.fitBox(Math.min(...un), Math.max(...un), points, maxK, animate);
    }
    // 找最大的经度空隙，从空隙之后开始展开，跨日期变更线的分布也能取到最紧凑的范围
    const lons = points.map((p) => ((p.lon % 360) + 360) % 360).sort((a, b) => a - b);
    let gap = -1;
    let at = 0;
    lons.forEach((l, i) => {
      const next = i === lons.length - 1 ? lons[0] + 360 : lons[i + 1];
      if (next - l > gap) {
        gap = next - l;
        at = (i + 1) % lons.length;
      }
    });
    const start = lons[at];
    const un = lons.map((l) => (l < start ? l + 360 : l));
    this.fitBox(Math.min(...un), Math.max(...un), points, maxK, animate);
  }

  fitBox(lo, hi, points, maxK, animate) {
    const lats = points.map((p) => p.lat);
    const la0 = Math.min(...lats);
    const la1 = Math.max(...lats);
    const ins = this.insets();
    const aw = Math.max(200, this.W - ins.l - ins.r);
    const ah = Math.max(160, this.H - ins.t - ins.b);
    // 留出标签和弧线拱起的空间
    const k = clamp(Math.min((aw * 0.78) / Math.max(hi - lo, 1), (ah * 0.62) / Math.max(la1 - la0, 1), maxK), this.kMin(), K_MAX);
    const cx = ins.l + aw / 2;
    const cy = ins.t + ah / 2 + ah * 0.06; // 弧线向上拱，整体稍微往下放
    this.flyTo({ k, lon: (lo + hi) / 2 - (cx - this.W / 2) / k, lat: (la0 + la1) / 2 + (cy - this.H / 2) / k }, animate ? 750 : 0);
  }

  /**
   * 显示整张世界地图。中心经度：给了 around（线路起点）就用它；
   * 否则选一条「接缝」经线（地图左右边缘），让被它切断的连线最少、离它近的服务器最少，中心 = 接缝 + 180°
   */
  fitWorld({ around = null, animate = true } = {}) {
    this.fitted = true;
    let lon = around ?? 110;
    if (around == null && this.servers.length) {
      const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
      const byId = new Map(this.servers.map((x) => [x.id, x]));
      let best = Infinity;
      for (let seam = -180; seam < 180; seam += 5) {
        let cost = 0;
        for (const e of this.edges) {
          const a = byId.get(e.a);
          const b = byId.get(e.b);
          if (!a || !b) continue;
          const ra = wrap(a.lon - seam);
          if (Math.abs(ra + wrap(b.lon - a.lon)) > 180 || Math.abs(ra) < 3) cost += 10;
        }
        for (const x of this.servers) {
          const d = Math.abs(wrap(x.lon - seam));
          if (d < 20) cost += (20 - d) / 4;
        }
        // 接缝尽量落在海上，别把大陆劈成两半
        let land = 0;
        for (let lat = -55; lat <= 72; lat += 3) if (isLand(seam, lat)) land++;
        cost += land * 1.5;
        // 同等情况下偏向常见的「亚太居中」视角
        cost += Math.abs(wrap(seam + 180 - 110)) / 1000;
        if (cost < best) {
          best = cost;
          lon = wrap(seam + 180);
        }
      }
    }
    const ins = this.insets();
    const k = this.worldK();
    const cx = ins.l + (this.W - ins.l - ins.r) / 2;
    const cy = ins.t + (this.H - ins.t - ins.b) / 2;
    this.worldCenter = lon;
    this.flyTo({ k, lon: lon - (cx - this.W / 2) / k, lat: 12 + (cy - this.H / 2) / k }, animate && !this.locked ? 750 : 0);
  }

  fitAll(animate = true) {
    this.fitWorld({ animate });
  }

  focus(sel) {
    if (!sel) return;
    if (sel.type === 'server') {
      const s = this.servers.find((x) => x.id === sel.id);
      if (!s) return;
      const ins = this.insets();
      const k = Math.max(this.v.k, 9);
      const cx = ins.l + (this.W - ins.l - ins.r) / 2;
      const cy = ins.t + (this.H - ins.t - ins.b) / 2;
      this.flyTo({ k, lon: this.unwrap(s.lon) - (cx - this.W / 2) / k, lat: s.lat + (cy - this.H / 2) / k });
    } else if (sel.type === 'link') {
      const pts = sel.id.split('|').map((id) => this.servers.find((x) => x.id === id)).filter(Boolean);
      this.fit(pts, { maxK: 40 });
    }
  }

  // ---------------- 交互 ----------------
  bind() {
    const el = this.canvas;
    const ptrs = new Map();
    let drag = null;
    let pinch = null;
    const local = (e) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, local(e));
      this.flight = null;
      if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, t: performance.now(), v: { ...this.v }, moved: false };
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: this.v.k };
        drag = null;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, local(e));
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const f = Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(pinch.d, 1);
        this.zoomBy((pinch.k * f) / this.v.k, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0);
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.v = this.clampView({ ...drag.v, lon: drag.v.lon - dx / this.v.k, lat: drag.v.lat + dy / this.v.k });
          this.dirty = true;
          el.style.cursor = 'grabbing';
        }
        return;
      }
      const [x, y] = local(e);
      const hit = this.h.isPicking?.() ? null : this.pick(x, y);
      this.setHover(hit);
      el.style.cursor = this.h.isPicking?.() ? 'crosshair' : hit ? 'pointer' : 'grab';
      this.h.onHover?.(hit, e);
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!drag) return;
      const d = drag;
      drag = null;
      el.style.cursor = 'grab';
      if (d.moved || performance.now() - d.t > 600) return;
      const [x, y] = local(e);
      if (this.h.isPicking?.()) {
        const ll = this.latLonAt(x, y);
        if (ll) this.h.onPickLocation?.(ll);
        return;
      }
      this.click(this.pick(x, y));
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => {
      this.setHover(null);
      this.h.onHover?.(null);
    });
    el.addEventListener('dblclick', (e) => {
      const [x, y] = local(e);
      if (!this.pick(x, y)) this.zoomBy(2, x, y, 400);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.flight = null;
        const [x, y] = local(e);
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomBy(Math.exp(-dy * 0.0018), x, y, 0);
      },
      { passive: false },
    );
  }

  setHover(hit) {
    this.hoverHit = hit;
  }

  click(hit) {
    if (!hit) {
      this.expanded = null;
      return this.h.onSelect?.(null);
    }
    if (hit.type === 'origin') return;
    if (hit.type === 'cluster') {
      const pts = hit.servers;
      const span = Math.max(...pts.map((p) => p.lon)) - Math.min(...pts.map((p) => p.lon)) + Math.max(...pts.map((p) => p.lat)) - Math.min(...pts.map((p) => p.lat));
      // 拉近能分开就拉近；同机房的话直接在屏幕上展开
      if (span * K_MAX > CLUSTER_PX * 3 && this.v.k < K_MAX * 0.9) {
        this.expanded = null;
        this.fit(pts, { maxK: Math.min(K_MAX, (CLUSTER_PX * 3.5) / Math.max(span, 1e-3)) });
      } else this.expanded = hit.key;
      return;
    }
    this.h.onSelect?.({ type: hit.type, id: hit.id });
  }

  pick(x, y) {
    const { nodes, labels, arcs } = this.hits;
    for (const l of labels) if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l.hit;
    let best = null;
    for (const n of nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < n.r + 7 && (!best || d < best.d)) best = { ...n.hit, d };
    }
    if (best) return best;
    const [wl, wr] = this.locked ? this.worldX() : [-Infinity, Infinity];
    for (const a of arcs) {
      for (let i = 1; i < a.pts.length; i++) {
        if (a.pts[i][0] < wl || a.pts[i][0] > wr) continue; // 锁定时被裁掉的部分不可点
        const d = distToSeg(x, y, a.pts[i - 1][0], a.pts[i - 1][1], a.pts[i][0], a.pts[i][1]);
        if (d < 6 && (!best || d < best.d)) best = { ...(a.hit || { type: 'link', id: a.key }), d };
      }
    }
    return best;
  }

  // ---------------- 每帧 ----------------
  frame() {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (performance.now() - f.t0) / f.duration);
      const e = ease(t);
      this.v = {
        lon: f.from.lon + (f.to.lon - f.from.lon) * e,
        lat: f.from.lat + (f.to.lat - f.from.lat) * e,
        k: Math.exp(Math.log(f.from.k) + (Math.log(f.to.k) - Math.log(f.from.k)) * e),
      };
      if (t >= 1) {
        this.v = this.clampView(this.v);
        this.flight = null;
      }
      this.dirty = true;
    }
    const nodes = this.layoutNodes();
    // 晨昏线每分钟刷新一次
    if (this.dirty || performance.now() - (this.baseAt || 0) > 60_000) {
      this.drawBase(nodes);
      this.baseAt = performance.now();
      this.dirty = false;
    }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.base, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.locked) {
      // 锁定：连线和节点只画在这一份世界里，跨接缝的线在边缘裁开
      const [x0, x1] = this.worldX();
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, this.H);
      g.clip();
    }
    const arcs = this.drawArcs(nodes);
    this.drawNodes(nodes);
    if (this.locked) g.restore();
    this.drawLabels(nodes, arcs);
  }

  /** 屏幕空间聚类，得到要画的节点和每台服务器的显示位置 */
  layoutNodes() {
    const sel = this.selection?.type === 'server' ? this.selection.id : null;
    const pts = this.servers.map((s) => ({ s, ...this.toScreen(s.lon, s.lat) }));
    // 重要的先占位：选中的、连线多的
    const deg = {};
    for (const e of this.edges) {
      deg[e.a] = (deg[e.a] || 0) + 1;
      deg[e.b] = (deg[e.b] || 0) + 1;
    }
    pts.sort((a, b) => (b.s.id === sel) - (a.s.id === sel) || (deg[b.s.id] || 0) - (deg[a.s.id] || 0) || a.s.id.localeCompare(b.s.id));
    const groups = [];
    for (const p of pts) {
      const g = groups.find((g) => Math.hypot(g.x - p.x, g.y - p.y) < CLUSTER_PX);
      if (g) g.members.push(p);
      else groups.push({ x: p.x, y: p.y, members: [p] });
    }
    const nodes = [];
    const pos = new Map();
    for (const g of groups) {
      const key = g.members.map((m) => m.s.id).sort().join(',');
      const n = g.members.length;
      const fan = n > 1 && (this.expanded === key || g.members.some((m) => m.s.id === sel) || this.v.k >= K_MAX * 0.98);
      if (n === 1 || fan) {
        const R = Math.max(26, 10 + n * 6);
        g.members.forEach((m, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          const x = n === 1 ? g.x : g.x + Math.cos(a) * R;
          const y = n === 1 ? g.y : g.y + Math.sin(a) * R;
          nodes.push({ key: m.s.id, servers: [m.s], x, y, anchor: n > 1 ? { x: g.x, y: g.y } : null, side: n > 1 && Math.cos(a) < -0.2 ? 'left' : null });
          pos.set(m.s.id, { x, y });
        });
      } else {
        nodes.push({ key, servers: g.members.map((m) => m.s), x: g.x, y: g.y, cluster: true });
        for (const m of g.members) pos.set(m.s.id, { x: g.x, y: g.y });
      }
    }
    const o = this.rv?.origin;
    if (o && o.kind !== 'srv' && o.lat != null) {
      const p = this.toScreen(o.lon, o.lat);
      nodes.push({ key: '@origin', servers: [{ id: '@origin', name: o.name, lat: o.lat, lon: o.lon }], x: p.x, y: p.y, origin: o });
      pos.set('@origin', p);
    } else if (o?.kind === 'srv') pos.set('@origin', pos.get(o.id));
    for (const n of nodes) {
      if (n.origin) {
        Object.assign(n, { color: '#e2e8f0', offline: 0, online: true, r: 7, deg: 99 });
        continue;
      }
      const s = n.servers;
      n.color = n.cluster ? clusterColor(s.map((x) => this.colorOf(x)), s.map((x) => statusKey(this.statusMap[x.id]))) : this.colorOf(s[0]);
      n.offline = s.filter((x) => statusKey(this.statusMap[x.id]) === 'offline').length;
      n.online = s.some((x) => statusKey(this.statusMap[x.id]) === 'online');
      n.r = n.cluster ? 7 + Math.sqrt(s.length) * 1.6 : 5;
      n.deg = s.reduce((a, x) => a + (deg[x.id] || 0), 0);
    }
    nodes.pos = pos;
    return nodes;
  }

  /** 点阵底图：背景渐变 + 陆地点阵（服务器附近染色、夜半球变暗） */
  drawBase(nodes) {
    const g = this.base.getContext('2d');
    const { W, H, v } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#050b17');
    bg.addColorStop(1, '#0a0f1f');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const rg = g.createRadialGradient(W * 0.55, H * 0.4, 0, W * 0.55, H * 0.4, Math.max(W, H) * 0.7);
    rg.addColorStop(0, 'rgba(56,189,248,0.05)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);

    // 点间距：世界坐标里取固定档位（拖动时点阵不闪），屏幕上约 7~10px，大陆轮廓才清楚
    const target = 7 / v.k;
    const step = [0.05, 0.1, 0.15, 0.25, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5].find((x) => x >= target) || 5;
    const px = step * v.k;
    const r0 = clamp(px * 0.2, 1.1, 2);
    const lon0 = v.lon - W / 2 / v.k;
    const lat0 = v.lat + H / 2 / v.k;
    const sun = subsolar(Date.now());
    const sinD = Math.sin(sun.lat * DEG);
    const cosD = Math.cos(sun.lat * DEG);
    // 只染服务器周围一小圈，不要把整块大陆染色
    const glows = nodes.map((n) => ({ x: n.x, y: n.y, c: n.color, R: n.cluster ? 62 : 48 }));
    // 按（颜色, 强度档）分桶，一个桶一次 fill
    const buckets = new Map();
    const add = (key, x, y, r) => {
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(x, y, r);
    };
    const iy0 = Math.floor(lat0 / step);
    const iy1 = Math.ceil((lat0 - H / v.k) / step);
    const ix0 = Math.floor(lon0 / step);
    const ix1 = Math.ceil((lon0 + W / v.k) / step);
    for (let iy = iy0; iy >= iy1; iy--) {
      const lat = iy * step;
      if (lat > 84 || lat < -62) continue;
      const y = H / 2 - (lat - v.lat) * v.k;
      const sinL = Math.sin(lat * DEG);
      const cosL = Math.cos(lat * DEG);
      // 隔行错开半格，更像六边形点阵
      const shift = Math.round(lat / step) & 1 ? step / 2 : 0;
      for (let ix = ix0; ix <= ix1; ix++) {
        const lon = ix * step + shift;
        if (this.locked && (lon < this.worldCenter - 180 || lon >= this.worldCenter + 180)) continue;
        if (!isLand(lon, lat)) continue;
        const x = W / 2 + (lon - v.lon) * v.k;
        const cz = sinL * sinD + cosL * cosD * Math.cos((lon - sun.lon) * DEG);
        const day = clamp((cz + 0.1) / 0.2, 0, 1); // 晨昏过渡带约 ±6°
        let best = null;
        let w = 0;
        for (const gl of glows) {
          const dx = x - gl.x;
          const dy = y - gl.y;
          if (Math.abs(dx) > gl.R || Math.abs(dy) > gl.R) continue;
          const ww = Math.exp(-(dx * dx + dy * dy) / (gl.R * gl.R * 0.35));
          if (ww > w) {
            w = ww;
            best = gl;
          }
        }
        if (best && w > 0.06) {
          const lvl = Math.min(5, Math.round(w * 5));
          add(`${best.c}|${lvl}`, x, y, r0 + w * 0.7);
        } else add(`base|${Math.round(day * 2)}`, x, y, r0);
      }
    }
    for (const [key, arr] of buckets) {
      const [c, lvl] = key.split('|');
      // 底色点要清楚：夜半球只是稍暗一点
      g.fillStyle = c === 'base' ? `rgba(105,140,185,${0.34 + Number(lvl) * 0.09})` : hexA(c, 0.45 + Number(lvl) * 0.1);
      g.beginPath();
      for (let i = 0; i < arr.length; i += 3) {
        g.moveTo(arr[i] + arr[i + 2], arr[i + 1]);
        g.arc(arr[i], arr[i + 1], arr[i + 2], 0, Math.PI * 2);
      }
      g.fill();
    }
    // 四周压暗
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(1,4,11,0)');
    vg.addColorStop(1, 'rgba(1,4,11,0.3)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
  }

  isHl(e) {
    const s = this.selection;
    const hv = this.hoverHit;
    if (e.dests) {
      const ids = [s?.type === 'server' && s.id, hv?.type === 'server' && hv.id, this.hover?.type === 'server' && this.hover.id];
      return ids.some((id) => id && e.dests.has(id));
    }
    return (
      (s?.type === 'link' && s.id === e.key) ||
      (s?.type === 'server' && (e.a === s.id || e.b === s.id)) ||
      (hv?.type === 'link' && hv.id === e.key) ||
      (hv?.type === 'server' && (e.a === hv.id || e.b === hv.id)) ||
      (this.hover?.type === 'server' && (e.a === this.hover.id || e.b === this.hover.id))
    );
  }

  drawArcs(nodes) {
    const g = this.g;
    const wrap = 360 * this.v.k;
    const focus = this.selection?.type === 'server' || this.selection?.type === 'link' || (this.rv && this.hoverHit?.type === 'server');
    const out = [];
    this.hits.arcs = [];
    for (const e of this.rv ? this.rv.segments : this.edges) {
      const pa = nodes.pos.get(e.a);
      let pb = nodes.pos.get(e.b);
      if (!pa || !pb) continue;
      // 走近路：终点可能要换到相邻的那一份世界
      if (Math.abs(pb.x - pa.x) > wrap / 2) pb = { x: pb.x - Math.sign(pb.x - pa.x) * wrap, y: pb.y };
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.hypot(dx, dy);
      if (d < 2) continue;
      let nx = -dy / d;
      let ny = dx / d;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      const bend = Math.min(d * 0.26, 260);
      const c = { x: (pa.x + pb.x) / 2 + nx * bend, y: (pa.y + pb.y) / 2 + ny * bend };

      const m = e.measured;
      const down = m && (m.rtt == null || m.loss >= 100);
      const color = down ? LAT_COLORS.bad : m ? latencyColor(m.rtt) : LAT_COLORS.none;
      const hl = this.isHl(e);
      const dim = focus && !hl;
      const mesh = e.kind === 'mesh';
      const mbps = m?.mbps ?? e.link?.bandwidthMbps ?? null;
      const rtt = m?.rtt ?? e.estimate;

      for (const off of this.copies(Math.min(pa.x, pb.x), Math.max(pa.x, pb.x))) {
        const p0 = { x: pa.x + off, y: pa.y };
        const p2 = { x: pb.x + off, y: pb.y };
        const p1 = { x: c.x + off, y: c.y };
        const curve = () => {
          g.beginPath();
          g.moveTo(p0.x, p0.y);
          g.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
        };
        g.lineCap = 'round';
        g.globalAlpha = dim ? 0.18 : mesh && !hl ? 0.5 : 1;
        if (e.kind === 'suggest') {
          // 建议的中转：细虚线 + 慢速流动
          curve();
          g.setLineDash([2, 6]);
          g.lineDashOffset = -this.time * 12;
          g.strokeStyle = hexA(color, hl ? 0.95 : 0.55);
          g.lineWidth = hl ? 2.2 : 1.5;
          g.stroke();
          g.setLineDash([]);
        } else if (!m || down) {
          curve();
          g.setLineDash([5, 5]);
          g.strokeStyle = hexA(color, 0.7);
          g.lineWidth = hl ? 2 : 1.3;
          g.stroke();
          g.setLineDash([]);
        } else {
          // 外发光 + 细实线 + 流动的点
          curve();
          g.strokeStyle = hexA(color, hl ? 0.22 : 0.1);
          g.lineWidth = hl ? 9 : 6;
          g.stroke();
          g.strokeStyle = hexA(color, hl ? 0.85 : 0.5);
          g.lineWidth = hl ? 1.8 : 1.1;
          g.stroke();
          g.setLineDash([0.1, mesh ? 14 : 10]);
          g.lineDashOffset = -this.time * (14 + 900 / (rtt + 20));
          g.strokeStyle = hexA(color, 0.95);
          g.lineWidth = hl ? 3.2 : 2.4;
          g.stroke();
          g.setLineDash([]);
          // 光点：数量随吞吐，双向
          const count = mbps ? clamp(Math.round(1 + Math.log10(mbps + 1) * 0.9), 1, 4) : 1;
          const travel = 0.9 + rtt / 70;
          g.globalCompositeOperation = 'lighter';
          for (let k = 0; k < count; k++) {
            let t = (this.time / travel + k / count + (hash(e.key) % 100) / 100) % 1;
            if (k % 2) t = 1 - t;
            for (let j = 0; j < 5; j++) {
              const tt = k % 2 ? t + j * 0.012 : t - j * 0.012;
              if (tt < 0 || tt > 1) continue;
              const q = bez(p0, p1, p2, tt);
              g.fillStyle = hexA(j ? color : '#ffffff', (1 - j / 5) * 0.9);
              g.beginPath();
              g.arc(q.x, q.y, (hl ? 3 : 2.4) * (1 - j * 0.15), 0, Math.PI * 2);
              g.fill();
            }
          }
          g.globalCompositeOperation = 'source-over';
        }
        g.globalAlpha = 1;
        const pts = [];
        for (let i = 0; i <= 24; i++) {
          const q = bez(p0, p1, p2, i / 24);
          pts.push([q.x, q.y]);
        }
        this.hits.arcs.push({ key: e.key, hit: e.hit, pts });
        out.push({ e, p0, p1, p2, color, down, hl, dim, mesh, mbps });
      }
    }
    return out;
  }

  /** 世界循环：返回需要额外画的水平偏移（0 和左右相邻的那一份） */
  copies(x0, x1) {
    const wrap = 360 * this.v.k;
    const [l, r] = this.locked ? this.worldX() : [-300, this.W + 300];
    const out = [];
    for (const off of [0, -wrap, wrap]) if (x1 + off > l && x0 + off < r) out.push(off);
    return out;
  }

  drawNodes(nodes) {
    const g = this.g;
    const t = this.time;
    const sel = this.selection?.type === 'server' ? this.selection.id : null;
    const hov = this.hoverHit?.type === 'server' ? this.hoverHit.id : this.hover?.type === 'server' ? this.hover.id : null;
    this.hits.nodes = [];
    // 展开的成员先画「腿」
    for (const n of nodes) {
      if (!n.anchor) continue;
      g.strokeStyle = 'rgba(125,211,252,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(n.anchor.x, n.anchor.y);
      g.lineTo(n.x, n.y);
      g.stroke();
    }
    for (const n of nodes) {
      for (const off of this.copies(n.x, n.x)) {
        const x = n.x + off;
        const y = n.y;
        if (n.origin) {
          this.drawOrigin(x, y);
          this.hits.nodes.push({ x, y, r: 9, hit: { type: 'origin' } });
          continue;
        }
        const isSel = !n.cluster && n.servers[0].id === sel;
        const isHov = !n.cluster && n.servers[0].id === hov;
        // 光晕
        g.globalCompositeOperation = 'lighter';
        const halo = g.createRadialGradient(x, y, 0, x, y, n.r * 4);
        halo.addColorStop(0, hexA(n.color, 0.45));
        halo.addColorStop(1, hexA(n.color, 0));
        g.fillStyle = halo;
        g.fillRect(x - n.r * 4, y - n.r * 4, n.r * 8, n.r * 8);
        g.globalCompositeOperation = 'source-over';
        // 在线：扩散环；离线：闪烁
        if (n.online && !n.offline) {
          const p = (t * 0.5 + (hash(n.key) % 100) / 100) % 1;
          g.strokeStyle = hexA(n.color, (1 - p) * 0.6);
          g.lineWidth = 1.2;
          g.beginPath();
          g.arc(x, y, n.r + 2 + p * 12, 0, Math.PI * 2);
          g.stroke();
        }
        const blink = n.offline === n.servers.length ? 0.45 + 0.55 * Math.abs(Math.sin(t * 3)) : 1;
        g.globalAlpha = blink;
        g.fillStyle = 'rgba(4,10,22,0.9)';
        g.beginPath();
        g.arc(x, y, n.r + 2, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = n.color;
        g.beginPath();
        g.arc(x, y, n.r + (isHov ? 1 : 0), 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        if (n.cluster) {
          g.fillStyle = '#04101f';
          g.font = `700 ${n.r > 9 ? 11 : 10}px ${FONT}`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(String(n.servers.length), x, y + 0.5);
          if (n.offline) {
            g.fillStyle = STATUS_COLORS.offline;
            g.beginPath();
            g.arc(x + n.r * 0.8, y - n.r * 0.8, 3.2, 0, Math.PI * 2);
            g.fill();
          }
        } else {
          g.fillStyle = 'rgba(255,255,255,0.85)';
          g.beginPath();
          g.arc(x, y, 1.8, 0, Math.PI * 2);
          g.fill();
        }
        if (this.rv?.origin?.kind === 'srv' && n.servers[0].id === this.rv.origin.id && !n.cluster) this.drawOrigin(x, y, true);
        if (isSel) {
          g.strokeStyle = '#fff';
          g.lineWidth = 1.6;
          g.beginPath();
          g.arc(x, y, n.r + 5 + Math.sin(t * 4) * 1.2, 0, Math.PI * 2);
          g.stroke();
        }
        this.hits.nodes.push({ x, y, r: n.r, hit: n.cluster ? { type: 'cluster', key: n.key, servers: n.servers } : { type: 'server', id: n.servers[0].id } });
      }
    }
  }

  /** 起点：白色双环 + 旋转刻度，和普通服务器一眼区分 */
  drawOrigin(x, y, ringOnly = false) {
    const g = this.g;
    const t = this.time;
    g.globalCompositeOperation = 'lighter';
    const halo = g.createRadialGradient(x, y, 0, x, y, 34);
    halo.addColorStop(0, 'rgba(226,232,240,0.35)');
    halo.addColorStop(1, 'rgba(226,232,240,0)');
    g.fillStyle = halo;
    g.fillRect(x - 34, y - 34, 68, 68);
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 2; i++) {
      const p = (t * 0.45 + i / 2) % 1;
      g.strokeStyle = `rgba(226,232,240,${(1 - p) * 0.5})`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(x, y, 9 + p * 22, 0, Math.PI * 2);
      g.stroke();
    }
    g.save();
    g.translate(x, y);
    g.rotate(t * 0.6);
    g.setLineDash([3, 3.3]);
    g.strokeStyle = 'rgba(226,232,240,0.9)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(0, 0, 11, 0, Math.PI * 2);
    g.stroke();
    g.restore();
    if (ringOnly) return;
    g.fillStyle = 'rgba(4,10,22,0.95)';
    g.beginPath();
    g.arc(x, y, 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f8fafc';
    g.beginPath();
    g.arc(x, y, 5.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0f172a';
    g.beginPath();
    g.arc(x, y, 2, 0, Math.PI * 2);
    g.fill();
  }

  measure(text, font) {
    const k = `${font}|${text}`;
    let w = this.textW.get(k);
    if (w == null) {
      this.g.font = font;
      w = this.g.measureText(text).width;
      if (this.textW.size > 4000) this.textW.clear();
      this.textW.set(k, w);
    }
    return w;
  }

  /** 节点名称 + 连线胶囊，按优先级贪心避让 */
  drawLabels(nodes, arcs) {
    const g = this.g;
    const sel = this.selection;
    const hv = this.hoverHit || this.hover;
    const placed = [];
    // 节点本身也是障碍物
    for (const n of this.hits.nodes) placed.push({ x: n.x - n.r - 3, y: n.y - n.r - 3, w: n.r * 2 + 6, h: n.r * 2 + 6 });
    const [bl, br] = this.locked ? this.worldX() : [0, this.W];
    const fits = (r) => r.x > Math.max(4, bl) && r.y > 4 && r.x + r.w < Math.min(this.W, br) - 4 && r.y + r.h < this.H - 4 && !placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    const items = [];
    const TF = `600 13px ${FONT}`;
    const SF = `11.5px ${FONT}`;
    const LF = `600 11.5px ${MONO}`;

    for (const n of nodes) {
      const ids = n.servers.map((s) => s.id);
      const important = ids.includes(sel?.id) || ids.includes(hv?.id);
      if (!this.showLabels && !important) continue;
      let title;
      let sub;
      let subColor = null;
      if (n.origin) {
        title = n.origin.name;
        sub = n.origin.sub || '起点';
      } else if (n.cluster) {
        const names = n.servers.map((s) => s.name);
        title = names.length <= 3 && names.join(' / ').length <= 26 ? names.join(' / ') : `${names.slice(0, 2).join(' / ')} 等 ${names.length} 台`;
        const city = cityName(n.servers[0].city);
        sub = [city, `${n.servers.length} 台`, n.offline ? `${n.offline} 台离线` : ''].filter(Boolean).join(' · ');
        if (n.offline) subColor = STATUS_COLORS.offline;
      } else {
        const s = n.servers[0];
        const st = this.statusMap[s.id];
        title = s.name;
        const key = statusKey(st);
        sub = [cityName(s.city), s.provider, key === 'offline' ? '离线' : st?.hubRtt != null ? fmtMs(st.hubRtt) : ''].filter(Boolean).join(' · ');
        if (key === 'offline') subColor = STATUS_COLORS.offline;
        const info = this.rv?.info.get(s.id);
        if (info) {
          sub = info.text;
          subColor = info.color;
        }
      }
      const tw = this.measure(title, TF);
      const sw = sub ? this.measure(sub, SF) : 0;
      const w = Math.max(tw, sw);
      const h = sub ? 32 : 17;
      for (const off of this.copies(n.x, n.x)) {
        items.push({
          kind: 'node',
          pr: (important || n.origin ? 1e4 : 0) + 100 + n.deg * 10 + (n.cluster ? 5 : 0),
          n,
          x: n.x + off,
          y: n.y,
          w,
          h,
          title,
          sub,
          subColor,
          hit: n.cluster ? { type: 'cluster', key: n.key, servers: n.servers } : { type: 'server', id: n.servers[0].id },
        });
      }
    }
    for (const a of arcs) {
      if (a.dim) continue;
      const e = a.e;
      if (a.mesh && !a.hl && !this.showLinkLabels) continue;
      if (this.rv && !a.hl && !e.link?.label && !this.showLinkLabels) continue;
      const m = e.measured;
      const rtt = a.down ? '中断' : m ? fmtMs(m.rtt) : `≈${fmtMs(e.estimate)}`;
      const parts = [e.kind === 'suggest' ? '建议' : '', e.link?.label, rtt, a.hl && a.mbps ? fmtMbps(a.mbps) : '', a.hl && m?.loss ? `丢包 ${m.loss.toFixed(1)}%` : ''].filter(Boolean);
      const text = parts.join(' · ');
      const w = this.measure(text, LF) + 22;
      items.push({ kind: 'link', pr: (a.hl ? 5000 : 0) + (e.link?.label ? 60 : 30), a, text, w, h: 22, hit: { type: 'link', id: e.key } });
    }
    items.sort((a, b) => b.pr - a.pr);
    this.hits.labels = [];

    g.textBaseline = 'alphabetic';
    for (const it of items) {
      let r = null;
      if (it.kind === 'node') {
        const pad = it.n.r + 8;
        const cands = it.n.side === 'left' ? ['l', 'r', 't', 'b'] : ['r', 'l', 't', 'b'];
        for (const c of cands) {
          const rr =
            c === 'r' ? { x: it.x + pad, y: it.y - (it.sub ? 15 : 9), w: it.w, h: it.h }
            : c === 'l' ? { x: it.x - pad - it.w, y: it.y - (it.sub ? 15 : 9), w: it.w, h: it.h }
            : c === 't' ? { x: it.x - it.w / 2, y: it.y - pad - it.h, w: it.w, h: it.h }
            : { x: it.x - it.w / 2, y: it.y + pad, w: it.w, h: it.h };
          if (fits(rr)) {
            r = { ...rr, align: c };
            break;
          }
        }
        if (!r && it.pr >= 1e4) r = { x: it.x + pad, y: it.y - 15, w: it.w, h: it.h, align: 'r' };
        if (!r) continue;
        placed.push(r);
        const left = r.align === 'l';
        const tx = left ? r.x + r.w : r.align === 't' || r.align === 'b' ? r.x + r.w / 2 : r.x;
        g.textAlign = left ? 'right' : r.align === 't' || r.align === 'b' ? 'center' : 'left';
        g.shadowColor = 'rgba(0,0,0,0.9)';
        g.shadowBlur = 6;
        g.font = TF;
        g.fillStyle = '#f1f5fb';
        g.fillText(it.title, tx, r.y + 13);
        if (it.sub) {
          g.font = SF;
          g.fillStyle = it.subColor || 'rgba(159,179,204,0.85)';
          g.fillText(it.sub, tx, r.y + 29);
        }
        g.shadowBlur = 0;
      } else {
        // 沿曲线找一个放得下的位置
        const { p0, p1, p2 } = it.a;
        for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
          const q = bez(p0, p1, p2, t);
          const rr = { x: q.x - it.w / 2, y: q.y - it.h / 2, w: it.w, h: it.h };
          if (fits(rr)) {
            r = rr;
            break;
          }
        }
        if (!r && it.a.hl) {
          const q = bez(p0, p1, p2, 0.5);
          r = { x: q.x - it.w / 2, y: q.y - it.h / 2, w: it.w, h: it.h };
        }
        if (!r) continue;
        placed.push(r);
        const c = it.a.color;
        g.fillStyle = 'rgba(6,12,24,0.92)';
        roundRect(g, r.x, r.y, r.w, r.h, r.h / 2);
        g.fill();
        g.strokeStyle = hexA(c, it.a.hl ? 0.95 : 0.7);
        g.lineWidth = it.a.hl ? 1.5 : 1.1;
        g.stroke();
        g.font = LF;
        g.textAlign = 'center';
        g.fillStyle = c;
        g.fillText(it.text, r.x + r.w / 2, r.y + 15);
      }
      this.hits.labels.push({ ...r, hit: it.hit });
    }
  }
}

function bez(p0, p1, p2, t) {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function clusterColor(colors, states) {
  if (states.every((s) => s === 'offline')) return STATUS_COLORS.offline;
  if (states.some((s) => s === 'offline')) return '#fbbf24';
  // 成员颜色取最多的那个
  const c = {};
  let best = colors[0];
  for (const x of colors) if ((c[x] = (c[x] || 0) + 1) > c[best]) best = x;
  return best;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
