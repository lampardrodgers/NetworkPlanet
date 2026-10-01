// 流量周期计算（Hub 和前端共用）。def = { type: 'monthly' | 'days' | 'none', at, days, tz }，见 server/config.js 的 normalizeCycle。
const DAY = 86_400_000;

/** 包含时刻 now 的周期 [start, end)；end 为 null 表示不重置 */
export function cycleAt(def, now = Date.now()) {
  if (def.type === 'none') return { start: def.at, end: null };
  if (def.type === 'days') {
    const p = def.days * DAY;
    const start = def.at + Math.floor((now - def.at) / p) * p;
    return { start, end: start + p };
  }
  // monthly：在商家时区里取「每月 day 号 hh:mm」，小月取月底，之后仍按原来的日期
  const shift = (def.tz || 0) * 60_000;
  const a = new Date(def.at + shift);
  const day = a.getUTCDate();
  const hh = a.getUTCHours();
  const mm = a.getUTCMinutes();
  const at = (y, m) => Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()), hh, mm) - shift;
  const n = new Date(now + shift);
  const y = n.getUTCFullYear();
  let m = n.getUTCMonth();
  if (at(y, m) > now) m--;
  return { start: at(y, m), end: at(y, m + 1) };
}

/** 全局默认周期：每月 resetDay 号 0 点（tz 时区） */
export function monthlyDef(resetDay, tz, now = Date.now()) {
  const n = new Date(now + tz * 60_000);
  return { type: 'monthly', at: Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), resetDay || 1) - tz * 60_000, tz };
}
