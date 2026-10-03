import { backupService } from './backup.js';
import { deviceTests } from './local/device-tests.js';
import { LOCAL_MODE } from './local/config.js';
import { getMeasurement, putProfile, configureMeasurement, startRound, stopRound, reschedule, onMeasurement, shutdownMeasurement } from './local/engine.js';
// Network Planet Hub：REST API + SSE 实时推送 + 静态文件（生产模式下托管 dist/）。
// 只用 Node 内置模块，零后端依赖。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, save, flush, newId, newToken, normalizeServer, normalizeLink, normalizeRoute } from './store.js';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { startMonitor, snapshot, ingestAgent, history, forget, tcpPing, targetHistory } from './monitor.js';
import { normalizeProbe, normalizeTargets, normalizeAlerts, effectiveProbe, safeHost, newEnrollKey, DEFAULT_TARGETS, normalizeOrigin } from './config.js';
import { holdPoll, refreshAgents, requestBandwidth, taskReport, listTasks, onTaskUpdate, agentConnected } from './agentbus.js';
import { startAlerts, onAlertEvent, activeAlerts } from './alerts.js';
import { notify } from './notify.js';
import { calibrateTraffic, trafficCycles } from './traffic.js';
import { startHistory, flushHistory, query as queryHistory } from './history.js';
import { PROVIDERS, providerMeta } from './providers/index.js';
import { cityFromRegion } from './regions.js';
import { findCity } from '../shared/cities.js';
import { geoLookup } from './geoip.js';
import { seedDemo, clearDemo } from './demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 50000);
const HOST = LOCAL_MODE ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const IS_PROD = process.env.NODE_ENV === 'production';
// 当前 Agent 版本（从脚本里读），前端据此提示「需要升级」
const AGENT_VERSION = (fs.readFileSync(path.join(ROOT, 'agent', 'np-agent.sh'), 'utf8').match(/^VERSION="([^"]+)"/m) || [])[1] || '';

// 首次启动且库为空时自动灌入演示数据（NP_DEMO=0 关闭）
if (!LOCAL_MODE && process.env.NP_DEMO !== '0' && db.servers.length === 0 && !db.settings.demoSeededOnce) {
  seedDemo();
  db.settings.demoSeededOnce = true;
  save();
}

// ---------------- 工具 ----------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > (req.url.startsWith('/api/backups/') ? 10 : 5) * 1024 * 1024) throw new HttpError(413, '请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式错误');
  }
}

function checkAdmin(req, url) {
  if (!ADMIN_TOKEN) return;
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  if (tok !== ADMIN_TOKEN) throw new HttpError(401, '需要 ADMIN_TOKEN');
}

const mask = (v) => (v ? (String(v).length <= 8 ? '••••' : `${String(v).slice(0, 4)}••••${String(v).slice(-4)}`) : '');

function publicAccount(a) {
  const meta = PROVIDERS[a.provider];
  const creds = {};
  for (const f of meta?.fields || []) creds[f.key] = f.secret ? mask(a.credentials?.[f.key]) : a.credentials?.[f.key] || '';
  return { id: a.id, provider: a.provider, label: a.label, credentials: creds, lastSync: a.lastSync || null, lastError: a.lastError || null, count: a.count ?? null };
}

/** settings 里的密钥打码；注册密钥只通过 /api/enroll 单独获取 */
function publicSettings() {
  const s = structuredClone(db.settings);
  s.enroll = { enabled: s.enroll.enabled };
  s.alerts.channels.telegram.botToken = mask(s.alerts.channels.telegram.botToken);
  s.alerts.channels.webhook.url = mask(s.alerts.channels.webhook.url);
  return s;
}

function publicState() {
  const visible = new Set(db.servers.filter(s => !LOCAL_MODE || !s.demo).map(s => s.id));
  return {
    deviceRuns: db.deviceRuns || [],
    servers: db.servers.filter(s => !LOCAL_MODE || !s.demo).map(({agentToken, machineId, ...s}) => s),
    localMode: LOCAL_MODE,
    links: db.links.filter(l => visible.has(l.a) && visible.has(l.b)),
    routes: db.routes.filter(r => visible.has(r.to) && r.via.every(id => visible.has(id))),
    accounts: db.accounts.map(publicAccount),
    providers: providerMeta(),
    settings: publicSettings(),
    agentVersion: AGENT_VERSION,
    hubTz: -new Date().getTimezoneOffset(), // 全局流量周期按 Hub 时区算
    authRequired: Boolean(ADMIN_TOKEN),
  };
}

