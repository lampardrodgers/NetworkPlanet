// 「安装探针」弹窗（一条命令通装 + 各机 Agent 状态）、告警事件列表、顶栏告警徽标。
import { store, statusOf, cityName } from '../state.js';
import { api } from '../api.js';
import { openModal, $, toast, confirmDialog, copyText } from './dom.js';
import { esc, fmtAgo, statusKey } from '../format.js';

export const hubUrl = () => store.settings.publicUrl || location.origin;
const isLocalHub = () => /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(hubUrl());

/**
 * 给 AI 编码助手（Claude Code、Codex 等能执行 ssh 的智能体）的部署说明。
 * 填好 Hub 地址和注册密钥，用户只需在末尾补上 VPS 登录方式，整段发给智能体即可。
 */
export function aiDeployPrompt({ hub, key, opts = '' }) {
  return `# 任务：在我的 VPS 上安装 Network Planet 探针

你可以通过 ssh 登录我的 VPS。请在下面「VPS 列表」里的每一台上安装 Network Planet 探针（np-agent），装完逐台汇报结果。

## 安装命令（每台机器都一样）
\`\`\`bash
curl -fsSL ${hub}/agent/install.sh | sudo NP_HUB=${hub} NP_KEY=${key}${opts ? ' ' + opts : ''} bash
\`\`\`
- 必须以 root 执行（非 root 用户加 sudo）。
- 想给某台机器指定显示名 / 城市 / 标签，就在 \`bash\` 前面加 \`NP_NAME=xxx\`、\`NP_CITY='Los Angeles'\`、\`NP_TAGS=cn2,proxy\`（列表里有写才加，没写就不加，探针会按公网 IP 自动定位）。

## 每台机器的步骤
1. ssh 登录，执行 \`uname -a; cat /etc/os-release | head -3; command -v systemctl curl\`，确认是 Linux、有 systemd 和 curl。
   - 没有 curl：用系统包管理器装（apt-get / dnf / yum）。
   - 没有 systemd（如 Alpine / OpenRC）：**不要安装**，记为「不支持」，继续下一台。
2. 检查能否连到 Hub：\`curl -sS -o /dev/null -w '%{http_code}\\n' ${hub}/agent/install.sh\`，应输出 200。不是 200 时记下报错（多半是 Hub 地址不对或防火墙），跳过这台。
3. 执行上面的安装命令。输出里出现「已注册为 …」和「✅ np-agent … 已运行」就是成功。
4. 验证：\`systemctl is-active np-agent\` 应为 active；\`journalctl -u np-agent -n 20 --no-pager\` 里不应有反复报错。

## 规则
- 只做上面这些事：不要改 ssh 配置、防火墙、内核参数，不要升级系统，不要重启机器。安装脚本自己会尝试装 ping 和 iperf3，不需要你另装。
- 已经装过的机器重新执行同一条命令即可（会原地升级，不会重复注册）。
- 不要把注册密钥、密码、私钥写进任何文件或发到别处；汇报里不要出现它们。
- 某台失败就记下原因继续下一台，不要为了装上而做上面没提到的改动；拿不准的先问我。

## 完成后汇报
用表格列出每台：主机 / 系统 / 结果（成功、不支持、连不上 Hub、其它失败）/ 失败原因。

## VPS 列表
（在这里写每台的登录方式，例如：）
- 1.2.3.4 端口 22 用户 root，用私钥 ~/.ssh/id_ed25519 登录，NP_NAME=HK-01
- 5.6.7.8 端口 2222 用户 ubuntu（有 sudo），密码见我的密码管理器 / 我会单独发给你
`;
}

/** Agent 状态：none 未安装 / stale 离线 / old 需升级 / ok */
export function agentState(s) {
  if (s.demo) return { key: 'demo', text: '演示' };
  const st = statusOf(s.id);
  const ag = st?.agent;
  if (!ag) return st?.lastSeen ? { key: 'stale', text: `离线（${fmtAgo(st.lastSeen)}）` } : { key: 'none', text: '未安装' };
  if (store.agentVersion && ag.version !== store.agentVersion) return { key: 'old', text: `v${ag.version} 需升级` };
  return { key: 'ok', text: `v${ag.version}` };
}

