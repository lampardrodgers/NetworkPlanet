import { getJson } from './http.js';

export default {
  id: 'linode',
  name: 'Linode / Akamai',
  docs: 'https://cloud.linode.com/profile/tokens',
  fields: [{ key: 'apiKey', label: 'Personal Access Token（Linodes 只读即可）', secret: true }],
  async list({ apiKey }) {
    const out = [];
    let page = 1;
    let pages = 1;
    do {
      const j = await getJson(`https://api.linode.com/v4/linode/instances?page=${page}&page_size=500`, { token: apiKey });
      pages = j.pages || 1;
      for (const l of j.data || []) {
        out.push({
          providerId: String(l.id),
          name: l.label,
          ip: (l.ipv4 || []).find((ip) => !/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ip)) || l.ipv4?.[0] || '',
          region: l.region,
          os: l.image || '',
          status: l.status,
          specs: {
            cpu: l.specs?.vcpus,
            ramMB: l.specs?.memory,
            diskGB: l.specs?.disk ? Math.round(l.specs.disk / 1024) : null,
            trafficTB: l.specs?.transfer ? l.specs.transfer / 1000 : null,
            plan: l.type,
          },
        });
      }
      page++;
    } while (page <= pages);
    return out;
  },
};
