// Hub → Agent 的下行通道 + 服务器间带宽测试编排。
//
// 下行通道：Agent 常驻一个长轮询 GET /api/agent/poll，Hub 有指令时立即返回（纯文本，每行一条）：
//   refresh                                  配置变了，马上重新上报拉取新配置
//   task <id> iperf-server <port> <maxSec>   在本机起 iperf3 服务端
//   task <id> iperf-client <host> <port> <durSec>  作为客户端测到 host 的上行 + 下行（-R）
//   task <id> stop                           提前结束 iperf3 服务端
// Hub 不会下发任意命令，Agent 端也只认上面这几种固定格式。
//
// 带宽测试流程：B 起服务端 → 回报 ready → A 跑客户端 → 回报结果 → 通知 B 结束。
import crypto from 'node:crypto';
import { db, save } from './store.js';
import { effectiveProbe, safeHost } from './config.js';
import { status } from './monitor.js';

const POLL_HOLD_MS = 45_000;
const AGENT_FRESH_MS = 90_000;

// ---------------- 长轮询 ----------------
const waiters = new Map(); // serverId -> res
const outbox = new Map(); // serverId -> string[]

function deliver(id) {
  const res = waiters.get(id);
  const box = outbox.get(id);
  if (!res || !box?.length) return;
  waiters.delete(id);
  outbox.delete(id);
  clearTimeout(res._npTimer);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(box.join('\n') + '\n');
}

export function sendToAgent(id, line) {
  const box = outbox.get(id) || [];
  if (!box.includes(line)) box.push(line);
  outbox.set(id, box);
  deliver(id);
}

/** 通知所有在线 Agent 立即重新拉配置 */
export function refreshAgents(ids = null) {
  for (const s of db.servers) if (!s.demo && (!ids || ids.includes(s.id))) sendToAgent(s.id, 'refresh');
}

export function holdPoll(id, req, res) {
  const old = waiters.get(id);
  if (old) {
    clearTimeout(old._npTimer);
    old.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    old.end('\n');
  }
  waiters.set(id, res);
  res._npTimer = setTimeout(() => {
    if (waiters.get(id) !== res) return;
    waiters.delete(id);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('\n');
  }, POLL_HOLD_MS);
  req.on('close', () => {
    if (waiters.get(id) === res) {
      clearTimeout(res._npTimer);
      waiters.delete(id);
    }
  });
  deliver(id);
}

export const agentConnected = (id) => waiters.has(id);