export async function openInstall() {
  let en;
  try {
    en = await api('GET', '/api/enroll');
  } catch (e) {
    return toast(e.message, 'error');
  }
  const m = openModal({
    title: '安装探针',
    wide: true,
    content: `
      <div class="form">
        ${isLocalHub() ? `<p class="warn-box">当前 Hub 地址是 <code>${esc(hubUrl())}</code>，VPS 访问不到。请先在 ⚙ 设置 →「Hub 公网地址」填一个 VPS 能访问的地址（域名或公网 IP:端口）。</p>` : ''}
        <h4 style="margin-top:0">一条命令，所有 VPS 通用 <label class="check" style="margin-left:auto"><input type="checkbox" data-enroll ${en.enabled ? 'checked' : ''}/> 允许自动注册</label></h4>
        <p class="hint">在每台 VPS 上以 root 执行。装好后自动出现在地球上：已经通过 API 导入或手动添加过的机器按 IP 自动认领，新机器按 IP 自动定位。</p>
        <pre class="cmd" data-cmd></pre>
        <div class="grid3">
          <label>NP_NAME（可选，显示名）<input class="input sm" data-opt="NP_NAME" placeholder="默认用主机名" /></label>
          <label>NP_TAGS（可选，逗号分隔）<input class="input sm" data-opt="NP_TAGS" placeholder="cn2,proxy" /></label>
          <label>NP_CITY（可选，定位不准时）<input class="input sm" data-opt="NP_CITY" placeholder="Los Angeles" /></label>
        </div>
        <div class="row-actions">
          <button type="button" class="btn sm primary" data-copy>复制安装命令</button>
          <button type="button" class="btn sm" data-rotate>更换注册密钥</button>
          <span class="hint">密钥只用于注册，泄露后更换即可，已安装的 Agent 不受影响。</span>
        </div>
        <div class="row-actions">
          <button type="button" class="btn sm" data-ai>🤖 复制给 AI 助手的部署说明</button>
          <span class="hint">机器多时：复制后在末尾补上各台 VPS 的登录方式，整段发给 Claude Code / Codex 等能用 ssh 的智能体，让它逐台安装并汇报。建议给它一把临时 ssh 密钥，装完删掉。</span>
        </div>
        <details class="more">
          <summary>升级 / 卸载 / 说明</summary>
          <p class="hint">升级（沿用原身份，不会重复注册）：</p>
          <pre class="cmd">curl -fsSL ${esc(hubUrl())}/agent/install.sh | sudo bash</pre>
          <p class="hint">卸载：</p>
          <pre class="cmd">curl -fsSL ${esc(hubUrl())}/agent/install.sh | sudo bash -s -- uninstall</pre>
          <p class="hint">Agent 是纯 bash + curl 脚本，以无特权的临时用户运行（只额外授予 ping 需要的 CAP_NET_RAW）。安装时会尝试装 ping 和 iperf3（带宽测试用，加 <code>NP_NO_DEPS=1</code> 跳过）。
          Hub 只能下发配置和测速任务，<b>不能</b>在 VPS 上执行任意命令。需要 systemd。</p>
        </details>
        <h4>各服务器 Agent 状态 <span class="hint" data-summary></span></h4>
        <div class="table-wrap"><table class="table"><thead><tr><th></th><th>服务器</th><th>位置</th><th>Agent</th><th>iperf3</th><th>最后上报</th></tr></thead><tbody data-rows></tbody></table></div>
      </div>`,
  });
  const opts = {};
  const extraOpts = () =>
    Object.entries(opts)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${/^[\w.,-]+$/.test(v) ? v : `'${v.replace(/'/g, '')}'`}`)
      .join(' ');
  const renderCmd = () => {
    const extra = extraOpts();
    $('[data-cmd]', m.el).textContent = `curl -fsSL ${hubUrl()}/agent/install.sh | sudo NP_HUB=${hubUrl()} NP_KEY=${en.key}${extra ? ' ' + extra : ''} bash`;
  };
  const renderRows = () => {
    const list = store.servers.filter((s) => !s.demo);
    const counts = { ok: 0, old: 0, stale: 0, none: 0 };
    $('[data-rows]', m.el).innerHTML = list.length
      ? list
          .map((s) => {
            const a = agentState(s);
            counts[a.key]++;
            const st = statusOf(s.id);
            return `<tr><td><i class="dot ${statusKey(st)}"></i></td><td>${esc(s.name)}</td><td>${esc(cityName(s.city))}</td>
              <td><span class="ag ${a.key}">${esc(a.text)}</span></td><td>${st?.agent ? (st.agent.iperf ? '✓' : '<span class="muted">无</span>') : ''}</td><td>${fmtAgo(st?.lastSeen)}</td></tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="hint" style="text-align:center;padding:16px">还没有真实服务器。执行上面的安装命令，装好后会自动出现在这里。</td></tr>';
    $('[data-summary]', m.el).textContent = list.length ? `${counts.ok + counts.old} 台在线${counts.old ? `（${counts.old} 台需升级）` : ''} · ${counts.stale} 台离线 · ${counts.none} 台未安装` : '';
  };
  renderCmd();
  renderRows();
  const timer = setInterval(() => (document.body.contains(m.el) ? renderRows() : clearInterval(timer)), 3000);

  m.el.addEventListener('input', (e) => {
    if (!e.target.dataset.opt) return;
    opts[e.target.dataset.opt] = e.target.value.trim();
    renderCmd();
  });
  $('[data-copy]', m.el).addEventListener('click', () => copyText($('[data-cmd]', m.el).textContent));
  $('[data-ai]', m.el).addEventListener('click', () => {
    if (isLocalHub()) return toast('先在 ⚙ 设置里填「Hub 公网地址」，否则 VPS 连不上 Hub', 'error');
    copyText(aiDeployPrompt({ hub: hubUrl(), key: en.key, opts: extraOpts() }));
  });
  $('[data-rotate]', m.el).addEventListener('click', async () => {
    if (!(await confirmDialog('更换后旧的安装命令立即失效（已安装的 Agent 不受影响）。继续？', { okText: '更换' }))) return;
    en = await api('POST', '/api/enroll/rotate');
    renderCmd();
    toast('注册密钥已更换', 'ok');
  });
  $('[data-enroll]', m.el).addEventListener('change', async (e) => {
    store.settings = await api('PUT', '/api/settings', { enroll: { enabled: e.target.checked } });
    toast(e.target.checked ? '已允许自动注册' : '已关闭自动注册（安装命令将无法注册新机器）', 'ok');
  });
}

