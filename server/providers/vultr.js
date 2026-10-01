import { getJson } from './http.js';

export default {
  id: 'vultr',
  name: 'Vultr',
  docs: 'https://my.vultr.com/settings/#settingsapi',
  fields: [{ key: 'apiKey', label: 'API Key', secret: true }],
  async list({ apiKey }) {
    const out = [];
    let cursor = '';
    do {
      const q = new URLSearchParams({ per_page: '500', ...(cursor ? { cursor } : {}) });
      const j = await getJson(`https://api.vultr.com/v2/instances?${q}`, { token: apiKey });
      for (const i of j.instances || []) {
        out.push({
          providerId: i.id,
          name: i.label || i.hostname || i.main_ip,
          ip: i.main_ip !== '0.0.0.0' ? i.main_ip : '',
          region: i.region,
          os: i.os,
          status: i.power_status === 'running' ? 'running' : i.power_status || i.status,
          specs: { cpu: i.vcpu_count, ramMB: i.ram, diskGB: i.disk, plan: i.plan },
        });
      }
      cursor = j.meta?.links?.next || '';
    } while (cursor);
    return out;
  },
};
