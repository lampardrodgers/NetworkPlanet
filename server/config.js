// 探针 / 检测目标 / 告警 / 自动注册的配置：默认值、校验与「全局 + 单机覆盖」合并。
// 所有来自前端的配置都经过这里清洗后才写进 db.settings，Agent 拿到的值也只来自这里。
import crypto from 'node:crypto';

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};
const bool = (v, def) => (v === undefined || v === null ? def : Boolean(v));
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
/** 只允许主机名 / IPv4 / IPv6 字符，避免任何注入到 Agent 命令行的可能 */
export const safeHost = (v) => (/^[A-Za-z0-9.:_-]{1,253}$/.test(String(v || '').trim()) ? String(v).trim() : '');

export const PROBE_DEFAULTS = () => ({
  intervalSec: 10, // 基础指标上报间隔
  peers: { enabled: true, intervalSec: 60, method: 'icmp', count: 4 }, // tcp 方式连的是对方的「探测端口」
  targets: { enabled: true, intervalSec: 60, count: 4 },
  bandwidth: { enabled: true, port: 5201, durationSec: 5, autoHours: 0 },
  traffic: { enabled: true, resetDay: 1, mode: 'sum' },
});

export function normalizeProbe(input = {}, base = PROBE_DEFAULTS()) {
  const p = input || {};
  return {
    intervalSec: clamp(p.intervalSec, 3, 300, base.intervalSec),
    peers: {
      enabled: bool(p.peers?.enabled, base.peers.enabled),
      intervalSec: clamp(p.peers?.intervalSec, 10, 3600, base.peers.intervalSec),
      method: oneOf(p.peers?.method, ['icmp', 'tcp'], base.peers.method),
      count: clamp(p.peers?.count, 1, 10, base.peers.count),
    },
    targets: {
      enabled: bool(p.targets?.enabled, base.targets.enabled),
      intervalSec: clamp(p.targets?.intervalSec, 10, 3600, base.targets.intervalSec),
      count: clamp(p.targets?.count, 1, 10, base.targets.count),
    },
    bandwidth: {
      enabled: bool(p.bandwidth?.enabled, base.bandwidth.enabled),
      port: clamp(p.bandwidth?.port, 1, 65535, base.bandwidth.port),
      durationSec: clamp(p.bandwidth?.durationSec, 2, 30, base.bandwidth.durationSec),
      autoHours: clamp(p.bandwidth?.autoHours, 0, 168, base.bandwidth.autoHours),
    },
    traffic: {
      enabled: bool(p.traffic?.enabled, base.traffic.enabled),
      resetDay: clamp(p.traffic?.resetDay, 1, 28, base.traffic.resetDay),
      mode: oneOf(p.traffic?.mode, TRAFFIC_MODES, base.traffic.mode),
    },
  };
}

/** 流量计费方式：双向合计 / 只算出站 / 只算入站 / 取较大的一方 */
export const TRAFFIC_MODES = ['sum', 'out', 'in', 'max'];

// ---------------- 检测目标（三网 / 自定义） ----------------
// 默认值是国内三大运营商各地常用的 DNS 服务器地址，社区探针普遍拿它们测「三网延迟」。
// 运营商可能调整或屏蔽 ICMP，界面里可以随时增删改。
const T = (id, name, group, host, extra = {}) => ({ id, name, group, method: 'icmp', host, port: 0, enabled: true, ...extra });
export const DEFAULT_TARGETS = () => [
  T('ct-sh', '上海电信', '电信', '202.96.209.133', { city: 'shanghai' }),
  T('ct-bj', '北京电信', '电信', '219.141.136.10', { city: 'beijing' }),
  T('ct-gd', '广东电信', '电信', '202.96.128.86', { city: 'guangzhou' }),
  T('cu-sh', '上海联通', '联通', '210.22.70.3', { city: 'shanghai' }),
  T('cu-bj', '北京联通', '联通', '202.106.0.20', { city: 'beijing' }),
  T('cu-gd', '广东联通', '联通', '210.21.196.6', { city: 'guangzhou' }),
  T('cm-sh', '上海移动', '移动', '211.136.112.50', { city: 'shanghai' }),
  T('cm-bj', '北京移动', '移动', '221.130.33.60', { city: 'beijing' }),
  T('cm-gd', '广东移动', '移动', '120.196.165.24', { city: 'guangzhou' }),
  T('cf', 'Cloudflare', '公共', '1.1.1.1'),
  T('gg', 'Google', '公共', '8.8.8.8'),
];

