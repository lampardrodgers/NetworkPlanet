// 服务器标记。
//  - 把距离 < SITE_RADIUS_KM 的服务器归为一个「站点」（例如洛杉矶的 5 台）
//  - 远看：站点显示为一个带数量徽标的聚合点
//  - 拉近到 AUTO_EXPAND_ALT 以下 / 点击聚合点 / 选中其中一台：成员以「蜘蛛腿」的形式在屏幕上展开，
//    展开半径以像素为单位，所以任何缩放级别下都清晰可点
//  - 所有标记都按像素定尺寸（随相机距离自动缩放）
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { latLonToVec3 } from './Globe.js';
import { haversineKm } from '../../shared/cities.js';
import { cityName } from '../state.js';
import { STATUS_COLORS, statusKey, fmtMs, latencyColor, esc } from '../format.js';

const SITE_RADIUS_KM = 25;
const SURFACE = 1.0012;
export const AUTO_EXPAND_ALT = 0.32;

const circleGeo = new THREE.CircleGeometry(1, 32);
const ringGeo = new THREE.RingGeometry(0.78, 1, 48);

function siteLayout(n, i) {
  // 返回第 i 个成员相对站点中心的像素偏移
  if (n <= 8) {
    const R = Math.max(30, 12 + n * 6);
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [Math.cos(a) * R, Math.sin(a) * R];
  }
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = 22 * Math.sqrt(i + 1);
  return [Math.cos(i * golden) * r, Math.sin(i * golden) * r];
}

export class Markers {
  constructor(globe, labels) {
    this.globe = globe;
    this.labels = labels;
    this.root = new THREE.Group();
    globe.scene.add(this.root);
    this.sites = new Map(); // siteId -> site
    this.members = new Map(); // serverId -> member
    this.selection = null;
    this.hover = null;
    this.forcedSite = null; // 被点击展开的站点
    this.showLabels = true;
    this.time = 0;

    // 腿线（站点中心 → 成员）
    this.legs = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.legs.frustumCulled = false;
    this.root.add(this.legs);

    // 选中高亮环
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.selRing.visible = false;
    this.root.add(this.selRing);

    globe.onFrame((dt) => this.update(dt));
  }

