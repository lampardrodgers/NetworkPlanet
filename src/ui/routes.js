import {deviceResults} from '../../shared/device-results.js';
// 线路模式的右侧面板：选起点、看每台 VPS 怎么走（每一跳延迟、总延迟、和直连比）、采用建议的中转、编辑自定义线路、设置本机位置。
import { store, serverById, cityName } from '../state.js';
import { originList, originInfo, routePlan, planSegments, evalPath } from '../routes.js';
import { findCity, CITIES } from '../../shared/cities.js';
import { fmtMs, latencyColor, esc, LAT_COLORS } from '../format.js';
import { $, openModal, toast, confirmDialog, formData } from './dom.js';
import { api } from '../api.js';

const ui = load();
let handlers = {};
let lastPlan = null;

function load() {
  try {
    return { origin: 'local', suggest: true, ...JSON.parse(localStorage.getItem('np.routes') || '{}') };
  } catch {
    return { origin: 'local', suggest: true };
  }
}
function persist() {
  try {
    localStorage.setItem('np.routes', JSON.stringify(ui));
  } catch {}
}

const nameOf = (key) => (key === '@origin' ? originInfo(ui.origin)?.name : serverById(key)?.name) || '?';
const msText = (h) => (h.measured && (h.rtt == null || h.loss >= 100) ? '中断' : h.rtt == null ? '—' : `${h.method === 'tcp' ? 'TCP ' : ''}${h.measured ? '' : '≈'}${fmtMs(h.rtt)}`);
const hopColor = (h) => (h.measured && (h.rtt == null || h.loss >= 100) ? LAT_COLORS.bad : h.measured ? latencyColor(h.rtt) : LAT_COLORS.none);

/** handlers: { onHover(id|null), onSelect(id), onChange(), pickLocation(cb) } */
export function initRoutePanel(h) {
  handlers = h;
  const root = $('#routepanel');
  $('#sourcebar').addEventListener('click',e=>{if(e.target.closest('[data-source-location]'))openOriginForm();});
  $('#sourcebar').addEventListener('change',e=>{if(e.target.matches('[data-measurement-origin]'))setRouteOrigin(e.target.value);});
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-origin]')) {
      ui.origin = e.target.value;
      persist();
      handlers.onChange?.({ refit: true });
    }
    if (e.target.matches('[data-suggest]')) {
      ui.suggest = e.target.checked;
      persist();
      handlers.onChange?.();
    }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    const row = e.target.closest('[data-to]');
    if (!b) {
      if (row) handlers.onSelect?.(row.dataset.to);
      return;
    }
    e.stopPropagation();
    const r = lastPlan?.rows.find((x) => x.to === row?.dataset.to);
    const act = b.dataset.act;
    if (act === 'origin-edit') openOriginForm();
    if (act === 'add') openRouteForm({ from: ui.origin });
    if (act === 'edit' && r) openRouteForm({ from: ui.origin, to: r.to, route: r.route, via: r.route?.via || r.suggest?.via || [] });
    if (act === 'adopt' && r?.suggest) {
      try {
        await api('POST', '/api/routes', { from: ui.origin, to: r.to, via: r.suggest.via, label: '', hopLabels: [] });
        toast(`已保存规划：经 ${r.suggest.via.map(nameOf).join(' → ')} 中转`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    if (act === 'del' && r?.route) {
      if (!(await confirmDialog(`删除去「${nameOf(r.to)}」的自定义线路，改回直连？`, { okText: '删除', danger: true }))) return;
      await api('DELETE', `/api/routes/${r.route.id}`);
      toast('已改回直连', 'ok');
    }
  });
  root.addEventListener('mouseover', (e) => handlers.onHover?.(e.target.closest('[data-to]')?.dataset.to || null));
  root.addEventListener('mouseleave', () => handlers.onHover?.(null));
}

