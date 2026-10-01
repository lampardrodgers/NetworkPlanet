// 演示数据：特意在洛杉矶 / 东京 / 法兰克福放了多台，用来展示「同城多机」的放大展开效果。
import { CITY_BY_KEY } from '../shared/cities.js';
import { db, newId, newToken, normalizeServer, normalizeLink, save } from './store.js';

const DEMO_SERVERS = [
  ['LA-CN2-GIA-01', 'bandwagon', 'los-angeles', ['cn2', 'proxy'], 2, 2048, 40],
  ['LA-CN2-GIA-02', 'bandwagon', 'los-angeles', ['cn2', 'proxy'], 4, 4096, 80],
  ['LA-Vultr-HP', 'vultr', 'los-angeles', ['web'], 1, 1024, 25],
  ['LA-DMIT-Premium', 'dmit', 'los-angeles', ['cn2', 'premium'], 2, 2048, 40],
  ['LA-RackNerd-Backup', 'racknerd', 'los-angeles', ['backup'], 3, 3072, 60],
  ['SJC-Linode', 'linode', 'fremont', ['k8s'], 4, 8192, 160],
  ['SEA-Vultr', 'vultr', 'seattle', ['monitor'], 1, 1024, 25],
  ['NYC-DO', 'digitalocean', 'new-york', ['web'], 2, 4096, 80],
  ['TOR-OVH', 'ovh', 'beauharnois', ['storage'], 4, 16384, 2000],
  ['LON-Linode', 'linode', 'london', ['web'], 2, 4096, 80],
  ['FRA-Hetzner-1', 'hetzner', 'falkenstein', ['db'], 8, 32768, 240],
  ['FRA-Hetzner-2', 'hetzner', 'falkenstein', ['db', 'replica'], 8, 32768, 240],
  ['FRA-Vultr', 'vultr', 'frankfurt', ['proxy'], 1, 1024, 25],
  ['AMS-DO', 'digitalocean', 'amsterdam', ['cdn'], 1, 2048, 50],
  ['HK-AliCloud', 'aliyun', 'hong-kong', ['cn', 'proxy'], 2, 2048, 40],
  ['TYO-Vultr-1', 'vultr', 'tokyo', ['game'], 2, 4096, 80],
  ['TYO-Vultr-2', 'vultr', 'tokyo', ['game'], 2, 4096, 80],
  ['TYO-Linode', 'linode', 'tokyo', ['proxy'], 1, 1024, 25],
  ['OSA-BWH', 'bandwagon', 'osaka', ['softbank'], 2, 2048, 40],
  ['SG-DO', 'digitalocean', 'singapore', ['web'], 2, 4096, 80],
  ['SYD-Vultr', 'vultr', 'sydney', ['web'], 1, 1024, 25],
  ['SAO-Vultr', 'vultr', 'sao-paulo', ['edge'], 1, 1024, 25],
  ['JNB-Vultr', 'vultr', 'johannesburg', ['edge'], 1, 1024, 25],
  ['BOM-DO', 'digitalocean', 'mumbai', ['edge'], 1, 2048, 50],
];

const DEMO_LINKS = [
  ['LA-CN2-GIA-01', 'HK-AliCloud', 'CN2 GIA 回国', 1000],
  ['LA-CN2-GIA-02', 'TYO-Vultr-1', '跨太平洋', 1000],
  ['LA-DMIT-Premium', 'SJC-Linode', '加州内网', 10000],
  ['SJC-Linode', 'SEA-Vultr', '', 1000],
  ['LA-Vultr-HP', 'NYC-DO', '美国东西', 1000],
  ['NYC-DO', 'LON-Linode', '跨大西洋', 1000],
  ['NYC-DO', 'TOR-OVH', '', 1000],
  ['LON-Linode', 'FRA-Hetzner-1', '', 1000],
  ['FRA-Hetzner-1', 'FRA-Hetzner-2', '数据库主从', 10000],
  ['FRA-Vultr', 'AMS-DO', '', 1000],
  ['FRA-Hetzner-1', 'BOM-DO', '', 500],
  ['HK-AliCloud', 'SG-DO', '', 1000],
  ['HK-AliCloud', 'TYO-Linode', '', 1000],
  ['TYO-Vultr-1', 'TYO-Vultr-2', '同机房', 10000],
  ['TYO-Vultr-2', 'OSA-BWH', '', 1000],
  ['SG-DO', 'SYD-Vultr', '', 500],
  ['SG-DO', 'BOM-DO', '', 500],
  ['LA-RackNerd-Backup', 'SAO-Vultr', '备份同步', 200],
  ['LON-Linode', 'JNB-Vultr', '', 200],
];

export function seedDemo() {
  const byName = {};
  let ipSeq = 10;
  for (const [name, provider, cityKey, tags, cpu, ramMB, diskGB] of DEMO_SERVERS) {
    const c = CITY_BY_KEY[cityKey];
    const srv = normalizeServer({
      name, provider, tags, city: c.name, country: c.cc, lat: c.lat, lon: c.lon, demo: true,
      ip: `203.0.113.${ipSeq++}`, // RFC 5737 文档保留地址段，不会真的去探测
      specs: { cpu, ramMB, diskGB, bandwidthMbps: 1000 },
      notes: '演示数据，可在「设置 → 清除演示数据」一键删除',
    });
    srv.id = newId('srv');
    srv.agentToken = newToken();
    srv.locSource = 'city';
    srv.createdAt = Date.now();
    db.servers.push(srv);
    byName[name] = srv.id;
  }
  for (const [a, b, label, bw] of DEMO_LINKS) {
    const l = normalizeLink({ a: byName[a], b: byName[b], label, bandwidthMbps: bw });
    l.id = newId('lnk');
    l.demo = true;
    db.links.push(l);
  }
  save();
  return { servers: DEMO_SERVERS.length, links: DEMO_LINKS.length };
}

export function clearDemo() {
  const ids = new Set(db.servers.filter((s) => s.demo).map((s) => s.id));
  db.servers = db.servers.filter((s) => !s.demo);
  db.links = db.links.filter((l) => !l.demo && !ids.has(l.a) && !ids.has(l.b));
  save();
  return [...ids];
}
