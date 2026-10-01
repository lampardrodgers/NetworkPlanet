// 流量周期与累计。Agent 上报的是网卡开机以来的累计字节数，这里做差分：
//  - 计数变小（重启 / 计数器归零）时，把当前值当作增量
//  - 每段增量同时写进 history.js 的时间桶，任意时间段 / 历史周期的用量都从那里汇总
//  - 当前周期另外精确累加一份（db.traffic），加上手动校准的偏移，就是「本周期已用」
// 周期边界变了（自然到期，或用户改了重置时间）就从历史桶重新汇总本周期，不会丢数据。
import { db, saveLazy } from './store.js';
import { recordTraffic, sumTraffic, firstTrafficAt } from './history.js';
import { cycleAt, monthlyDef } from '../shared/cycle.js';

const DAY = 86_400_000;
const HUB_TZ = () => -new Date().getTimezoneOffset();

/** 生效的周期定义：单机设置优先，否则全局「每月 resetDay 号 0 点（Hub 时区）」 */
export function cycleDef(srv, cfg) {
  return srv.trafficCycle?.type ? srv.trafficCycle : { ...monthlyDef(cfg.resetDay, HUB_TZ()), inherit: true };
}

export const usedBy = (rx, tx, mode) => (mode === 'out' ? tx : mode === 'in' ? rx : mode === 'max' ? Math.max(rx, tx) : rx + tx);
const limitOf = (srv) => (srv.specs?.trafficTB ? srv.specs.trafficTB * 1e12 : null);

/** 当前周期的累计；周期变了就从历史重新汇总 */
function sync(srv, cfg, now = Date.now()) {
  const { start } = cycleAt(cycleDef(srv, cfg), now);
  const t = (db.traffic[srv.id] ||= { cycle: null, rx: 0, tx: 0, lastRx: null, lastTx: null, lastTs: null, offsets: {} });
  t.offsets ||= {};
  if (t.offset != null) {
    // 旧版本只存了一个 offset
    if (t.offset) t.offsets[t.cycle] = t.offset;
    delete t.offset;
  }
  if (t.cycle !== start) {
    const s = sumTraffic(srv.id, start, now);
    Object.assign(t, { cycle: start, rx: s.rx, tx: s.tx });
    // 只保留最近 24 个周期的校准值
    const keys = Object.keys(t.offsets).map(Number).sort((a, b) => b - a);
    for (const k of keys.slice(24)) delete t.offsets[k];
    saveLazy();
  }
  return t;
}

export function ingestTraffic(srv, rxBytes, txBytes, cfg) {
  if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return;
  const now = Date.now();
  const t = (db.traffic[srv.id] ||= { cycle: null, rx: 0, tx: 0, lastRx: null, lastTx: null, lastTs: null, offsets: {} });
  let drx = 0;
  let dtx = 0;
  if (t.lastRx != null) {
    drx = rxBytes >= t.lastRx ? rxBytes - t.lastRx : rxBytes;
    dtx = txBytes >= t.lastTx ? txBytes - t.lastTx : txBytes;
    recordTraffic(srv.id, t.lastTs || now - 10_000, now, drx, dtx);
  }
  Object.assign(t, { lastRx: rxBytes, lastTx: txBytes, lastTs: now });
  const before = t.cycle;
  sync(srv, cfg, now);
  if (before === t.cycle) {
    t.rx += drx;
    t.tx += dtx;
  }
  saveLazy();
}

/** 用户手动校准「本周期已用」（比如装 Agent 时周期已经过了一半） */
export function calibrateTraffic(srv, usedBytes, cfg) {
  const t = sync(srv, cfg);
  t.offsets[t.cycle] = Math.max(0, usedBytes) - usedBy(t.rx, t.tx, cfg.mode);
  saveLazy();
}

export function forgetTraffic(id) {
  delete db.traffic[id];
}

/** 给前端 / 告警用的摘要；没有任何数据时返回 null */
export function trafficSummary(srv, cfg) {
  if (!db.traffic[srv.id]) return null;
  const now = Date.now();
  const def = cycleDef(srv, cfg);
  const { start, end } = cycleAt(def, now);
  const t = sync(srv, cfg, now);
  const used = Math.max(0, usedBy(t.rx, t.tx, cfg.mode) + (t.offsets[start] || 0));
  const limit = limitOf(srv);
  const elapsed = now - start;
  // 线性外推到周期末（至少过了 6 小时才估，否则太不准）
  const projected = end && elapsed > 6 * 3_600_000 ? Math.round((used / elapsed) * (end - start)) : null;
  return {
    rx: t.rx,
    tx: t.tx,
    used,
    limit,
    pct: limit ? Math.round((used / limit) * 1000) / 10 : null,
    mode: cfg.mode,
    cycleType: def.type,
    cycleInherit: !!def.inherit,
    cycleStart: start,
    nextReset: end,
    projected,
    dailyAvg: elapsed > 3_600_000 ? Math.round((used / elapsed) * DAY) : null,
  };
}

/** 最近 n 个周期的用量（当前周期在最前），历史周期从时间桶汇总 */
export function trafficCycles(srv, cfg, n = 12) {
  const def = cycleDef(srv, cfg);
  const limit = limitOf(srv);
  const first = firstTrafficAt(srv.id);
  const now = Date.now();
  const t = db.traffic[srv.id] ? sync(srv, cfg, now) : null;
  const out = [];
  let at = now;
  for (let i = 0; i < n; i++) {
    const { start, end } = cycleAt(def, at);
    if (i > 0 && (first == null || (end ?? now) <= first)) break;
    const cur = i === 0;
    const s = sumTraffic(srv.id, start, cur ? now : end);
    const rx = cur && t ? t.rx : s.rx;
    const tx = cur && t ? t.tx : s.tx;
    const used = Math.max(0, usedBy(rx, tx, cfg.mode) + (t?.offsets[start] || 0));
    const span = ((cur ? now : end) - start) / 1000;
    out.push({
      start,
      end,
      current: cur,
      rx: Math.round(rx),
      tx: Math.round(tx),
      used: Math.round(used),
      limit,
      pct: limit ? Math.round((used / limit) * 1000) / 10 : null,
      coverage: span > 0 ? Math.min(100, Math.round((s.cov / span) * 1000) / 10) : 0,
      partial: first != null && first > start,
    });
    if (!end || def.type === 'none') break;
    at = start - 1;
  }
  return { def: { ...def }, mode: cfg.mode, cycles: out };
}
