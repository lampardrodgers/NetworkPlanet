// 格式化 & 配色工具
export const LAT_COLORS = { good: '#34d399', ok: '#a3e635', warn: '#fbbf24', bad: '#fb7185', none: '#64748b' };
export const STATUS_COLORS = { online: '#34d399', offline: '#fb7185', unknown: '#94a3b8' };

export function latencyColor(ms) {
  if (ms == null) return LAT_COLORS.none;
  if (ms < 60) return LAT_COLORS.good;
  if (ms < 150) return LAT_COLORS.ok;
  if (ms < 250) return LAT_COLORS.warn;
  return LAT_COLORS.bad;
}

export function statusKey(st) {
  if (!st || st.online == null) return 'unknown';
  return st.online ? 'online' : 'offline';
}
export const STATUS_TEXT = { online: '在线', offline: '离线', unknown: '未知' };

export const fmtMs = (v) => (v == null ? '—' : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);
export const fmtPct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

export function fmtBps(v) {
  if (v == null) return '—';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let i = 0;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export const fmtMbps = (v) => (v == null ? '—' : v >= 1000 ? `${+(v / 1000).toFixed(1)} Gbps` : `${Math.round(v)} Mbps`);

export function fmtBytesMB(mb) {
  if (mb == null) return '—';
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}天 ${h}时` : h ? `${h}时 ${m}分` : `${m}分`;
}

export function fmtAgo(ts) {
  if (!ts) return '从未';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return new Date(ts).toLocaleString();
}

// 供应商配色（用于「按供应商着色」和标签）
const PROVIDER_PALETTE = ['#38bdf8', '#a78bfa', '#f472b6', '#facc15', '#2dd4bf', '#fb923c', '#60a5fa', '#c084fc', '#4ade80', '#f87171'];
const providerColorCache = {};
export function providerColor(p) {
  const k = (p || 'custom').toLowerCase();
  if (!providerColorCache[k]) {
    let h = 0;
    for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    providerColorCache[k] = PROVIDER_PALETTE[h % PROVIDER_PALETTE.length];
  }
  return providerColorCache[k];
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