/** 当前起点的线路规划，以及平面视图要画的数据 */
function endpointResult(id) {
 const p=store.status.local?.profiles?.[id];
 if(!store.localMode||p?.disabled)return null;
 return (store.status.local?.results||[]).filter(r=>r.source==='local'&&r.target===id&&r.method==='ssh-banner'&&r.address===p?.endpoint?.host&&r.port===p?.endpoint?.port).sort((a,b)=>b.finishedAt-a.finishedAt)[0]||null;
}
export function routeView() {
  if (store.servers.length && !originInfo(ui.origin)) ui.origin = 'local';
  const plan = routePlan(ui.origin, { suggest: ui.suggest });
  lastPlan = plan;
  const info = new Map();
  for (const r of plan.rows) {
    const p = r.path;
    const how = plan.origin?.id?.startsWith('device:') && !(serverById(r.to)?.host||serverById(r.to)?.ip) ? '无公网地址 · 未测' : p.via.length ? `经 ${p.via.map(nameOf).join(' → ')}` : '直连';
    let text = `${p.total == null ? (p.down ? '中断' : '—') : `${p.measured ? '' : '≈'}${fmtMs(p.total)}`} · ${how}`;
    const endpoint=ui.origin.startsWith('device:')?deviceResults(store.deviceRuns,ui.origin.slice(7)).find(x=>x.target===r.to&&x.method==='ssh-banner'):ui.origin==='local'?endpointResult(r.to):null;
    if(endpoint)text=endpoint.state==='ok'?`${fmtMs(endpoint.rtt)} · frp/SSH 端到端${endpoint.stale?' · 历史':''}`:'SSH 后端未响应';
    if (r.suggest) text += ` · 中转可到 ${fmtMs(r.suggest.total)}`;
    info.set(r.to, { text, color: p.down ? LAT_COLORS.bad : p.total == null ? LAT_COLORS.none : latencyColor(p.total) });
  }
  return { plan, origin: plan.origin, segments: plan.origin ? planSegments(plan, { showSuggest: ui.suggest }) : [], info };
}

export function renderRoutePanel(plan = lastPlan) {
  const root = $('#routepanel');
  if (!root || root.classList.contains('hidden') || !plan) return;
  const origin = plan.origin;
  const groups = {};
  for (const o of originList()) (groups[o.group] ||= []).push(o);
  const opts = Object.entries(groups)
    .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((o) => `<option value="${o.key}" ${o.key === ui.origin ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</optgroup>`)
    .join('');
  const rows = plan.rows;
  const viaN = rows.filter((r) => r.path.via.length).length;
  const sugN = rows.filter((r) => r.suggest).length;
  const tot = rows.map((r) => r.path.total).filter((x) => x != null);
  const noLoc = origin?.kind === 'local' && origin.lat == null;
  const scroll = $('.rp-list', root)?.scrollTop || 0;
  root.innerHTML = `
    <div class="rp-head">
      <b>线路</b>
      <select class="input" data-origin title="从哪里出发">${opts}</select>
      <button class="icon-btn" data-act="origin-edit" title="设置本机位置">⌖</button>
    </div>
    ${noLoc ? `<div class="rp-warn">本机位置未定位，先显示拓扑起点。<button class="btn sm primary" data-act="origin-edit">设置本机位置</button></div>` : ''}
    <div class="rp-tools">
      ${store.localMode ? '<span class="hint">本地实测 · 未知段不估算</span>' : `<label class="check"><input type="checkbox" data-suggest ${ui.suggest ? 'checked' : ''}/> 推荐中转</label>`}
      <button class="btn sm" data-act="add">＋ 自定义线路</button>
    </div>
    <div class="rp-sum">
      <span><b>${rows.length}</b> 台</span>
      <span><b>${viaN}</b> 条中转</span>
      ${sugN ? `<span class="warn"><b>${sugN}</b> 条建议</span>` : ''}
      ${tot.length ? `<span>中位 <b>${fmtMs(tot.sort((a, b) => a - b)[Math.floor(tot.length / 2)])}</b></span>` : ''}
    </div>
    <div class="rp-list">${rows.map(rowHtml).join('') || '<div class="empty">没有可以到达的服务器</div>'}</div>
    <p class="rp-foot">${originHint(origin)}</p>`;
  $('.rp-list', root).scrollTop = scroll;
}

