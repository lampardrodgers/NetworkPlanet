import { haversineKm } from '../../shared/cities.js';

const wrapLongitude = x => ((x + 180) % 360 + 360) % 360 - 180;

// 循环移动世界接缝：先保护连线和边缘标签，再平衡节点占用的左右空间。
export function balancedWorldLongitude(points, edges = [], preferred = 110, landAt = () => false) {
  if (!points.length) return preferred;
  const byId = new Map(points.map(p => [p.id,p]));
  let best = Infinity, center = preferred;
  for (let lon = -180; lon < 180; lon += 5) {
    const offsets = points.map(p => wrapLongitude(p.lon-lon));
    const mean = offsets.reduce((a,b)=>a+b,0)/offsets.length;
    const middle = (Math.min(...offsets)+Math.max(...offsets))/2;
    let cost = mean*mean + middle*middle*0.3;
    for (const x of offsets) cost += Math.max(0,Math.abs(x)-145)**2*4;
    for (const e of edges) {
      const a=byId.get(e.a),b=byId.get(e.b);
      if(a&&b&&Math.abs(wrapLongitude(a.lon-lon)-wrapLongitude(b.lon-lon))>180)cost+=10000;
    }
    const seam=wrapLongitude(lon-180);
    for(let lat=-55;lat<=72;lat+=3)if(landAt(seam,lat))cost+=0.15;
    cost+=Math.abs(wrapLongitude(lon-preferred))*0.0001;
    if(cost<best){best=cost;center=lon;}
  }
  return center;
}

// 使用地图实际展示的纬度范围和未被工具栏遮挡的高度，避免缩小时强制以赤道居中。
export function clampMapLatitude(lat, height, scale, top, bottom) {
  const low = -58 + (height / 2 - bottom) / scale;
  const high = 82 - (height / 2 - top) / scale;
  return low > high ? (low + high) / 2 : Math.max(low, Math.min(high, lat));
}

// 屏幕上靠近不代表在同一地点。各成员都必须位于 25 km 内。
export function sameMapSite(members, server) {
  return members.every(other => (!other.country || !server.country || other.country === server.country)
    && haversineKm(other.lat, other.lon, server.lat, server.lon) < 25);
}
