// 运行时监控状态（只在内存中，不落盘）：
//  - Hub 探测：Hub 所在机器定时对每台服务器做 TCP connect，得到 Hub→服务器 RTT 与在线状态
//  - Agent 上报：服务器上的 np-agent 上报 CPU/内存/磁盘/网速，以及它到其它服务器的 ping（构成互联延迟矩阵）
//  - 演示模式：demo=true 的服务器由这里模拟数据
import net from 'node:net';
import { db } from './store.js';
import { estimateRttMs, CITY_BY_KEY } from '../shared/cities.js';
import { effectiveProbe } from './config.js';
import { ingestTraffic, trafficSummary, forgetTraffic } from './traffic.js';
import { recordMetrics, recordProbe, forgetHistory, synthDemoHistory } from './history.js';

const HISTORY_LEN = 240; // 每台机器保留的历史点数
const AGENT_STALE_MS = 90_000;
const PEER_STALE_MS = 300_000;

export const status = new Map(); // id -> { hubRtt, hubOnline, lastProbe, agent, lastAgent, history[] }
export const peers = new Map(); // "a|b" -> { a, b, rtt, loss, jitter, ts }
export const targetResults = new Map(); // "serverId|targetId" -> { rtt, loss, jitter, ts, hist: [{t, rtt, loss}] }
const TARGET_HIST = 120;

function st(id) {
  if (!status.has(id)) status.set(id, { hubRtt: null, hubOnline: null, lastProbe: 0, agent: null, lastAgent: 0, history: [] });
  return status.get(id);
}

export function forget(id) {
  status.delete(id);
  for (const k of peers.keys()) if (k.startsWith(id + '|') || k.endsWith('|' + id)) peers.delete(k);
  for (const k of targetResults.keys()) if (k.startsWith(id + '|')) targetResults.delete(k);
  for (const k of Object.keys(db.bandwidth)) if (k.startsWith(id + '|') || k.endsWith('|' + id)) delete db.bandwidth[k];
  forgetTraffic(id);
  forgetHistory(id);
}

function recordTarget(sid, tid, r, now) {
  const key = `${sid}|${tid}`;
  const old = targetResults.get(key);
  const hist = old?.hist || [];
  hist.push({ t: now, rtt: r.rtt, loss: r.loss });
  if (hist.length > TARGET_HIST) hist.splice(0, hist.length - TARGET_HIST);
  targetResults.set(key, { rtt: r.rtt, loss: r.loss, jitter: r.jitter, ts: now, hist });
}

export function targetHistory(sid) {
  const out = {};
  for (const [k, v] of targetResults) if (k.startsWith(sid + '|')) out[k.slice(sid.length + 1)] = v.hist;
  return out;
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
      recordProbe(srv.id, s.hubRtt);
      pushHistory(s, { t: s.lastProbe, hubRtt: s.hubRtt, ...pickMetrics(s.agent, s.lastAgent) });
    }),
  );
}

