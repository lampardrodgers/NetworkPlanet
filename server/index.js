// Network Planet Hub：REST API + SSE 实时推送 + 静态文件（生产模式下托管 dist/）。
// 只用 Node 内置模块，零后端依赖。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, save, flush, newId, newToken, normalizeServer, normalizeLink } from './store.js';
import { startMonitor, snapshot, ingestAgent, history, forget, tcpPing } from './monitor.js';
import { PROVIDERS, providerMeta } from './providers/index.js';
import { cityFromRegion } from './regions.js';
import { findCity } from '../shared/cities.js';
import { geoLookup } from './geoip.js';
import { seedDemo, clearDemo } from './demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 50000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const IS_PROD = process.env.NODE_ENV === 'production';

// 首次启动且库为空时自动灌入演示数据（NP_DEMO=0 关闭）
if (process.env.NP_DEMO !== '0' && db.servers.length === 0 && !db.settings.demoSeededOnce) {
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
    if (size > 5 * 1024 * 1024) throw new HttpError(413, '请求体过大');
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

function publicState() {
  return {
    servers: db.servers,
    links: db.links,
    accounts: db.accounts.map(publicAccount),
    providers: providerMeta(),
    settings: db.settings,
    authRequired: Boolean(ADMIN_TOKEN),
  };
}

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
setInterval(() => clients.size && broadcast('status', snapshot()), 3000);
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

route('GET', '/api/state', () => publicState());
route('GET', '/api/status', () => snapshot());

route('GET', '/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: status\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
  return undefined; // 保持连接
});

// ---- 服务器 CRUD ----
route('POST', '/api/servers', async (req, res, { body }) => {
  const srv = normalizeServer(body);
  if (!srv.ip && !srv.host && srv.lat == null && !srv.city) throw new HttpError(400, '至少需要 IP / 域名或位置');
  const loc = await resolveLocation(srv, srv.provider);
  if (loc) Object.assign(srv, loc);
  if (srv.lat == null) throw new HttpError(400, '无法确定位置：请填写城市或经纬度');
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
    );
    if (loc) Object.assign(next, loc, { locSource: body.lat != null ? 'manual' : loc.locSource });
  }
  Object.assign(old, next);
  save();
  changed('servers');
  return old;
});

route('DELETE', '/api/servers/:id', (req, res, { params }) => {
  findServer(params.id);
  db.servers = db.servers.filter((s) => s.id !== params.id);
  db.links = db.links.filter((l) => l.a !== params.id && l.b !== params.id);
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

route('POST', '/api/servers/:id/probe', async (req, res, { params }) => {
  const s = findServer(params.id);
  const rtt = await tcpPing(s.host || s.ip, s.probePort || 22);
  return { rtt };
});

// 批量导入（JSON 数组），可选 replace 覆盖
route('POST', '/api/import', async (req, res, { body }) => {
  const list = Array.isArray(body) ? body : body.servers || [];
  const links = Array.isArray(body.links) ? body.links : [];
  if (body.replace) {
    db.servers = [];
    db.links = [];
  }
  const idMap = {};
  let added = 0;
  const skipped = [];
  for (const raw of list) {
    const srv = normalizeServer(raw);
    const loc = await resolveLocation(srv, srv.provider);
    if (!loc) {
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
  save();
  changed('servers');
  return { added, skipped };
});

route('GET', '/api/export', () => ({
  exportedAt: new Date().toISOString(),
  servers: db.servers.map(({ agentToken, ...s }) => s),
  links: db.links,
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
  const allowed = ['showMeasuredMesh', 'probeIntervalSec', 'publicUrl'];
  for (const k of allowed) if (body[k] !== undefined) db.settings[k] = body[k];
  save();
  changed('settings');
  return db.settings;
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
  if (!s || !token || s.agentToken !== token) throw new HttpError(401, 'agent 认证失败');
  return s;
}

route(
  'POST',
  '/api/agent/report',
  (req, res, { url, body }) => {
    const s = agentAuth(req, url, body);
    ingestAgent(s.id, body);
    return { ok: true, interval: 10 };
  },
  { admin: false },
);

route(
  'GET',
  '/api/agent/peers',
  (req, res, { url }) => {
    const s = agentAuth(req, url, null);
    // 纯文本「id ip」每行一条，方便 shell 解析
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

function serveStatic(req, res, url) {
  const p = decodeURIComponent(url.pathname);
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
  startMonitor();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
