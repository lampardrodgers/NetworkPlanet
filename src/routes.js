import {deviceResults,preferredLatency} from '../shared/device-results.js';
// 线路模式：从一个起点（本机 / 某台服务器 / 某个检测目标）出发，到每台 VPS 怎么走、每一跳多少延迟。
//  - 起点 local：用 Hub 测到各机的延迟（Hub 跑在自己电脑上时，就是本机到 VPS 的延迟）
//  - 起点 srv:<id>：用 Agent 之间互测的延迟
//  - 起点 tgt:<id>：用各机 Agent 测这个检测目标（比如「上海电信」）的延迟，相当于「从这个运营商出发」
//  - 有自定义线路（起点 → 中转… → 终点）就按线路走，否则直连
//  - 另外在实测数据上跑一遍最短路，直连明显更慢时给出「建议经 X 中转」
import {currentDeviceId} from './device-state.js';
import { store, serverById, statusOf, measuredBetween, cityName } from './state.js';
import { estimateRttMs, CITY_BY_KEY } from '../shared/cities.js';

const RELAY_COST = 2; // 每多一跳额外算 2ms（转发开销），避免为了省 1ms 绕一圈

export function originList() {
  const o = store.settings.origin || {};
  const current=currentDeviceId(),reports=new Map((store.deviceRuns||[]).map(r=>[r.deviceId,r]));
  const list = [{ key: 'local', name: '部署主机 · '+(o.name || store.status.local?.host || '后台主机'), group: '后台测量' }];
  if(current)list.unshift({key:'device:'+current,name:'当前设备 · '+(reports.get(current)?.name||'尚未测试'),group:'设备测量'});
  for(const r of reports.values())if(r.deviceId!==current)list.push({key:'device:'+r.deviceId,name:'其他设备 · '+r.name,group:'设备测量'});
  for (const s of store.servers) if (store.localMode || s.lat != null) list.push({ key: `srv:${s.id}`, name: 'VPS · '+s.name, group: '服务器' });
  for (const t of store.localMode ? [] : store.settings.targets || []) if (t.enabled && t.city && CITY_BY_KEY[t.city]) list.push({ key: `tgt:${t.id}`, name: t.name, group: t.group || '检测目标' });
  return list;
}

/** 起点的位置与名称；本机还没设置位置时 lat 为 null */
export function originInfo(key) {
  if(key?.startsWith('device:')){const r=(store.deviceRuns||[]).filter(r=>'device:'+r.deviceId===key).at(-1);return r?{key,kind:'local',id:key,name:r.name,sub:'设备报告 · '+new Date(r.finishedAt).toLocaleString(),lat:r.lat,lon:r.lon}:key==='device:'+currentDeviceId()?{key,kind:'local',id:key,name:'当前设备',sub:'尚未回传测试结果',lat:null,lon:null}:null;}
  if (key === 'local') {
    const o = store.settings.origin || {};
    return { key, kind: 'local', name: o.name || '本机', sub: o.note || '', lat: o.lat ?? null, lon: o.lon ?? null };
  }
  if (key?.startsWith('srv:')) {
    const s = serverById(key.slice(4));
    return s ? { key, kind: 'srv', id: s.id, name: s.name, sub: cityName(s.city), lat: s.lat, lon: s.lon } : null;
  }
  if (key?.startsWith('tgt:')) {
    const t = (store.settings.targets || []).find((x) => `tgt:${x.id}` === key);
    const c = t && CITY_BY_KEY[t.city];
    return c ? { key, kind: 'tgt', id: t.id, name: t.name, sub: `${t.group || ''} · ${t.host}`, lat: c.lat, lon: c.lon } : null;
  }
  return null;
}

/** 起点 → 某台服务器的一跳 */
function localHop(source, target) {
  if(source?.startsWith('device:')){const r=preferredLatency(deviceResults(store.deviceRuns,source.slice(7)),target);return r?.state==='ok'?{rtt:r.rtt,loss:r.loss,measured:true,method:r.method}:{rtt:null,loss:r?100:null,measured:!!r};}
  const p = store.status.local?.profiles?.[target];
  const methods = ['icmp','ssh-banner','tcp'];
  const address = serverById(target)?.host || serverById(target)?.ip;
  const r = (store.status.local?.results || []).filter(r => r.source === source && r.target === target && r.kind === 'latency' && methods.includes(r.method) && (source !== 'local' || (address && r.address === address))).sort((a,b) => b.finishedAt-a.finishedAt).filter((r,i,all)=>all.findIndex(x=>x.method===r.method)===i).sort((a,b)=>Number(b.state==='ok')-Number(a.state==='ok')||methods.indexOf(a.method)-methods.indexOf(b.method))[0];
  if (!r || r.state !== 'ok') return { rtt: null, loss: null, measured: false };
  return {rtt:r.rtt,loss:r.loss??null,measured:true,method:r.method,stale:!!r.stale};
}
function firstHop(origin, toId) {
  if (store.localMode) return localHop(origin.kind === 'local' ? (origin.id||'local') : origin.id, toId);
  const to = serverById(toId);
  if (origin.kind === 'local') {
    const st = statusOf(toId);
    if (st?.online === false) return { rtt: null, loss: 100, measured: true };
    if (st?.hubRtt != null) return { rtt: st.hubRtt, loss: 0, measured: true };
  } else if (origin.kind === 'srv') {
    const m = measuredBetween(origin.id, toId);
    if (m) return { rtt: m.rtt, loss: m.loss, measured: true };
  } else if (origin.kind === 'tgt') {
    const r = store.status.targets?.[toId]?.[origin.id];
    if (r) return { rtt: r.rtt, loss: r.loss, measured: true };
  }
  return { rtt: origin.lat != null && to ? estimateRttMs(origin, to) : null, loss: null, measured: false };
}

