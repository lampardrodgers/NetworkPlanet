// 左侧服务器列表：搜索、按状态过滤、按城市/供应商/标签分组。
import { store, statusOf, cityName, alertsOf } from '../state.js';
import { statusKey, fmtMs, latencyColor, esc, providerColor } from '../format.js';
import { $ } from './dom.js';

const ui = {
  q: '',
  filter: 'all',
  group: localStorage.getItem('np.group') || 'city',
  collapsed: new Set(),
  open: !matchMedia('(max-width: 800px)').matches,
};

let handlers = {};

export function initSidebar(h) {
  handlers = h;
  const root = $('#sidebar');
  root.innerHTML = `
    <button class="side-toggle" title="服务器列表">☰</button>
    <div class="side-inner">
      <div class="side-head">
        <input type="search" class="input" placeholder="搜索名称 / IP / 城市 / 标签…" />
        <div class="side-tools">
          <div class="seg" data-filter>
            <button data-v="all" class="on">全部</button><button data-v="online">在线</button><button data-v="offline">离线</button>
          </div>
          <select class="input sm" data-group title="分组">
            <option value="city">按城市</option><option value="provider">按供应商</option><option value="tag">按标签</option><option value="none">不分组</option>
          </select>
        </div>
      </div>
      <div class="side-list"></div>
    </div>`;
  root.classList.toggle('collapsed', !ui.open);
  $('[data-group]', root).value = ui.group;

  $('.side-toggle', root).addEventListener('click', () => {
    ui.open = !ui.open;
    root.classList.toggle('collapsed', !ui.open);
  });
  $('input[type=search]', root).addEventListener('input', (e) => {
    ui.q = e.target.value.trim().toLowerCase();
    renderSidebar();
  });
  $('[data-filter]', root).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ui.filter = b.dataset.v;
    for (const x of $('[data-filter]', root).children) x.classList.toggle('on', x === b);
    renderSidebar();
  });
  $('[data-group]', root).addEventListener('change', (e) => {
    ui.group = e.target.value;
    localStorage.setItem('np.group', ui.group);
    renderSidebar();
  });

  const list = $('.side-list', root);
  list.addEventListener('click', (e) => {
    const g = e.target.closest('[data-group-key]');
    if (g) {
      const k = g.dataset.groupKey;
      ui.collapsed.has(k) ? ui.collapsed.delete(k) : ui.collapsed.add(k);
      renderSidebar();
      return;
    }
    const it = e.target.closest('[data-id]');
    if (it) handlers.onSelect?.(it.dataset.id);
  });
  list.addEventListener('mouseover', (e) => handlers.onHover?.(e.target.closest('[data-id]')?.dataset.id || null));
  list.addEventListener('mouseleave', () => handlers.onHover?.(null));
}

function matches(s) {
  const st = statusKey(statusOf(s.id));
  if (ui.filter === 'online' && st !== 'online') return false;
  if (ui.filter === 'offline' && st !== 'offline') return false;
  if (!ui.q) return true;
  const hay = [s.name, s.ip, s.host, s.city, cityName(s.city), s.country, s.provider, ...(s.tags || [])].join(' ').toLowerCase();
  return hay.includes(ui.q);
}

function groupKeys(s) {
  if (ui.group === 'city') return [s.city ? `${cityName(s.city)}${s.country ? ' · ' + s.country : ''}` : '未知位置'];
  if (ui.group === 'provider') return [s.provider || '未指定供应商'];
  if (ui.group === 'tag') return s.tags?.length ? s.tags : ['无标签'];
  return ['全部服务器'];
}

export function renderSidebar() {
  const list = $('#sidebar .side-list');
  if (!list) return;
  const servers = store.servers.filter(matches);
  const groups = new Map();
  for (const s of servers) for (const k of groupKeys(s)) (groups.get(k) || groups.set(k, []).get(k)).push(s);
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const sel = store.selection?.type === 'server' ? store.selection.id : null;

  if (!store.servers.length) {
    list.innerHTML = `<div class="empty">还没有服务器<br/><button class="btn primary sm" data-empty-add>＋ 添加第一台</button></div>`;
    $('[data-empty-add]', list).onclick = () => handlers.onAdd?.();
    return;
  }
  if (!servers.length) {
    list.innerHTML = `<div class="empty">没有匹配的服务器</div>`;
    return;
  }

  const scroll = list.scrollTop;
  list.innerHTML = sorted
    .map(([k, arr]) => {
      const on = arr.filter((s) => statusKey(statusOf(s.id)) === 'online').length;
      const collapsed = ui.collapsed.has(k);
      return `
      <div class="group ${collapsed ? 'collapsed' : ''}">
        <div class="group-head" data-group-key="${esc(k)}">
          <span class="caret">▾</span><span class="g-name">${esc(k)}</span>
          <span class="g-count">${on}/${arr.length}</span>
        </div>
        ${collapsed ? '' : arr.map((s) => item(s, sel)).join('')}
      </div>`;
    })
    .join('');
  list.scrollTop = scroll;
}

function item(s, sel) {
  const st = statusOf(s.id);
  const key = statusKey(st);
  const rtt = st?.hubRtt;
  return `
    <div class="srv-item ${sel === s.id ? 'active' : ''}" data-id="${s.id}">
      <i class="dot ${key}"></i>
      <div class="srv-main">
        <div class="srv-name">${esc(s.name)}${s.demo ? '<span class="pill">演示</span>' : ''}${alertsOf(s.id).length ? `<span class="pill warn" title="${esc(alertsOf(s.id).map((a) => a.ruleName).join('、'))}">⚠</span>` : ''}</div>
        <div class="srv-sub"><span class="prov" style="color:${providerColor(s.provider)}">${esc(s.provider || '—')}</span> · ${esc(s.ip || s.host || '')}</div>
      </div>
      <div class="srv-rtt" style="color:${latencyColor(rtt)}">${key === 'offline' ? '<span class="off">离线</span>' : fmtMs(rtt)}</div>
    </div>`;
}

export function renderStats() {
  const el = $('#stats');
  const total = store.servers.length;
  let on = 0;
  let off = 0;
  const rtts = [];
  for (const s of store.servers) {
    const st = statusOf(s.id);
    const k = statusKey(st);
    if (k === 'online') on++;
    if (k === 'offline') off++;
    if (st?.hubRtt != null) rtts.push(st.hubRtt);
  }
  const cities = new Set(store.servers.map((s) => s.city).filter(Boolean)).size;
  const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
  el.innerHTML = `
    <span class="stat"><b>${total}</b>服务器</span>
    <span class="stat ok"><b>${on}</b>在线</span>
    <span class="stat ${off ? 'bad' : ''}"><b>${off}</b>离线</span>
    <span class="stat"><b>${cities}</b>城市</span>
    <span class="stat"><b>${store.links.length}</b>连接</span>
    <span class="stat"><b style="color:${latencyColor(avg)}">${avg == null ? '—' : Math.round(avg)}</b>平均ms</span>
    <span class="conn ${store.connected ? 'live' : ''}" title="${store.connected ? '实时连接正常' : '实时连接断开，正在重连…'}"></span>`;
}