const statusPayload = () => {
  const snap = snapshot();
  for (const id of Object.keys(snap.servers)) snap.servers[id].poll = agentConnected(id);
  const local = LOCAL_MODE ? getMeasurement() : null;
  if (local) {
    const visible = new Set(db.servers.filter(s => !s.demo).map(s => s.id));
    for (const id of Object.keys(snap.servers)) {
      if (!visible.has(id)) { delete snap.servers[id]; continue; }
      const latest = local.results.filter(r => r.source === 'local' && r.target === id && r.kind === 'latency' && r.transport !== 'proxy').sort((a,b) => b.finishedAt-a.finishedAt);
      // 手动结果不因网页开了五分钟而消失；明确作为上次测试状态展示。
      const current = local.config.mode === 'manual' ? latest : latest.filter(r=>!r.stale);
      snap.servers[id].online = current.length ? current.some(r => r.state === 'ok') : null;
      snap.servers[id].measurementStale = !!latest[0]?.stale;
      snap.servers[id].lastCheckedAt = latest[0]?.finishedAt || null;
      snap.servers[id].hubRtt = (latest.find(r => r.method === 'icmp' && r.state === 'ok') || latest.find(r => r.method === 'tcp' && r.state === 'ok'))?.rtt ?? null;
    }
  }
  return { ...snap, local, alerts: activeAlerts() };
};

/** 统一的定位逻辑：显式坐标 > 供应商 region > 城市名 > IP 地理定位 */
async function resolveLocation(item, provider, { allowGeoip = true } = {}) {
  if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
    const c = item.city ? findCity(item.city) : null;
    return { lat: item.lat, lon: item.lon, city: item.city || c?.name || '', country: item.country || c?.cc || '', locSource: 'coords' };
  }
  const byRegion = cityFromRegion(provider, item.region);
  if (byRegion) return { lat: byRegion.lat, lon: byRegion.lon, city: byRegion.name, country: byRegion.cc, locSource: 'region' };
  const byCity = item.city ? findCity(item.city) : null;
  if (byCity) return { lat: byCity.lat, lon: byCity.lon, city: byCity.name, country: byCity.cc, locSource: 'city' };
  if (allowGeoip && (item.ip || item.host)) {
    const g = await geoLookup(item.ip || item.host);
    if (g) return { lat: g.lat, lon: g.lon, city: g.city, country: g.country, locSource: 'geoip' };
  }
  return null;
}

// ---------------- SSE ----------------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const changed = (what) => broadcast('changed', { what, ts: Date.now() });
onMeasurement(() => broadcast('status', statusPayload()));
setInterval(() => clients.size && broadcast('status', statusPayload()), 3000);
onTaskUpdate((t) => broadcast('task', t));
onAlertEvent((ev) => broadcast('alert', ev));
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);

// ---------------- 路由 ----------------
const routes = [];
const route = (method, pattern, handler, { admin = true } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, admin });
};

const findServer = (id) => {
  const s = db.servers.find((x) => x.id === id);
  if (!s) throw new HttpError(404, '服务器不存在');
  return s;
};

const deviceApi=deviceTests(db,save,()=>changed('device-tests'));
route('GET','/api/device-tests',()=>deviceApi.list());
route('PUT','/api/device-tests/location',(req,res,{body})=>deviceApi.location(body));
route('POST','/api/device-tests',(req,res,{body})=>deviceApi.create(body));
route('POST','/api/device-tests/upload',(req,res,{body})=>deviceApi.accept(body),{admin:false});
route('POST','/api/device-tests/script',(req,res,{body})=>{res.setHeader('Cache-Control','no-store');return deviceApi.fetchScript(body);},{admin:false});

route('GET', '/api/state', () => publicState());
route('GET', '/api/status', () => statusPayload());
route('GET', '/api/local', () => getMeasurement());
route('PUT', '/api/local/config', (req,res,{body}) => { try { const out=configureMeasurement(body); changed('measurement'); return out; } catch(e) { throw new HttpError(400,e.message); } });
route('PUT', '/api/local/profiles/:id', (req,res,{params,body}) => { try { const out=putProfile(params.id,body); changed('profiles'); return out; } catch(e) { throw new HttpError(400,e.message); } });
route('POST', '/api/local/rounds', (req,res,{body}) => { try { return startRound(body); } catch(e) { throw new HttpError(400,e.message); } });
route('POST', '/api/local/stop', () => stopRound());

route('GET', '/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
  return undefined; // 保持连接
});

// ---- 服务器 CRUD ----
route('POST', '/api/servers', async (req, res, { body }) => {
  const srv = normalizeServer(body);
  if (!LOCAL_MODE && !srv.ip && !srv.host && srv.lat == null && !srv.city) throw new HttpError(400, '至少需要 IP / 域名或位置');
  const loc = await resolveLocation(srv, srv.provider, { allowGeoip: !LOCAL_MODE });
  if (loc) Object.assign(srv, loc);
  if (!LOCAL_MODE && srv.lat == null) throw new HttpError(400, '无法确定位置：请填写城市或经纬度');
  srv.id = newId('srv');
  srv.agentToken = newToken();
  srv.createdAt = Date.now();
  db.servers.push(srv);
  save();
  changed('servers');
  return srv;
});

