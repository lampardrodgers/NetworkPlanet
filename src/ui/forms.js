// 手动增删改：服务器表单、连接表单。
import { store, cityName } from '../state.js';
import { CITIES, haversineKm } from '../../shared/cities.js';
import { api } from '../api.js';
import { openModal, $, toast, formData } from './dom.js';
import { esc } from '../format.js';

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
        <p class="hint">只填 IP 也可以，保存时会自动按 IP 定位；同城多台机器会在地球上聚合，放大后散开。</p>
      </fieldset>
      <fieldset>
        <legend>配置</legend>
        <div class="grid4">
          <label>CPU 核<input class="input" name="specs.cpu" type="number" min="0" value="${v(sp.cpu)}" /></label>
          <label>内存 MB<input class="input" name="specs.ramMB" type="number" min="0" value="${v(sp.ramMB)}" /></label>
          <label>磁盘 GB<input class="input" name="specs.diskGB" type="number" min="0" value="${v(sp.diskGB)}" /></label>
          <label>端口带宽 Mbps<input class="input" name="specs.bandwidthMbps" type="number" min="0" value="${v(sp.bandwidthMbps)}" /></label>
          <label>月流量 TB<input class="input" name="specs.trafficTB" type="number" step="any" min="0" value="${v(sp.trafficTB)}" /></label>
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    delete d.cityPick;
    const body = { ...d, tags: d.tags };
    for (const k of ['probePort', 'monthlyCost']) body[k] = d[k] === '' ? null : Number(d[k]);
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

