import { getJson } from './http.js';

// 搬瓦工 / KiwiVM：每台 VPS 一组 VEID + API Key。可在一个账号里填多组，每行 "VEID:APIKEY"。
export default {
  id: 'bandwagon',
  name: '搬瓦工 BandwagonHost (KiwiVM)',
  docs: 'KiwiVM 面板 → API → 生成 API Key',
  fields: [{ key: 'pairs', label: '每行一个 VEID:API_KEY', secret: true, multiline: true }],
  async list({ pairs }) {
    const lines = String(pairs || '')
      .split(/\n|,/)
      .map((l) => l.trim())
      .filter(Boolean);
    const out = [];
    for (const line of lines) {
      const [veid, key] = line.split(':').map((s) => s.trim());
      if (!veid || !key) throw new Error(`格式错误：「${line}」应为 VEID:API_KEY`);
      const q = new URLSearchParams({ veid, api_key: key });
      const j = await getJson(`https://api.64clouds.com/v1/getServiceInfo?${q}`);
      if (j.error && j.error !== 0) throw new Error(`VEID ${veid}: ${j.message || j.error}`);
      out.push({
        providerId: veid,
        name: j.hostname || `BWH-${veid}`,
        ip: j.ip_addresses?.[0] || '',
        region: j.node_location_id || j.node_location,
        regionText: j.node_location,
        os: j.os,
        status: j.suspended ? 'suspended' : 'running',
        specs: {
          ramMB: j.plan_ram ? Math.round(j.plan_ram / 1048576) : null,
          diskGB: j.plan_disk ? Math.round(j.plan_disk / 1073741824) : null,
          trafficTB: j.plan_monthly_data ? +(j.plan_monthly_data * (j.monthly_data_multiplier || 1) / 1e12).toFixed(2) : null,
          plan: j.plan,
        },
      });
    }
    return out;
  },
};
