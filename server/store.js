// JSON 文件持久化：data/db.json。写入做了防抖 + 原子替换（先写 .tmp 再 rename）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.NP_DATA_DIR || path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = () => ({
  version: 1,
  servers: [],
  links: [],
  accounts: [],
  settings: { showMeasuredMesh: true, probeIntervalSec: 15 },
});

export const db = load();
let saveTimer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...EMPTY(), ...raw, settings: { ...EMPTY().settings, ...(raw.settings || {}) } };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] 读取 db.json 失败，使用空库：', err.message);
    return EMPTY();
  }
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

export function flush() {
  clearTimeout(saveTimer);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); // 内含 API Key，仅属主可读
  fs.renameSync(tmp, DB_FILE);
}

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const newToken = () => crypto.randomBytes(18).toString('base64url');

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? '' : String(v).trim());

/** 清洗外部传入的服务器对象，只保留已知字段 */
export function normalizeServer(input, existing = {}) {
  const s = { ...existing };
  const pick = (k, fn) => {
    if (input[k] !== undefined) s[k] = fn(input[k]);
  };
  pick('name', str);
  pick('ip', str);
  pick('host', str);
  pick('provider', str);
  pick('providerId', str);
  pick('accountId', str);
  pick('region', str);
  pick('city', str);
  pick('country', str);
  pick('lat', num);
  pick('lon', num);
  pick('probePort', num);
  pick('notes', str);
  pick('os', str);
  pick('monthlyCost', num);
  pick('expiresAt', str);
  pick('demo', Boolean);
  if (input.tags !== undefined) {
    s.tags = (Array.isArray(input.tags) ? input.tags : String(input.tags).split(','))
      .map((t) => String(t).trim())
      .filter(Boolean);
  }
  if (input.specs !== undefined && input.specs && typeof input.specs === 'object') {
    s.specs = {
      cpu: num(input.specs.cpu),
      ramMB: num(input.specs.ramMB),
      diskGB: num(input.specs.diskGB),
      bandwidthMbps: num(input.specs.bandwidthMbps),
      trafficTB: num(input.specs.trafficTB),
      plan: str(input.specs.plan),
    };
  }
  s.name ||= s.ip || '未命名服务器';
  s.tags ||= [];
  s.specs ||= {};
  s.probePort ??= 22;
  return s;
}

export function normalizeLink(input, existing = {}) {
  const l = { ...existing };
  if (input.a !== undefined) l.a = str(input.a);
  if (input.b !== undefined) l.b = str(input.b);
  if (input.label !== undefined) l.label = str(input.label);
  if (input.bandwidthMbps !== undefined) l.bandwidthMbps = num(input.bandwidthMbps);
  if (input.kind !== undefined) l.kind = str(input.kind) || 'custom';
  l.kind ||= 'custom';
  return l;
}