function pickMetrics(agent, lastAgent) {
  if (!agent || Date.now() - lastAgent > AGENT_STALE_MS) return {};
  return { cpu: agent.cpu, mem: agent.mem, rx: agent.rxBps, tx: agent.txBps };
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const text = (v, max = 80) => (v ? String(v).slice(0, max) : undefined);

/** 处理 agent 上报（字段白名单读取，新增字段要在这里加） */
export function ingestAgent(srv, body) {
  const id = srv.id;
  const s = st(id);
  const n = num;
  const now = Date.now();
  s.agent = {
    cpu: n(body.cpu),
    cores: n(body.cores),
    mem: n(body.mem),
    memTotalMB: n(body.memTotalMB),
    swap: n(body.swap),
    disk: n(body.disk),
    diskTotalGB: n(body.diskTotalGB),
    rxBps: n(body.rxBps),
    txBps: n(body.txBps),
    load1: n(body.load1),
    load5: n(body.load5),
    load15: n(body.load15),
    uptimeSec: n(body.uptimeSec),
    conns: n(body.conns),
    procs: n(body.procs),
    hostname: text(body.hostname),
    kernel: text(body.kernel),
    os: text(body.os),
    arch: text(body.arch, 20),
    version: text(body.version, 20),
    iperf: body.iperf === true || body.iperf === 1 || body.iperf === '1',
  };
  s.lastAgent = now;
  const cfg = effectiveProbe(db.settings, srv);
  if (cfg.traffic.enabled) ingestTraffic(srv, n(body.rxBytes), n(body.txBytes), cfg.traffic);
  const a = s.agent;
  recordMetrics(id, { cpu: a.cpu, mem: a.mem, disk: a.disk, load: a.load1, conns: a.conns, rxBps: a.rxBps, txBps: a.txBps }, now);
  if (Array.isArray(body.peers)) {
    for (const p of body.peers) {
      if (!p?.id || p.id === id) continue;
      peers.set(`${id}|${p.id}`, { a: id, b: String(p.id), rtt: n(p.rtt), loss: n(p.loss), jitter: n(p.jitter), ts: now });
    }
  }
  if (Array.isArray(body.targets)) {
    const known = new Set(db.settings.targets.map((t) => t.id));
    for (const t of body.targets) if (t?.id && known.has(t.id)) recordTarget(id, t.id, { rtt: n(t.rtt), loss: n(t.loss), jitter: n(t.jitter) }, now);
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
      traffic: trafficSummary(srv, effectiveProbe(db.settings, srv).traffic),
    };
  }
  const peerList = [];
  for (const p of peers.values()) if (now - p.ts < PEER_STALE_MS) peerList.push(p);
  // 检测目标结果：{ serverId: { targetId: { rtt, loss, jitter, ts } } }
  const targets = {};
  for (const [k, v] of targetResults) {
    if (now - v.ts > PEER_STALE_MS) continue;
    const i = k.lastIndexOf('|');
    (targets[k.slice(0, i)] ||= {})[k.slice(i + 1)] = { rtt: v.rtt, loss: v.loss, jitter: v.jitter, ts: v.ts };
  }
  return { ts: now, servers, peers: peerList, targets, bandwidth: [...Object.values(db.bandwidth), ...demoBandwidth.values()] };
}

export function history(id) {
  return st(id).history;
}