route('PUT', '/api/servers/:id', async (req, res, { params, body }) => {
  const old = findServer(params.id);
  const next = normalizeServer(body, old);
  const locChanged = body.lat !== undefined || body.lon !== undefined || body.city !== undefined;
  if (locChanged) {
    const loc = await resolveLocation(
      { ...next, lat: body.lat !== undefined ? next.lat : null, lon: body.lon !== undefined ? next.lon : null },
      next.provider,
      { allowGeoip: !LOCAL_MODE },
    );
    if (loc) Object.assign(next, loc, { locSource: body.lat != null ? 'manual' : loc.locSource });
  }
  Object.assign(old, next);
  save();
  changed('servers');
  if (body.probe !== undefined) refreshAgents([old.id]);
  return old;
});

// 明确请求才查询公网地址；不使用 frp 管理入口替代设备位置。
route('POST', '/api/servers/:id/locate', async (req, res, { params, body }) => {
  const srv = findServer(params.id);
  const egressIp = body.egressIp;
  if (egressIp !== undefined && (typeof egressIp !== 'string' || !net.isIP(egressIp))) throw new HttpError(400, '出口 IP 格式不正确');
  if (!egressIp && !srv.ip && !srv.host) throw new HttpError(400, '设备没有独立公网地址，请填写实际城市');
  const g = await geoLookup(egressIp || srv.ip || srv.host);
  if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) throw new HttpError(404, 'IP 定位失败');
  Object.assign(srv, { lat: g.lat, lon: g.lon, city: g.city, country: g.country, locSource: egressIp ? 'egress-geoip' : 'geoip', locIp: egressIp || g.ip, locProvider: 'ip-api.com', locUpdatedAt: Date.now() });
  save();
  changed('servers');
  return { id: srv.id, lat: srv.lat, lon: srv.lon, city: srv.city, country: srv.country, locSource: srv.locSource };
});

route('DELETE', '/api/servers/:id', (req, res, { params }) => {
  findServer(params.id);
  db.servers = db.servers.filter((s) => s.id !== params.id);
  db.links = db.links.filter((l) => l.a !== params.id && l.b !== params.id);
  db.routes = db.routes.filter((r) => r.to !== params.id && r.from !== `srv:${params.id}` && !r.via.includes(params.id));
  delete db.localProfiles[params.id];
  db.settings.measurement.scope = db.settings.measurement.scope.filter(id => id !== params.id);
  if (!db.settings.measurement.scope.length) db.settings.measurement.mode = 'manual';
  for (const p of Object.values(db.localProfiles)) for (const k of ['managementVia','businessVia']) p[k] = (p[k] || []).filter(id => id !== params.id);
  reschedule();
  forget(params.id);
  save();
  changed('servers');
  return { ok: true };
});

route('POST', '/api/servers/:id/rotate-token', (req, res, { params }) => {
  const s = findServer(params.id);
  s.agentToken = newToken();
  save();
  return { agentToken: s.agentToken };
});

route('GET', '/api/servers/:id/history', (req, res, { params }) => history(params.id));
route('GET', '/api/servers/:id/targets', (req, res, { params }) => targetHistory(params.id));

// 校准本周期已用流量（GB）
route('POST', '/api/servers/:id/traffic', (req, res, { params, body }) => {
  const s = findServer(params.id);
  const gb = Number(body.usedGB);
  if (!Number.isFinite(gb) || gb < 0) throw new HttpError(400, '请填写已用流量（GB）');
  calibrateTraffic(s, gb * 1e9, effectiveProbe(db.settings, s).traffic);
  return { ok: true };
});

// 长期历史（图表）：from / to 毫秒时间戳，step 300 / 3600 / 86400 秒，tz 为浏览器时区（相对 UTC 的分钟数，按天汇总时切日用）
route('GET', '/api/servers/:id/metrics', (req, res, { params, url }) => {
  findServer(params.id);
  const q = (k, d) => (url.searchParams.has(k) && Number.isFinite(Number(url.searchParams.get(k))) ? Number(url.searchParams.get(k)) : d);
  const to = Math.min(q('to', Date.now()), Date.now());
  const from = Math.max(q('from', to - 86_400_000), to - 400 * 86_400_000);
  if (!(to > from)) throw new HttpError(400, '时间范围不对');
  const step = q('step', to - from <= 2 * 86_400_000 ? 300 : to - from <= 45 * 86_400_000 ? 3600 : 86400);
  return queryHistory(params.id, { from, to, step, tz: Math.max(-720, Math.min(840, q('tz', 0))) });
});

