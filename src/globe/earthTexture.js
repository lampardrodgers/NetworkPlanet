// 用 world-atlas（Natural Earth 50m）在 canvas 上绘制等距圆柱投影的地球贴图，完全离线。
// d3-geo 负责处理跨日期变更线的多边形裁剪。
import { geoEquirectangular, geoPath, geoGraticule10 } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import countries from 'world-atlas/countries-50m.json';

export function drawEarthCanvas(width) {
  const W = width;
  const H = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const projection = geoEquirectangular()
    .scale(W / (2 * Math.PI))
    .translate([W / 2, H / 2]);
  const path = geoPath(projection, ctx);
  const k = W / 4096; // 线宽按分辨率缩放

  // 海洋：纵向渐变，两极更暗
  const ocean = ctx.createLinearGradient(0, 0, 0, H);
  ocean.addColorStop(0, '#030a18');
  ocean.addColorStop(0.5, '#071a33');
  ocean.addColorStop(1, '#030a18');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, W, H);

  // 经纬网
  ctx.beginPath();
  path(geoGraticule10());
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
  ctx.lineWidth = 1 * k;
  ctx.stroke();

  // 陆地
  const land = feature(countries, countries.objects.land);
  ctx.beginPath();
  path(land);
  ctx.fillStyle = '#0f2a44';
  ctx.fill();

  // 陆地内部的点阵纹理（科技感），裁剪到陆地范围
  ctx.save();
  ctx.clip();
  const step = Math.max(4, Math.round(6 * k));
  ctx.fillStyle = 'rgba(94, 234, 212, 0.12)';
  const r = Math.max(0.9, 1.1 * k);
  for (let y = step / 2; y < H; y += step) {
    // 高纬度横向拉伸，按纬度调整间距，让点在球面上大致均匀
    const lat = (0.5 - y / H) * Math.PI;
    const sx = step / Math.max(0.15, Math.cos(lat));
    for (let x = (y / step) % 2 ? sx / 2 : 0; x < W; x += sx) ctx.fillRect(x, y, r, r);
  }
  ctx.restore();

  // 国界
  ctx.beginPath();
  path(mesh(countries, countries.objects.countries, (a, b) => a !== b));
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.28)';
  ctx.lineWidth = 0.8 * k;
  ctx.stroke();

  // 海岸线
  ctx.beginPath();
  path(land);
  ctx.strokeStyle = 'rgba(94, 234, 212, 0.55)';
  ctx.lineWidth = 1.2 * k;
  ctx.stroke();

  return canvas;
}

/**
 * 海岸线 / 国界的矢量线（经纬度对数组），在 3D 中绘制，放大到城市级别也清晰。
 * 返回 { coast: [[lon,lat],...][], borders: [...] }
 */
export function vectorLines() {
  const coast = mesh(countries, countries.objects.land).coordinates;
  const borders = mesh(countries, countries.objects.countries, (a, b) => a !== b).coordinates;
  return { coast, borders };
}
