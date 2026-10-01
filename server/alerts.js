// 告警：每 15 秒评估一次规则，状态变化（触发 / 恢复）时记录事件并发送通知。
// 演示服务器和「静音」的服务器不参与。
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { snapshot } from './monitor.js';
import { effectiveProbe } from './config.js';
import { notify } from './notify.js';

const EVAL_MS = 15_000;
const MAX_EVENTS = 300;
const state = new Map(); // "serverId|rule" -> { since, firing }
let onEvent = () => {};
export function onAlertEvent(fn) {
  onEvent = fn;
}

const RULE_NAMES = {
  offline: '离线',
  cpu: 'CPU 过高',
  mem: '内存过高',
  disk: '磁盘将满',
  traffic: '流量将超',
  targetLatency: '检测目标延迟过高',
  targetLoss: '检测目标丢包',
  expiry: '即将到期',
};

/** 计算每条规则当前是否满足，返回 { rule: { hit, holdMs, text } } */
function evaluate(srv, st, targets, rules) {
  const out = {};
  const ag = st?.agent;
  const r = rules;
  if (r.offline.enabled) out.offline = { hit: st?.online === false, holdMs: r.offline.sec * 1000, text: '无法连接（Hub 探测失败且 Agent 无上报）' };
  const lasting = (min) => (min ? `（持续 ${min} 分钟）` : '');
  if (r.cpu.enabled) out.cpu = { hit: ag?.cpu != null && ag.cpu >= r.cpu.pct, holdMs: r.cpu.min * 60_000, text: `CPU ${ag?.cpu ?? '—'}% ≥ ${r.cpu.pct}%${lasting(r.cpu.min)}` };
  if (r.mem.enabled) out.mem = { hit: ag?.mem != null && ag.mem >= r.mem.pct, holdMs: r.mem.min * 60_000, text: `内存 ${ag?.mem ?? '—'}% ≥ ${r.mem.pct}%${lasting(r.mem.min)}` };
  if (r.disk.enabled) out.disk = { hit: ag?.disk != null && ag.disk >= r.disk.pct, holdMs: 0, text: `磁盘已用 ${ag?.disk ?? '—'}% ≥ ${r.disk.pct}%` };
  if (r.traffic.enabled) {
    const tr = st?.traffic;
    out.traffic = { hit: tr?.pct != null && tr.pct >= r.traffic.pct, holdMs: 0, text: `本周期流量已用 ${tr?.pct ?? '—'}% ≥ ${r.traffic.pct}%` };
  }
  const enabledTargets = db.settings.targets.filter((t) => t.enabled);
  if (r.targetLatency.enabled) {
    const bad = enabledTargets.filter((t) => targets?.[t.id]?.rtt != null && targets[t.id].rtt >= r.targetLatency.ms);
    out.targetLatency = { hit: bad.length > 0, holdMs: r.targetLatency.min * 60_000, text: `${bad.map((t) => `${t.name} ${Math.round(targets[t.id].rtt)}ms`).join('、')} ≥ ${r.targetLatency.ms}ms` };
  }
  if (r.targetLoss.enabled) {
    const bad = enabledTargets.filter((t) => targets?.[t.id]?.loss != null && targets[t.id].loss >= r.targetLoss.pct);
    out.targetLoss = { hit: bad.length > 0, holdMs: r.targetLoss.min * 60_000, text: `${bad.map((t) => `${t.name} ${targets[t.id].loss}%`).join('、')} 丢包 ≥ ${r.targetLoss.pct}%` };
  }
  if (r.expiry.enabled && srv.expiresAt) {
    const days = Math.ceil((new Date(srv.expiresAt + 'T23:59:59').getTime() - Date.now()) / 86400_000);
    out.expiry = { hit: Number.isFinite(days) && days <= r.expiry.days, holdMs: 0, text: days < 0 ? `已过期 ${-days} 天（${srv.expiresAt}）` : `还有 ${days} 天到期（${srv.expiresAt}）` };
  }
  return out;
}

function record(srv, rule, level, text) {
  const ev = {
    id: crypto.randomBytes(5).toString('hex'),
    ts: Date.now(),
    serverId: srv.id,
    serverName: srv.name,
    rule,
    ruleName: RULE_NAMES[rule] || rule,
    level, // firing | resolved
    text,
  };
  db.events.push(ev);
  if (db.events.length > MAX_EVENTS) db.events.splice(0, db.events.length - MAX_EVENTS);
  save();
  onEvent(ev);
  const cfg = db.settings.alerts;
  if (level === 'firing' || cfg.recovery) {
    const title = `${level === 'firing' ? '🔴' : '✅'} ${srv.name} ${ev.ruleName}${level === 'resolved' ? ' 已恢复' : ''}`;
    const where = [srv.ip, srv.city].filter(Boolean).join(' · ');
    notify(cfg.channels, title, `${text}${where ? `\n${where}` : ''}\n${new Date(ev.ts).toLocaleString('zh-CN', { hour12: false })}`).catch((e) =>
      console.warn('[alerts] 通知发送失败：', e.message),
    );
  }
}

function tick() {
  const cfg = db.settings.alerts;
  if (!cfg?.enabled) {
    state.clear();
    return;
  }
  const snap = snapshot();
  const now = Date.now();
  const alive = new Set();
  for (const srv of db.servers) {
    if (srv.demo || srv.alertsMuted) continue;
    const results = evaluate(srv, snap.servers[srv.id], snap.targets[srv.id], cfg.rules);
    // 关闭了流量统计的机器不做流量告警
    if (!effectiveProbe(db.settings, srv).traffic.enabled) delete results.traffic;
    for (const [rule, r] of Object.entries(results)) {
      const key = `${srv.id}|${rule}`;
      alive.add(key);
      const s = state.get(key) || { since: null, firing: false };
      if (r.hit) {
        s.since ??= now;
        if (!s.firing && now - s.since >= r.holdMs) {
          s.firing = true;
          record(srv, rule, 'firing', r.text);
        }
      } else {
        s.since = null;
        if (s.firing) {
          s.firing = false;
          record(srv, rule, 'resolved', `${RULE_NAMES[rule]}已恢复`);
        }
      }
      state.set(key, s);
    }
  }
  // 删掉的服务器 / 关掉的规则：直接丢弃状态，不发恢复通知
  for (const k of state.keys()) if (!alive.has(k)) state.delete(k);
}

/** 当前正在告警的条目（给前端显示徽标） */
export function activeAlerts() {
  const out = [];
  for (const [k, s] of state) {
    if (!s.firing) continue;
    const [serverId, rule] = k.split('|');
    out.push({ serverId, rule, ruleName: RULE_NAMES[rule], since: s.since });
  }
  return out;
}

export function startAlerts() {
  // 等第一轮探测完成再开始评估，避免启动瞬间误报
  setTimeout(() => {
    tick();
    setInterval(tick, EVAL_MS).unref();
  }, 30_000).unref();
}
