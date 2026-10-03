// 杂项弹窗：延迟矩阵、JSON/CSV 导入导出、设置、管理口令。
import { openBackup } from './backup.js';
import { store, measuredBetween, cityName } from '../state.js';
import { estimateRttMs } from '../../shared/cities.js';
import { api, setToken } from '../api.js';
import { openModal, $, toast, confirmDialog } from './dom.js';
import { esc, latencyColor, fmtMs } from '../format.js';

// ---------------- 延迟矩阵 ----------------
let matrixMode = 'peers';

export function openMatrix({ onPick, onPickServer } = {}) {
  const servers = [...store.servers].sort((a, b) => (a.lon ?? 0) - (b.lon ?? 0));
  if (!servers.length) return toast('还没有服务器', 'warn');
  const m = openModal({
    title: '延迟矩阵',
    wide: true,
    content: `
      <div class="matrix-tools">
        <div class="seg" data-mode><button data-v="peers">服务器互联</button><button data-v="targets">三网 / 检测目标</button></div>
        <label class="check" data-est-wrap><input type="checkbox" data-est checked /> 无实测时显示估算值（斜体）</label>
        <span class="hint" data-tip></span>
      </div>
      <div class="matrix-wrap"></div>`,
  });
  const render = () => {
    for (const b of $('[data-mode]', m.el).children) b.classList.toggle('on', b.dataset.v === matrixMode);
    $('[data-est-wrap]', m.el).classList.toggle('hidden', matrixMode !== 'peers');
    if (matrixMode === 'targets') return renderTargets();
    $('[data-tip]', m.el).textContent = '按经度从西到东排序 · 点击格子查看这条链路';
    if (servers.length < 2) {
      $('.matrix-wrap', m.el).innerHTML = '<p class="hint" style="padding:16px">至少需要两台服务器</p>';
      return;
    }
    const showEst = $('[data-est]', m.el).checked;
    const head = servers.map((s) => `<th title="${esc(s.name)}"><div class="vh">${esc(s.name)}</div></th>`).join('');
    const rows = servers
      .map((a) => {
        const cells = servers
          .map((b) => {
            if (a.id === b.id) return '<td class="self"></td>';
            const mm = measuredBetween(a.id, b.id);
            if (mm) {
              const down = mm.rtt == null;
              return `<td data-a="${a.id}" data-b="${b.id}" style="background:${down ? 'var(--lat-bad)' : latencyColor(mm.rtt)}33;color:${down ? 'var(--lat-bad)' : latencyColor(mm.rtt)}" title="${esc(a.name)} ⟷ ${esc(b.name)}：${down ? '不通' : fmtMs(mm.rtt)}${mm.loss ? ` 丢包 ${mm.loss}%` : ''}">${down ? '✕' : Math.round(mm.rtt)}</td>`;
            }
            if (!showEst) return `<td data-a="${a.id}" data-b="${b.id}"></td>`;
            const est = estimateRttMs(a, b);
            return `<td data-a="${a.id}" data-b="${b.id}" class="est" title="估算 ≈ ${est} ms">${est}</td>`;
          })
          .join('');
        return `<tr><th class="rh" title="${esc(cityName(a.city))}">${esc(a.name)}</th>${cells}</tr>`;
      })
      .join('');
    $('.matrix-wrap', m.el).innerHTML = `<table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  };
  // 行 = 服务器，列 = 检测目标（按分组排列）
  const renderTargets = () => {
    const targets = (store.settings.targets || []).filter((t) => t.enabled);
    $('[data-tip]', m.el).textContent = '数据来自各服务器的 Agent · 点击行查看服务器';
    if (!targets.length) {
      $('.matrix-wrap', m.el).innerHTML = '<p class="hint" style="padding:16px">没有启用的检测目标（⚙ 设置 →「检测目标」）</p>';
      return;
    }
    const head = targets.map((t) => `<th title="${esc(t.host)}"><div class="vh">${esc(t.name)}</div></th>`).join('');
    const rows = servers
      .map((s) => {
        const res = store.status.targets?.[s.id] || {};
        const cells = targets
          .map((t) => {
            const r = res[t.id];
            if (!r) return '<td class="nodata"></td>';
            if (r.rtt == null) return `<td style="color:var(--lat-bad)" title="不通">✕</td>`;
            const c = latencyColor(r.rtt);
            return `<td style="background:${c}33;color:${c}" title="${esc(s.name)} → ${esc(t.name)}：${fmtMs(r.rtt)}${r.loss ? ` 丢包 ${r.loss}%` : ''}">${Math.round(r.rtt)}${r.loss ? '<sup>!</sup>' : ''}</td>`;
          })
          .join('');
        return `<tr data-sid="${s.id}"><th class="rh" title="${esc(cityName(s.city))}">${esc(s.name)}</th>${cells}</tr>`;
      })
      .join('');
    $('.matrix-wrap', m.el).innerHTML = `<table class="matrix tmatrix"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  };
  render();
  $('[data-est]', m.el).addEventListener('change', render);
  $('[data-mode]', m.el).addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    matrixMode = e.target.dataset.v;
    render();
  });
  $('.matrix-wrap', m.el).addEventListener('click', (e) => {
    const td = e.target.closest('td[data-a]');
    const tr = e.target.closest('tr[data-sid]');
    if (td) {
      m.close();
      onPick?.(td.dataset.a, td.dataset.b);
    } else if (tr) {
      m.close();
      onPickServer?.(tr.dataset.sid);
    }
  });
  const timer = setInterval(() => (document.body.contains(m.el) ? render() : clearInterval(timer)), 5000);
}

// ---------------- 导入导出 ----------------
export function openImportExport() { openBackup({parseImport}); }

function parseImport(text) {
  const t = text.trim();
  if (!t) throw new Error('内容为空');
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = JSON.parse(t);
    if(j.format==='network-planet-encrypted')throw new Error('请使用“加密完整备份 / 同步”导入此文件');
    return Array.isArray(j) ? { servers: j } : { servers: j.servers || [], links: j.links || [], routes: j.routes || [] };
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  if (!head.includes('name') && !head.includes('ip')) throw new Error('CSV 首行需要表头，至少包含 name 或 ip');
  const servers = lines.map((l) => {
    const cols = l.split(',').map((c) => c.trim());
    const o = {};
    head.forEach((h, i) => (o[h] = cols[i] ?? ''));
    if (o.tags) o.tags = o.tags.split('|');
    for (const k of ['lat', 'lon']) o[k] = o[k] === '' || o[k] == null ? undefined : Number(o[k]);
    return o;
  });
  return { servers };
}

export function promptToken() {
  return new Promise((resolve) => {
    const m = openModal({
      title: '需要访问口令',
      content: `<form class="form"><p class="hint">这个 Hub 启用了 ADMIN_TOKEN，请输入口令。</p><input class="input mono" type="password" name="t" required /><div class="form-actions"><button class="btn primary" type="submit">进入</button></div></form>`,
      onClose: () => resolve(),
    });
    $('form', m.el).addEventListener('submit', (e) => {
      e.preventDefault();
      setToken(e.target.elements.t.value.trim());
      m.close();
    });
  });
}
