// 运行时监控状态（只在内存中，不落盘）：
//  - Hub 探测：Hub 所在机器定时对每台服务器做 TCP connect，得到 Hub→服务器 RTT 与在线状态
//  - Agent 上报：服务器上的 np-agent 上报 CPU/内存/磁盘/网速，以及它到其它服务器的 ping（构成互联延迟矩阵）
//  - 演示模式：demo=true 的服务器由这里模拟数据
import net from 'node:net';
import { db } from './store.js';
import { estimateRttMs } from '../shared/cities.js';

const HISTORY_LEN = 240; // 每台机器保留的历史点数
const AGENT_STALE_MS = 90_000;
const PEER_STALE_MS = 300_000;

export const status = new Map(); // id -> { hubRtt, hubOnline, lastProbe, agent, lastAgent, history[] }
export const peers = new Map(); // "a|b" -> { a, b, rtt, loss, jitter, ts, mbps? }

function st(id) {
  if (!status.has(id)) status.set(id, { hubRtt: null, hubOnline: null, lastProbe: 0, agent: null, lastAgent: 0, history: [] });
  return status.get(id);
}

export function forget(id) {
  status.delete(id);
  for (const k of peers.keys()) if (k.startsWith(id + '|') || k.endsWith('|' + id)) peers.delete(k);
}

function pushHistory(s, point) {
  s.history.push(point);
  if (s.history.length > HISTORY_LEN) s.history.splice(0, s.history.length - HISTORY_LEN);
}

/** TCP connect 测延迟。连接被拒绝（RST）也说明主机可达，RTT 同样有效。 */
export function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok ? Number(process.hrtime.bigint() - t0) / 1e6 : null);
    };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(e.code === 'ECONNREFUSED'));
  });
}

async function probeAll() {
  const targets = db.servers.filter((s) => !s.demo && (s.ip || s.host));
  await Promise.all(
    targets.map(async (srv) => {
      const rtt = await tcpPing(srv.host || srv.ip, srv.probePort || 22);
      const s = st(srv.id);
      s.hubRtt = rtt == null ? null : Math.round(rtt * 10) / 10;
      s.hubOnline = rtt != null;
      s.lastProbe = Date.now();
      pushHistory(s, { t: s.lastProbe, hubRtt: s.hubRtt, ...pickMetrics(s.agent, s.lastAgent) });
    }),
  );
}

function pickMetrics(agent, lastAgent) {
  if (!agent || Date.now() - lastAgent > AGENT_STALE_MS) return {};
  return { cpu: agent.cpu, mem: agent.mem, rx: agent.rxBps, tx: agent.txBps };
}

/** 处理 agent 上报 */
export function ingestAgent(id, body) {
  const s = st(id);
  const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  s.agent = {
    cpu: n(body.cpu),
    mem: n(body.mem),
    memTotalMB: n(body.memTotalMB),
    disk: n(body.disk),
    rxBps: n(body.rxBps),
    txBps: n(body.txBps),
    load1: n(body.load1),
    uptimeSec: n(body.uptimeSec),
    hostname: body.hostname ? String(body.hostname).slice(0, 80) : undefined,
    kernel: body.kernel ? String(body.kernel).slice(0, 80) : undefined,
    version: body.version ? String(body.version).slice(0, 20) : undefined,
  };
  s.lastAgent = Date.now();
  if (Array.isArray(body.peers)) {
    for (const p of body.peers) {
      if (!p?.id || p.id === id) continue;
      peers.set(`${id}|${p.id}`, {
        a: id,
        b: String(p.id),
        rtt: n(p.rtt),
        loss: n(p.loss),
        jitter: n(p.jitter),
        mbps: n(p.mbps),
        ts: Date.now(),
      });
    }
  }
  pushHistory(s, { t: s.lastAgent, hubRtt: s.hubRtt, ...pickMetrics(s.agent, s.lastAgent) });
}

/** 合成发给前端的状态快照 */
export function snapshot() {
  const now = Date.now();
  const servers = {};
  for (const srv of db.servers) {
    const s = st(srv.id);
    const agentFresh = s.agent && now - s.lastAgent < AGENT_STALE_MS;
    let online = null;
    if (agentFresh) online = true;
    else if (s.hubOnline != null) online = s.hubOnline;
    servers[srv.id] = {
      online,
      hubRtt: s.hubRtt,
      lastProbe: s.lastProbe || null,
      lastSeen: s.lastAgent || null,
      agent: agentFresh ? s.agent : null,
    };
  }
  const peerList = [];
  for (const p of peers.values()) if (now - p.ts < PEER_STALE_MS) peerList.push(p);
  return { ts: now, servers, peers: peerList };
}

