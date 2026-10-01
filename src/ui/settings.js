// 设置弹窗：通用 / 探针 / 检测目标 / 告警 四个分页，一个「保存」统一提交。
import { store } from '../state.js';
import { api, setToken, getToken } from '../api.js';
import { openModal, $, $$, toast, confirmDialog, formData } from './dom.js';
import { esc } from '../format.js';

const TABS = [
  ['general', '通用'],
  ['probe', '探针'],
  ['targets', '检测目标'],
  ['alerts', '告警'],
];
let lastTab = 'general';

const chk = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} /> ${label}</label>`;
const num = (name, v, { min = 0, max = 99999, unit = '' } = {}) =>
  `<span class="num-in"><input class="input sm" type="number" name="${name}" value="${v ?? ''}" min="${min}" max="${max}" />${unit ? `<em>${unit}</em>` : ''}</span>`;
const sel = (name, v, opts) => `<select class="input sm" name="${name}">${opts.map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;

export const TRAFFIC_MODE_OPTS = [
  ['sum', '双向合计'],
  ['out', '只算出站'],
  ['in', '只算入站'],
  ['max', '取较大方向'],
];

export function openSettings({ onChanged, tab } = {}) {
  const s = store.settings;
  const p = s.probe;
  const a = s.alerts;
  const R = a.rules;
  const demoCount = store.servers.filter((x) => x.demo).length;
  const m = openModal({
    title: '设置',
    wide: true,
    content: `
    <form class="form settings">
      <nav class="tabs">${TABS.map(([k, t]) => `<button type="button" data-tab="${k}">${t}</button>`).join('')}</nav>

      <section data-pane="general">
        <label>Hub 公网地址（Agent 上报用）
          <input class="input mono" name="publicUrl" value="${esc(s.publicUrl || '')}" placeholder="${esc(location.origin)}" />
        </label>
        <p class="hint">VPS 上的 Agent 需要能访问这个地址（安装命令里也会用它）。留空则使用当前浏览器地址。</p>
        <label>Hub 探测间隔（秒）<input class="input" name="probeIntervalSec" type="number" min="5" max="600" value="${s.probeIntervalSec || 15}" /></label>
        <p class="hint">Hub 会对每台服务器的「探测端口」做 TCP 连接测延迟（不需要 Agent）。</p>
        <h4>演示数据</h4>
        <div class="row-actions">
          <span class="hint">当前 ${demoCount} 台演示服务器</span>
          ${demoCount ? '<button type="button" class="btn sm danger" data-clear-demo>清除演示数据</button>' : '<button type="button" class="btn sm" data-seed-demo>载入演示数据</button>'}
        </div>
        <h4>访问口令</h4>
        <div class="row-actions">
          <span class="hint">${store.authRequired ? 'Hub 已启用 ADMIN_TOKEN。' : 'Hub 未设置 ADMIN_TOKEN（启动时设置环境变量即可启用）。'}</span>
          ${getToken() ? '<button type="button" class="btn sm" data-logout>清除本地口令</button>' : ''}
        </div>
      </section>

      <section data-pane="probe">
        <p class="hint">这里是所有 Agent 的全局配置，保存后几秒内下发生效，不用重启 Agent。单台服务器可以在「编辑」里单独覆盖。</p>
        <div class="opt-grid">
          <div class="opt-row"><b>基础指标</b><span>每 ${num('probe.intervalSec', p.intervalSec, { min: 3, max: 300, unit: '秒' })} 上报 CPU / 内存 / 磁盘 / 网速 / 连接数</span></div>
          <div class="opt-row">${chk('probe.peers.enabled', p.peers.enabled, '<b>服务器互测</b>')}
            <span>每 ${num('probe.peers.intervalSec', p.peers.intervalSec, { min: 10, max: 3600, unit: '秒' })}
            用 ${sel('probe.peers.method', p.peers.method, [['icmp', 'ICMP ping'], ['tcp', 'TCP 连接']])}
            发 ${num('probe.peers.count', p.peers.count, { min: 1, max: 10, unit: '次' })}</span></div>
          <div class="opt-row">${chk('probe.targets.enabled', p.targets.enabled, '<b>检测目标</b>')}
            <span>每 ${num('probe.targets.intervalSec', p.targets.intervalSec, { min: 10, max: 3600, unit: '秒' })}
            每个目标测 ${num('probe.targets.count', p.targets.count, { min: 1, max: 10, unit: '次' })}（三网 / 自定义，见「检测目标」页）</span></div>
          <div class="opt-row">${chk('probe.bandwidth.enabled', p.bandwidth.enabled, '<b>带宽测试</b>')}
            <span>iperf3 端口 ${num('probe.bandwidth.port', p.bandwidth.port, { min: 1, max: 65535 })}
            每方向 ${num('probe.bandwidth.durationSec', p.bandwidth.durationSec, { min: 2, max: 30, unit: '秒' })}
            自动测速 每 ${num('probe.bandwidth.autoHours', p.bandwidth.autoHours, { min: 0, max: 168, unit: '小时' })}（0 = 只手动）</span></div>
          <div class="opt-row">${chk('probe.traffic.enabled', p.traffic.enabled, '<b>流量统计</b>')}
            <span>每月 ${num('probe.traffic.resetDay', p.traffic.resetDay, { min: 1, max: 28, unit: '号' })} 重置，
            计费方式 ${sel('probe.traffic.mode', p.traffic.mode, TRAFFIC_MODE_OPTS)}</span></div>
        </div>
        <p class="hint">带宽测试会真实消耗流量（约 带宽 × 时长 × 2），并需要在防火墙放行 iperf3 端口。自动测速只针对「手动连接」的两端。</p>
        <p class="hint">这里的重置日是默认值（Hub 时区 0 点）。各台机器的重置时刻、周期长度（如每 30 天）、商家时区可以在服务器「编辑 → 流量周期」里单独设置。</p>
      </section>

      <section data-pane="targets">
        <p class="hint">每台装了 Agent 的服务器都会去测这些目标。默认是国内三网各地常用的 DNS 地址，运营商可能调整或屏蔽 ICMP，测不通时换成你自己的目标即可。</p>
        <div class="table-wrap"><table class="table targets-table">
          <thead><tr><th></th><th>名称</th><th>分组</th><th>方式</th><th>地址（IP / 域名）</th><th>端口</th><th></th></tr></thead>
          <tbody>${s.targets.map(targetRow).join('')}</tbody>
        </table></div>
        <div class="row-actions">
          <button type="button" class="btn sm" data-add-target>＋ 添加目标</button>
          <button type="button" class="btn sm" data-reset-targets>恢复默认三网</button>
        </div>
      </section>

      <section data-pane="alerts">
        <div class="row-actions">${chk('alerts.enabled', a.enabled, '<b>启用告警</b>')}${chk('alerts.recovery', a.recovery, '恢复时也通知')}</div>
        <div class="opt-grid">
          <div class="opt-row">${chk('alerts.rules.offline.enabled', R.offline.enabled, '离线')}<span>持续 ${num('alerts.rules.offline.sec', R.offline.sec, { min: 15, max: 3600, unit: '秒' })}</span></div>
          <div class="opt-row">${chk('alerts.rules.cpu.enabled', R.cpu.enabled, 'CPU')}<span>≥ ${num('alerts.rules.cpu.pct', R.cpu.pct, { min: 1, max: 100, unit: '%' })} 持续 ${num('alerts.rules.cpu.min', R.cpu.min, { max: 1440, unit: '分钟' })}</span></div>
          <div class="opt-row">${chk('alerts.rules.mem.enabled', R.mem.enabled, '内存')}<span>≥ ${num('alerts.rules.mem.pct', R.mem.pct, { min: 1, max: 100, unit: '%' })} 持续 ${num('alerts.rules.mem.min', R.mem.min, { max: 1440, unit: '分钟' })}</span></div>
          <div class="opt-row">${chk('alerts.rules.disk.enabled', R.disk.enabled, '磁盘')}<span>已用 ≥ ${num('alerts.rules.disk.pct', R.disk.pct, { min: 1, max: 100, unit: '%' })}</span></div>
          <div class="opt-row">${chk('alerts.rules.traffic.enabled', R.traffic.enabled, '流量')}<span>本周期已用 ≥ 套餐的 ${num('alerts.rules.traffic.pct', R.traffic.pct, { min: 1, max: 100, unit: '%' })}（需在服务器里填「月流量」）</span></div>
          <div class="opt-row">${chk('alerts.rules.targetLatency.enabled', R.targetLatency.enabled, '检测目标延迟')}<span>任一目标 ≥ ${num('alerts.rules.targetLatency.ms', R.targetLatency.ms, { min: 1, max: 10000, unit: 'ms' })} 持续 ${num('alerts.rules.targetLatency.min', R.targetLatency.min, { max: 1440, unit: '分钟' })}</span></div>
          <div class="opt-row">${chk('alerts.rules.targetLoss.enabled', R.targetLoss.enabled, '检测目标丢包')}<span>任一目标 ≥ ${num('alerts.rules.targetLoss.pct', R.targetLoss.pct, { min: 1, max: 100, unit: '%' })} 持续 ${num('alerts.rules.targetLoss.min', R.targetLoss.min, { max: 1440, unit: '分钟' })}</span></div>
          <div class="opt-row">${chk('alerts.rules.expiry.enabled', R.expiry.enabled, '到期提醒')}<span>提前 ${num('alerts.rules.expiry.days', R.expiry.days, { min: 1, max: 90, unit: '天' })}（需在服务器里填「到期日」）</span></div>
        </div>
        <h4>通知渠道</h4>
        <fieldset>
          <legend>${chk('alerts.channels.telegram.enabled', a.channels.telegram.enabled, 'Telegram Bot')}</legend>
          <div class="grid2">
            <label>Bot Token<input class="input mono" name="alerts.channels.telegram.botToken" value="${esc(a.channels.telegram.botToken)}" placeholder="123456:ABC-DEF…" autocomplete="off" /></label>
            <label>Chat ID<input class="input mono" name="alerts.channels.telegram.chatId" value="${esc(a.channels.telegram.chatId)}" placeholder="123456789 或 -100…" /></label>
          </div>
          <p class="hint">Hub 需要能访问 api.telegram.org（国内机器上的 Hub 建议用下面的 Webhook）。</p>
        </fieldset>
        <fieldset>
          <legend>${chk('alerts.channels.webhook.enabled', a.channels.webhook.enabled, 'Webhook')}</legend>
          <div class="grid3">
            <label>类型${sel('alerts.channels.webhook.type', a.channels.webhook.type, [['generic', '通用 JSON'], ['dingtalk', '钉钉机器人'], ['wecom', '企业微信机器人'], ['feishu', '飞书机器人'], ['bark', 'Bark']])}</label>
            <label class="span2">URL<input class="input mono" name="alerts.channels.webhook.url" value="${esc(a.channels.webhook.url)}" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" autocomplete="off" /></label>
          </div>
          <p class="hint">钉钉机器人的安全设置请选「自定义关键词」并填 <code>Network Planet</code>；Bark 填 <code>https://api.day.app/你的key</code>。</p>
        </fieldset>
        <div class="row-actions"><button type="button" class="btn sm" data-test-alert>保存并发送测试通知</button><span class="hint" data-test-result></span></div>
      </section>

      <div class="form-actions"><span class="err"></span><button type="button" class="btn" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
    </form>`,
  });
  const form = $('form', m.el);

  const showTab = (k) => {
    lastTab = k;
    for (const b of $$('[data-tab]', form)) b.classList.toggle('on', b.dataset.tab === k);
    for (const p of $$('[data-pane]', form)) p.classList.toggle('hidden', p.dataset.pane !== k);
  };
  showTab(tab || lastTab);
  $('.tabs', form).addEventListener('click', (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));

  // ---- 检测目标表格 ----
  const tbody = $('.targets-table tbody', form);
  $('[data-add-target]', form).addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', targetRow({ enabled: true, method: 'icmp', group: '自定义', name: '', host: '', port: '' }));
    $('tr:last-child [data-f=name]', tbody).focus();
  });
  tbody.addEventListener('click', (e) => e.target.closest('[data-del]')?.closest('tr').remove());
  tbody.addEventListener('change', (e) => {
    if (e.target.dataset.f !== 'method') return;
    const port = $('[data-f=port]', e.target.closest('tr'));
    port.disabled = e.target.value === 'icmp';
    if (!port.disabled && !port.value) port.value = e.target.value === 'http' ? 443 : 80;
  });
  $('[data-reset-targets]', form).addEventListener('click', async () => {
    if (!(await confirmDialog('用默认的三网 + 公共 DNS 目标替换当前列表？'))) return;
    store.settings = await api('PUT', '/api/settings', { targets: 'default' });
    tbody.innerHTML = store.settings.targets.map(targetRow).join('');
    toast('已恢复默认检测目标', 'ok');
  });

  const collect = () => {
    const d = formData(form);
    const targets = $$('tr', tbody)
      .map((tr) => {
        const f = (k) => $(`[data-f=${k}]`, tr);
        return { id: tr.dataset.id || undefined, enabled: f('enabled').checked, name: f('name').value, group: f('group').value, method: f('method').value, host: f('host').value.trim(), port: f('port').value, city: tr.dataset.city || undefined };
      })
      .filter((t) => t.host);
    // 表格里的输入框没有 name，formData 不会收集；alerts / probe 的数字由服务端校验
    return { publicUrl: (d.publicUrl || '').trim().replace(/\/$/, ''), probeIntervalSec: Number(d.probeIntervalSec) || 15, probe: d.probe, alerts: d.alerts, targets };
  };

  const save = async () => {
    store.settings = await api('PUT', '/api/settings', collect());
    onChanged?.();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await save();
      toast('设置已保存，Agent 会在几秒内收到新配置', 'ok');
      m.close();
    } catch (x) {
      $('.err', form).textContent = x.message;
    }
  });

  $('[data-test-alert]', form).addEventListener('click', async (e) => {
    const out = $('[data-test-result]', form);
    e.target.disabled = true;
    out.textContent = '发送中…';
    try {
      await save();
      const r = await api('POST', '/api/alerts/test');
      out.innerHTML = r.map((x) => `${esc(x.channel)}：${x.ok ? '<span style="color:var(--ok)">成功</span>' : `<span class="bad">${esc(x.error)}</span>`}`).join('　');
    } catch (x) {
      out.innerHTML = `<span class="bad">${esc(x.message)}</span>`;
    } finally {
      e.target.disabled = false;
    }
  });

  $('[data-clear-demo]', form)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`删除全部 ${demoCount} 台演示服务器及其连接？`, { danger: true, okText: '清除' }))) return;
    await api('DELETE', '/api/demo');
    toast('演示数据已清除', 'ok');
    m.close();
  });
  $('[data-seed-demo]', form)?.addEventListener('click', async () => {
    await api('POST', '/api/demo');
    toast('已载入演示数据', 'ok');
    m.close();
  });
  $('[data-logout]', form)?.addEventListener('click', () => {
    setToken('');
    location.reload();
  });
}

