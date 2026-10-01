// 服务器之间的连线：大圆弧 + 流动光点。
//  - 颜色 = 实测延迟（无实测时灰色虚线，并显示按距离估算的延迟）
//  - 光点走完一条弧的时间 ∝ 延迟（越快的链路光点跑得越快），光点数量 ∝ 实测吞吐
//  - 端点跟随 Markers 的实时位置（站点展开时连线也会跟着分开）
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { latencyColor, fmtMs, fmtMbps, LAT_COLORS, esc } from '../format.js';

const SEG = 64; // 每条弧固定段数，方便原地更新缓冲区
const MAX_PULSES = 2000;

function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Links {
  constructor(globe, markers, labels) {
    this.globe = globe;
    this.markers = markers;
    this.labels = labels;
    this.root = new THREE.Group();
    globe.scene.add(this.root);
    this.edges = new Map(); // key -> edge object
    this.focusServer = null;
    this.selectedKey = null;
    this.hoverKey = null;
    this.showLabels = false;

    const pg = new THREE.BufferGeometry();
    this.pulsePos = new Float32Array(MAX_PULSES * 3);
    this.pulseCol = new Float32Array(MAX_PULSES * 3);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pulsePos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pulseCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setDrawRange(0, 0);
    this.pulses = new THREE.Points(
      pg,
      new THREE.PointsMaterial({
        size: 6 * Math.min(window.devicePixelRatio || 1, 2), // sizeAttenuation=false 时单位是设备像素
        sizeAttenuation: false,
        map: makeDotTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.pulses.frustumCulled = false;
    this.pulses.renderOrder = 8;
    this.root.add(this.pulses);

    globe.onFrame((dt) => this.update(dt));
  }

  setEdges(list) {
    const next = new Map();
    for (const e of list) {
      let obj = this.edges.get(e.key);
      if (!obj) obj = this.createEdge(e);
      obj.data = e;
      this.styleEdge(obj);
      next.set(e.key, obj);
    }
    for (const [k, obj] of this.edges) if (!next.has(k)) this.disposeEdge(obj);
    this.edges = next;
  }

  createEdge(e) {
    const geo = new LineGeometry();
    geo.setPositions(new Float32Array((SEG + 1) * 3));
    const mat = new LineMaterial({ color: 0xffffff, linewidth: 2, transparent: true, depthWrite: false, dashed: false, dashSize: 0.01, gapSize: 0.008 });
    const line = new Line2(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 4;
    this.root.add(line);

    const el = document.createElement('div');
    el.className = 'np-label np-link';
    el.dataset.link = e.key;
    const label = new CSS2DObject(el);
    label.center.set(0.5, 1.3);
    this.root.add(label);

    const obj = { data: e, line, label, pts: new Float32Array((SEG + 1) * 3), lastA: new THREE.Vector3(), lastB: new THREE.Vector3(Infinity, 0, 0), visible: false, t: Math.random() };
    obj.unregister = this.labels.register({
      obj: label,
      wanted: () => obj.visible && obj.labelPos && this.globe.isFacing(obj.labelPos, 0) && (this.showLabels || this.isHighlighted(obj)),
      priority: () => (this.selectedKey === obj.data.key ? 2800 : this.hoverKey === obj.data.key ? 2600 : this.isHighlighted(obj) ? 400 : 10),
    });
    return obj;
  }

  disposeEdge(obj) {
    obj.unregister();
    this.root.remove(obj.line, obj.label);
    obj.line.geometry.dispose();
    obj.line.material.dispose();
    obj.label.element.remove();
  }

  /** 根据实测/估算数据设置颜色、虚线、标签内容 */
  styleEdge(obj) {
    const e = obj.data;
    const m = e.measured;
    const down = m && (m.rtt == null || m.loss >= 100);
    const color = down ? LAT_COLORS.bad : m ? latencyColor(m.rtt) : LAT_COLORS.none;
    obj.color = new THREE.Color(color);
    obj.line.material.color.copy(obj.color);
    const dashed = !m || down;
    if (obj.line.material.dashed !== dashed) {
      obj.line.material.dashed = dashed;
      obj.line.material.needsUpdate = true;
    }
    obj.down = down;
    // 光点数量随吞吐增加；旅行时间随延迟增加
    const mbps = m?.mbps ?? e.link?.bandwidthMbps ?? null;
    obj.pulseCount = down ? 0 : mbps ? THREE.MathUtils.clamp(Math.round(1 + Math.log10(mbps + 1) * 0.9), 1, 4) : 1;
    const rtt = m?.rtt ?? e.estimate;
    obj.travel = 0.9 + rtt / 70; // 秒
    const rttText = down ? '中断' : m ? fmtMs(m.rtt) : `≈${fmtMs(e.estimate)}`;
    const extra = [m?.loss ? `丢包 ${m.loss.toFixed(1)}%` : '', mbps ? fmtMbps(mbps) : ''].filter(Boolean).join(' · ');
    const html = `<b style="color:${color}">${rttText}</b>${e.link?.label ? `<span>${esc(e.link.label)}</span>` : ''}${extra ? `<small>${extra}</small>` : ''}`;
    if (obj.label.element._html !== html) {
      obj.label.element.innerHTML = html;
      obj.label.element._html = html;
      obj.label.element._size = null;
    }
  }

  isHighlighted(obj) {
    const e = obj.data;
    return this.selectedKey === e.key || this.hoverKey === e.key || (this.focusServer && (e.a === this.focusServer || e.b === this.focusServer));
  }

  /** 屏幕空间拾取连线 */
  pick(clientX, clientY, radius = 7) {
    const rect = this.globe.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    const v = new THREE.Vector3();
    const p = new THREE.Vector2();
    const q = new THREE.Vector2();
    for (const obj of this.edges.values()) {
      if (!obj.visible) continue;
      let prev = null;
      for (let i = 0; i <= SEG; i += 2) {
        v.fromArray(obj.pts, i * 3);
        if (!this.globe.isFacing(v, -0.01)) {
          prev = null;
          continue;
        }
        this.globe.project(v, p);
        if (prev) {
          const d = distToSeg(x, y, prev.x, prev.y, p.x, p.y);
          if (d < radius && (!best || d < best.d)) best = { type: 'link', id: obj.data.key, d };
        }
        prev = q.copy(p);
      }
    }
    return best;
  }

  update(dt) {
    const camDist = this.globe.camera.position.length();
    const anyFocus = Boolean(this.focusServer || this.selectedKey);
    let n = 0;
    const v = new THREE.Vector3();

    for (const obj of this.edges.values()) {
      const a = this.markers.positionOf(obj.data.a);
      const b = this.markers.positionOf(obj.data.b);
      obj.visible = Boolean(a && b) && a.distanceToSquared(b) > 1e-12;
      obj.line.visible = obj.visible;
      if (!obj.visible) continue;

      if (!obj.lastA.equals(a) || !obj.lastB.equals(b)) {
        obj.lastA.copy(a);
        obj.lastB.copy(b);
        this.rebuildArc(obj, a, b);
      }

      const hl = this.isHighlighted(obj);
      const mat = obj.line.material;
      mat.linewidth = this.selectedKey === obj.data.key ? 4 : hl ? 3 : obj.data.kind === 'mesh' ? 1 : 1.8;
      mat.opacity = anyFocus && !hl ? 0.18 : obj.data.kind === 'mesh' ? 0.4 : 0.85;
      // 虚线尺寸随缩放调整，近看不会变成实线
      if (mat.dashed) {
        mat.dashSize = 0.012 * (camDist - 1);
        mat.gapSize = 0.009 * (camDist - 1);
      }

      // 光点
      if (obj.pulseCount && n < MAX_PULSES - 8) {
        obj.t = (obj.t + dt / obj.travel) % 1;
        const dim = anyFocus && !hl ? 0.25 : 1;
        for (let k = 0; k < obj.pulseCount; k++) {
          let t = (obj.t + k / obj.pulseCount) % 1;
          if (k % 2) t = 1 - t; // 双向流动
          samplePts(obj.pts, t, v);
          this.pulsePos.set([v.x, v.y, v.z], n * 3);
          this.pulseCol.set([obj.color.r * dim, obj.color.g * dim, obj.color.b * dim], n * 3);
          n++;
        }
      }
    }
    const g = this.pulses.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, n);
  }

  rebuildArc(obj, a, b) {
    const ua = a.clone().normalize();
    const ub = b.clone().normalize();
    const ra = a.length();
    const rb = b.length();
    const theta = ua.angleTo(ub);
    const lift = Math.min(0.45, theta * 0.32);
    const sinT = Math.sin(theta) || 1e-6;
    const pts = obj.pts;
    const v = new THREE.Vector3();
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const wa = Math.sin((1 - t) * theta) / sinT;
      const wb = Math.sin(t * theta) / sinT;
      v.set(ua.x * wa + ub.x * wb, ua.y * wa + ub.y * wb, ua.z * wa + ub.z * wb).normalize();
      v.multiplyScalar(ra + (rb - ra) * t + lift * Math.sin(Math.PI * t));
      pts[i * 3] = v.x;
      pts[i * 3 + 1] = v.y;
      pts[i * 3 + 2] = v.z;
    }
    // 原地写入 Line2 的实例缓冲区（避免每帧新建 GPU buffer）
    const geo = obj.line.geometry;
    const buf = geo.attributes.instanceStart.data;
    const arr = buf.array;
    for (let i = 0; i < SEG; i++) {
      arr[i * 6] = pts[i * 3];
      arr[i * 6 + 1] = pts[i * 3 + 1];
      arr[i * 6 + 2] = pts[i * 3 + 2];
      arr[i * 6 + 3] = pts[i * 3 + 3];
      arr[i * 6 + 4] = pts[i * 3 + 4];
      arr[i * 6 + 5] = pts[i * 3 + 5];
    }
    buf.needsUpdate = true;
    // 虚线需要的累积长度
    if (!geo.attributes.instanceDistanceStart) obj.line.computeLineDistances();
    else {
      const d = geo.attributes.instanceDistanceStart.data;
      let acc = 0;
      for (let i = 0; i < SEG; i++) {
        const dx = pts[i * 3 + 3] - pts[i * 3];
        const dy = pts[i * 3 + 4] - pts[i * 3 + 1];
        const dz = pts[i * 3 + 5] - pts[i * 3 + 2];
        d.array[i * 2] = acc;
        acc += Math.hypot(dx, dy, dz);
        d.array[i * 2 + 1] = acc;
      }
      d.needsUpdate = true;
    }
    obj.labelPos = new THREE.Vector3().fromArray(pts, (SEG / 2) * 3);
    obj.label.position.copy(obj.labelPos);
  }
}

function samplePts(pts, t, out) {
  const f = t * SEG;
  const i = Math.min(SEG - 1, Math.floor(f));
  const u = f - i;
  out.set(
    pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * u,
    pts[i * 3 + 1] + (pts[i * 3 + 4] - pts[i * 3 + 1]) * u,
    pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * u,
  );
  return out;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
