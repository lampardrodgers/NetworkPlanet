// 节点标签移位避让且不丢弃；连线标签仍可在拥挤时隐藏。
// 所有 CSS2DObject 标签都通过 register() 加入。
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w+3,b.x+b.w+3)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h+3,b.y+b.h+3)-Math.max(a.y,b.y));
export function placeNodeLabel(rect,placed,width,height) {
  let best=null,score=Infinity;
  for(let ring=0;ring<=12;ring++)for(const dx of [0,-rect.w-16,rect.w+16])for(const sign of (ring?[1,-1]:[1])){
    const r={...rect,x:Math.max(8,Math.min(width-rect.w-8,rect.x+dx)),y:Math.max(8,Math.min(height-rect.h-8,rect.y+sign*ring*(rect.h+8)))};
    const penalty=placed.reduce((sum,p)=>sum+overlap(r,p),0)*10000+Math.hypot(r.x-rect.x,r.y-rect.y);
    if(penalty<score){score=penalty;best=r;}
  }
  return best; // 空间不足也保留名称，选最少重叠的位置。
}
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
    const placed = [...document.querySelectorAll('#topbar,#sidebar:not(.collapsed),#detail:not(.hidden),#routepanel:not(.hidden),#viewbar')].map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height).map(r=>({x:r.left,y:r.top,w:r.width,h:r.height}));
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
      cands.push({ it, el, p, r: { x, y, w: el._size.w, h: el._size.h }, pr: it.priority() });
    }
    cands.sort((a, b) => Number(!!b.it.required)-Number(!!a.it.required) || b.pr - a.pr);
    for (const c of cands) {
      if(c.it.required){
        const r=placeNodeLabel(c.r,placed,window.innerWidth,window.innerHeight);
        const dx=r.x-c.r.x,dy=r.y-c.r.y;
        c.el.style.translate=`${dx}px ${dy}px`;
        c.el.classList.remove('np-hidden');
        const x=c.p.x-r.x,y=c.p.y-r.y;
        const ex=Math.max(0,Math.min(r.w,x)),ey=Math.max(0,Math.min(r.h,y));
        const length=Math.hypot(ex-x,ey-y);
        c.el.classList.toggle('np-displaced',Math.hypot(dx,dy)>2&&length>2);
        c.el.style.setProperty('--leader-x',`${x}px`);c.el.style.setProperty('--leader-y',`${y}px`);
        c.el.style.setProperty('--leader-length',`${length}px`);c.el.style.setProperty('--leader-angle',`${Math.atan2(ey-y,ex-x)}rad`);
        placed.push(r);continue;
      }
      const pad = 2;
      const hit = c.pr < 1000 && placed.some((r) => c.r.x < r.x + r.w + pad && c.r.x + c.r.w + pad > r.x && c.r.y < r.y + r.h + pad && c.r.y + c.r.h + pad > r.y);
      c.el.classList.toggle('np-hidden', hit);
      if (!hit) placed.push(c.r);
    }
  }
}
