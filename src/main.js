import { openLocalMonitor } from './ui/local.js';
// 入口：把 Hub 数据、3D 地球、各 UI 面板串起来。
import './styles.css';
import * as THREE from 'three';
import { Globe, DEFAULT_ALT, latLonToVec3, vec3ToLatLon } from './globe/Globe.js';
import { LabelManager } from './globe/labels.js';
import { Markers } from './globe/Markers.js';
import { Links } from './globe/Links.js';
import { FlatMap } from './flat/FlatMap.js';
import { initRoutePanel, renderRoutePanel, routeView } from './ui/routes.js';
import { store, select, setView, computeEdges, serverById, recordLinkHistory } from './state.js';
import { api, subscribe } from './api.js';
import { $, $$, toast, confirmDialog, hasOpenModal } from './ui/dom.js';
import { initSidebar, renderSidebar, renderStats } from './ui/sidebar.js';
import { initDetail, renderDetail, updateLive } from './ui/detail.js';
import { initForms, openServerForm, openLinkForm } from './ui/forms.js';
import { openProviders, refreshProviders } from './ui/providers.js';
import { openMatrix, openImportExport, promptToken } from './ui/misc.js';
import { openSettings } from './ui/settings.js';
import { openInstall, openEvents, renderAlertBadge } from './ui/probe.js';
import { esc, fmtMs, latencyColor } from './format.js';

let globe;
let markers;
let links;
let flat;
let pickCallback = null;
const flatOn = () => store.view.mode === 'flat' || store.view.mode === 'route';
const routeOn = () => store.view.mode === 'route';

/** 线路模式：重新规划并交给平面视图；refit 时把起点和所有服务器框进视野 */
function refreshRoutes({ refit = false } = {}) {
  if (!routeOn() && !store.localMode) return flat.setRouteView(null);
  const rv = routeView();
  rv.layoutSegments = rv.segments; // 隐藏连线只影响显示，不改变重置视图时的地图切分。
  if(store.localMode){
    store.localEdges=rv.segments.map(e=>({...e,a:e.a==='@origin'&&rv.origin?.kind==='srv'?rv.origin.id:e.a}));
    links.setEdges(computeEdges());
    flat.setEdges(computeEdges());
    markers.setData(mapServers(rv.origin),store.status.servers);
    if(!store.view.showLinks)rv.segments=[];
  }
  flat.setRouteView(rv);
  if(routeOn())renderRoutePanel(rv.plan);
  if (refit) {
    // 整张世界地图，兼顾起点连线连续和节点左右分布。
    flat.fitWorld({ around: rv.origin?.lon ?? null });
  }
}

function mapServers(origin=store.settings.origin){
 if(!store.localMode||!Number.isFinite(origin?.lat)||origin?.kind==='srv')return store.servers;
 return [...store.servers,{id:'@origin',name:origin.name||'本机',city:origin.name||'本机',lat:origin.lat,lon:origin.lon,isOrigin:true}];
}

// ---------------- 数据 ----------------
async function loadState() {
  try {
    const s = await api('GET', '/api/state');
    Object.assign(store, {
      servers: s.servers,
      localMode: s.localMode,
      links: s.links,
      routes: s.routes || [],
      accounts: s.accounts,
      providers: s.providers,
      settings: s.settings,
      agentVersion: s.agentVersion,
      hubTz: s.hubTz ?? 0,
      authRequired: s.authRequired,
    });
    document.querySelector('[data-action=install]')?.classList.toggle('hidden', !!s.localMode);
    document.querySelector('[data-action=local-monitor]')?.classList.toggle('hidden', !s.localMode);
    try {
      if(s.localMode&&!localStorage.getItem('np.localLinksV1')){
        localStorage.setItem('np.localLinksV1','1');setView({showLinks:true,showLinkLabels:true});
      }
    } catch {}
    store.emit('data');
  } catch (e) {
    if (e.status === 401) {
      await promptToken();
      return loadState();
    }
    toast(`加载失败：${e.message}`, 'error', 6000);
  }
}