// ---------------- 告警 ----------------
export function renderAlertBadge() {
  const b = $('#topbar .bell .badge-n');
  if (!b) return;
  const n = (store.status.alerts || []).length;
  b.textContent = n || (store.unreadEvents ? '•' : '');
  b.classList.toggle('hidden', !n && !store.unreadEvents);
  b.classList.toggle('firing', n > 0);
}

export async function openEvents({ onSelect } = {}) {
  store.unreadEvents = 0;
  renderAlertBadge();
  const m = openModal({
    title: '告警',
    wide: true,
    content: `
      <div class="form">
        ${store.settings.alerts?.enabled ? '' : '<p class="warn-box">告警未启用。在 ⚙ 设置 →「告警」里打开并配置通知渠道。</p>'}
        <h4 style="margin-top:0">正在告警</h4>
        <div data-active></div>
        <h4>最近事件 <button type="button" class="btn xs" data-clear style="margin-left:auto">清空</button></h4>
        <div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>服务器</th><th>类型</th><th>详情</th></tr></thead><tbody data-events><tr><td colspan="4"><div class="loading-inline"><div class="spinner sm"></div>加载中…</div></td></tr></tbody></table></div>
      </div>`,
  });
  const renderActive = () => {
    const list = store.status.alerts || [];
    $('[data-active]', m.el).innerHTML = list.length
      ? list
          .map((a) => {
            const s = store.servers.find((x) => x.id === a.serverId);
            return `<div class="alert-row" data-sid="${a.serverId}"><i class="dot offline"></i><b>${esc(s?.name || a.serverId)}</b><span>${esc(a.ruleName)}</span><span class="muted">${fmtAgo(a.since)}起</span></div>`;
          })
          .join('')
      : '<p class="hint">一切正常 ✓</p>';
  };
  const load = async () => {
    const evs = await api('GET', '/api/events');
    $('[data-events]', m.el).innerHTML = evs.length
      ? evs
          .map(
            (e) => `<tr class="ev ${e.level}" data-sid="${e.serverId}"><td class="mono">${new Date(e.ts).toLocaleString('zh-CN', { hour12: false })}</td>
              <td>${esc(e.serverName)}</td><td>${e.level === 'firing' ? '🔴' : '✅'} ${esc(e.ruleName)}${e.level === 'resolved' ? '恢复' : ''}</td><td>${esc(e.text)}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="4" class="hint" style="text-align:center;padding:16px">暂无事件</td></tr>';
  };
  renderActive();
  load().catch((e) => toast(e.message, 'error'));
  const timer = setInterval(() => (document.body.contains(m.el) ? renderActive() : clearInterval(timer)), 3000);
  m.el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-sid]');
    if (row && store.servers.some((s) => s.id === row.dataset.sid)) {
      m.close();
      onSelect?.(row.dataset.sid);
    }
  });
  $('[data-clear]', m.el).addEventListener('click', async () => {
    if (!(await confirmDialog('清空全部告警事件记录？', { danger: true, okText: '清空' }))) return;
    await api('DELETE', '/api/events');
    load();
  });
}