// 历史流量周期（当前周期在最前）
route('GET', '/api/servers/:id/cycles', (req, res, { params, url }) => {
  const s = findServer(params.id);
  const n = Math.max(1, Math.min(36, Number(url.searchParams.get('n')) || 12));
  return trafficCycles(s, effectiveProbe(db.settings, s).traffic, n);
});

route('POST', '/api/servers/:id/probe', async (req, res, { params }) => {
  const s = findServer(params.id);
  const rtt = await tcpPing(s.host || s.ip, s.probePort || 22);
  return { rtt };
});

// 加密完整备份只开放管理员接口；恢复过程不触发测量。
const backups=backupService({db,dataDir:process.env.NP_DATA_DIR||path.resolve('data'),flush,busy:()=>!!getMeasurement().active,changed,reschedule});
for(const action of ['export','preview','apply','basic-preview','basic-apply'])route('POST','/api/backups/'+action,async(req,res,{body})=>{
  if(!LOCAL_MODE)throw new HttpError(400,'完整迁移目前用于本地测量模式');
  try{return await backups[action](body);}catch(e){throw new HttpError(400,e.message);}
});
route('GET','/api/backups/rollback/:id',(req,res,{params})=>{
  try{return backups.rollback(params.id);}catch{throw new HttpError(404,'未找到回滚备份');}
});

// 批量导入（JSON 数组），可选 replace 覆盖
route('POST', '/api/import', async (req, res, { body }) => {
  if(body.format==='network-planet-encrypted')throw new HttpError(400,'请使用完整备份接口');
  if(getMeasurement().active)throw new HttpError(409,'当前正在测量，请结束本轮后再导入');
  const list = Array.isArray(body) ? body : body.servers || [];
  const links = Array.isArray(body.links) ? body.links : [];
  if (body.replace) {
    db.servers = [];
    db.links = [];
    db.routes = [];
    db.localProfiles = {};
    db.settings.measurement = {...db.settings.measurement,mode:'manual',scope:[]};
    reschedule();
  }
  const idMap = {};
  let added = 0;
  const skipped = [];
  for (const raw of list) {
    const srv = normalizeServer(raw);
    const loc = await resolveLocation(srv, srv.provider, { allowGeoip: !LOCAL_MODE });
    if (!loc && !LOCAL_MODE) {
      skipped.push(srv.name);
      continue;
    }
    Object.assign(srv, loc);
    srv.id = newId('srv');
    srv.agentToken = newToken();
    srv.createdAt = Date.now();
    if (raw.id) idMap[raw.id] = srv.id;
    idMap[srv.name] = srv.id;
    db.servers.push(srv);
    added++;
  }
  for (const raw of links) {
    const a = idMap[raw.a] || raw.a;
    const b = idMap[raw.b] || raw.b;
    if (!db.servers.some((s) => s.id === a) || !db.servers.some((s) => s.id === b)) continue;
    const l = normalizeLink({ ...raw, a, b });
    l.id = newId('lnk');
    db.links.push(l);
  }
  for(const raw of Array.isArray(body.routes)?body.routes:[]){
    const r=normalizeRoute({...raw,to:idMap[raw.to]||raw.to,via:(raw.via||[]).map(id=>idMap[id]||id),from:raw.from?.startsWith('srv:')?'srv:'+(idMap[raw.from.slice(4)]||raw.from.slice(4)):raw.from});
    if(!r.from||!db.servers.some(s=>s.id===r.to)||!r.via.every(id=>db.servers.some(s=>s.id===id)))continue;
    if(r.from.startsWith('srv:')&&!db.servers.some(s=>s.id===r.from.slice(4)))continue;
    r.id=newId('route');db.routes=db.routes.filter(x=>x.from!==r.from||x.to!==r.to);db.routes.push(r);
  }
  save();
  changed('servers');
  return { added, skipped };
});

route('GET', '/api/export', () => ({
  exportedAt: new Date().toISOString(),
  servers: db.servers.map(({ agentToken, machineId, ...s }) => s),
  links: db.links,
  routes: db.routes,
}));

// ---- 连接 ----
route('POST', '/api/links', (req, res, { body }) => {
  const l = normalizeLink(body);
  if (!l.a || !l.b || l.a === l.b) throw new HttpError(400, '需要两台不同的服务器');
  findServer(l.a);
  findServer(l.b);
  if (db.links.some((x) => (x.a === l.a && x.b === l.b) || (x.a === l.b && x.b === l.a))) throw new HttpError(409, '这两台之间已有连接');
  l.id = newId('lnk');
  db.links.push(l);
  save();
  changed('links');
  return l;
});
route('PUT', '/api/links/:id', (req, res, { params, body }) => {
  const l = db.links.find((x) => x.id === params.id);
  if (!l) throw new HttpError(404, '连接不存在');
  Object.assign(l, normalizeLink(body, l));
  save();
  changed('links');
  return l;
});
route('DELETE', '/api/links/:id', (req, res, { params }) => {
  db.links = db.links.filter((x) => x.id !== params.id);
  save();
  changed('links');
  return { ok: true };
});