let reloadTimer;
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadState, 120);
};

function connectStream() {
  let hadError = false;
  subscribe({
    onStatus: (snap) => {
      store.status = snap;
      recordLinkHistory();
      store.emit('status');
    },
    onChanged: scheduleReload,
    onTask: (t) => {
      store.tasks.set(t.id, t);
      if (t.state === 'done') toast(`带宽测试完成：${t.aName} ⇄ ${t.bName}  ↑${t.up ?? '—'} / ↓${t.down ?? '—'} Mbps`, 'ok', 6000);
      if (t.state === 'error') toast(`带宽测试失败（${t.aName} ⇄ ${t.bName}）：${t.error}`, 'error', 8000);
      updateLive();
    },
    onAlert: (ev) => {
      store.unreadEvents++;
      renderAlertBadge();
      toast(`${ev.level === 'firing' ? '🔴' : '✅'} ${ev.serverName} ${ev.ruleName}${ev.level === 'resolved' ? '已恢复' : `：${ev.text}`}`, ev.level === 'firing' ? 'error' : 'ok', 7000);
    },
    onOpen: () => {
      store.connected = true;
      renderStats();
      if (hadError) scheduleReload(); // 断线期间可能错过了变更
    },
    onError: () => {
      hadError = true;
      store.connected = false;
      renderStats();
    },
  });
}

// ---------------- 状态 → 视图 ----------------
store.on('data', () => {
  markers.setData(mapServers(), store.status.servers);
  links.setEdges(computeEdges());
  flat.setData(store.servers, store.status.servers);
  flat.setEdges(computeEdges());
  refreshRoutes();
  const sel = store.selection;
  if (sel?.type === 'server' && !serverById(sel.id)) select(null);
  if (sel?.type === 'site' && !markers.sites.has(sel.id)) select(null);
  renderSidebar();
  renderStats();
  renderDetail();
  refreshProviders();
  renderMapPlacement();
});

function renderMapPlacement() {
  const el = $('#map-placement');
  const missing = store.servers.filter(s => !Number.isFinite(s.lat) || !Number.isFinite(s.lon));
  el.classList.toggle('hidden', !missing.length);
  el.innerHTML = `${missing.length ? `<details open><summary>位置待确认 · ${missing.length} 台（未放入地图）</summary><div>${missing.map(s => `<button class="chip" data-unplaced="${esc(s.id)}">${esc(s.name)}</button>`).join('')}</div><small>点击节点补充实际城市。中转入口的位置不代表设备位置。</small></details>` : ''}`;
  el.querySelectorAll('[data-unplaced]').forEach(button => button.onclick = () => openServerForm(serverById(button.dataset.unplaced)));
}

store.on('status', () => {
  markers.refreshStatus(store.status.servers);
  links.setEdges(computeEdges());
  flat.refreshStatus(store.status.servers);
  flat.setEdges(computeEdges());
  refreshRoutes();
  renderSidebar();
  renderStats();
  renderAlertBadge();
  updateLive();
});

store.on('select', (sel) => {
  markers.setSelection(sel);
  flat.setSelection(sel);
  links.focusServer = sel?.type === 'server' ? sel.id : null;
  links.selectedKey = sel?.type === 'link' ? sel.id : null;
  if (sel) pauseAutoRotate();
  renderDetail();
  renderSidebar();
});

store.on('view', applyView);

