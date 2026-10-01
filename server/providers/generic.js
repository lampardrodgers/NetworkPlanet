import { getJson } from './http.js';

// 通用 JSON：任何能返回服务器数组的 URL（自建 CMDB、面板导出、GitHub raw 文件……）。
// 数组元素字段：name, ip, city 或 lat/lon, provider, region, tags, specs{cpu,ramMB,diskGB}
export default {
  id: 'generic',
  name: '通用 JSON URL',
  docs: 'URL 返回 [{ "name": "...", "ip": "...", "city": "Los Angeles" }]，或 { "servers": [...] }',
  fields: [
    { key: 'url', label: 'JSON URL' },
    { key: 'apiKey', label: 'Bearer Token（可选）', secret: true, optional: true },
  ],
  async list({ url, apiKey }) {
    if (!url) throw new Error('缺少 URL');
    const j = await getJson(url, { token: apiKey || undefined });
    const arr = Array.isArray(j) ? j : j.servers || j.data || [];
    return arr.map((s, i) => ({
      providerId: String(s.id ?? s.providerId ?? s.ip ?? i),
      name: s.name || s.label || s.hostname || s.ip,
      ip: s.ip || s.main_ip || '',
      provider: s.provider,
      region: s.region || s.city,
      city: s.city,
      country: s.country,
      lat: s.lat ?? s.latitude,
      lon: s.lon ?? s.lng ?? s.longitude,
      tags: s.tags,
      status: s.status || 'unknown',
      specs: s.specs || {},
    }));
  },
};