function originHint(o) {
  if (!o) return '';
  if(o?.id?.startsWith('device:'))return '当前显示此设备最近的延迟和线路报告；未测节点不使用后台主机延迟补齐。VPS 互测在后台测量中单独执行。';
  if (store.localMode) return '延迟来自本地测量。中转总值仅为分段估算；端到端响应在本地测量中查看。保存线路不会修改实际网络。';
  if (o.kind === 'local') return '本机 → VPS 的延迟取自 Hub 的探测：Hub 跑在你这台电脑上时就是本机延迟；Hub 在别处时代表 Hub 所在网络。';
  if (o.kind === 'tgt') return `从「${esc(o.name)}」出发：用各台 VPS 上的 Agent 测这个目标的延迟（反向测，近似对称）。`;
  return `从「${esc(o.name)}」出发：用 Agent 之间互测的延迟。`;
}

function hopsHtml(path) {
  const parts = [`<span class="rp-node">${esc(originInfo(ui.origin)?.name)}</span>`];
  for (const h of path.hops) {
    parts.push(`<span class="rp-hop" style="color:${hopColor(h)};border-color:${hopColor(h)}55">${h.label ? `${esc(h.label)} · ` : ''}${msText(h)}</span>`);
    parts.push(`<span class="rp-node">${esc(nameOf(h.to))}</span>`);
  }
  return parts.join('<i>→</i>');
}

function rowHtml(r) {
  const s = serverById(r.to);
  const p = r.path;
  const color = p.down ? LAT_COLORS.bad : p.total == null ? LAT_COLORS.none : latencyColor(p.total);
  const via = p.via.length > 0;
  const endpoint=ui.origin.startsWith('device:')?deviceResults(store.deviceRuns,ui.origin.slice(7)).find(x=>x.target===r.to&&x.method==='ssh-banner'):ui.origin==='local'?endpointResult(r.to):null;
  const frps=store.status.local?.profiles?.[r.to]?.managementVia?.at(-1);
  const frpRtt=!ui.origin.startsWith('device:')&&frps?(store.status.local?.results||[]).filter(x=>x.source===r.to&&x.target===frps&&x.kind==='latency'&&x.state==='ok').sort((a,b)=>b.finishedAt-a.finishedAt)[0]:null;
  const trace=(ui.origin.startsWith('device:')?deviceResults(store.deviceRuns,ui.origin.slice(7)):(store.status.local?.results||[])).filter(x=>x.kind==='route'&&x.source===(lastPlan?.origin?.kind==='local'?(lastPlan.origin.id||'local'):lastPlan?.origin?.id)&&x.target===r.to).sort((a,b)=>b.finishedAt-a.finishedAt)[0];
  const save = via && r.direct.total != null && p.total != null ? r.direct.total - p.total : null;
  return `
    <div class="rp-row ${via ? 'via' : ''} ${r.suggest ? 'has-sug' : ''}" data-to="${r.to}">
      <div class="rp-top">
        <b>${esc(s?.name)}</b><small>${esc(cityName(s?.city))}</small>
        ${r.route?.label ? `<span class="tag">${esc(r.route.label)}</span>` : ''}
        <em style="color:${color}">${p.total == null ? (p.down ? '中断' : '—') : `${p.measured ? '' : '≈'}${fmtMs(p.total)}`}</em>
      </div>
      <div class="rp-path">${hopsHtml(p)}</div>
      ${endpoint?`<div class="rp-cmp">frp/SSH 端到端：<b>${endpoint.state==='ok'?fmtMs(endpoint.rtt):endpoint.state==='refused'?'入口端口拒绝连接':'后端未响应'}</b>${endpoint.stale?' · 历史结果':''}</div>`:''}
      ${frpRtt?`<div class="rp-cmp">frpc → frps：<b>${fmtMs(frpRtt.rtt)}</b> · ${frpRtt.method==='tcp'?'TCP 建连':'Ping 往返'} · ${esc(nameOf(frps))}${frpRtt.stale?' · 历史结果':''}</div>`:''}
      ${trace?`<div class="rp-cmp">${trace.entryOnly?'公网入口':'去程'}观测：${esc(trace.networks?.join(' → ')||'网络未识别')}${trace.complete?'':' · 路径不完整'}</div>`:''}
      ${via ? `<div class="rp-cmp">直连 <span style="color:${hopColor(r.direct.hops[0])}">${msText(r.direct.hops[0])}</span>${save != null ? ` · 与分段估算相差 ${fmtMs(Math.abs(save))}` : ''}${p.loss ? ` · 丢包 ${p.loss.toFixed(1)}%` : ''}</div>` : ''}
      ${r.suggest ? `<div class="rp-sug"><span>建议经 <b>${r.suggest.via.map((v) => esc(nameOf(v))).join(' → ')}</b> 中转：${fmtMs(r.suggest.total)}${r.direct.total != null ? `（省 ${fmtMs(r.direct.total - r.suggest.total)}）` : '（直连不通）'}</span><button class="btn sm primary" data-act="adopt">保存规划</button></div>` : ''}
      <div class="rp-acts">
        <button class="link-btn" data-act="edit">${via || r.route ? '编辑线路' : '设中转'}</button>
        ${r.route ? '<button class="link-btn bad" data-act="del">改回直连</button>' : ''}
      </div>
    </div>`;
}

