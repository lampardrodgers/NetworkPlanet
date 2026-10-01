import { getJson } from './http.js';

export default {
  id: 'hetzner',
  name: 'Hetzner Cloud',
  docs: 'https://console.hetzner.cloud → 项目 → Security → API Tokens',
  fields: [{ key: 'apiKey', label: 'API Token（每个项目一个）', secret: true }],
  async list({ apiKey }) {
    const out = [];
    let page = 1;
    while (page) {
      const j = await getJson(`https://api.hetzner.cloud/v1/servers?page=${page}&per_page=50`, { token: apiKey });
      for (const s of j.servers || []) {
        const loc = s.datacenter?.location || {};
        out.push({
          providerId: String(s.id),
          name: s.name,
          ip: s.public_net?.ipv4?.ip || '',
          region: loc.name,
          city: loc.city,
          country: loc.country,
          lat: loc.latitude,
          lon: loc.longitude,
          os: s.image?.description || '',
          status: s.status,
          specs: {
            cpu: s.server_type?.cores,
            ramMB: s.server_type?.memory ? s.server_type.memory * 1024 : null,
            diskGB: s.server_type?.disk,
            plan: s.server_type?.name,
          },
        });
      }
      page = j.meta?.pagination?.next_page || 0;
    }
    return out;
  },
};