function serverHop(a, b) {
  if (store.localMode) return localHop(a,b);
  const m = measuredBetween(a, b);
  if (m) return { rtt: m.rtt, loss: m.loss, measured: true };
  const sa = serverById(a);
  const sb = serverById(b);
  return { rtt: sa && sb ? estimateRttMs(sa, sb) : null, loss: null, measured: false };
}

/** 按给定中转计算整条路径 */
export function evalPath(origin, via, to, hopLabels = []) {
  const chain = [...via, to];
  const hops = chain.map((id, i) => {
    const h = i === 0 ? firstHop(origin, id) : serverHop(chain[i - 1], id);
    const from=i===0?origin.key:chain[i-1];
    const source=i===0?(origin.kind==='local'?(origin.id||'local'):origin.id):chain[i-1];
    const trace=(source?.startsWith('device:')?deviceResults(store.deviceRuns,source.slice(7)):(store.status.local?.results||[])).filter(r=>r.kind==='route'&&r.source===source&&r.target===id&&r.state==='ok').sort((a,b)=>b.finishedAt-a.finishedAt)[0];
    return { from, to: id, label: (store.localMode && hopLabels[i]?.includes('VLESS') ? 'VLESS 规划 / 公网' : hopLabels[i]) || '', networks:trace?.networks||[], routeChecked:!!trace, ...h };
  });
  const down = hops.some((h) => h.measured && (h.rtt == null || h.loss >= 100));
  const total = down || hops.some((h) => h.rtt == null) ? null : hops.reduce((a, h) => a + h.rtt, 0);
  // 丢包按「至少一段丢」合成
  const loss = hops.every((h) => h.loss != null) ? 100 * (1 - hops.reduce((a, h) => a * (1 - h.loss / 100), 1)) : null;
  return { via, to, hops, total, loss, down, measured: hops.length === 1 && hops.every((h) => h.measured) };
}

/** 只用实测数据的最短路（最多 maxVia 个中转） */
function bestPath(origin, to, maxVia = 2) {
  const ids = store.servers.filter((s) => s.lat != null && `srv:${s.id}` !== origin.key).map((s) => s.id);
  // Bellman-Ford 式按跳数展开：dist[k][id] = 用 k 个中转到 id 的最短
  let layer = new Map();
  for (const id of ids) {
    const h = firstHop(origin, id);
    if (h.measured && h.rtt != null && !(h.loss >= 100)) layer.set(id, { d: h.rtt, via: [] });
  }
  let best = layer.get(to) || null;
  for (let k = 1; k <= maxVia; k++) {
    const next = new Map();
    for (const [mid, p] of layer) {
      if (mid === to) continue;
      for (const id of ids) {
        if (id === mid || p.via.includes(id)) continue;
        const m = measuredBetween(mid, id);
        if (!m || m.rtt == null || m.loss >= 100) continue;
        const d = p.d + m.rtt + RELAY_COST;
        const cur = next.get(id);
        if (!cur || d < cur.d) next.set(id, { d, via: [...p.via, mid] });
      }
    }
    const cand = next.get(to);
    if (cand && (!best || cand.d < best.d)) best = cand;
    layer = next;
  }
  return best;
}

/**
 * 某个起点的完整线路规划：每台服务器一行
 * { to, route?(自定义线路), path(实际走的), direct, suggest?(建议的更优中转) }
 */
export function routePlan(originKey, { suggest = true } = {}) {
  const origin = originInfo(originKey);
  if (!origin) return { origin: null, rows: [] };
  const rows = [];
  for (const s of store.servers) {
    if (`srv:${s.id}` === originKey) continue;
    const route = (store.routes || []).find((r) => r.from === originKey && r.to === s.id) || null;
    const direct = evalPath(origin, [], s.id, route && !route.via.length ? route.hopLabels : []);
    const path = route?.via.length ? evalPath(origin, route.via, s.id, route.hopLabels) : direct;
    let sug = null;
    if (!store.localMode && suggest && !route?.via.length) {
      const b = bestPath(origin, s.id);
      if (b?.via.length) {
        const p = evalPath(origin, b.via, s.id);
        // 直连断了，或者中转能省 20% 且至少 15ms，才算值得
        if (p.total != null && (direct.total == null || (p.total < direct.total * 0.8 && direct.total - p.total >= 15))) sug = p;
      }
    }
    rows.push({ to: s.id, route, path, direct, suggest: sug });
  }
  rows.sort((a, b) => (a.path.total ?? 1e9) - (b.path.total ?? 1e9));
  return { origin, rows };
}

