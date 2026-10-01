// IP → 坐标。使用 ip-api.com 免费接口（无需 key，限速 45 次/分钟），结果缓存在内存。
// 设置环境变量 NP_GEOIP=off 可完全禁用对外请求。
import net from 'node:net';
import dns from 'node:dns/promises';

const cache = new Map();

export async function geoLookup(ipOrHost) {
  if (process.env.NP_GEOIP === 'off' || !ipOrHost) return null;
  let ip = ipOrHost;
  if (!net.isIP(ip)) {
    try {
      ip = (await dns.lookup(ipOrHost)).address;
    } catch {
      return null;
    }
  }
  if (cache.has(ip)) return cache.get(ip);
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,lat,lon,isp,as`,
      { signal: AbortSignal.timeout(6000) },
    );
    const j = await res.json();
    const out =
      j.status === 'success'
        ? { ip, lat: j.lat, lon: j.lon, city: j.city, country: j.countryCode, region: j.regionName, isp: j.isp, as: j.as }
        : null;
    cache.set(ip, out);
    return out;
  } catch {
    return null;
  }
}