export function normalizeTargets(list) {
  if (!Array.isArray(list)) return DEFAULT_TARGETS();
  const seen = new Set();
  const out = [];
  for (const t of list.slice(0, 60)) {
    const host = safeHost(t?.host);
    if (!host) continue;
    let id = /^[A-Za-z0-9_-]{1,32}$/.test(t.id || '') ? t.id : `t${crypto.randomBytes(3).toString('hex')}`;
    while (seen.has(id)) id = `t${crypto.randomBytes(3).toString('hex')}`;
    seen.add(id);
    const method = oneOf(t.method, ['icmp', 'tcp', 'http'], 'icmp');
    out.push({
      id,
      name: str(t.name, 40) || host,
      group: str(t.group, 20) || '自定义',
      method,
      host,
      port: method === 'icmp' ? 0 : clamp(t.port, 1, 65535, method === 'http' ? 80 : 443),
      enabled: bool(t.enabled, true),
      city: /^[a-z-]{1,40}$/.test(t.city || '') ? t.city : undefined,
    });
  }
  return out;
}

// ---------------- 告警 ----------------
export const ALERT_DEFAULTS = () => ({
  enabled: false,
  recovery: true, // 恢复时也通知
  rules: {
    offline: { enabled: true, sec: 90 },
    cpu: { enabled: true, pct: 90, min: 5 },
    mem: { enabled: true, pct: 90, min: 5 },
    disk: { enabled: true, pct: 90 },
    traffic: { enabled: true, pct: 80 },
    targetLatency: { enabled: false, ms: 300, min: 5 },
    targetLoss: { enabled: false, pct: 20, min: 5 },
    expiry: { enabled: true, days: 7 },
  },
  channels: {
    telegram: { enabled: false, botToken: '', chatId: '' },
    webhook: { enabled: false, type: 'generic', url: '' },
  },
});

export const WEBHOOK_TYPES = ['generic', 'dingtalk', 'wecom', 'feishu', 'bark'];

export function normalizeAlerts(input = {}, base = ALERT_DEFAULTS()) {
  const a = input || {};
  const r = a.rules || {};
  const b = base.rules;
  const ch = a.channels || {};
  const keepSecret = (v, old) => (v === undefined || String(v).includes('••••') ? old : str(v, 500));
  return {
    enabled: bool(a.enabled, base.enabled),
    recovery: bool(a.recovery, base.recovery),
    rules: {
      offline: { enabled: bool(r.offline?.enabled, b.offline.enabled), sec: clamp(r.offline?.sec, 15, 3600, b.offline.sec) },
      cpu: { enabled: bool(r.cpu?.enabled, b.cpu.enabled), pct: clamp(r.cpu?.pct, 1, 100, b.cpu.pct), min: clamp(r.cpu?.min, 0, 1440, b.cpu.min) },
      mem: { enabled: bool(r.mem?.enabled, b.mem.enabled), pct: clamp(r.mem?.pct, 1, 100, b.mem.pct), min: clamp(r.mem?.min, 0, 1440, b.mem.min) },
      disk: { enabled: bool(r.disk?.enabled, b.disk.enabled), pct: clamp(r.disk?.pct, 1, 100, b.disk.pct) },
      traffic: { enabled: bool(r.traffic?.enabled, b.traffic.enabled), pct: clamp(r.traffic?.pct, 1, 100, b.traffic.pct) },
      targetLatency: {
        enabled: bool(r.targetLatency?.enabled, b.targetLatency.enabled),
        ms: clamp(r.targetLatency?.ms, 1, 10000, b.targetLatency.ms),
        min: clamp(r.targetLatency?.min, 0, 1440, b.targetLatency.min),
      },
      targetLoss: {
        enabled: bool(r.targetLoss?.enabled, b.targetLoss.enabled),
        pct: clamp(r.targetLoss?.pct, 1, 100, b.targetLoss.pct),
        min: clamp(r.targetLoss?.min, 0, 1440, b.targetLoss.min),
      },
      expiry: { enabled: bool(r.expiry?.enabled, b.expiry.enabled), days: clamp(r.expiry?.days, 1, 90, b.expiry.days) },
    },
    channels: {
      telegram: {
        enabled: bool(ch.telegram?.enabled, base.channels.telegram.enabled),
        botToken: keepSecret(ch.telegram?.botToken, base.channels.telegram.botToken),
        chatId: ch.telegram?.chatId === undefined ? base.channels.telegram.chatId : str(ch.telegram.chatId, 64),
      },
      webhook: {
        enabled: bool(ch.webhook?.enabled, base.channels.webhook.enabled),
        type: oneOf(ch.webhook?.type, WEBHOOK_TYPES, base.channels.webhook.type),
        url: keepSecret(ch.webhook?.url, base.channels.webhook.url),
      },
    },
  };
}