// ---------------- 带宽测试 ----------------
const tasks = new Map(); // id -> task
const queue = []; // 等待执行的 { a, b, auto }
let onUpdate = () => {};
export function onTaskUpdate(fn) {
  onUpdate = fn;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const activeTask = () => [...tasks.values()].find((t) => t.state === 'starting' || t.state === 'running');

function publicTask(t) {
  const { timer, ...rest } = t;
  return rest;
}
export const listTasks = () => [...tasks.values()].map(publicTask).sort((x, y) => y.created - x.created).slice(0, 30);

/** 检查两台能不能测，返回错误原因（中文）或 null */
export function bandwidthBlocker(aId, bId) {
  const a = db.servers.find((s) => s.id === aId);
  const b = db.servers.find((s) => s.id === bId);
  if (!a || !b) return '服务器不存在';
  if (a.id === b.id) return '两端不能是同一台';
  if (a.demo || b.demo) return '演示服务器不能真实测速';
  for (const s of [a, b]) {
    const st = status.get(s.id);
    if (!st?.agent || Date.now() - st.lastAgent > AGENT_FRESH_MS) return `${s.name} 的 Agent 不在线`;
    if (!effectiveProbe(db.settings, s).bandwidth.enabled) return `${s.name} 关闭了带宽测试`;
    if (!st.agent.iperf) return `${s.name} 没有安装 iperf3（重新运行安装命令会自动安装）`;
  }
  if (!safeHost(b.host || b.ip)) return `${b.name} 没有可用的 IP / 域名`;
  return null;
}

export function requestBandwidth(aId, bId, { auto = false } = {}) {
  const why = bandwidthBlocker(aId, bId);
  if (why) throw new Error(why);
  const key = pairKey(aId, bId);
  if (queue.some((q) => pairKey(q.a, q.b) === key) || [...tasks.values()].some((t) => (t.state === 'starting' || t.state === 'running') && t.key === key)) {
    throw new Error('这两台的测试已经在排队或进行中');
  }
  queue.push({ a: aId, b: bId, auto });
  const t = runNext();
  return t ? publicTask(t) : { queued: true, position: queue.length };
}

function runNext() {
  if (activeTask() || !queue.length) return null;
  const { a, b, auto } = queue.shift();
  const why = bandwidthBlocker(a, b);
  if (why) {
    if (!auto) console.warn('[bandwidth] 跳过：', why);
    return runNext();
  }
  const sa = db.servers.find((s) => s.id === a);
  const sb = db.servers.find((s) => s.id === b);
  const cfg = effectiveProbe(db.settings, sb).bandwidth;
  const t = {
    id: crypto.randomBytes(5).toString('hex'),
    key: pairKey(a, b),
    a,
    b,
    aName: sa.name,
    bName: sb.name,
    host: safeHost(sb.host || sb.ip),
    port: cfg.port,
    dur: cfg.durationSec,
    auto,
    state: 'starting',
    created: Date.now(),
  };
  // 两个方向各 dur 秒，再留出启动和网络余量
  t.timer = setTimeout(() => finish(t, { error: '超时：Agent 没有及时响应（检查 iperf3 端口防火墙）' }), (t.dur * 2 + 60) * 1000);
  tasks.set(t.id, t);
  sendToAgent(b, `task ${t.id} iperf-server ${t.port} ${t.dur * 2 + 40}`);
  onUpdate(publicTask(t));
  return t;
}

function finish(t, { up = null, down = null, error = null }) {
  if (t.state === 'done' || t.state === 'error') return;
  clearTimeout(t.timer);
  t.state = error ? 'error' : 'done';
  t.error = error;
  t.up = up;
  t.down = down;
  t.finished = Date.now();
  sendToAgent(t.b, `task ${t.id} stop`);
  if (!error) {
    db.bandwidth[t.key] = { a: t.a, b: t.b, up, down, ts: t.finished };
    save();
  }
  onUpdate(publicTask(t));
  // 只保留最近 50 条
  if (tasks.size > 50) for (const k of [...tasks.keys()].slice(0, tasks.size - 50)) tasks.delete(k);
  setTimeout(runNext, 1000);
}

/** Agent 回报任务进度：body = { id: 服务器 id, task: 任务 id, state, ... } */
export function taskReport(serverId, body) {
  const t = tasks.get(String(body.task || ''));
  if (!t || (serverId !== t.a && serverId !== t.b)) return false;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
  if (body.state === 'error') finish(t, { error: String(body.error || '未知错误').slice(0, 200) });
  else if (body.state === 'ready' && serverId === t.b && t.state === 'starting') {
    t.state = 'running';
    sendToAgent(t.a, `task ${t.id} iperf-client ${t.host} ${t.port} ${t.dur}`);
    onUpdate(publicTask(t));
  } else if (body.state === 'done' && serverId === t.a) {
    const up = num(body.up);
    const down = num(body.down);
    if (up == null && down == null) finish(t, { error: String(body.error || 'iperf3 没有输出结果').slice(0, 200) });
    else finish(t, { up, down });
  }
  return true;
}

// 定时自动测速：对所有「手动连接」，距上次结果（或上次尝试）超过 autoHours 的排进队列
const lastAuto = new Map();
setInterval(() => {
  const h = db.settings.probe?.bandwidth?.autoHours;
  if (!h) return;
  const now = Date.now();
  for (const l of db.links) {
    if (l.demo) continue;
    const key = pairKey(l.a, l.b);
    const last = Math.max(db.bandwidth[key]?.ts || 0, lastAuto.get(key) || 0);
    if (now - last < h * 3600_000) continue;
    if (bandwidthBlocker(l.a, l.b)) continue;
    lastAuto.set(key, now);
    try {
      requestBandwidth(l.a, l.b, { auto: true });
    } catch {}
  }
}, 5 * 60_000).unref();
