// 地球场景：渲染器、相机、轨道控制、贴图、大气层、星空、飞行动画、拾取。
// 坐标约定：地球半径 = 1，球心在原点；相机绕原点转动（地球本身不旋转），因此经纬度 → 世界坐标是固定的。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { drawEarthCanvas, vectorLines } from './earthTexture.js';

const DEG = Math.PI / 180;
export const MIN_ALT = 0.012; // 最近可以贴到地表约 75km 视野
export const MAX_ALT = 5;
export const DEFAULT_ALT = 2.6;

export function latLonToVec3(lat, lon, r = 1, target = new THREE.Vector3()) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return target.set(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

export function vec3ToLatLon(v) {
  const n = v.clone().normalize();
  const lat = 90 - Math.acos(THREE.MathUtils.clamp(n.y, -1, 1)) / DEG;
  let lon = Math.atan2(n.z, -n.x) / DEG - 180;
  if (lon < -180) lon += 360;
  return { lat, lon };
}

export class Globe {
  constructor(container) {
    this.container = container;
    this.frameHooks = [];
    this.timer = new THREE.Timer();
    this.flight = null;

    const w = container.clientWidth;
    const h = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x01040b, 1);
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(w, h);
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.001, 100);
    latLonToVec3(25, 110, 1 + DEFAULT_ALT, this.camera.position);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // 缩放自己实现：按「离地高度」指数缩放，贴近地表时也能细调
    this.controls.minDistance = 1 + MIN_ALT;
    this.controls.maxDistance = 1 + MAX_ALT;
    this.controls.autoRotateSpeed = 0.35;

    this.buildEarth();
    this.buildAtmosphere();
    this.buildStars();

    const light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.set(-1.5, 1, 2);
    this.camera.add(light); // 光源跟随相机，任何角度都是「白天」
    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0x6688aa, 0.9));

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindZoom();

    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------------- 场景构建 ----------------
  buildEarth() {
    const maxTex = this.renderer.capabilities.maxTextureSize;
    // 8192×4096 足够放大到城市级别；手机上降到 4096 节省显存
    const size = maxTex >= 8192 && !matchMedia('(max-width: 800px)').matches ? 8192 : 4096;
    const canvas = drawEarthCanvas(size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.onUpdate = () => {
      // 上传到 GPU 后释放 canvas 内存（约 128MB）
      canvas.width = canvas.height = 1;
      tex.onUpdate = null;
    };

    this.earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 192, 128),
      new THREE.MeshPhongMaterial({ map: tex, shininess: 6, specular: 0x112233, emissive: 0x0a1a2e, emissiveIntensity: 0.6 }),
    );
    this.earth.name = 'earth';
    this.scene.add(this.earth);

    // 矢量海岸线与国界：贴图放大后会糊，这两层线永远清晰
    const { coast, borders } = vectorLines();
    const toSegments = (lines, r) => {
      const arr = [];
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          latLonToVec3(line[i - 1][1], line[i - 1][0], r, a);
          latLonToVec3(line[i][1], line[i][0], r, b);
          arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return g;
    };
    this.coastLines = new THREE.LineSegments(
      toSegments(coast, 1.0004),
      new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.0, depthWrite: false }),
    );
    this.borderLines = new THREE.LineSegments(
      toSegments(borders, 1.0004),
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.0, depthWrite: false }),
    );
    this.scene.add(this.coastLines, this.borderLines);
  }

  buildAtmosphere() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: new THREE.Color(0x38bdf8) } },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float rim = 1.0 - abs(dot(vNormal, vView));
          float a = pow(rim, 3.0) * 0.9;
          gl_FragColor = vec4(glowColor, a);
        }`,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const atm = new THREE.Mesh(new THREE.SphereGeometry(1.1, 96, 64), mat);
    atm.renderOrder = -1;
    this.scene.add(atm);

    // 地表边缘的菲涅尔亮边
    const rimMat = new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: new THREE.Color(0x7dd3fc) } },
      vertexShader: mat.vertexShader,
      fragmentShader: /* glsl */ `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float rim = 1.0 - max(dot(vNormal, vView), 0.0);
          gl_FragColor = vec4(glowColor, pow(rim, 4.0) * 0.55);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.002, 96, 64), rimMat));
  }

  buildStars() {
    const n = 3000;
    const pos = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(30 + Math.random() * 30);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb8d6, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.7 }));
    this.scene.add(stars);
  }

  // ---------------- 缩放 ----------------
  get altitude() {
    return this.camera.position.length() - 1;
  }

  setAltitude(alt) {
    const a = THREE.MathUtils.clamp(alt, MIN_ALT, MAX_ALT);
    this.camera.position.setLength(1 + a);
  }

  zoomBy(factor) {
    this.cancelFlight();
    this.flyTo({ alt: this.altitude * factor, duration: 400 });
  }

  bindZoom() {
    const el = this.renderer.domElement;
    // 滚轮挂在容器上：鼠标停在标签上时也能缩放
    this.container.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.cancelFlight();
        this.onUserInteract?.();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.setAltitude(this.altitude * Math.exp(dy * 0.0016));
      },
      { passive: false },
    );
    // 双指捏合
    const touches = new Map();
    let pinchStart = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinchStart = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), alt: this.altitude };
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2 && pinchStart) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.setAltitude(pinchStart.alt * (pinchStart.d / Math.max(d, 1)));
      }
    });
    const end = (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinchStart = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---------------- 飞行动画 ----------------
  /** 飞到某个经纬度 / 高度。lat/lon 省略则只改高度。 */
  flyTo({ lat, lon, alt, duration = 1400 } = {}) {
    const fromDir = this.camera.position.clone().normalize();
    const toDir = lat != null ? latLonToVec3(lat, lon, 1) : fromDir.clone();
    const fromAlt = this.altitude;
    const toAlt = THREE.MathUtils.clamp(alt ?? fromAlt, MIN_ALT, MAX_ALT);
    const angle = fromDir.angleTo(toDir);
    // 远距离飞行时中途抬高，像飞机一样「拉升再下降」
    const peak = Math.max(fromAlt, toAlt, Math.min(2.2, angle * 1.2));
    const q = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
    this.flight = { fromDir, q, fromAlt, toAlt, peak, t0: performance.now(), duration: angle > 0.6 ? duration * 1.25 : duration };
    this.controls.enabled = false;
  }

  cancelFlight() {
    if (this.flight) {
      this.flight = null;
      this.controls.enabled = true;
    }
  }

  stepFlight() {
    const f = this.flight;
    if (!f) return;
    const t = Math.min(1, (performance.now() - f.t0) / f.duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const qt = new THREE.Quaternion().slerp(f.q, e);
    const dir = f.fromDir.clone().applyQuaternion(qt);
    // 高度在对数空间插值，并叠加一个抛物线拉升
    const la = Math.log(f.fromAlt) + (Math.log(f.toAlt) - Math.log(f.fromAlt)) * e;
    const lift = Math.sin(Math.PI * e) * Math.max(0, Math.log(f.peak) - Math.max(Math.log(f.fromAlt), Math.log(f.toAlt)));
    this.camera.position.copy(dir.multiplyScalar(1 + Math.exp(la + lift)));
    this.camera.lookAt(0, 0, 0);
    if (t >= 1) {
      this.flight = null;
      this.controls.enabled = true;
    }
  }

  // ---------------- 拾取 ----------------
  setPointer(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster;
  }

  pickEarth(clientX, clientY) {
    const hit = this.setPointer(clientX, clientY).intersectObject(this.earth, false)[0];
    return hit ? vec3ToLatLon(hit.point) : null;
  }

  /** 某点处 1 像素对应的世界长度，用于让标记保持固定屏幕尺寸 */
  worldPerPixel(point) {
    const d = this.camera.position.distanceTo(point);
    return (2 * d * Math.tan((this.camera.fov * DEG) / 2)) / this.renderer.domElement.clientHeight;
  }

  /** 点是否在相机可见的半球（未被地球挡住） */
  isFacing(point, margin = 0.0) {
    return point.dot(this.camera.position) > 1 + margin;
  }

  project(point, out = new THREE.Vector2()) {
    const v = point.clone().project(this.camera);
    const el = this.renderer.domElement;
    return out.set(((v.x + 1) / 2) * el.clientWidth, ((1 - v.y) / 2) * el.clientHeight);
  }

  // ---------------- 主循环 ----------------
  onFrame(fn) {
    this.frameHooks.push(fn);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.emitResize?.(w, h);
  }

  tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.flight) this.stepFlight();
    else {
      const alt = this.altitude;
      // 越靠近地表，拖拽越慢；自转速度也随高度变化
      this.controls.rotateSpeed = THREE.MathUtils.clamp(alt * 0.55, 0.012, 0.9);
      this.controls.autoRotateSpeed = 0.35 * THREE.MathUtils.clamp(alt / DEFAULT_ALT, 0.05, 1.2);
      this.controls.update();
    }
    // 远看用贴图（更柔和），拉近后逐渐显示矢量线
    const near = THREE.MathUtils.clamp((0.9 - this.altitude) / 0.7, 0, 1);
    this.coastLines.material.opacity = 0.75 * near;
    this.borderLines.material.opacity = 0.35 * near;
    this.coastLines.visible = this.borderLines.visible = near > 0;
    for (const fn of this.frameHooks) fn(dt);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
}