function targetRow(t) {
  const m = t.method || 'icmp';
  return `<tr data-id="${esc(t.id || '')}" data-city="${esc(t.city || '')}">
    <td><input type="checkbox" data-f="enabled" ${t.enabled ? 'checked' : ''} title="启用" /></td>
    <td><input class="input sm" data-f="name" value="${esc(t.name)}" placeholder="上海电信" /></td>
    <td><input class="input sm" data-f="group" value="${esc(t.group)}" list="np-target-groups" style="width:70px" /></td>
    <td><select class="input sm" data-f="method">${['icmp', 'tcp', 'http'].map((x) => `<option ${x === m ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td><input class="input sm mono" data-f="host" value="${esc(t.host)}" placeholder="1.2.3.4 / example.com" /></td>
    <td><input class="input sm" data-f="port" type="number" min="1" max="65535" value="${t.port || ''}" ${m === 'icmp' ? 'disabled' : ''} style="width:72px" /></td>
    <td><button type="button" class="icon-btn" data-del title="删除">✕</button></td>
  </tr>`;
}

// 分组输入的候选
document.body.insertAdjacentHTML('beforeend', '<datalist id="np-target-groups"><option value="电信"></option><option value="联通"></option><option value="移动"></option><option value="公共"></option><option value="自定义"></option></datalist>');
