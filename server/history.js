// 长期历史（给图表和「任意时间段流量」用）：两级聚合桶，按服务器存 data/history/<id>.json
//  - m5：5 分钟一桶，保留 8 天（24 小时 / 7 天视图）
//  - h1：1 小时一桶，保留 400 天（30 天 / 周期 / 自定义区间，按天的视图由它再汇总）
// 指标桶存「和 + 次数」，查询时才算平均；流量桶存这段时间内的字节增量。
// 流量增量按采样时长分摊到经过的每个桶（参考 VPS-Monitor 的做法），所以跨小时/跨天的上报不会全堆在一个桶里。
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.NP_DATA_DIR || path.resolve(process.cwd(), 'data');
const DIR = path.join(DATA_DIR, 'history');
const DAY = 86_400_000;
export const TIERS = {
  m5: { ms: 300_000, keep: 8 * DAY },
  h1: { ms: 3_600_000, keep: 400 * DAY },
};
// 落盘列顺序（新增字段只能往后加）
const COLS = ['t', 'n', 'cpu', 'cpuMax', 'mem', 'memMax', 'disk', 'load', 'conns', 'rxMax', 'txMax', 'pn', 'on', 'rtt', 'rttN', 'rx', 'tx', 'cov'];
const SAVE_MS = 5 * 60_000;
const COVER_GAP_MS = 5 * 60_000; // 两次上报间隔不超过它，才算「这段时间有采样」
const SPREAD_MAX_MS = 7 * DAY; // 间隔更长的增量不再分摊，直接记在最后一桶

const data = new Map(); // id -> { m5: Map<t, bucket>, h1: Map<t, bucket>, demo }
const dirty = new Set();

const blank = (t) => ({ t, n: 0, cpu: 0, cpuMax: 0, mem: 0, memMax: 0, disk: 0, load: 0, conns: 0, rxMax: 0, txMax: 0, pn: 0, on: 0, rtt: 0, rttN: 0, rx: 0, tx: 0, cov: 0 });

function series(id) {
  let d = data.get(id);
  if (!d) data.set(id, (d = { m5: new Map(), h1: new Map(), demo: false }));
  return d;
}

function bucket(d, tier, ts) {
  const ms = TIERS[tier].ms;
  const t = Math.floor(ts / ms) * ms;
  let b = d[tier].get(t);
  if (!b) d[tier].set(t, (b = blank(t)));
  return b;
}

const ok = (v) => typeof v === 'number' && Number.isFinite(v);

/** Agent 指标（每次上报一个样本） */
export function recordMetrics(id, m, now = Date.now()) {
  const d = series(id);
  for (const tier of ['m5', 'h1']) {
    const b = bucket(d, tier, now);
    b.n++;
    if (ok(m.cpu)) (b.cpu += m.cpu), (b.cpuMax = Math.max(b.cpuMax, m.cpu));
    if (ok(m.mem)) (b.mem += m.mem), (b.memMax = Math.max(b.memMax, m.mem));
    if (ok(m.disk)) b.disk += m.disk;
    if (ok(m.load)) b.load += m.load;
    if (ok(m.conns)) b.conns += m.conns;
    if (ok(m.rxBps)) b.rxMax = Math.max(b.rxMax, m.rxBps);
    if (ok(m.txBps)) b.txMax = Math.max(b.txMax, m.txBps);
  }
  if (!d.demo) dirty.add(id);
}

/** Hub 探测结果（rtt 为 null 表示不可达） */
export function recordProbe(id, rtt, now = Date.now()) {
  const d = series(id);
  for (const tier of ['m5', 'h1']) {
    const b = bucket(d, tier, now);
    b.pn++;
    if (rtt != null) (b.on++, (b.rtt += rtt), b.rttN++);
  }
  if (!d.demo) dirty.add(id);
}

/** 流量增量：[t0, t1) 这段时间里收发了 rx / tx 字节，按时长比例分摊到经过的桶 */
export function recordTraffic(id, t0, t1, rx, tx) {
  if (!(rx >= 0 && tx >= 0) || !(t1 > t0)) return;
  const d = series(id);
  const covered = t1 - t0 <= COVER_GAP_MS;
  if (t1 - t0 > SPREAD_MAX_MS) t0 = t1 - 1;
  const span = t1 - t0;
  for (const tier of ['m5', 'h1']) {
    const ms = TIERS[tier].ms;
    let cur = t0;
    while (cur < t1) {
      const end = Math.min(t1, Math.floor(cur / ms) * ms + ms);
      const f = (end - cur) / span;
      const b = bucket(d, tier, cur);
      b.rx += rx * f;
      b.tx += tx * f;
      if (covered) b.cov += (end - cur) / 1000;
      cur = end;
    }
  }
  if (!d.demo) dirty.add(id);
}

