// 杂项弹窗：延迟矩阵、JSON/CSV 导入导出、设置、管理口令。
import { store, measuredBetween, cityName } from '../state.js';
import { estimateRttMs } from '../../shared/cities.js';
import { api, setToken, getToken } from '../api.js';
import { openModal, $, toast, confirmDialog } from './dom.js';
import { esc, latencyColor, fmtMs } from '../format.js';

// ---------------- 延迟矩阵 ----------------
export function openMatrix({ onPick } = {}) {
  const servers = [...store.servers].sort((a, b) => (a.lon ?? 0) - (b.lon ?? 0));
  if (servers.length < 2) return toast('至少需要两台服务器', 'warn');
  const m = openModal({
    title: '互联延迟矩阵',
    wide: true,
    content: `
      <div class="matrix-tools">
        <label class="check"><input type="checkbox" data-est checked /> 无实测时显示估算值（斜体）</label>
        <span class="hint">按经度从西到东排序 · 点击格子查看这条链路</span>
      </div>
      <div class="matrix-wrap"></div>`,
  });
  const render = () => {
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
  render();
  $('[data-est]', m.el).addEventListener('change', render);
  $('.matrix-wrap', m.el).addEventListener('click', (e) => {
    const td = e.target.closest('td[data-a]');
    if (!td) return;
    m.close();
    onPick?.(td.dataset.a, td.dataset.b);
  });
  const timer = setInterval(() => (document.body.contains(m.el) ? render() : clearInterval(timer)), 5000);
}

// ---------------- 导入导出 ----------------
export function openImportExport() {
  const m = openModal({
    title: '导入 / 导出',
    wide: true,
    content: `
      <div class="form">
        <div class="row-actions">
          <button class="btn" data-export>⬇ 导出 JSON（服务器 + 连接）</button>
          <span class="hint">导出不包含 Agent Token 和 API Key。</span>
        </div>
        <h4>批量导入</h4>
        <p class="hint">支持 JSON（导出格式，或服务器数组）或 CSV（首行表头：<code>name,ip,city,provider,tags,lat,lon</code>，tags 用 <code>|</code> 分隔）。没有坐标/城市时按 IP 自动定位。</p>
        <textarea class="input mono" rows="10" placeholder='[{"name":"LA-1","ip":"1.2.3.4","city":"Los Angeles","provider":"vultr","tags":["proxy"]}]'></textarea>
        <div class="row-actions">
          <label class="btn sm">选择文件<input type="file" accept=".json,.csv,.txt" hidden /></label>
          <label class="check"><input type="checkbox" data-replace /> 覆盖现有全部数据（危险）</label>
        </div>
        <div class="form-actions"><span class="err"></span><button class="btn primary" data-import>导入</button></div>
      </div>`,
  });
  const ta = $('textarea', m.el);
  $('[data-export]', m.el).addEventListener('click', async () => {
    const data = await api('GET', '/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `network-planet-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('input[type=file]', m.el).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) ta.value = await f.text();
  });
  $('[data-import]', m.el).addEventListener('click', async (e) => {
    const err = $('.err', m.el);
    err.textContent = '';
    let payload;
    try {
      payload = parseImport(ta.value);
    } catch (x) {
      err.textContent = x.message;
      return;
    }
    const replace = $('[data-replace]', m.el).checked;
    if (replace && !(await confirmDialog('将删除现有全部服务器和连接，确定？', { danger: true, okText: '覆盖' }))) return;
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/import', { ...payload, replace });
      toast(`导入 ${r.added} 台${r.skipped.length ? `，${r.skipped.length} 台无法定位已跳过` : ''}`, r.skipped.length ? 'warn' : 'ok', 5000);
      m.close();
    } catch (x) {
      err.textContent = x.message;
    } finally {
      e.target.disabled = false;
    }
  });
}

function parseImport(text) {
  const t = text.trim();
  if (!t) throw new Error('内容为空');
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? { servers: j } : { servers: j.servers || [], links: j.links || [] };
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

// ---------------- 设置 ----------------
export function openSettings({ onChanged } = {}) {
  const s = store.settings;
  const demoCount = store.servers.filter((x) => x.demo).length;
  const m = openModal({
    title: '设置',
    content: `
      <form class="form">
        <label>Hub 公网地址（Agent 上报用）
          <input class="input mono" name="publicUrl" value="${esc(s.publicUrl || '')}" placeholder="${esc(location.origin)}" />
        </label>
        <p class="hint">VPS 上的 Agent 需要能访问这个地址。留空则使用当前浏览器地址。</p>
        <label>Hub 探测间隔（秒）<input class="input" name="probeIntervalSec" type="number" min="5" max="600" value="${s.probeIntervalSec || 15}" /></label>
        <p class="hint">Hub 会对每台服务器的「探测端口」做 TCP 连接测延迟（无需 Agent）。</p>
        <div class="form-actions"><button class="btn primary" type="submit">保存</button></div>
      </form>
      <h4>演示数据</h4>
      <div class="row-actions">
        <span class="hint">当前 ${demoCount} 台演示服务器</span>
        ${demoCount ? '<button class="btn sm danger" data-clear-demo>清除演示数据</button>' : '<button class="btn sm" data-seed-demo>载入演示数据</button>'}
      </div>
      <h4>访问口令</h4>
      <div class="row-actions">
        <span class="hint">${store.authRequired ? 'Hub 已启用 ADMIN_TOKEN。' : 'Hub 未设置 ADMIN_TOKEN（启动时设置环境变量即可启用）。'}</span>
        ${getToken() ? '<button class="btn sm" data-logout>清除本地口令</button>' : ''}
      </div>`,
  });
  $('form', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      store.settings = await api('PUT', '/api/settings', { publicUrl: f.publicUrl.value.trim().replace(/\/$/, ''), probeIntervalSec: Number(f.probeIntervalSec.value) || 15 });
      toast('已保存', 'ok');
      m.close();
      onChanged?.();
    } catch (x) {
      toast(x.message, 'error');
    }
  });
  $('[data-clear-demo]', m.el)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`删除全部 ${demoCount} 台演示服务器及其连接？`, { danger: true, okText: '清除' }))) return;
    await api('DELETE', '/api/demo');
    toast('演示数据已清除', 'ok');
    m.close();
  });
  $('[data-seed-demo]', m.el)?.addEventListener('click', async () => {
    await api('POST', '/api/demo');
    toast('已载入演示数据', 'ok');
    m.close();
  });
  $('[data-logout]', m.el)?.addEventListener('click', () => {
    setToken('');
    location.reload();
  });
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