let lastMode = null;
function applyView() {
  const v = store.view;
  markers.showLabels = flat.showLabels = v.showLabels;
  links.showLabels = flat.showLinkLabels = v.showLinkLabels;
  globe.controls.autoRotate = v.autoRotate && !store.selection;
  links.setEdges(computeEdges());
  flat.setEdges(computeEdges());
  for (const b of $$('#viewbar [data-toggle]')) b.classList.toggle('on', Boolean(v[b.dataset.toggle]));
  for (const b of $$('#viewbar [data-mode]')) b.classList.toggle('on', b.dataset.mode === v.mode);
  flat.setLocked(Boolean(v.flatLocked));
  $('[data-toggle=flatLocked]').classList.toggle('hidden', !flatOn());
  if (v.mode !== lastMode) {
    const was = lastMode;
    lastMode = v.mode;
    $('#globe').classList.toggle('hidden', flatOn());
    globe.setPaused(flatOn());
    $('#routepanel').classList.toggle('hidden', !routeOn());
    $('[data-toggle=autoRotate]').classList.toggle('hidden', flatOn());
    flat.setActive(flatOn());
    refreshRoutes({ refit: routeOn() && was != null });
    if (v.mode === 'flat' && was === 'route') flat.fitAll();
  }
}

// ---------------- 相机 ----------------
function flyToSelection(sel, { zoom = true } = {}) {
  if (!sel) return;
  if (flatOn()) {
    if (sel.type === 'site') flat.fit(markers.sites.get(sel.id)?.servers || [], { maxK: 120 });
    else if (zoom || sel.type !== 'server') flat.focus(sel);
    return;
  }
  if (sel.type === 'server') {
    const s = serverById(sel.id);
    if (!s) return;
    const multi = (markers.siteOfServer(s.id)?.servers.length || 1) > 1;
    globe.flyTo({ lat: s.lat, lon: s.lon, alt: zoom ? Math.min(globe.altitude, multi ? 0.22 : 0.7) : globe.altitude });
  } else if (sel.type === 'site') {
    const site = markers.sites.get(sel.id);
    if (site) globe.flyTo({ lat: site.lat, lon: site.lon, alt: Math.min(globe.altitude, 0.2) });
  } else if (sel.type === 'link') {
    const [a, b] = sel.id.split('|').map(serverById);
    if (!a || !b) return;
    const va = latLonToVec3(a.lat, a.lon);
    const vb = latLonToVec3(b.lat, b.lon);
    const mid = vec3ToLatLon(va.clone().add(vb).normalize().lengthSq() > 0.01 ? va.clone().add(vb) : va);
    const angle = va.angleTo(vb);
    globe.flyTo({ lat: mid.lat, lon: mid.lon, alt: THREE.MathUtils.clamp(angle * 1.4, 0.12, 2.6) });
  }
}

let rotateTimer;
function pauseAutoRotate() {
  globe.controls.autoRotate = false;
  clearTimeout(rotateTimer);
  rotateTimer = setTimeout(() => {
    if (store.view.autoRotate && !store.selection) globe.controls.autoRotate = true;
  }, 25000);
}

// ---------------- 指针交互 ----------------
function pickAt(x, y) {
  return markers.pick(x, y) || links.pick(x, y);
}

function bindPointer() {
  const el = $('#globe');
  let down = null;
  el.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    pauseAutoRotate();
    globe.cancelFlight();
  });
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 600) return;
    down = null;
    // 点在标签上：标签自己处理
    if (e.target.closest('.np-label')) return;
    if (pickCallback) {
      const ll = globe.pickEarth(e.clientX, e.clientY);
      if (ll) finishPick(ll);
      return;
    }
    const hit = pickAt(e.clientX, e.clientY);
    if(hit?.id==='@origin')return;
    if (hit) {
      select({ type: hit.type, id: hit.id });
      if (hit.type === 'site') flyToSelection(hit);
    } else select(null);
  });
  el.addEventListener('dblclick', (e) => {
    const ll = globe.pickEarth(e.clientX, e.clientY);
    if (ll) globe.flyTo({ lat: ll.lat, lon: ll.lon, alt: globe.altitude * 0.4, duration: 700 });
  });

  // 标签点击
  globe.labelRenderer.domElement.addEventListener('click', (e) => {
    const l = e.target.closest('.np-label');
    if (!l || pickCallback) return;
    if(l.dataset.server==='@origin')return;
    if (l.dataset.server) select({ type: 'server', id: l.dataset.server });
    else if (l.dataset.site) {
      select({ type: 'site', id: l.dataset.site });
      flyToSelection(store.selection);
    } else if (l.dataset.link) select({ type: 'link', id: l.dataset.link });
  });

  // 悬停
  const tip = $('#tooltip');
  let raf = 0;
  el.addEventListener('pointermove', (e) => {
    if (raf || e.buttons) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const hit = pickCallback ? null : pickAt(e.clientX, e.clientY);
      markers.hover = hit?.type === 'server' ? hit : null;
      links.hoverKey = hit?.type === 'link' ? hit.id : null;
      el.style.cursor = pickCallback ? 'crosshair' : hit ? 'pointer' : '';
      if (hit?.type === 'link') {
        showLinkTip(hit, e);
      } else tip.classList.add('hidden');
    });
  });
  el.addEventListener('pointerleave', () => tip.classList.add('hidden'));
}

