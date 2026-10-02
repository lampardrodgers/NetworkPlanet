// 手动增删改：服务器表单、连接表单。
import { store, cityName } from '../state.js';
import { CITIES, haversineKm } from '../../shared/cities.js';
import { api } from '../api.js';
import { openModal, $, toast, formData } from './dom.js';
import { esc, fmtDT, fmtDuration, tzLabel } from '../format.js';
import { cycleAt, monthlyDef } from '../../shared/cycle.js';
import { TRAFFIC_MODE_OPTS } from './settings.js';

let ctx = {}; // { pickOnGlobe(cb), onSaved(server) }
export function initForms(c) {
  ctx = c;
}

const cityOption = (c) => `${c.zh} · ${c.name}`;

export function openServerForm(existing = null) {
  const s = existing || { probePort: 22, specs: {}, tags: [] };
  const sp = s.specs || {};
  const providers = [...new Set(['vultr', 'digitalocean', 'linode', 'hetzner', 'bandwagon', 'aws', 'gcp', 'azure', 'aliyun', 'tencent', 'oracle', 'ovh', 'racknerd', 'dmit', ...store.servers.map((x) => x.provider).filter(Boolean)])];
  const v = (x) => (x == null ? '' : esc(x));
  const m = openModal({
    title: existing ? `编辑：${existing.name}` : '添加服务器',
    wide: true,
    content: `
    <form class="form" autocomplete="off">
      <div class="grid2">
        <label>名称 *<input class="input" name="name" required value="${v(s.name)}" placeholder="LA-CN2-01" /></label>
        <label>供应商<input class="input" name="provider" list="np-providers" value="${v(s.provider)}" placeholder="vultr / bandwagon / …" /></label>
        <label>IP 地址<input class="input mono" name="ip" value="${v(s.ip)}" placeholder="1.2.3.4" /></label>
        <label>域名（可选，优先用于探测）<input class="input mono" name="host" value="${v(s.host)}" placeholder="la1.example.com" /></label>
      </div>
      <fieldset>
        <legend>位置</legend>
        <div class="grid3">
          <label class="span2">城市<input class="input" name="cityPick" list="np-cities" value="${s.city ? v(cityLabel(s.city)) : ''}" placeholder="输入「洛杉矶」或「Los Angeles」" /></label>
          <label>国家/地区<input class="input" name="country" value="${v(s.country)}" placeholder="US" /></label>
          <label>纬度<input class="input mono" name="lat" type="number" step="any" min="-90" max="90" value="${v(s.lat)}" /></label>
          <label>经度<input class="input mono" name="lon" type="number" step="any" min="-180" max="180" value="${v(s.lon)}" /></label>
          <div class="loc-actions">
            <button type="button" class="btn sm" data-geoip>按 IP 定位</button>
            <button type="button" class="btn sm" data-pick>在地球上选点</button>
          </div>
        </div>
        <p class="hint">${store.localMode ? '点击「按 IP 定位」查询约略位置；内网设备请填写实际城市。' : '只填 IP 也可以，保存时会自动按 IP 定位。'}同城多台机器会聚合，放大或点击后展开。</p>
      </fieldset>
      <fieldset>
        <legend>配置</legend>
        <div class="grid4">
          <label>CPU 核<input class="input" name="specs.cpu" type="number" min="0" value="${v(sp.cpu)}" /></label>
          <label>内存 MB<input class="input" name="specs.ramMB" type="number" min="0" value="${v(sp.ramMB)}" /></label>
          <label>磁盘 GB<input class="input" name="specs.diskGB" type="number" min="0" value="${v(sp.diskGB)}" /></label>
          <label>端口带宽 Mbps<input class="input" name="specs.bandwidthMbps" type="number" min="0" value="${v(sp.bandwidthMbps)}" /></label>
          <label>流量额度<span class="input-unit"><input class="input" name="quotaVal" type="number" step="any" min="0" value="${sp.trafficTB == null ? '' : sp.trafficTB < 1 ? +(sp.trafficTB * 1000).toFixed(3) : sp.trafficTB}" placeholder="不限" /><select class="input" name="quotaUnit"><option ${sp.trafficTB != null && sp.trafficTB < 1 ? 'selected' : ''}>GB</option><option ${sp.trafficTB == null || sp.trafficTB >= 1 ? 'selected' : ''}>TB</option></select></span></label>
          <label>套餐<input class="input" name="specs.plan" value="${v(sp.plan)}" /></label>
          <label>月费 $<input class="input" name="monthlyCost" type="number" step="any" min="0" value="${v(s.monthlyCost)}" /></label>
          <label>到期日<input class="input" name="expiresAt" type="date" value="${v(s.expiresAt)}" /></label>
        </div>
      </fieldset>
      <div class="grid3">
        <label>探测端口<input class="input" name="probePort" type="number" min="1" max="65535" value="${v(s.probePort ?? 22)}" /></label>
        <label>系统<input class="input" name="os" value="${v(s.os)}" placeholder="Debian 12" /></label>
        <label>标签（逗号分隔）<input class="input" name="tags" value="${v((s.tags || []).join(', '))}" placeholder="cn2, proxy" /></label>
      </div>
      <label>备注<textarea class="input" name="notes" rows="2">${v(s.notes)}</textarea></label>
      ${cycleFieldset(s)}
      ${probeFieldset(s)}
      <datalist id="np-cities">${CITIES.map((c) => `<option value="${cityOption(c)}"></option>`).join('')}</datalist>
      <datalist id="np-providers">${providers.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
      <div class="form-actions">
        <span class="err"></span>
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">${existing ? '保存' : '添加'}</button>
      </div>
    </form>`,
  });

  const form = $('form', m.el);
  const f = (n) => form.elements[n];
  let chosenCity = s.city || '';

  f('cityPick').addEventListener('input', () => {
    const c = CITIES.find((c) => cityOption(c) === f('cityPick').value);
    if (c) {
      chosenCity = c.name;
      f('lat').value = c.lat;
      f('lon').value = c.lon;
      f('country').value = c.cc;
    } else chosenCity = f('cityPick').value.trim();
  });

  $('[data-geoip]', form).addEventListener('click', async (e) => {
    const ip = f('host').value.trim() || f('ip').value.trim();
    if (!ip) return toast('先填写 IP 或域名', 'warn');
    e.target.disabled = true;
    try {
      const g = await api('GET', `/api/geoip?ip=${encodeURIComponent(ip)}`);
      f('lat').value = g.lat;
      f('lon').value = g.lon;
      f('country').value = g.country || '';
      chosenCity = g.city || '';
      f('cityPick').value = g.city ? cityLabel(g.city) : '';
      toast(`定位到：${g.city || ''} ${g.country || ''}（${g.isp || ''}）`, 'ok');
    } catch (err) {
      toast(`定位失败：${err.message}`, 'error');
    } finally {
      e.target.disabled = false;
    }
  });

  $('[data-pick]', form).addEventListener('click', () => {
    m.hide(true);
    ctx.pickOnGlobe((ll) => {
      m.hide(false);
      if (!ll) return;
      f('lat').value = ll.lat.toFixed(4);
      f('lon').value = ll.lon.toFixed(4);
      // 匹配 80km 内最近的已知城市
      const near = CITIES.map((c) => ({ c, d: haversineKm(c.lat, c.lon, ll.lat, ll.lon) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d < 80) {
        chosenCity = near.c.name;
        f('cityPick').value = cityOption(near.c);
        f('country').value = near.c.cc;
      }
    });
  });

  const cyc = bindCycle(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    delete d.cityPick;
    const body = { ...d, tags: d.tags };
    // 流量额度统一存 TB
    const q = d.quotaVal === '' ? null : Number(d.quotaVal);
    body.specs = { ...d.specs, trafficTB: q == null ? null : d.quotaUnit === 'GB' ? q / 1000 : q };
    delete body.quotaVal;
    delete body.quotaUnit;
    delete body.cyc;
    try {
      body.trafficCycle = cyc.value();
    } catch (err) {
      $('.err', form).textContent = err.message;
      return;
    }
    for (const k of ['probePort', 'monthlyCost']) body[k] = d[k] === '' ? null : Number(d[k]);
    if (s.demo) delete body.probe;
    // 位置：只有改动过才提交，避免把 API 导入的位置变成「手动」
    const lat = d.lat === '' ? null : Number(d.lat);
    const lon = d.lon === '' ? null : Number(d.lon);
    delete body.lat;
    delete body.lon;
    delete body.country;
    const locChanged = !existing || lat !== existing.lat || lon !== existing.lon || chosenCity !== (existing.city || '');
    if (locChanged) {
      body.city = chosenCity;
      body.country = d.country;
      body.lat = lat;
      body.lon = lon;
    }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const saved = existing ? await api('PUT', `/api/servers/${existing.id}`, body) : await api('POST', '/api/servers', body);
      toast(existing ? '已保存' : `已添加 ${saved.name}`, 'ok');
      m.close();
      ctx.onSaved?.(saved, !existing);
    } catch (err) {
      $('.err', form).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

/** 单台服务器的探针 / 告警覆盖项：留空或「跟随全局」即继承设置里的值 */
function probeFieldset(s) {
  if (s.demo) return '';
  const p = s.probe || {};
  const g = store.settings.probe || {};
  const tri = (name, v, globalOn) => `
    <select class="input sm" name="probe.${name}">
      <option value="inherit" ${v == null ? 'selected' : ''}>跟随全局（${globalOn ? '开' : '关'}）</option>
      <option value="on" ${v === true ? 'selected' : ''}>开启</option>
      <option value="off" ${v === false ? 'selected' : ''}>关闭</option>
    </select>`;
  const modeName = Object.fromEntries(TRAFFIC_MODE_OPTS)[g.traffic?.mode] || '';
  return `
    <fieldset>
      <legend>探针与告警（只影响这台）</legend>
      <div class="grid4">
        <label>服务器互测${tri('peers', p.peers, g.peers?.enabled)}</label>
        <label>检测目标${tri('targets', p.targets, g.targets?.enabled)}</label>
        <label>带宽测试${tri('bandwidth', p.bandwidth, g.bandwidth?.enabled)}</label>
        <label>流量统计${tri('traffic', p.traffic, g.traffic?.enabled)}</label>
        <label>上报间隔（秒）<input class="input sm" name="probe.intervalSec" type="number" min="3" max="300" value="${p.intervalSec ?? ''}" placeholder="全局 ${g.intervalSec ?? 10}" /></label>
        <label>流量计费方式
          <select class="input sm" name="probe.trafficMode">
            <option value="">跟随全局（${modeName}）</option>
            ${TRAFFIC_MODE_OPTS.map(([k, t]) => `<option value="${k}" ${p.trafficMode === k ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </label>
        <label class="check" style="align-self:end;margin-bottom:6px"><input type="checkbox" name="alertsMuted" ${s.alertsMuted ? 'checked' : ''} /> 这台不发告警</label>
      </div>
      <p class="hint">流量告警需要填上面的「流量额度」，到期提醒需要填「到期日」。</p>
    </fieldset>`;
}

// ---------------- 流量周期 ----------------
const TZ_NAMES = { 480: '北京 / 香港 / 新加坡', 540: '东京 / 首尔', 0: 'UTC / 伦敦（冬令时）', 60: '法兰克福 / 阿姆斯特丹（冬）', 120: '法兰克福（夏）', '-300': '纽约（冬）', '-240': '纽约（夏）', '-480': '洛杉矶（冬）', '-420': '洛杉矶（夏）', 330: '印度', 600: '悉尼（冬）', 660: '悉尼（夏）', 180: '莫斯科' };
const TZ_LIST = [...new Set([...Array.from({ length: 27 }, (_, i) => (i - 12) * 60), 330, 570])].sort((a, b) => a - b);
const browserTz = () => -new Date().getTimezoneOffset();
const toInput = (ts, tz) => new Date(ts + tz * 60_000).toISOString().slice(0, 16);
function fromInput(v, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - tz * 60_000 : null;
}

/** 单台服务器的流量周期：不同商家的重置时间、周期长度、结算时区都不一样 */
function cycleFieldset(s) {
  const c = s.trafficCycle;
  const tz = c?.tz ?? browserTz();
  const g = store.settings.probe?.traffic || {};
  // 新设置时默认填「当前全局周期的起点」，用户只要改成商家的时间即可
  const at = c?.at ?? cycleAt(monthlyDef(g.resetDay, store.hubTz)).start;
  return `
    <fieldset>
      <legend>流量周期（这台机器的重置规则）</legend>
      <div class="grid4">
        <label>重置方式
          <select class="input sm" name="cyc.type">
            <option value="inherit" ${!c ? 'selected' : ''}>跟随全局（每月 ${g.resetDay ?? 1} 号 0 点）</option>
            <option value="monthly" ${c?.type === 'monthly' ? 'selected' : ''}>每月固定日期和时刻</option>
            <option value="days" ${c?.type === 'days' ? 'selected' : ''}>每隔 N 天</option>
            <option value="none" ${c?.type === 'none' ? 'selected' : ''}>不重置（一直累计）</option>
          </select>
        </label>
        <label data-cyc-show="monthly days none"><span data-cyc-at-label>某一次重置的时间</span><input class="input sm" type="datetime-local" name="cyc.at" value="${toInput(at, tz)}" /></label>
        <label data-cyc-show="days">每几天<input class="input sm" type="number" min="1" max="3650" name="cyc.days" value="${c?.days ?? 30}" /></label>
        <label data-cyc-show="monthly days none">商家结算时区
          <select class="input sm" name="cyc.tz">${TZ_LIST.map((z) => `<option value="${z}" ${z === tz ? 'selected' : ''}>${tzLabel(z)}${TZ_NAMES[z] ? ' ' + TZ_NAMES[z] : ''}</option>`).join('')}</select>
        </label>
      </div>
      <p class="hint" data-cyc-preview></p>
    </fieldset>`;
}

function bindCycle(form) {
  const f = (n) => form.elements[n];
  if (!f('cyc.type')) return { value: () => undefined };
  const def = () => {
    const type = f('cyc.type').value;
    if (type === 'inherit') return null;
    const tz = Number(f('cyc.tz').value);
    return { type, at: fromInput(f('cyc.at').value, tz), days: Math.max(1, Number(f('cyc.days').value) || 30), tz };
  };
  const render = () => {
    const type = f('cyc.type').value;
    form.querySelectorAll('[data-cyc-show]').forEach((el) => el.classList.toggle('hidden', !el.dataset.cycShow.split(' ').includes(type)));
    form.querySelector('[data-cyc-at-label]').textContent = type === 'none' ? '从什么时候开始累计' : '某一次重置的时间（如开通时间）';
    const d = def() || { ...monthlyDef(store.settings.probe?.traffic?.resetDay, store.hubTz), inherit: true };
    const out = form.querySelector('[data-cyc-preview]');
    if (d.at == null) return (out.textContent = '请填写时间');
    const { start, end } = cycleAt(d);
    const rule =
      d.type === 'none' ? '不重置'
        : d.type === 'days' ? `每 ${d.days} 天重置一次`
          : `每月 ${new Date(d.at + d.tz * 60_000).getUTCDate()} 号 ${fmtDT(d.at, { tz: d.tz }).split(' ')[1]} 重置（${tzLabel(d.tz)}），没有这一天的月份在月底重置`;
    out.innerHTML = `${rule}。<br>本周期：<b>${fmtDT(start, { tz: d.tz, year: true })}</b> → <b>${end ? fmtDT(end, { tz: d.tz, year: true }) : '至今'}</b>${end ? `，还剩 ${fmtDuration(end - Date.now())}` : ''}${d.tz !== browserTz() ? `（你的本地时间 ${fmtDT(start)} → ${end ? fmtDT(end) : '至今'}）` : ''}。改了之后，本周期用量会从已有的历史数据重新汇总。`;
  };
  // 换时区时输入框里的「墙上时间」保持不变：用户填的就是商家面板上看到的时间
  form.addEventListener('input', (e) => e.target.name?.startsWith('cyc.') && render());
  form.addEventListener('change', (e) => e.target.name?.startsWith('cyc.') && render());
  render();
  return {
    value: () => {
      const d = def();
      if (d && d.at == null) throw new Error('请填写流量周期的时间');
      return d;
    },
  };
}

function cityLabel(name) {
  const c = CITIES.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  return c ? cityOption(c) : name;
}

// ---------------- 连接 ----------------
export function openLinkForm({ a = '', b = '', link = null } = {}) {
  if (store.servers.length < 2) return toast('至少需要两台服务器', 'warn');
  const opts = (sel) =>
    [...store.servers]
      .sort((x, y) => (x.city || '').localeCompare(y.city || '') || x.name.localeCompare(y.name))
      .map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} — ${esc(cityName(s.city))}</option>`)
      .join('');
  const l = link || {};
  const m = openModal({
    title: link ? '编辑连接' : '添加连接',
    content: `
    <form class="form">
      <label>端点 A<select class="input" name="a" required ${link ? 'disabled' : ''}><option value="">选择服务器…</option>${opts(link?.a || a)}</select></label>
      <label>端点 B<select class="input" name="b" required ${link ? 'disabled' : ''}><option value="">选择服务器…</option>${opts(link?.b || b)}</select></label>
      <div class="grid2">
        <label>备注<input class="input" name="label" value="${esc(l.label || '')}" placeholder="CN2 回国 / 内网 / WireGuard…" /></label>
        <label>标称带宽 Mbps<input class="input" name="bandwidthMbps" type="number" min="0" value="${l.bandwidthMbps ?? ''}" /></label>
      </div>
      <p class="hint">连线颜色取自两端 Agent 的实测延迟；没有实测时显示灰色虚线和按距离估算的延迟。</p>
      <div class="form-actions"><span class="err"></span><button type="button" class="btn" data-close>取消</button><button class="btn primary" type="submit">${link ? '保存' : '添加'}</button></div>
    </form>`,
  });
  const form = $('form', m.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const body = { label: d.label, bandwidthMbps: d.bandwidthMbps === '' ? null : Number(d.bandwidthMbps) };
    try {
      if (link) await api('PUT', `/api/links/${link.id}`, body);
      else {
        if (d.a === d.b) throw new Error('两端不能是同一台');
        await api('POST', '/api/links', { ...body, a: d.a, b: d.b });
      }
      toast(link ? '已保存' : '连接已添加', 'ok');
      m.close();
    } catch (err) {
      $('.err', form).textContent = err.message;
    }
  });
}