// ---------------- 单台服务器的覆盖项 ----------------
/** server.probe：null 表示继承全局 */
export function normalizeServerProbe(input = {}) {
  const tri = (v) => (v === true || v === 'on' ? true : v === false || v === 'off' ? false : null);
  const optNum = (v, lo, hi) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : clamp(v, lo, hi, null));
  return {
    intervalSec: optNum(input.intervalSec, 3, 300),
    peers: tri(input.peers),
    targets: tri(input.targets),
    bandwidth: tri(input.bandwidth),
    traffic: tri(input.traffic),
    resetDay: optNum(input.resetDay, 1, 28),
    trafficMode: TRAFFIC_MODES.includes(input.trafficMode) ? input.trafficMode : null,
  };
}

/**
 * server.trafficCycle：单台机器自己的流量周期（null = 跟随全局「每月 N 号 0 点」）
 *  - monthly：每月在 at 那一天的同一时刻重置（31 号这类日期遇到小月取月底，之后仍按原日期）
 *  - days：从 at 起每 days 天重置一次（有的商家是 30 天一周期）
 *  - none：不重置，从 at 起一直累计（按量计费 / 一次性流量包）
 * at 是某一次重置的时刻（毫秒时间戳），tz 是商家结算用的时区（相对 UTC 的分钟数，如 UTC+8 = 480）
 */
export const CYCLE_TYPES = ['monthly', 'days', 'none'];
export function normalizeCycle(input) {
  if (!input || typeof input !== 'object' || !CYCLE_TYPES.includes(input.type)) return null;
  const at = Number(input.at);
  return {
    type: input.type,
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    days: clamp(input.days, 1, 3650, 30),
    tz: clamp(input.tz, -720, 840, 0),
  };
}

/** 计算某台服务器最终生效的探针配置 */
export function effectiveProbe(settings, srv) {
  const g = settings.probe;
  const o = srv?.probe || {};
  const pick = (v, d) => (v == null ? d : v);
  return {
    intervalSec: pick(o.intervalSec, g.intervalSec),
    peers: { ...g.peers, enabled: pick(o.peers, g.peers.enabled) },
    targets: { ...g.targets, enabled: pick(o.targets, g.targets.enabled) },
    bandwidth: { ...g.bandwidth, enabled: pick(o.bandwidth, g.bandwidth.enabled) },
    traffic: { ...g.traffic, enabled: pick(o.traffic, g.traffic.enabled), resetDay: pick(o.resetDay, g.traffic.resetDay), mode: pick(o.trafficMode, g.traffic.mode) },
  };
}

export const newEnrollKey = () => crypto.randomBytes(24).toString('base64url');

/** 补齐/清洗整个 settings（启动加载时调用一次） */
/** 线路模式里「本机」的位置：Hub 测的延迟就当作本机延迟（Hub 跑在自己电脑上时正好如此） */
export function normalizeOrigin(o) {
  const lat = Number(o?.lat);
  const lon = Number(o?.lon);
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return { name: str(o?.name, 30) || '本机', note: str(o?.note, 40), lat: ok ? lat : null, lon: ok ? lon : null };
}

export function normalizeSettings(s) {
  s.probe = normalizeProbe(s.probe);
  s.targets = normalizeTargets(s.targets);
  s.alerts = normalizeAlerts(s.alerts);
  s.origin = normalizeOrigin(s.origin);
  s.enroll = { enabled: bool(s.enroll?.enabled, true), key: s.enroll?.key || newEnrollKey() };
  return s;
}
