// 供应商 API 导入：管理 API Key 账号 → 拉取实例列表 → 勾选导入 / 更新。
import { store, cityName } from '../state.js';
import { api } from '../api.js';
import { openModal, $, $$, toast, confirmDialog } from './dom.js';
import { esc, fmtAgo, fmtBytesMB, providerColor } from '../format.js';

let modal = null;
let syncState = null; // { accountId, items }

export function openProviders() {
  modal = openModal({
    title: '通过供应商 API 导入',
    wide: true,
    content: `
      <div class="prov-layout">
        <div class="prov-accounts"></div>
        <div class="prov-add">
          <h4>添加 API 账号</h4>
          <form class="form" autocomplete="off">
            <label>供应商<select class="input" name="provider">${store.providers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
            <label>名称<input class="input" name="label" placeholder="例如：Vultr 主账号" /></label>
            <div class="prov-fields"></div>
            <p class="hint prov-docs"></p>
            <div class="form-actions"><span class="err"></span><button class="btn primary" type="submit">保存并拉取</button></div>
          </form>
          <p class="hint">🔒 API Key 只保存在 Hub 服务器的 <code>data/db.json</code>（权限 600），前端只显示打码值。建议使用只读权限的 Token。</p>
        </div>
      </div>
      <div class="sync-result"></div>`,
    onClose: () => {
      modal = null;
      syncState = null;
    },
  });
  const form = $('.prov-add form', modal.el);
  const renderFields = () => {
    const p = store.providers.find((x) => x.id === form.elements.provider.value);
    $('.prov-fields', form).innerHTML = (p?.fields || [])
      .map((f) =>
        f.multiline
          ? `<label>${esc(f.label)}<textarea class="input mono" name="cred.${f.key}" rows="3" ${f.optional ? '' : 'required'}></textarea></label>`
          : `<label>${esc(f.label)}<input class="input mono" name="cred.${f.key}" type="${f.secret ? 'password' : 'text'}" ${f.optional ? '' : 'required'} /></label>`,
      )
      .join('');
    $('.prov-docs', form).textContent = p?.docs ? `获取方式：${p.docs}` : '';
  };
  form.elements.provider.addEventListener('change', renderFields);
  renderFields();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const credentials = {};
    for (const el of form.elements) if (el.name?.startsWith('cred.')) credentials[el.name.slice(5)] = el.value;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    $('.err', form).textContent = '';
    try {
      const acc = await api('POST', '/api/accounts', { provider: form.elements.provider.value, label: form.elements.label.value, credentials });
      store.accounts.push(acc);
      form.reset();
      renderFields();
      renderAccounts();
      await sync(acc.id);
    } catch (err) {
      $('.err', form).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('.prov-accounts', modal.el).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'sync') sync(id);
    if (b.dataset.act === 'delete') {
      if (!(await confirmDialog('删除这个 API 账号？已导入的服务器会保留。', { danger: true, okText: '删除' }))) return;
      await api('DELETE', `/api/accounts/${id}`);
      store.accounts = store.accounts.filter((a) => a.id !== id);
      renderAccounts();
    }
  });
  renderAccounts();
}

export function refreshProviders() {
  if (modal) renderAccounts();
}

function renderAccounts() {
  const el = $('.prov-accounts', modal.el);
  if (!store.accounts.length) {
    el.innerHTML = `<h4>已保存的账号</h4><p class="hint">还没有账号。支持：${store.providers.map((p) => esc(p.name)).join('、')}。</p>`;
    return;
  }
  el.innerHTML = `<h4>已保存的账号</h4>` + store.accounts
    .map((a) => {
      const p = store.providers.find((x) => x.id === a.provider);
      const keys = Object.entries(a.credentials).filter(([, v]) => v).map(([k, v]) => `<code>${esc(String(v).split('\n')[0])}</code>`).join(' ');
      return `
      <div class="acc-row">
        <div class="acc-main">
          <b><span class="badge" style="--c:${providerColor(a.provider)}">${esc(p?.name || a.provider)}</span> ${esc(a.label)}</b>
          <div class="hint">${keys} · 上次同步：${fmtAgo(a.lastSync)}${a.count != null ? ` · ${a.count} 台` : ''}</div>
          ${a.lastError ? `<div class="err">${esc(a.lastError)}</div>` : ''}
        </div>
        <div class="row-actions">
          <button class="btn sm primary" data-act="sync" data-id="${a.id}">拉取</button>
          <button class="btn sm danger" data-act="delete" data-id="${a.id}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

async function sync(accountId) {
  const box = $('.sync-result', modal?.el);
  if (!box) return;
  const acc = store.accounts.find((a) => a.id === accountId);
  box.innerHTML = `<div class="loading-inline"><div class="spinner sm"></div>正在调用 ${esc(acc?.label || '')} API…</div>`;
  try {
    const { items } = await api('POST', `/api/accounts/${accountId}/sync`);
    syncState = { accountId, items };
    renderSync();
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

function renderSync() {
  const box = $('.sync-result', modal.el);
  const { items } = syncState;
  if (!items.length) {
    box.innerHTML = '<p class="hint">该账号下没有实例。</p>';
    return;
  }
  box.innerHTML = `
    <div class="sync-head">
      <h4>拉取到 ${items.length} 台实例</h4>
      <label class="check"><input type="checkbox" data-all checked /> 全选</label>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th></th><th>名称</th><th>IP</th><th>区域 → 位置</th><th>配置</th><th>状态</th><th></th></tr></thead>
      <tbody>${items
        .map(
          (it, i) => `
        <tr class="${it.lat == null ? 'warn' : ''}">
          <td><input type="checkbox" data-i="${i}" ${it.lat == null ? 'disabled' : 'checked'} /></td>
          <td><b>${esc(it.name)}</b></td>
          <td class="mono">${esc(it.ip || '—')}</td>
          <td>${esc(it.region || '')} → ${it.lat != null ? `${esc(cityName(it.city) || `${it.lat.toFixed(1)},${it.lon.toFixed(1)}`)} <small class="muted">${esc(it.locSource || '')}</small>` : '<span class="bad">无法定位</span>'}</td>
          <td class="muted">${[it.specs?.cpu && `${it.specs.cpu}C`, it.specs?.ramMB && fmtBytesMB(it.specs.ramMB), it.specs?.diskGB && `${it.specs.diskGB}G`].filter(Boolean).join(' / ')}</td>
          <td>${esc(it.status || '')}</td>
          <td>${it.existingId ? '<span class="pill">已导入·将更新</span>' : '<span class="pill new">新</span>'}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <div class="form-actions"><span class="hint">已导入的实例会更新 IP / 配置 / 状态，保留你修改过的名称、标签、备注和手动位置。</span><button class="btn primary" data-import>导入 / 更新选中</button></div>`;

  $('[data-all]', box).addEventListener('change', (e) => {
    for (const c of $$('tbody input[type=checkbox]:not(:disabled)', box)) c.checked = e.target.checked;
  });
  $('[data-import]', box).addEventListener('click', async (e) => {
    const providerIds = $$('tbody input[type=checkbox]:checked', box).map((c) => items[+c.dataset.i].providerId);
    if (!providerIds.length) return toast('没有勾选任何实例', 'warn');
    e.target.disabled = true;
    try {
      const r = await api('POST', `/api/accounts/${syncState.accountId}/import`, { providerIds });
      toast(`导入完成：新增 ${r.added}，更新 ${r.updated}`, 'ok', 4000);
      sync(syncState.accountId);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.disabled = false;
    }
  });
}