function showLinkTip(hit, e) {
  const tip = $('#tooltip');
  const [a, b] = hit.id.split('|').map(serverById);
  const edge = computeEdges().find((x) => x.key === hit.id);
  const rtt = edge?.measured?.rtt;
  tip.innerHTML = `<b>${esc(a?.name)}</b> ⟷ <b>${esc(b?.name)}</b><br/>${edge?.measured ? `<span style="color:${latencyColor(rtt)}">${rtt == null ? '中断' : fmtMs(rtt)}</span>` : `≈ ${fmtMs(edge?.estimate)}（估算）`}${edge?.link?.label ? ` · ${esc(edge.link.label)}` : ''}`;
  tip.style.left = `${e.clientX + 14}px`;
  tip.style.top = `${e.clientY + 12}px`;
  tip.classList.remove('hidden');
}

function startPick(cb) {
  pickCallback = cb;
  $('#pickhint').classList.remove('hidden');
}
function finishPick(ll) {
  const cb = pickCallback;
  pickCallback = null;
  $('#pickhint').classList.add('hidden');
  $('#globe').style.cursor = '';
  flat.canvas.style.cursor = '';
  cb?.(ll);
}

// ---------------- 动作 ----------------
const actions = {
  'add-server': () => openServerForm(),
  'add-link': () => openLinkForm(store.selection?.type === 'server' ? { a: store.selection.id } : {}),
  providers: () => openProviders(),
  matrix: () =>
    openMatrix({
      onPick: (a, b) => {
        const sel = { type: 'link', id: a < b ? `${a}|${b}` : `${b}|${a}` };
        select(sel);
        flyToSelection(sel);
      },
      onPickServer: (id) => {
        const sel = { type: 'server', id };
        select(sel);
        flyToSelection(sel);
      },
    }),
  'import-export': () => openImportExport(),
  'local-monitor': () => openLocalMonitor(),
  settings: () => openSettings({ onChanged: renderDetail }),
  install: () => openInstall(),
  events: () => openEvents({ onSelect: (id) => { const sel = { type: 'server', id }; select(sel); flyToSelection(sel); } }),
  'zoom-in': () => (flatOn() ? flat.zoomBy(2) : globe.zoomBy(0.5)),
  'zoom-out': () => (flatOn() ? flat.zoomBy(0.5) : globe.zoomBy(2)),
  'reset-view': () => {
    select(null);
    if (routeOn()) refreshRoutes({ refit: true });
    else if (flatOn()) flat.fitAll();
    // 锁定时 fitAll 只是重新选中心经度，视角本身是固定的
    else globe.flyTo({ alt: DEFAULT_ALT });
  },
};

function bindActions() {
  document.body.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a && actions[a.dataset.action]) actions[a.dataset.action]();
    const t = e.target.closest('[data-toggle]');
    if (t) setView({ [t.dataset.toggle]: !store.view[t.dataset.toggle] });
    const md = e.target.closest('#viewbar [data-mode]');
    if (md) setView({ mode: md.dataset.mode });
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') {
      if (pickCallback) return finishPick(null);
      if (!hasOpenModal()) select(null);
    }
    if (hasOpenModal()) return;
    if (e.key === '/') {
      e.preventDefault();
      $('#sidebar input[type=search]')?.focus();
    }
    if (e.key === '+' || e.key === '=') actions['zoom-in']();
    if (e.key === '-') actions['zoom-out']();
    if (e.key === 'n') openServerForm();
  });
}