// ---- 线路（线路模式：起点 → 中转 → 终点） ----
function checkRoute(r) {
  if (!r.from || !r.to) throw new HttpError(400, '需要起点和终点');
  findServer(r.to);
  for (const v of r.via) findServer(v);
  if (r.from.startsWith('srv:')) findServer(r.from.slice(4));
  if (r.from.startsWith('tgt:') && !db.settings.targets.some((t) => `tgt:${t.id}` === r.from)) throw new HttpError(400, '检测目标不存在');
  const chain = [r.from.startsWith('srv:') ? r.from.slice(4) : null, ...r.via, r.to].filter(Boolean);
  if (new Set(chain).size !== chain.length) throw new HttpError(400, '线路里有重复的服务器');
}
route('POST', '/api/routes', (req, res, { body }) => {
  const r = normalizeRoute(body);
  checkRoute(r);
  // 同一起点到同一终点只保留一条，新的覆盖旧的
  db.routes = db.routes.filter((x) => !(x.from === r.from && x.to === r.to));
  r.id = newId('rte');
  db.routes.push(r);
  save();
  changed('routes');
  return r;
});
route('PUT', '/api/routes/:id', (req, res, { params, body }) => {
  const r = db.routes.find((x) => x.id === params.id);
  if (!r) throw new HttpError(404, '线路不存在');
  const next = normalizeRoute(body, r);
  checkRoute(next);
  Object.assign(r, next);
  save();
  changed('routes');
  return r;
});
route('DELETE', '/api/routes/:id', (req, res, { params }) => {
  db.routes = db.routes.filter((x) => x.id !== params.id);
  save();
  changed('routes');
  return { ok: true };
});

// ---- 供应商账号 & API 导入 ----
const syncCache = new Map(); // accountId -> items

route('POST', '/api/accounts', (req, res, { body }) => {
  const meta = PROVIDERS[body.provider];
  if (!meta) throw new HttpError(400, '未知供应商');
  const credentials = {};
  for (const f of meta.fields) {
    const v = body.credentials?.[f.key];
    if (!v && !f.optional) throw new HttpError(400, `缺少 ${f.label}`);
    credentials[f.key] = v ? String(v).trim() : '';
  }
  const a = { id: newId('acc'), provider: meta.id, label: String(body.label || meta.name).trim(), credentials, createdAt: Date.now() };
  db.accounts.push(a);
  save();
  changed('accounts');
  return publicAccount(a);
});

route('PUT', '/api/accounts/:id', (req, res, { params, body }) => {
  const a = db.accounts.find((x) => x.id === params.id);
  if (!a) throw new HttpError(404, '账号不存在');
  if (body.label !== undefined) a.label = String(body.label).trim();
  // 只有显式填写的字段才覆盖（前端看到的是打码值，未修改则不传）
  for (const [k, v] of Object.entries(body.credentials || {})) if (v && !String(v).includes('••••')) a.credentials[k] = String(v).trim();
  save();
  changed('accounts');
  return publicAccount(a);
});

route('DELETE', '/api/accounts/:id', (req, res, { params }) => {
  db.accounts = db.accounts.filter((x) => x.id !== params.id);
  syncCache.delete(params.id);
  save();
  changed('accounts');
  return { ok: true };
});

route('POST', '/api/accounts/:id/sync', async (req, res, { params }) => {
  const a = db.accounts.find((x) => x.id === params.id);
  if (!a) throw new HttpError(404, '账号不存在');
  const meta = PROVIDERS[a.provider];
  let items;
  try {
    items = await meta.list(a.credentials);
    a.lastError = null;
  } catch (e) {
    a.lastError = e.message;
    save();
    throw new HttpError(502, `${meta.name} API 调用失败：${e.message}`);
  }
  const provider = a.provider === 'generic' ? null : a.provider;
  for (const it of items) {
    it.provider = it.provider || provider || 'custom';
    const loc = await resolveLocation(it, it.provider);
    if (loc) Object.assign(it, loc);
    it.existingId = db.servers.find((s) => s.accountId === a.id && s.providerId === it.providerId)?.id || null;
  }
  a.lastSync = Date.now();
  a.count = items.length;
  syncCache.set(a.id, items);
  save();
  changed('accounts');
  return { items };
});

