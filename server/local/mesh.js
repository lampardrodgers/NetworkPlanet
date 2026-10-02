import net from 'node:net';

// 仅选择有独立公网地址的已启用 VPS，不把 frp 入口当成内网设备的地址。
export function meshNodes(servers,profiles) {
  return servers.filter(s=>!s.demo&&!profiles[s.id]?.disabled&&net.isIP(s.host||s.ip||'')&&!(profiles[s.id]?.managementVia?.length));
}
export function meshJobs(nodes) {
  if(nodes.length<2)throw new Error('至少需要两台有独立 IP 的 VPS');
  if(nodes.length>40)throw new Error('单轮全部互测最多支持 40 台 VPS');
  return nodes.flatMap(a=>nodes.filter(b=>b.id!==a.id).map(b=>({source:a.id,target:b.id,address:b.host||b.ip,method:'icmp',kind:'latency',segment:'vps-mesh',requirePing:true})));
}
