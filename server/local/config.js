// 本地模式配置：默认不发起测量，所有任务必须有明确范围。
import net from 'node:net';
export const LOCAL_MODE = process.env.NP_MODE !== 'legacy';
export const METHODS = ['icmp', 'tcp', 'ssh-banner', 'vless'];
export function host(v) {
  const s = String(v || '').trim().replace(/^\[|\]$/g, '');
  if (!s || s.length > 253 || (!net.isIP(s) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(s))) throw new Error('无效主机地址');
  return s;
}
export function integer(v, min, max, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}范围为 ${min}～${max}`);
  return n;
}
const ids = (a) => {
  if (!Array.isArray(a) || a.length > 500 || a.some(x => !/^[\w-]{1,64}$/.test(x))) throw new Error('节点范围无效');
  return [...new Set(a)];
};
export function normalizeMeasurement(input = {}, old = {}) {
  const p = { mode: 'manual', intervalSec: null, scope: [], remote: false, ...old, ...input };
  if (!['manual', 'auto'].includes(p.mode)) throw new Error('请选择手动或自动测试');
  p.intervalSec = p.intervalSec == null ? null : integer(p.intervalSec, 60, 86400, '周期（秒）');
  p.scope = ids(p.scope);
  if (p.mode === 'auto' && (!p.intervalSec || !p.scope.length)) throw new Error('自动测试需要设置周期并选择节点');
  if (p.directInterface && !/^(en\d+|eth\d+|wlan\d+|wlp\w+|enp\w+)$/.test(p.directInterface)) throw new Error('DIRECT 网卡格式不正确');
  const r = { enabled: false, withAuto: false, refreshSec: 21600, ...old.routeAnalysis, ...input.routeAnalysis };
  return { directInterface: String(p.directInterface || ''), proxyTests: p.proxyTests === true, mode: p.mode, intervalSec: p.intervalSec, scope: p.scope, remote: p.remote === true,
    routeAnalysis: { enabled: r.enabled === true, withAuto: r.withAuto === true, refreshSec: integer(r.refreshSec, 300, 604800, '线路刷新周期（秒）') } };
}
export function normalizeProfile(p = {}, old = {}) {
  const o = { ...old, ...p };
  const cleanIds = a => ids(a || []).slice(0, 4);
  const out = { methods: (o.methods || ['icmp']).filter(x => METHODS.includes(x)),
    managementVia: cleanIds(o.managementVia), businessVia: cleanIds(o.businessVia),
    note: String(o.note || '').slice(0, 500), disabled: o.disabled === true, verified: false };
  if (o.endpoint?.host) out.endpoint = { host: host(o.endpoint.host), port: integer(o.endpoint.port || 22, 1, 65535, '服务端口') };
  if (o.frpServer?.host) out.frpServer = { host: host(o.frpServer.host), port: integer(o.frpServer.port, 1, 65535, 'frps 端口') };
  if (o.ssh) {
    const s = { ...old.ssh, ...o.ssh };
    if (!/^[a-zA-Z0-9_][\w.-]{0,63}$/.test(s.user || '')) throw new Error('SSH 用户名无效');
    if (s.identityFile && !/^\/(?!.*[\r\n\0]).+/.test(s.identityFile)) throw new Error('密钥需要本地绝对路径');
    const jump = s.jump ? { host: host(s.jump.host), user: String(s.jump.user), port: integer(s.jump.port || 22, 1, 65535, '跳板端口') } : null;
    if (jump && !/^[a-zA-Z0-9_][\w.-]{0,63}$/.test(jump.user)) throw new Error('跳板用户名无效');
    out.ssh = { host: host(s.host), port: integer(s.port || 22, 1, 65535, 'SSH 端口'), user: s.user, identityFile: String(s.identityFile || ''), jump };
  }
  return out;
}