route('POST', '/api/accounts/:id/import', async (req, res, { params, body }) => {
  const a = db.accounts.find((x) => x.id === params.id);
  if (!a) throw new HttpError(404, '账号不存在');
  const items = syncCache.get(a.id);
  if (!items) throw new HttpError(400, '请先同步（拉取列表）');
  const wanted = new Set(body.providerIds || items.map((i) => i.providerId));
  let added = 0;
  let updated = 0;
  for (const it of items) {
    if (!wanted.has(it.providerId)) continue;
    const existing = db.servers.find((s) => s.accountId === a.id && s.providerId === it.providerId);
    if (existing) {
      // 更新供应商侧字段，保留用户自己改过的名称 / 标签 / 备注 / 手动位置
      existing.ip = it.ip || existing.ip;
      existing.region = it.region;
      existing.os = it.os || existing.os;
      existing.providerStatus = it.status;
      existing.specs = { ...existing.specs, ...Object.fromEntries(Object.entries(it.specs || {}).filter(([, v]) => v != null)) };
      if (existing.locSource !== 'manual' && it.lat != null) Object.assign(existing, { lat: it.lat, lon: it.lon, city: it.city, country: it.country, locSource: it.locSource });
      updated++;
      continue;
    }
    if (it.lat == null) continue;
    const srv = normalizeServer({ ...it, accountId: a.id });
    Object.assign(srv, { id: newId('srv'), agentToken: newToken(), createdAt: Date.now(), locSource: it.locSource, providerStatus: it.status });
    db.servers.push(srv);
    added++;
  }
  save();
  changed('servers');
  return { added, updated };
});

// ---- 杂项 ----
route('GET', '/api/geoip', async (req, res, { url }) => {
  const q = url.searchParams.get('ip');
  const g = await geoLookup(q);
  if (!g) throw new HttpError(404, '定位失败');
  return g;
});

route('PUT', '/api/settings', (req, res, { body }) => {
  if (body.showMeasuredMesh !== undefined) db.settings.showMeasuredMesh = Boolean(body.showMeasuredMesh);
  if (body.probeIntervalSec !== undefined) db.settings.probeIntervalSec = Math.min(600, Math.max(5, Number(body.probeIntervalSec) || 15));
  if (body.publicUrl !== undefined) {
    const u = String(body.publicUrl || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s'"`$\\]+$/.test(u)) throw new HttpError(400, 'Hub 公网地址格式不对，应类似 https://planet.example.com');
    db.settings.publicUrl = u;
  }
  let agentsAffected = false;
  if (body.probe !== undefined) {
    db.settings.probe = normalizeProbe(body.probe, db.settings.probe);
    agentsAffected = true;
  }
  if (body.targets !== undefined) {
    db.settings.targets = body.targets === 'default' ? DEFAULT_TARGETS() : normalizeTargets(body.targets);
    agentsAffected = true;
  }
  if (body.alerts !== undefined) db.settings.alerts = normalizeAlerts(body.alerts, db.settings.alerts);
  if (body.origin !== undefined) db.settings.origin = normalizeOrigin(body.origin);
  if (body.enroll?.enabled !== undefined) db.settings.enroll.enabled = Boolean(body.enroll.enabled);
  save();
  changed('settings');
  if (agentsAffected) refreshAgents();
  return publicSettings();
});

// ---- 一键安装 / 自动注册 ----
route('GET', '/api/enroll', () => ({ ...db.settings.enroll, agentVersion: AGENT_VERSION }));
route('POST', '/api/enroll/rotate', () => {
  db.settings.enroll.key = newEnrollKey();
  save();
  return db.settings.enroll;
});

// ---- 带宽测试 ----
route('POST', '/api/bandwidth', (req, res, { body }) => {
  try {
    return requestBandwidth(String(body.a || ''), String(body.b || ''));
  } catch (e) {
    throw new HttpError(409, e.message);
  }
});
route('GET', '/api/bandwidth/tasks', () => listTasks());

// ---- 告警 ----
route('GET', '/api/events', () => [...db.events].reverse());
route('DELETE', '/api/events', () => {
  db.events = [];
  save();
  return { ok: true };
});
route('POST', '/api/alerts/test', async () => {
  const ch = db.settings.alerts.channels;
  if (!(ch.telegram.enabled && ch.telegram.botToken && ch.telegram.chatId) && !(ch.webhook.enabled && ch.webhook.url)) {
    throw new HttpError(400, '还没有启用任何通知渠道');
  }
  return notify(ch, '🔔 Network Planet 测试通知', `如果你看到这条消息，说明告警通知配置正确。\n${new Date().toLocaleString('zh-CN', { hour12: false })}`);
});

route('POST', '/api/demo', () => {
  const r = seedDemo();
  changed('servers');
  return r;
});
route('DELETE', '/api/demo', () => {
  const ids = clearDemo();
  ids.forEach(forget);
  changed('servers');
  return { removed: ids.length };
});

// ---- Agent 端点（使用每台服务器自己的 agentToken 认证，不需要 ADMIN_TOKEN）----
function agentAuth(req, url, body) {
  const id = body?.id || url.searchParams.get('id');
  const token = req.headers['x-np-token'] || body?.token || url.searchParams.get('token');
  const s = db.servers.find((x) => x.id === id);
  if (!s || !token || !safeEqual(s.agentToken, token)) throw new HttpError(401, 'agent 认证失败');
  return s;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const text = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

/** 请求方的公网 IP（经反向代理时取 X-Forwarded-For 第一个） */
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isPublicIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (v === 6) return !/^(::1?$|fe[89ab]|f[cd]|::ffff:)/i.test(ip);
  return false;
}

/**
 * 下发给 Agent 的配置（纯文本，每行「类型 参数…」，方便 bash 用 read 解析）。
 * 第一行 v <hash>：Agent 带着 hash 上报，配置没变时只回 same，省流量。
 */
function agentDirectives(srv) {
  const c = effectiveProbe(db.settings, srv);
  const b = (v) => (v ? 1 : 0);
  const lines = [
    `cfg interval ${c.intervalSec}`,
    `cfg peers ${b(c.peers.enabled)}`,
    `cfg peer_interval ${c.peers.intervalSec}`,
    `cfg peer_method ${c.peers.method}`,
    `cfg peer_count ${c.peers.count}`,
    `cfg targets ${b(c.targets.enabled)}`,
    `cfg target_interval ${c.targets.intervalSec}`,
    `cfg target_count ${c.targets.count}`,
    `cfg traffic ${b(c.traffic.enabled)}`,
    `cfg bandwidth ${b(c.bandwidth.enabled)}`,
  ];
  if (c.peers.enabled) {
    for (const o of db.servers) {
      const host = safeHost(o.host || o.ip);
      if (o.id === srv.id || o.demo || !host) continue;
      lines.push(`peer ${o.id} ${host} ${Number(o.probePort) || 22}`);
    }
  }
  if (c.targets.enabled) {
    for (const t of db.settings.targets) if (t.enabled) lines.push(`target ${t.id} ${t.method} ${t.host} ${t.port || 0}`);
  }
  const hash = crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 10);
  return { hash, text: `v ${hash}\n${lines.join('\n')}\n` };
}