  // ---------------- 数据 ----------------
  setData(servers, statusMap) {
    this.statusMap = statusMap || {};
    const placed = servers.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    // 站点聚类（贪心）
    const groups = [];
    for (const s of [...placed].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id))) {
      const g = groups.find((g) => haversineKm(g.lat, g.lon, s.lat, s.lon) < SITE_RADIUS_KM);
      if (g) g.servers.push(s);
      else groups.push({ lat: s.lat, lon: s.lon, servers: [s] });
    }
    const nextSites = new Map();
    for (const g of groups) {
      const id = `site:${g.lat.toFixed(2)},${g.lon.toFixed(2)}`;
      let site = this.sites.get(id);
      if (!site) site = this.createSite(id, g);
      site.servers = g.servers;
      site.name = cityName(mostCommon(g.servers.map((s) => s.city).filter(Boolean))) || `${g.lat.toFixed(1)}, ${g.lon.toFixed(1)}`;
      nextSites.set(id, site);
    }
    for (const [id, site] of this.sites) if (!nextSites.has(id)) this.disposeSite(site);
    this.sites = nextSites;

    // 成员
    const nextMembers = new Map();
    for (const site of this.sites.values()) {
      site.servers.forEach((srv, i) => {
        let m = this.members.get(srv.id);
        if (m && m.site !== site) {
          this.disposeMember(m);
          m = null;
        }
        if (!m) m = this.createMember(srv, site);
        m.server = srv;
        m.index = i;
        m.offset = siteLayout(site.servers.length, i);
        nextMembers.set(srv.id, m);
      });
    }
    for (const [id, m] of this.members) if (!nextMembers.has(id)) this.disposeMember(m);
    this.members = nextMembers;
    this.refreshStatus(statusMap);
  }

  refreshStatus(statusMap) {
    this.statusMap = statusMap || {};
    for (const m of this.members.values()) {
      const st = this.statusMap[m.server.id];
      const key = statusKey(st);
      m.status = key;
      m.dot.material.color.set(STATUS_COLORS[key]);
      m.pulse.material.color.set(STATUS_COLORS[key]);
      const rtt = st?.hubRtt;
      const html = `<i class="dot ${key}"></i><b>${esc(m.server.name)}</b>${rtt != null ? `<em style="color:${latencyColor(rtt)}">${fmtMs(rtt)}</em>` : key === 'offline' ? '<em class="off">离线</em>' : ''}`;
      if (m.label.element._html !== html) {
        m.label.element.innerHTML = html;
        m.label.element._html = html;
        m.label.element._size = null;
      }
    }
    for (const site of this.sites.values()) {
      const counts = { online: 0, offline: 0, unknown: 0 };
      for (const s of site.servers) counts[statusKey(this.statusMap[s.id])]++;
      const n = site.servers.length;
      const color = counts.offline === n ? STATUS_COLORS.offline : counts.offline ? '#fbbf24' : counts.online ? STATUS_COLORS.online : STATUS_COLORS.unknown;
      site.dot.material.color.set(color);
      site.pulse.material.color.set(color);
      const html = `<b>${esc(site.name)}</b><span class="count">${n}</span>${counts.offline ? `<span class="bad">${counts.offline}↓</span>` : ''}`;
      if (site.label.element._html !== html) {
        site.label.element.innerHTML = html;
        site.label.element._html = html;
        site.label.element._size = null;
      }
    }
  }

  createSite(id, g) {
    const normal = latLonToVec3(g.lat, g.lon, 1);
    const dot = new THREE.Mesh(circleGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    const pulse = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const center = normal.clone().multiplyScalar(SURFACE);
    for (const m of [dot, pulse]) {
      m.position.copy(center);
      m.lookAt(center.clone().multiplyScalar(2));
      m.renderOrder = 5;
      this.root.add(m);
    }
    const el = document.createElement('div');
    el.className = 'np-label np-site';
    el.dataset.site = id;
    const label = new CSS2DObject(el);
    label.center.set(-0.15, 0.5);
    label.position.copy(center);
    this.root.add(label);

    // 东/北切向量，用来在地表上摆放展开的成员
    const up = Math.abs(normal.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const east = new THREE.Vector3().crossVectors(up, normal).normalize();
    const north = new THREE.Vector3().crossVectors(normal, east).normalize();

    const site = { id, lat: g.lat, lon: g.lon, normal, center, east, north, dot, pulse, label, expand: 0, servers: [] };
    site.unregister = this.labels.register({
      obj: label,
      wanted: () => site.servers.length > 1 && site.expand < 0.5 && this.globe.isFacing(center, 0.002),
      priority: () => (this.selection?.id === site.id ? 2000 : 100 + site.servers.length),
    });
    return site;
  }

  createMember(srv, site) {
    const dot = new THREE.Mesh(circleGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    const pulse = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    dot.renderOrder = 6;
    pulse.renderOrder = 5;
    this.root.add(dot, pulse);
    const el = document.createElement('div');
    el.className = 'np-label np-srv';
    el.dataset.server = srv.id;
    const label = new CSS2DObject(el);
    label.center.set(-0.12, 0.5);
    this.root.add(label);
    const m = { server: srv, site, dot, pulse, label, pos: site.center.clone(), phase: Math.random() * Math.PI * 2, offset: [0, 0] };
    m.unregister = this.labels.register({
      obj: label,
      wanted: () => {
        const single = m.site.servers.length === 1;
        const shown = single || m.site.expand > 0.5;
        const important = this.selection?.id === srv.id || this.hover?.id === srv.id;
        return shown && (this.showLabels || important) && this.globe.isFacing(m.pos, 0.002);
      },
      priority: () => (this.selection?.id === srv.id ? 3000 : this.hover?.id === srv.id ? 2500 : m.site.expand > 0.5 ? 300 : 50),
    });
    return m;
  }

  disposeSite(site) {
    site.unregister();
    this.root.remove(site.dot, site.pulse, site.label);
    site.dot.material.dispose();
    site.pulse.material.dispose();
    site.label.element.remove();
  }

  disposeMember(m) {
    m.unregister();
    this.root.remove(m.dot, m.pulse, m.label);
    m.dot.material.dispose();
    m.pulse.material.dispose();
    m.label.element.remove();
  }

  // ---------------- 交互 ----------------
  setSelection(sel) {
    this.selection = sel;
    if (sel?.type === 'site') this.forcedSite = sel.id;
    else if (sel?.type === 'server') this.forcedSite = this.members.get(sel.id)?.site.id || null;
    else this.forcedSite = null;
  }

  siteOfServer(id) {
    return this.members.get(id)?.site || null;
  }

  /** 当前显示位置（展开动画中的实时位置），供连线使用 */
  positionOf(serverId) {
    return this.members.get(serverId)?.pos || null;
  }

  /** 屏幕空间拾取：返回最近的服务器或聚合点 */
  pick(clientX, clientY, radius = 14) {
    const rect = this.globe.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    const consider = (pos, hit, r) => {
      if (!this.globe.isFacing(pos, 0.0005)) return;
      const p = this.globe.project(pos);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < r && (!best || d < best.d)) best = { ...hit, d };
    };
    for (const m of this.members.values()) {
      const visible = m.site.servers.length === 1 || m.site.expand > 0.5;
      if (visible) consider(m.pos, { type: 'server', id: m.server.id }, radius);
    }
    for (const s of this.sites.values()) {
      if (s.servers.length > 1 && s.expand < 0.5) consider(s.center, { type: 'site', id: s.id }, radius + 6);
    }
    return best;
  }

  // ---------------- 每帧 ----------------
  update(dt) {
    this.time += dt;
    const alt = this.globe.altitude;
    const auto = alt < AUTO_EXPAND_ALT;
    const legPts = [];
    const tmp = new THREE.Vector3();

    for (const site of this.sites.values()) {
      const n = site.servers.length;
      const want = n > 1 && (auto || this.forcedSite === site.id) ? 1 : 0;
      site.expand += (want - site.expand) * Math.min(1, dt * 7);
      if (Math.abs(want - site.expand) < 0.001) site.expand = want;

      const wpp = this.globe.worldPerPixel(site.center);
      const facing = this.globe.isFacing(site.center, -0.02);
      // 聚合点：数量越多越大；展开后缩成一个小锚点
      const clusterPx = n > 1 ? 7 + Math.sqrt(n) * 2.2 : 0;
      const px = THREE.MathUtils.lerp(clusterPx, n > 1 ? 2.5 : 0, site.expand);
      site.dot.visible = facing && px > 0;
      site.dot.scale.setScalar(Math.max(px, 0.001) * wpp);
      const t = (this.time * 0.6 + site.lat * 0.01) % 1;
      site.pulse.visible = facing && n > 1 && site.expand < 0.5;
      site.pulse.scale.setScalar((clusterPx + 4 + t * 16) * wpp);
      site.pulse.material.opacity = (1 - t) * 0.5 * (1 - site.expand);

      for (const id of site.servers.map((s) => s.id)) {
        const m = this.members.get(id);
        if (!m) continue;
        const [ox, oy] = m.offset;
        const e = n > 1 ? easeOut(site.expand) : 0;
        tmp.copy(site.center)
          .addScaledVector(site.east, ox * wpp * e)
          .addScaledVector(site.north, -oy * wpp * e)
          .setLength(SURFACE + 0.0002);
        m.pos.copy(tmp);
        const showDot = facing && (n === 1 || site.expand > 0.02);
        m.dot.visible = showDot;
        m.dot.position.copy(m.pos);
        m.dot.lookAt(tmp.multiplyScalar(2));
        const sel = this.selection?.id === m.server.id;
        const hov = this.hover?.id === m.server.id;
        const r = (sel ? 6.5 : hov ? 6 : 4.5) * wpp * (n === 1 ? 1 : Math.max(0.35, site.expand));
        m.dot.scale.setScalar(r);
        // 离线：闪烁；在线：扩散脉冲环
        if (m.status === 'offline') m.dot.material.opacity = 0.45 + 0.55 * Math.abs(Math.sin(this.time * 3 + m.phase));
        else m.dot.material.opacity = 1;
        const pt = (this.time * 0.5 + m.phase / 6.283) % 1;
        m.pulse.visible = showDot && m.status === 'online';
        m.pulse.position.copy(m.dot.position);
        m.pulse.quaternion.copy(m.dot.quaternion);
        m.pulse.scale.setScalar((5 + pt * 10) * wpp);
        m.pulse.material.opacity = (1 - pt) * 0.55 * (n === 1 ? 1 : site.expand);
        m.label.position.copy(m.pos);
        m.label.center.x = ox < -1 && site.expand > 0.5 ? 1.12 : -0.12; // 左半边的成员，标签放左侧

        if (n > 1 && site.expand > 0.02 && facing) legPts.push(site.center.x, site.center.y, site.center.z, m.pos.x, m.pos.y, m.pos.z);
      }
    }

    // 腿线：复用预分配的缓冲区（每帧新建 attribute 会泄漏 GPU buffer）
    let attr = this.legs.geometry.getAttribute('position');
    if (!attr || attr.array.length < legPts.length) {
      this.legs.geometry.dispose();
      attr = new THREE.BufferAttribute(new Float32Array(Math.max(legPts.length * 2, 192)), 3).setUsage(THREE.DynamicDrawUsage);
      this.legs.geometry.setAttribute('position', attr);
    }
    attr.array.set(legPts);
    attr.needsUpdate = true;
    this.legs.geometry.setDrawRange(0, legPts.length / 3);

    // 选中环
    const selM = this.selection?.type === 'server' ? this.members.get(this.selection.id) : null;
    const selS = this.selection?.type === 'site' ? this.sites.get(this.selection.id) : null;
    const target = selM ? selM.pos : selS ? selS.center : null;
    this.selRing.visible = Boolean(target) && this.globe.isFacing(target, -0.02);
    if (target) {
      const wpp = this.globe.worldPerPixel(target);
      const base = selM ? 10 : 9 + Math.sqrt(selS.servers.length) * 2.2;
      this.selRing.position.copy(target);
      this.selRing.lookAt(target.clone().multiplyScalar(2));
      this.selRing.scale.setScalar((base + Math.sin(this.time * 4) * 1.2) * wpp);
    }
  }
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function mostCommon(arr) {
  const c = {};
  let best = null;
  for (const x of arr) if ((c[x] = (c[x] || 0) + 1) > (c[best] || 0)) best = x;
  return best;
}
