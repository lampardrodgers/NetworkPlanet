// 全局前端状态 + 极简事件总线。
import { estimateRttMs, CITIES } from '../shared/cities.js';

const listeners = {};
export const store = {
  servers: [],
  links: [],
  accounts: [],
  providers: [],
  settings: {},
  status: { servers: {}, peers: [] },
  /** 前端为每台机器累积的历史（与 /history 合并） */
  history: new Map(),
  selection: null, // { type: 'server'|'site'|'link', id }
  connected: false,
  view: loadView(),

  on(evt, fn) {
    (listeners[evt] ||= []).push(fn);
    return () => (listeners[evt] = listeners[evt].filter((f) => f !== fn));
  },
  emit(evt, payload) {
    for (const fn of listeners[evt] || []) fn(payload);
  },
};

function loadView() {
  const def = { autoRotate: true, showLinks: true, showMesh: false, showLinkLabels: false, showLabels: true };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem('np.view') || '{}') };
  } catch {
    return def;
  }
}
export function setView(patch) {
  Object.assign(store.view, patch);
  try {
    localStorage.setItem('np.view', JSON.stringify(store.view));
  } catch {}
  store.emit('view', store.view);
}

export const serverById = (id) => store.servers.find((s) => s.id === id);
export const statusOf = (id) => store.status.servers?.[id] || null;

export function select(sel) {
  const same = sel && store.selection && sel.type === store.selection.type && sel.id === store.selection.id;
  if (same) return;
  store.selection = sel;
  store.emit('select', sel);
}

/** 两台之间的实测数据：合并 a→b 与 b→a（任一方向有数据即可） */
export function measuredBetween(a, b) {
  const list = store.status.peers || [];
  const ab = list.find((p) => p.a === a && p.b === b);
  const ba = list.find((p) => p.a === b && p.b === a);
  const arr = [ab, ba].filter(Boolean);
  if (!arr.length) return null;
  const avg = (k) => {
    const v = arr.map((p) => p[k]).filter((x) => x != null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  return { rtt: avg('rtt'), loss: avg('loss'), jitter: avg('jitter'), mbps: avg('mbps'), ts: Math.max(...arr.map((p) => p.ts)) };
}

/**
 * 计算当前要画在地球上的连线：手动连接 + （可选）实测网格。
 * 返回 [{ key, a, b, link?, measured?, estimate, rtt, kind }]
 */
export function computeEdges() {
  const out = [];
  const seen = new Set();
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const push = (a, b, link, kind) => {
    const sa = serverById(a);
    const sb = serverById(b);
    if (!sa || !sb || sa.lat == null || sb.lat == null) return;
    const key = pairKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    const measured = measuredBetween(a, b);
    const estimate = estimateRttMs(sa, sb);
    out.push({ key, a, b, link, measured, estimate, rtt: measured?.rtt ?? null, kind });
  };
  if (store.view.showLinks) for (const l of store.links) push(l.a, l.b, l, 'manual');
  if (store.view.showMesh) for (const p of store.status.peers || []) push(p.a, p.b, null, 'mesh');
  return out;
}

/** 选中项相关的所有连线（即使全局关闭了显示，也要能在详情里看到） */
export function edgesOf(serverId) {
  return store.links
    .filter((l) => l.a === serverId || l.b === serverId)
    .map((l) => {
      const other = l.a === serverId ? l.b : l.a;
      return { link: l, other, measured: measuredBetween(serverId, other), estimate: estimateRttMs(serverById(serverId), serverById(other) || serverById(serverId)) };
    });
}

/** 英文城市名 → 中文显示名（不在表里就原样返回） */
const zhCache = {};
export function cityName(name) {
  if (!name) return '';
  if (!(name in zhCache)) {
    const c = CITIES.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    zhCache[name] = c ? c.zh : name;
  }
  return zhCache[name];
}

/** 前端维护的连线延迟历史（来自 SSE 推送），用于连线详情里的折线图 */
export const linkHistory = new Map();
export function recordLinkHistory() {
  const seen = new Set();
  for (const p of store.status.peers || []) {
    const key = p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = measuredBetween(p.a, p.b);
    const arr = linkHistory.get(key) || [];
    if (arr.length && arr[arr.length - 1].ts === m.ts) continue;
    arr.push({ ts: m.ts, rtt: m.rtt });
    if (arr.length > 120) arr.shift();
    linkHistory.set(key, arr);
  }
}