export function history(id) {
  return st(id).history;
}

// ---------------- 演示数据模拟 ----------------
const demoState = new Map();
const rnd = (a, b) => a + Math.random() * (b - a);
const drift = (v, min, max, step) => Math.min(max, Math.max(min, v + rnd(-step, step)));

function simulateDemo() {
  const demos = db.servers.filter((s) => s.demo);
  const now = Date.now();
  for (const srv of demos) {
    let d = demoState.get(srv.id);
    if (!d) {
      d = {
        cpu: rnd(5, 60),
        mem: rnd(20, 80),
        disk: rnd(15, 85),
        rx: rnd(1e5, 5e7),
        tx: rnd(1e5, 5e7),
        base: srv.lat != null ? estimateRttMs({ lat: 31.23, lon: 121.47 }, srv) : 80, // 假设 Hub 在上海
        down: Math.random() < 0.04,
        uptime: rnd(3600, 9e6),
      };
      demoState.set(srv.id, d);
    }
    if (Math.random() < (d.down ? 0.05 : 0.0015)) d.down = !d.down; // 偶尔掉线、很快恢复，让演示更真实
    d.cpu = drift(d.cpu, 1, 99, 8);
    d.mem = drift(d.mem, 8, 97, 2);
    d.rx = drift(d.rx, 1e4, 1.2e8, 6e6);
    d.tx = drift(d.tx, 1e4, 1.2e8, 6e6);
    d.uptime += 3;
    const s = st(srv.id);
    s.hubOnline = !d.down;
    s.hubRtt = d.down ? null : Math.round((d.base + rnd(0, 8)) * 10) / 10;
    s.lastProbe = now;
    if (!d.down) {
      s.agent = {
        cpu: +d.cpu.toFixed(1), mem: +d.mem.toFixed(1), memTotalMB: srv.specs?.ramMB || 2048, disk: +d.disk.toFixed(1),
        rxBps: Math.round(d.rx), txBps: Math.round(d.tx), load1: +(d.cpu / 25).toFixed(2), uptimeSec: Math.round(d.uptime),
        hostname: srv.name, kernel: '6.1.0-demo', version: 'demo',
      };
      s.lastAgent = now;
    } else {
      s.agent = null;
      s.lastAgent = 0;
    }
    pushHistory(s, { t: now, hubRtt: s.hubRtt, ...pickMetrics(s.agent, s.lastAgent) });
  }
  // 演示服务器之间的互联矩阵
  for (const a of demos) {
    for (const b of demos) {
      if (a.id >= b.id) continue;
      const da = demoState.get(a.id);
      const dbb = demoState.get(b.id);
      const key = `${a.id}|${b.id}`;
      if (da?.down || dbb?.down) {
        peers.set(key, { a: a.id, b: b.id, rtt: null, loss: 100, jitter: null, ts: now });
        continue;
      }
      const base = estimateRttMs(a, b);
      const prev = peers.get(key);
      const mbps = prev?.mbps != null ? drift(prev.mbps, 5, 950, 40) : rnd(50, 800);
      peers.set(key, {
        a: a.id, b: b.id,
        rtt: Math.round((base + rnd(0, base * 0.08 + 1)) * 10) / 10,
        loss: Math.random() < 0.08 ? +rnd(0.5, 6).toFixed(1) : 0,
        jitter: +rnd(0.1, 4).toFixed(1),
        mbps: Math.round(mbps),
        ts: now,
      });
    }
  }
}

let probeTimer;
export function startMonitor() {
  const loop = async () => {
    try {
      await probeAll();
    } catch (e) {
      console.error('[monitor] probe error', e);
    }
    probeTimer = setTimeout(loop, Math.max(5, db.settings.probeIntervalSec || 15) * 1000);
  };
  loop();
  setInterval(simulateDemo, 3000);
  simulateDemo();
}

export function stopMonitor() {
  clearTimeout(probeTimer);
}
