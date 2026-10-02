import { haversineKm } from '../../shared/cities.js';

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