/** 某段时间内的流量合计（部分覆盖的桶按比例计入）。8 天内用 5 分钟桶，更早用小时桶。 */
export function sumTraffic(id, from, to = Date.now()) {
  const d = data.get(id);
  const out = { rx: 0, tx: 0, cov: 0 };
  if (!d || !(to > from)) return out;
  const tier = from >= Date.now() - TIERS.m5.keep + TIERS.h1.ms ? 'm5' : 'h1';
  const ms = TIERS[tier].ms;
  const now = Date.now();
  for (const b of d[tier].values()) {
    const s = Math.max(from, b.t);
    const e = Math.min(to, b.t + ms);
    if (e <= s) continue;
    // 还没走完的桶，数据只覆盖到现在，按已过去的部分折算
    const f = Math.min(1, (e - s) / Math.max(1, Math.min(ms, now - b.t)));
    out.rx += b.rx * f;
    out.tx += b.tx * f;
    out.cov += b.cov * f;
  }
  return out;
}

/** 最早一条流量数据的时间（没有则 null） */
export function firstTrafficAt(id) {
  const d = data.get(id);
  let min = null;
  for (const b of d?.h1.values() || []) if ((b.rx || b.tx) && (min == null || b.t < min)) min = b.t;
  return min;
}

/**
 * 查询图表数据。step 只取 300 / 3600 / 86400；按天汇总时用调用方的时区（tz = 相对 UTC 的分钟数）切日。
 * 返回列式数组，缺数据的桶填 null，图表会断开而不是连成直线。
 */
export function query(id, { from, to = Date.now(), step = 3600, tz = 0 }) {
  const d = data.get(id);
  step = step <= 300 ? 300 : step >= 86400 ? 86400 : 3600;
  if (step === 300 && from < Date.now() - TIERS.m5.keep) step = 3600;
  const tier = step === 300 ? 'm5' : 'h1';
  const stepMs = step * 1000;
  const shift = tz * 60_000;
  const keyOf = step === 86400 ? (t) => Math.floor((t + shift) / DAY) * DAY - shift : (t) => Math.floor(t / stepMs) * stepMs;
  const groups = new Map();
  for (const b of d?.[tier].values() || []) {
    if (b.t + TIERS[tier].ms <= from || b.t >= to) continue;
    const k = keyOf(b.t);
    const g = groups.get(k);
    if (!g) groups.set(k, { ...b, t: k });
    else {
      for (const c of COLS) if (c !== 't' && !c.endsWith('Max')) g[c] += b[c];
      for (const c of ['cpuMax', 'memMax', 'rxMax', 'txMax']) g[c] = Math.max(g[c], b[c]);
    }
  }
  const avg = (s, n, p = 1) => (n ? Math.round((s / n) * 10 ** p) / 10 ** p : null);
  const cols = { t: [], cpu: [], cpuMax: [], mem: [], memMax: [], disk: [], load: [], conns: [], rtt: [], online: [], rxRate: [], txRate: [], rxMax: [], txMax: [], rx: [], tx: [], cov: [] };
  for (let k = keyOf(from); k < to; k = step === 86400 ? keyOf(k + DAY + 3_600_000) : k + stepMs) {
    const g = groups.get(k);
    const len = step === 86400 ? keyOf(k + DAY + 3_600_000) - k : stepMs; // 夏令时之类的不规则日长（固定偏移下就是 24h）
    cols.t.push(k);
    cols.cpu.push(g ? avg(g.cpu, g.n) : null);
    cols.cpuMax.push(g?.n ? g.cpuMax : null);
    cols.mem.push(g ? avg(g.mem, g.n) : null);
    cols.memMax.push(g?.n ? g.memMax : null);
    cols.disk.push(g ? avg(g.disk, g.n) : null);
    cols.load.push(g ? avg(g.load, g.n, 2) : null);
    cols.conns.push(g ? avg(g.conns, g.n, 0) : null);
    cols.rtt.push(g ? avg(g.rtt, g.rttN) : null);
    cols.online.push(g?.pn ? Math.round((g.on / g.pn) * 1000) / 10 : g?.n ? 100 : null);
    const hasNet = g && (g.n || g.rx || g.tx);
    // 平均速率 = 字节 / 桶时长；当前这个还没走完的桶按已过去的时间算
    const elapsed = Math.max(1, Math.min(len, Date.now() - k)) / 1000;
    cols.rxRate.push(hasNet ? Math.round((g.rx * 8) / elapsed) : null);
    cols.txRate.push(hasNet ? Math.round((g.tx * 8) / elapsed) : null);
    cols.rxMax.push(g?.n ? g.rxMax : null);
    cols.txMax.push(g?.n ? g.txMax : null);
    cols.rx.push(hasNet ? Math.round(g.rx) : null);
    cols.tx.push(hasNet ? Math.round(g.tx) : null);
    cols.cov.push(g ? Math.round(g.cov) : 0);
  }
  return { from, to, step, tz, ...cols };
}