/** 把规划转成平面视图要画的线段（同一段只画一次，记下哪些终点经过它） */
export function planSegments(plan, { showSuggest = true } = {}) {
  const segs = new Map();
  const add = (h, kind, dest) => {
    const a = h.from === plan.origin.key ? '@origin' : h.from;
    const key = `${kind === 'suggest' ? 's:' : ''}${a}>${h.to}`;
    let seg = segs.get(key);
    if (!seg) {
      seg = {
        key,
        a,
        b: h.to,
        kind: kind === 'suggest' ? 'suggest' : 'manual',
        route: kind,
        measured: h.measured ? { rtt: h.rtt, loss: h.loss } : null,
        estimate: h.rtt ?? null,
        link: { label: store.localMode
          ? h.method==='ssh-banner'?'SSH 端到端':h.networks?.length ? h.networks.map(n=>n.replace(/^(电信|移动|联通)\s+/, '')).join(' / ')
            : /端到端/.test(h.label||'') ? '端到端' : /frp/i.test(h.label||'') ? 'frp' : /VLESS/.test(h.label||'') ? '公网' : '未知线路'
          : h.label || '', compact:store.localMode },
        dests: new Set(),
        hit: { type: 'server', id: dest },
      };
      segs.set(key, seg);
    }
    if (h.label && !seg.link.label) seg.link.label = h.label;
    if (kind === 'route') seg.route = 'route';
    seg.dests.add(dest);
  };
  for (const r of plan.rows) {
    if(plan.origin?.id?.startsWith('device:')&&!(serverById(r.to)?.host||serverById(r.to)?.ip)&&r.path.total==null&&!r.path.down)continue;
    for (const h of r.path.hops) add(h, r.route?.via.length ? 'route' : 'direct', r.to);
  }
  if(store.localMode && plan.origin?.kind==='local' && !plan.origin.id) for(const row of plan.rows){
    const srv=serverById(row.to);
    // 有独立地址的 VPS 始终保留本机直连；中转段另画，不以中转代替 DIRECT。
    if(row.path.via.length&&(srv?.ip||srv?.host))for(const hop of row.direct.hops)add(hop,'direct',row.to);
    const p=store.status.local?.profiles?.[row.to];
    if(p?.disabled||srv?.ip||srv?.host)continue;
    const r=(store.status.local?.results||[]).filter(r=>r.source==='local'&&r.target===row.to&&r.method==='ssh-banner'&&r.address===p?.endpoint?.host&&r.port===p?.endpoint?.port).sort((a,b)=>b.finishedAt-a.finishedAt)[0];
    if(r?.state==='ok')add({from:plan.origin.key,to:row.to,measured:true,rtt:r.rtt,stale:r.stale,label:'端到端（SSH）'},'direct',row.to);
  }
  if(store.localMode&&!plan.origin?.id?.startsWith('device:'))for(const r of [...(store.status.local?.results||[])].sort((a,b)=>b.finishedAt-a.finishedAt)){
    if(r.source==='local'||r.kind!=='latency'||r.state!=='ok'||!['icmp','tcp'].includes(r.method))continue;
    if(!plan.rows.some(row=>row.path.hops.some(h=>h.from===r.target&&h.to===r.source)))continue;
    const key=`${r.source}>${r.target}`;
    if(segs.has(key))continue;
    const frp=store.status.local?.profiles?.[r.source]?.managementVia?.includes(r.target);
    // 客户端主动测服务器所得 RTT 画在实际测量方向上；不复制成相反方向的结果。
    // 同一 frp 关系已有实测边时，不再叠加一条未测的反向规划边。
    if(frp){const reverse=segs.get(`${r.target}>${r.source}`);if(reverse&&!reverse.measured)segs.delete(`${r.target}>${r.source}`);}
    add({from:r.source,to:r.target,measured:true,rtt:r.rtt,stale:r.stale,method:r.method,label:frp?'frp':`反向 ${serverById(r.source)?.name} → ${serverById(r.target)?.name}`},'route',r.source);
  }
  // 建议线路里和已有线段重合的部分（比如本机→香港）直接复用，不再叠一条虚线
  if (showSuggest) {
    for (const r of plan.rows) {
      for (const h of r.suggest?.hops || []) {
        const same = segs.get(`${h.from === plan.origin.key ? '@origin' : h.from}>${h.to}`);
        if (same) same.dests.add(r.to);
        else add(h, 'suggest', r.to);
      }
    }
  }
  return [...segs.values()];
}
