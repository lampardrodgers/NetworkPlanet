// 标签避让：每隔几帧按优先级贪心放置，和已放置标签重叠的就淡出。
// 所有 CSS2DObject 标签都通过 register() 加入。
export class LabelManager {
  constructor(globe) {
    this.globe = globe;
    this.items = new Set();
    this.frame = 0;
    globe.onFrame(() => {
      if (++this.frame % 3 === 0) this.layout();
    });
  }

  /** item: { obj: CSS2DObject, priority: () => number, wanted: () => boolean } */
  register(item) {
    this.items.add(item);
    return () => this.items.delete(item);
  }

  layout() {
    const placed = [];
    const cands = [];
    for (const it of this.items) {
      const { obj } = it;
      const want = Boolean(it.wanted()); // CSS2DRenderer 只认严格的 false
      obj.visible = want;
      if (!want) continue;
      const el = obj.element;
      // 尺寸缓存：内容变化时由调用方把 el._size 置空
      if (!el._size || !el._size.w) el._size = { w: el.offsetWidth, h: el.offsetHeight };
      const p = this.globe.project(obj.getWorldPosition(obj._tmp || (obj._tmp = obj.position.clone())));
      const x = p.x - obj.center.x * el._size.w;
      const y = p.y - obj.center.y * el._size.h;
      cands.push({ it, el, r: { x, y, w: el._size.w, h: el._size.h }, pr: it.priority() });
    }
    cands.sort((a, b) => b.pr - a.pr);
    for (const c of cands) {
      const pad = 2;
      const hit = c.pr < 1000 && placed.some((r) => c.r.x < r.x + r.w + pad && c.r.x + c.r.w + pad > r.x && c.r.y < r.y + r.h + pad && c.r.y + c.r.h + pad > r.y);
      c.el.classList.toggle('np-hidden', hit);
      if (!hit) placed.push(c.r);
    }
  }
}