// ---------------- 启动 ----------------
async function boot() {
  await new Promise((r) => setTimeout(r, 30)); // 让 loading 先渲染出来（生成贴图会阻塞主线程）
  globe = new Globe($('#globe'));
  const labels = new LabelManager(globe);
  markers = new Markers(globe, labels);
  links = new Links(globe, markers, labels);
  globe.controls.addEventListener('start', pauseAutoRotate);
  flat = new FlatMap($('#flat'), {
    isPicking: () => Boolean(pickCallback),
    onPickLocation: (ll) => finishPick(ll),
    onSelect: (hit) => select(hit ? { type: hit.type, id: hit.id } : null),
    onHover: (hit, e) => {
      const tip = $('#tooltip');
      if (hit?.type === 'link' && !routeOn()) showLinkTip(hit, e);
      else tip.classList.add('hidden');
    },
  });
  initRoutePanel({
    onHover: (id) => (flat.hover = id ? { type: 'server', id } : null),
    onSelect: (id) => select({ type: 'server', id }),
    onChange: (opts) => refreshRoutes(opts),
    pickLocation: (cb) => startPick(cb),
  });
  window.np = { store, globe, markers, links, flat, select }; // 方便在控制台调试

  initSidebar({
    onLayoutChange: () => {
      if (flatOn()) flat.fitAll();
    },
    onSelect: (id) => {
      const sel = { type: 'server', id };
      select(sel);
      flyToSelection(sel);
    },
    onHover: (id) => (markers.hover = flat.hover = id ? { type: 'server', id } : null),
    onAdd: () => openServerForm(),
  });
  initDetail({
    onClose: () => select(null),
    onFly: (sel) => flyToSelection(sel),
    onSelect: (sel) => {
      select(sel);
      flyToSelection(sel, { zoom: sel.type !== 'server' });
    },
    getSite: (id) => markers.sites.get(id),
    onEditServer: (id) => openServerForm(serverById(id)),
    onDeleteServer: async (id) => {
      const s = serverById(id);
      if (!(await confirmDialog(`删除服务器「${s?.name}」及其所有连接？`, { danger: true, okText: '删除' }))) return;
      await api('DELETE', `/api/servers/${id}`);
      select(null);
      toast('已删除', 'ok');
    },
    onAddLink: (preset) => openLinkForm(preset),
    onEditLink: (id) => openLinkForm({ link: store.links.find((l) => l.id === id) }),
    onDeleteLink: async (id) => {
      if (!(await confirmDialog('删除这条连接？', { danger: true, okText: '删除' }))) return;
      await api('DELETE', `/api/links/${id}`);
      toast('连接已删除', 'ok');
    },
    onRotateToken: async (id) => {
      if (!(await confirmDialog('重置后旧 Token 立即失效，需要在 VPS 上重新安装 Agent。继续？', { okText: '重置' }))) return;
      await api('POST', `/api/servers/${id}/rotate-token`);
      await loadState();
      toast('Token 已重置', 'ok');
    },
  });
  initForms({
    pickOnGlobe: startPick,
    onSaved: (srv, isNew) => {
      if (!isNew) return;
      // 等 SSE 触发的重新加载完成后再选中
      setTimeout(() => {
        const sel = { type: 'server', id: srv.id };
        select(sel);
        flyToSelection(sel);
      }, 400);
    },
  });
  bindPointer();
  bindActions();
  applyView();

  await loadState();
  if (routeOn()) refreshRoutes({ refit: true });
  connectStream();
  $('#loading').classList.add('done');
  setTimeout(() => $('#loading').remove(), 600);
}

boot().catch((e) => {
  console.error(e);
  $('#loading span').textContent = `启动失败：${e.message}`;
});