export function forgetHistory(id) {
  data.delete(id);
  dirty.delete(id);
  fs.rm(path.join(DIR, `${id}.json`), { force: true }, () => {});
}

// ---------------- 持久化 ----------------
function prune(d, now = Date.now()) {
  for (const tier of ['m5', 'h1']) for (const t of d[tier].keys()) if (t < now - TIERS[tier].keep) d[tier].delete(t);
}

export function flushHistory() {
  if (!dirty.size) return;
  fs.mkdirSync(DIR, { recursive: true });
  for (const id of dirty) {
    const d = data.get(id);
    if (!d || d.demo) continue;
    prune(d);
    const pack = (m) => [...m.values()].sort((a, b) => a.t - b.t).map((b) => COLS.map((c) => (c === 'rx' || c === 'tx' ? Math.round(b[c]) : Math.round(b[c] * 100) / 100)));
    const file = path.join(DIR, `${id}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify({ v: 1, cols: COLS, m5: pack(d.m5), h1: pack(d.h1) }));
    fs.renameSync(file + '.tmp', file);
  }
  dirty.clear();
}

export function loadHistory(validIds) {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of files) {
    const id = f.slice(0, -5);
    if (!validIds.has(id)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const cols = raw.cols || COLS;
      const d = series(id);
      for (const tier of ['m5', 'h1']) {
        for (const row of raw[tier] || []) {
          const b = blank(0);
          cols.forEach((c, i) => c in b && (b[c] = row[i] ?? 0));
          d[tier].set(b.t, b);
        }
      }
      prune(d);
    } catch (e) {
      console.warn(`[history] 读取 ${f} 失败：`, e.message);
    }
  }
}

export function startHistory(validIds) {
  loadHistory(validIds);
  setInterval(flushHistory, SAVE_MS).unref();
}

// ---------------- 演示数据 ----------------
/** 给演示服务器生成过去 45 天的历史（只在内存，不落盘），带昼夜规律 */
export function synthDemoHistory(id, { cpu = 30, mem = 50, disk = 40, rtt = 80, dailyBytes = 3e10 } = {}, now = Date.now()) {
  const d = series(id);
  d.demo = true;
  if (d.h1.size) return;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const diurnal = (t) => 0.55 + 0.45 * Math.sin(((new Date(t).getUTCHours() + 8 - 9) / 24) * Math.PI * 2); // 北京时间晚上高峰
  const weekly = Array.from({ length: 8 }, () => rnd(0.6, 1.4));
  const fill = (tier, span) => {
    const ms = TIERS[tier].ms;
    for (let t = Math.floor((now - span) / ms) * ms; t < Math.floor(now / ms) * ms; t += ms) {
      if (Math.random() < 0.004) continue; // 偶尔缺一桶，像真实的采样空缺
      const k = diurnal(t) * weekly[Math.floor(t / (7 * DAY)) % 8];
      const n = ms / 3000;
      const c = Math.min(99, cpu * k * rnd(0.7, 1.3));
      const m = Math.min(97, mem + rnd(-4, 4));
      const bytes = (dailyBytes / DAY) * ms * k * rnd(0.6, 1.4);
      const b = blank(t);
      Object.assign(b, {
        n, cpu: c * n, cpuMax: Math.min(100, c * rnd(1.2, 2)), mem: m * n, memMax: Math.min(99, m + rnd(1, 5)),
        disk: (disk + ((t - now) / DAY) * 0.05) * n, load: (c / 25) * n, conns: 200 * k * n,
        rxMax: ((bytes * 8) / (ms / 1000)) * rnd(2, 5), txMax: ((bytes * 8) / (ms / 1000)) * rnd(2, 5),
        pn: n, on: n, rtt: (rtt + rnd(0, 6)) * n, rttN: n,
        rx: bytes * rnd(0.35, 0.65), tx: 0, cov: ms / 1000,
      });
      b.tx = bytes - b.rx;
      d[tier].set(t, b);
    }
  };
  fill('h1', 45 * DAY);
  // 5 分钟桶由小时桶拆出来，保证两级的流量合计一致
  for (const h of d.h1.values()) {
    if (h.t < now - TIERS.m5.keep) continue;
    const w = Array.from({ length: 12 }, () => rnd(0.5, 1.5));
    const sw = w.reduce((a, b) => a + b, 0);
    w.forEach((wi, i) => {
      const f = wi / sw;
      const b = { ...h, t: h.t + i * 300_000 };
      for (const c of ['n', 'cpu', 'mem', 'disk', 'load', 'conns', 'pn', 'on', 'rtt', 'rttN', 'cov']) b[c] = h[c] / 12;
      b.cpu *= wi;
      b.cpuMax = Math.min(100, (h.cpu / h.n) * wi * rnd(1.1, 1.6));
      b.rx = h.rx * f;
      b.tx = h.tx * f;
      d.m5.set(b.t, b);
    });
  }
}

export const hasHistory = (id) => !!data.get(id)?.h1.size;