// ---------------- 演示数据模拟 ----------------
const demoState = new Map();
const demoBandwidth = new Map(); // 演示连接的带宽测试结果（只在内存）
let demoTargetsAt = 0;
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
        // 假设 Hub 在上海；非 CN2 / 非香港的机器回国绕路，直连明显更慢，线路模式里才看得出中转的价值
        base: srv.lat != null ? estimateRttMs({ lat: 31.23, lon: 121.47 }, srv) * (srv.tags?.includes('cn2') || srv.country === 'HK' ? 1 : 1.6) : 80,
        down: Math.random() < 0.04,
        uptime: rnd(3600, 9e6),
        rxBytes: rnd(1e9, 5e11),
        txBytes: rnd(1e9, 5e11),
        conns: Math.round(rnd(20, 800)),
      };
      demoState.set(srv.id, d);
      // 演示机：生成 45 天历史，日均流量按「套餐额度 × 随机比例 / 30」，流量条和图表才有看头
      const limit = (srv.specs?.trafficTB || 1) * 1e12;
      const dailyBytes = (limit / 30) * rnd(0.25, 1.05);
      synthDemoHistory(srv.id, { cpu: d.cpu, mem: d.mem, disk: d.disk, rtt: d.base, dailyBytes }, now);
      d.netBase = (dailyBytes * 8) / 86400 / 2; // 实时网速和历史日均对得上
      d.rx = d.tx = d.netBase;
      delete db.traffic[srv.id]; // 让本周期用量从刚生成的历史重新汇总
    }
    if (Math.random() < (d.down ? 0.05 : 0.0015)) d.down = !d.down; // 偶尔掉线、很快恢复，让演示更真实
    d.cpu = drift(d.cpu, 1, 99, 8);
    d.mem = drift(d.mem, 8, 97, 2);
    d.rx = drift(d.rx, d.netBase * 0.2, d.netBase * 3, d.netBase * 0.3);
    d.tx = drift(d.tx, d.netBase * 0.2, d.netBase * 3, d.netBase * 0.3);
    d.uptime += 3;
    d.rxBytes += (d.rx / 8) * 3;
    d.txBytes += (d.tx / 8) * 3;
    d.conns = Math.round(drift(d.conns, 5, 3000, 30));
    const s = st(srv.id);
    s.hubOnline = !d.down;
    s.hubRtt = d.down ? null : Math.round((d.base + rnd(0, 8)) * 10) / 10;
    s.lastProbe = now;
    recordProbe(srv.id, s.hubRtt, now);
    if (!d.down) {
      s.agent = {
        cpu: +d.cpu.toFixed(1), cores: srv.specs?.cpu || 1, mem: +d.mem.toFixed(1), memTotalMB: srv.specs?.ramMB || 2048, swap: 0,
        disk: +d.disk.toFixed(1), diskTotalGB: srv.specs?.diskGB || 40,
        rxBps: Math.round(d.rx), txBps: Math.round(d.tx), load1: +(d.cpu / 25).toFixed(2), uptimeSec: Math.round(d.uptime),
        conns: d.conns, procs: 80 + (d.conns % 60),
        hostname: srv.name, kernel: '6.1.0-demo', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'x86_64', version: 'demo', iperf: true,
      };
      s.lastAgent = now;
      const cfg = effectiveProbe(db.settings, srv).traffic;
      if (cfg.enabled) ingestTraffic(srv, d.rxBytes, d.txBytes, cfg);
      const a = s.agent;
      recordMetrics(srv.id, { cpu: a.cpu, mem: a.mem, disk: a.disk, load: a.load1, conns: a.conns, rxBps: a.rxBps, txBps: a.txBps }, now);
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
      peers.set(key, {
        a: a.id, b: b.id,
        rtt: Math.round((base + rnd(0, base * 0.08 + 1)) * 10) / 10,
        loss: Math.random() < 0.08 ? +rnd(0.5, 6).toFixed(1) : 0,
        jitter: +rnd(0.1, 4).toFixed(1),
        ts: now,
      });
    }
  }
  // 演示连接的带宽：首次随机生成，之后缓慢漂移
  const demoIds = new Set(demos.map((s) => s.id));
  for (const l of db.links) {
    if (!demoIds.has(l.a) || !demoIds.has(l.b)) continue;
    const key = l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`;
    const [a, b] = key.split('|');
    const prev = demoBandwidth.get(key);
    const cap = Math.min(l.bandwidthMbps || 1000, 950);
    if (!prev || now - prev.ts > 60_000) {
      demoBandwidth.set(key, {
        a, b,
        up: Math.round(prev ? drift(prev.up, 5, cap, 60) : rnd(cap * 0.2, cap * 0.9)),
        down: Math.round(prev ? drift(prev.down, 5, cap, 60) : rnd(cap * 0.2, cap * 0.9)),
        ts: now,
        demo: true,
      });
    }
  }
  for (const k of demoBandwidth.keys()) {
    const [a, b] = k.split('|');
    if (!demoIds.has(a) || !demoIds.has(b)) demoBandwidth.delete(k);
  }
  // 演示机到三网 / 公共目标的延迟：30 秒一轮
  if (now - demoTargetsAt >= 30_000) {
    demoTargetsAt = now;
    for (const srv of demos) {
      const d = demoState.get(srv.id);
      for (const t of db.settings.targets) {
        if (!t.enabled) continue;
        if (d?.down) {
          recordTarget(srv.id, t.id, { rtt: null, loss: 100, jitter: null }, now);
          continue;
        }
        const city = t.city && CITY_BY_KEY[t.city];
        // 国内三网走国际出口有绕路，非 CN2 线路额外加一截
        const detour = srv.tags?.includes('cn2') || srv.country === 'HK' ? 1 : 1.35;
        const base = city ? estimateRttMs(srv, city) * detour : rnd(1, 12);
        recordTarget(srv.id, t.id, {
          rtt: Math.round((base + rnd(0, base * 0.1 + 1)) * 10) / 10,
          loss: Math.random() < 0.1 ? +rnd(1, 12).toFixed(1) : 0,
          jitter: +rnd(0.2, 6).toFixed(1),
        }, now);
      }
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