// 一条命令通装：用注册密钥换取这台机器的 id / token
route(
  'POST',
  '/api/agent/register',
  async (req, res, { body }) => {
    const en = db.settings.enroll;
    if (!en.enabled) throw new HttpError(403, '自动注册已关闭（在「安装探针」里开启）');
    if (!safeEqual(en.key, body.key)) throw new HttpError(401, '注册密钥错误');
    const str = (v, n = 80) => (v == null ? '' : String(v).trim().slice(0, n));
    const machineId = /^[a-f0-9]{16,64}$/.test(body.machineId || '') ? body.machineId : '';
    const remote = clientIp(req);
    const ips = [remote, ...(Array.isArray(body.ips) ? body.ips : [])].map((x) => str(x, 45)).filter((x) => net.isIP(x) && isPublicIp(x));
    const pubIp = ips[0] || '';

    // 1) 同一台机器重装：按 machine-id；2) 已经通过 API / 手动加过：按 IP 认领
    let srv = (machineId && db.servers.find((s) => !s.demo && s.machineId === machineId)) || db.servers.find((s) => !s.demo && !s.machineId && s.ip && ips.includes(s.ip));
    const specs = { cpu: Number(body.cores) || null, ramMB: Number(body.ramMB) || null, diskGB: Number(body.diskGB) || null };
    let created = false;
    if (!srv) {
      srv = normalizeServer({
        name: str(body.name) || str(body.hostname) || pubIp || '新服务器',
        ip: pubIp,
        tags: str(body.tags, 200),
        os: str(body.os),
        provider: str(body.provider, 40),
        specs,
      });
      const loc = await resolveLocation({ ...srv, city: str(body.city) }, srv.provider);
      if (!loc) throw new HttpError(400, `无法确定位置（公网 IP：${pubIp || '未知'}）。请在安装命令里加上 NP_CITY="Los Angeles" 这样的城市名`);
      Object.assign(srv, loc, { id: newId('srv'), agentToken: newToken(), createdAt: Date.now(), source: 'agent' });
      db.servers.push(srv);
      created = true;
    } else {
      // 只补空缺字段，不覆盖用户 / 供应商 API 填过的
      srv.os ||= str(body.os);
      srv.ip ||= pubIp;
      srv.specs = { ...specs, ...Object.fromEntries(Object.entries(srv.specs || {}).filter(([, v]) => v != null && v !== '')) };
      if (body.name) srv.name = str(body.name);
    }
    if (machineId) srv.machineId = machineId;
    srv.agentToken ||= newToken();
    save();
    changed('servers');
    console.log(`[agent] ${created ? '新注册' : '认领'} ${srv.name} (${srv.id}) 来自 ${remote}`);
    return text(res, `NP_ID=${srv.id}\nNP_TOKEN=${srv.agentToken}\nNP_NAME=${srv.name.replace(/[^\w.\-一-龥 ]/g, '')}\n`);
  },
  { admin: false },
);

