import { getJson } from './http.js';

export default {
  id: 'digitalocean',
  name: 'DigitalOcean',
  docs: 'https://cloud.digitalocean.com/account/api/tokens',
  fields: [{ key: 'apiKey', label: 'Personal Access Token', secret: true }],
  async list({ apiKey }) {
    const out = [];
    let url = 'https://api.digitalocean.com/v2/droplets?per_page=200';
    while (url) {
      const j = await getJson(url, { token: apiKey });
      for (const d of j.droplets || []) {
        const v4 = (d.networks?.v4 || []).find((n) => n.type === 'public');
        out.push({
          providerId: String(d.id),
          name: d.name,
          ip: v4?.ip_address || '',
          region: d.region?.slug,
          os: d.image ? `${d.image.distribution || ''} ${d.image.name || ''}`.trim() : '',
          status: d.status === 'active' ? 'running' : d.status,
          specs: { cpu: d.vcpus, ramMB: d.memory, diskGB: d.disk, plan: d.size_slug },
        });
      }
      url = j.links?.pages?.next || '';
    }
    return out;
  },
};