// ---------------- 自定义线路表单 ----------------
export function openRouteForm({ from = 'local', to = '', via = [], route = null } = {}) {
  const servers = [...store.servers].filter((s) => s.lat != null).sort((a, b) => (a.city || '').localeCompare(b.city || '') || a.name.localeCompare(b.name));
  const srvOpts = (sel) => servers.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} — ${esc(cityName(s.city))}</option>`).join('');
  const origins = originList()
    .map((o) => `<option value="${o.key}" ${o.key === (route?.from || from) ? 'selected' : ''}>${esc(o.group)} · ${esc(o.name)}</option>`)
    .join('');
  const hopLabels = [...(route?.hopLabels || [])];
  let hops = [...via];
  const m = openModal({
    title: route ? '编辑线路' : '自定义线路',
    content: `
    <form class="form route-form">
      <div class="grid2">
        <label>起点<select class="input" name="from">${origins}</select></label>
        <label>终点<select class="input" name="to" required><option value="">选择服务器…</option>${srvOpts(route?.to || to)}</select></label>
      </div>
      <div class="rf-chain"></div>
      <button type="button" class="btn sm" data-addhop>＋ 加一个中转</button>
      <label>线路名称<input class="input" name="label" value="${esc(route?.label || '')}" placeholder="比如：欧洲经香港 / 美西走 CN2" /></label>
      <div class="rf-preview"></div>
      <p class="hint">每段注明测量来源。中转总值为分段估算。本地模式没有数据时显示未知。保存只记录拓扑，不改变实际网络。</p>
      <div class="form-actions"><span class="err"></span><button type="button" class="btn" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
    </form>`,
  });
  const form = $('form', m.el);
  const chain = $('.rf-chain', form);
  const readLabels = () => [...chain.querySelectorAll('[data-hl]')].forEach((x) => (hopLabels[+x.dataset.hl] = x.value));
  const draw = () => {
    const fromKey = form.from.value;
    const toId = form.to.value;
    const seg = (i) => `<input class="input sm" data-hl="${i}" value="${esc(hopLabels[i] || '')}" placeholder="第 ${i + 1} 段标签（专线 / hysteria2 / WG…）" />`;
    chain.innerHTML = `
      <div class="rf-end">${esc(originInfo(fromKey)?.name || '起点')}</div>
      ${hops.map((id, i) => `${seg(i)}<div class="rf-via"><span>中转 ${i + 1}</span><select class="input" data-via="${i}">${srvOpts(id)}</select><button type="button" class="icon-btn" data-up="${i}" title="上移">↑</button><button type="button" class="icon-btn" data-rm="${i}" title="移除">✕</button></div>`).join('')}
      ${seg(hops.length)}
      <div class="rf-end">${esc(serverById(toId)?.name || '终点')}</div>`;
    preview();
  };
  const preview = () => {
    const o = originInfo(form.from.value);
    const toId = form.to.value;
    if (!o || !toId) return ($('.rf-preview', form).innerHTML = '');
    readLabels();
    const p = evalPath(o, hops, toId, hopLabels);
    const d = evalPath(o, [], toId);
    const total = p.total == null ? '—' : `${p.measured ? '' : '≈'}${fmtMs(p.total)}`;
    $('.rf-preview', form).innerHTML = `预计 <b style="color:${p.total == null ? LAT_COLORS.none : latencyColor(p.total)}">${total}</b>，直连 ${msText(d.hops[0])}`;
  };
  form.addEventListener('change', (e) => {
    if (e.target.dataset.via != null) hops[+e.target.dataset.via] = e.target.value;
    readLabels();
    draw();
  });
  form.addEventListener('input', (e) => {
    if (e.target.dataset.hl != null) hopLabels[+e.target.dataset.hl] = e.target.value;
  });
  form.addEventListener('click', (e) => {
    const t = e.target;
    if (t.matches('[data-addhop]')) {
      readLabels();
      const used = new Set([...hops, form.to.value, form.from.value.slice(4)]);
      hops.push(servers.find((s) => !used.has(s.id))?.id || servers[0]?.id);
      hopLabels.splice(hops.length - 1, 0, '');
      draw();
    }
    if (t.dataset.rm != null) {
      readLabels();
      const i = +t.dataset.rm;
      hops.splice(i, 1);
      hopLabels.splice(i + 1, 1);
      draw();
    }
    if (t.dataset.up != null && +t.dataset.up > 0) {
      readLabels();
      const i = +t.dataset.up;
      [hops[i - 1], hops[i]] = [hops[i], hops[i - 1]];
      draw();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readLabels();
    const d = formData(form);
    const body = { from: d.from, to: d.to, via: hops, label: d.label, hopLabels: hopLabels.slice(0, hops.length + 1) };
    try {
      if (!d.to) throw new Error('选一个终点');
      if (route && route.from === d.from && route.to === d.to) await api('PUT', `/api/routes/${route.id}`, body);
      else await api('POST', '/api/routes', body);
      toast(hops.length ? '线路已保存' : '已保存（直连）', 'ok');
      m.close();
    } catch (err) {
      $('.err', form).textContent = err.message;
    }
  });
  draw();
}

// ---------------- 本机位置 ----------------
export function openOriginForm() {
  const device=ui.origin.startsWith('device:');
  const o = device?originInfo(ui.origin)||{}:store.settings.origin || {};
  const m = openModal({
    title: device?'设备起点位置':'部署主机位置',
    content: `
    <form class="form">
      <div class="grid2">
        <label>名称<input class="input" name="name" value="${esc(o.name || '本机')}" placeholder="本机 / 家里 / 公司" /></label>
        <label>说明<input class="input" name="note" value="${esc(o.note || '')}" placeholder="比如：上海电信 1000M" /></label>
      </div>
      <label>城市<input class="input" name="city" list="rp-cities" placeholder="输入城市名，比如 上海 / Shanghai" /></label>
      <datalist id="rp-cities">${CITIES.map((c) => `<option value="${esc(c.zh)}">${esc(c.name)}</option>`).join('')}</datalist>
      <div class="grid2">
        <label>纬度<input class="input" name="lat" type="number" step="any" value="${o.lat ?? ''}" /></label>
        <label>经度<input class="input" name="lon" type="number" step="any" value="${o.lon ?? ''}" /></label>
      </div>
      <div class="row-btns">
        <button type="button" class="btn sm" data-geo>📍 浏览器定位</button>
        <button type="button" class="btn sm" data-pick>在地图上点选</button>
      </div>
      <p class="hint">只设置当前选中起点在地图上的位置，不改变实际测量来源。</p>
      <div class="form-actions"><span class="err"></span><button type="button" class="btn" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
    </form>`,
  });
  const form = $('form', m.el);
  form.city.addEventListener('change', () => {
    const c = findCity(form.city.value) || CITIES.find((x) => x.zh === form.city.value.trim());
    if (!c) return ($('.err', form).textContent = '没找到这个城市，可以直接填经纬度');
    $('.err', form).textContent = '';
    form.lat.value = c.lat;
    form.lon.value = c.lon;
  });
  $('[data-geo]', form).addEventListener('click', () => {
    if (!navigator.geolocation) return ($('.err', form).textContent = '浏览器不支持定位');
    $('.err', form).textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        form.lat.value = p.coords.latitude.toFixed(3);
        form.lon.value = p.coords.longitude.toFixed(3);
        $('.err', form).textContent = '';
      },
      (err) => ($('.err', form).textContent = `定位失败：${err.message}`),
      { timeout: 10000 },
    );
  });
  $('[data-pick]', form).addEventListener('click', () => {
    m.hide(true);
    handlers.pickLocation?.((ll) => {
      m.hide(false);
      if (!ll) return;
      form.lat.value = ll.lat.toFixed(3);
      form.lon.value = ll.lon.toFixed(3);
    });
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    try {
      if (d.lat === '' || d.lon === '') throw new Error('需要经纬度（选城市、定位或在地图上点选）');
      if(device)await api('PUT','/api/device-tests/location',{deviceId:ui.origin.slice(7),name:d.name,lat:Number(d.lat),lon:Number(d.lon)});
      else await api('PUT', '/api/settings', { origin: { name: d.name, note: d.note, lat: Number(d.lat), lon: Number(d.lon) } });
      toast('本机位置已保存', 'ok');
      m.close();
    } catch (err) {
      $('.err', form).textContent = err.message;
    }
  });
}

export const routeOrigin = () => ui.origin;

export function setRouteOrigin(key,{notify=true}={}){ui.origin=key;persist();if(notify)handlers.onChange?.({refit:true});}
function renderSourceVisibility() {
  const visible = !!store.localMode && ui.sourceVisible !== false;
  $('#sourcebar')?.classList.toggle('hidden', !visible);
  const button = $('[data-action="toggle-sourcebar"]');
  if (!button) return;
  button.classList.toggle('hidden', !store.localMode);
  button.setAttribute('aria-expanded', String(visible));
  button.title = `${visible ? '隐藏' : '显示'}测量起点面板`;
}

export function toggleSourceSelector() {
  ui.sourceVisible = ui.sourceVisible === false;
  persist();
  renderSourceVisibility();
}

export function renderSourceSelector(origin){
 const root=$('#sourcebar');if(!root)return;renderSourceVisibility();
 const items=originList();const signature=JSON.stringify([items,ui.origin]);
 if(root.dataset.signature!==signature){root.dataset.signature=signature;root.innerHTML=`<label>测量起点 <select class="input" data-measurement-origin aria-label="测量起点">${items.map(o=>`<option value="${esc(o.key)}" ${o.key===ui.origin?'selected':''}>${esc(o.name)}</option>`).join('')}</select></label><small data-source-info></small><button class="link-btn" data-source-location>设置起点位置</button>`;}
 $('[data-source-location]',root).hidden=origin?.kind!=='local';
 const device=ui.origin.startsWith('device:');const run=device?(store.deviceRuns||[]).filter(r=>'device:'+r.deviceId===ui.origin).at(-1):null;
 $('[data-source-info]',root).textContent=device?(run?'结果：'+new Date(run.finishedAt).toLocaleString()+' · 未测节点不补用后台数据':'尚无结果，请运行“此设备测试”的命令'):ui.origin==='local'?'显示部署主机发出的测量结果':'显示此 VPS 发出的互测结果';
}