route(
  'POST',
  '/api/agent/report',
  (req, res, { url, body }) => {
    const s = agentAuth(req, url, body);
    ingestAgent(s, body);
    const d = agentDirectives(s);
    return text(res, body.cfgv === d.hash ? 'same\n' : d.text);
  },
  { admin: false },
);

// 长轮询：Hub 有指令（测速任务 / 配置变更）时立即返回
route(
  'GET',
  '/api/agent/poll',
  (req, res, { url }) => {
    const s = agentAuth(req, url, null);
    holdPoll(s.id, req, res);
    return undefined;
  },
  { admin: false },
);

route(
  'POST',
  '/api/agent/task',
  (req, res, { url, body }) => {
    const s = agentAuth(req, url, body);
    return { ok: taskReport(s.id, body) };
  },
  { admin: false },
);

// 兼容 0.1 版 Agent
route(
  'GET',
  '/api/agent/peers',
  (req, res, { url }) => {
    const s = agentAuth(req, url, null);
    return db.servers
      .filter((x) => x.id !== s.id && !x.demo && (x.ip || x.host))
      .map((x) => `${x.id} ${x.ip || x.host}`)
      .join('\n');
  },
  { admin: false },
);

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.sh': 'text/x-shellscript; charset=utf-8', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

function serveFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// Hub 自举安装：/hub/install.sh 是填好代码包地址的安装脚本，/hub/bundle.tar.gz 现场打包本 Hub 的代码（不含 data/）
const BUNDLE_FILES = ['package.json', 'server', 'shared', 'agent', 'dist', 'scripts', 'README.md', 'docs'];
function hubOrigin(req) {
  return db.settings.publicUrl || `http://${req.headers.host || `localhost:${PORT}`}`;
}
function serveHubInstaller(req, res, p) {
  if (p === '/hub/install.sh') {
    const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'install-hub.sh'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(sh.replace('__NP_SRC__', `${hubOrigin(req)}/hub/bundle.tar.gz`));
  }
  if (p === '/hub/bundle.tar.gz') {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) return send(res, 503, '这台 Hub 还没有构建前端（npm run build），不能提供代码包');
    const files = BUNDLE_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));
    const tar = spawn('tar', ['-czf', '-', '-C', ROOT, ...files], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="network-planet.tar.gz"' });
    tar.stdout.pipe(res);
    tar.on('error', () => res.destroy());
    req.on('close', () => tar.kill());
    return;
  }
  send(res, 404, 'Not Found');
}

function serveStatic(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith('/hub/')) return serveHubInstaller(req, res, p);
  if (p.startsWith('/agent/')) {
    const f = path.join(ROOT, 'agent', path.basename(p));
    return serveFile(res, f);
  }
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    return send(res, 200, IS_PROD ? '请先运行 npm run build' : 'Hub API 运行中。开发模式请访问 Vite 地址（默认 http://localhost:50001）');
  }
  const file = path.normalize(path.join(dist, p));
  if (!file.startsWith(dist)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, stat) => serveFile(res, !err && stat.isFile() ? file : path.join(dist, 'index.html')));
}

// ---------------- 启动 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (LOCAL_MODE) {
      const h = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
      if (!['localhost','127.0.0.1','[::1]'].includes(h)) throw new HttpError(403, '只允许本地访问');
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (!['http:','https:'].includes(origin.protocol) || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) throw new HttpError(403, '不允许跨站访问本地服务');
      }
      if (['POST','PUT','DELETE'].includes(req.method) && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不允许跨站操作');
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, '接口不存在');
    if (r.admin) checkAdmin(req, url);
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : null;
    const out = await r.handler(req, res, { params, body, url });
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[network-planet] Hub 已启动 http://localhost:${PORT}${ADMIN_TOKEN ? '（已启用 ADMIN_TOKEN）' : ''}`);
  startHistory(new Set(db.servers.map((s) => s.id)));
  startMonitor();
  if (!LOCAL_MODE) startAlerts();
  reschedule();
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.race([shutdownMeasurement(), new Promise(resolve => setTimeout(resolve, 5000))]);
    flush();
    flushHistory();
    process.exit(0);
  });
}
