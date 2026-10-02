import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
export const NETWORKS={4134:'电信 163',4809:'电信 CN2',58453:'移动 CMI',58807:'移动 CMIN2',9929:'联通 9929',10099:'联通国际',4837:'联通骨干',9808:'移动骨干'};
export const CLASSIFIER_VERSION=2;
// 路由器接口地址未必在该网络的 BGP 公告前缀中。登记信息与 ASN 匹配分开记录，不伪造 ASN。
const infrastructure=new net.BlockList();infrastructure.addSubnet('59.43.0.0',16,'ipv4');
const cn2Source='https://rdap.apnic.net/ip/59.43.0.0/16'; // APNIC: CN2-BB，核对于 2026-10-02
const dataDir=()=>process.env.NP_DATA_DIR||path.resolve('data');
let cached=null, stamp=0;
export function asnDatabase() {
  try {const file=path.join(dataDir(),'asn-prefixes.json');const t=fs.statSync(file).mtimeMs;if(!cached||t!==stamp){cached=JSON.parse(fs.readFileSync(file,'utf8'));stamp=t;}return cached;}catch{return {prefixes:[],updatedAt:null,source:'本地 ASN 数据库尚未导入'};}
}
const indexes=new WeakMap();
export function classifyTrace(text, address, database=asnDatabase()) {
  const blocks=indexes.get(database)||new Map();
  if(!indexes.has(database)) {
  for(const row of database.prefixes||[]) {
    try {const [ip,bits]=row.prefix.split('/'); const b=blocks.get(row.asn)||new net.BlockList();b.addSubnet(ip,+bits,net.isIP(ip)===6?'ipv6':'ipv4');blocks.set(row.asn,b);} catch {}
  }
    indexes.set(database,blocks);
  }
  const hops=[];
  for(const line of text.split('\n')) {
    const m=line.match(/^\s*(\d+)\s+(.*)$/);if(!m)continue;
    const ips=[...new Set(m[2].split(/\s+/).map(x=>x.replace(/[()]/g,'')).filter(x=>net.isIP(x)))];
    const matches=ips.flatMap(ip=>{
      const found=[...blocks].filter(([,b])=>b.check(ip,net.isIP(ip)===6?'ipv6':'ipv4')).map(([asn])=>({ip,asn,label:NETWORKS[asn]||`AS${asn}`,evidence:'bgp-prefix',source:database.source}));
      if(net.isIP(ip)===4&&infrastructure.check(ip,'ipv4')&&!found.some(n=>n.label===NETWORKS[4809]))found.push({ip,asn:null,label:NETWORKS[4809],evidence:'registered-infrastructure',source:cn2Source});
      return found;
    });
    hops.push({hop:+m[1],ips,networks:matches,raw:line.trim().slice(0,500)});
  }
  if(!hops.length)throw new Error('没有可解析的路由结果，工具可能缺失或权限不足');
  const networks=[...new Set(hops.flatMap(h=>h.networks.map(n=>n.label)))];
  return {state:'ok',hops,networks,classifierVersion:CLASSIFIER_VERSION,complete:hops.some(h=>h.ips.includes(address)),databaseAt:database.updatedAt,databaseSource:database.source,
    note:networks.length?'仅代表本方向可见跳点；不认证 GIA 产品等级，不代表完整路径或所有业务流量。'+(hops.some(h=>h.networks.some(n=>n.evidence==='registered-infrastructure'))?' CN2 依据：APNIC 登记的 59.43.0.0/16（CN2-BB）。':''):'证据不足：节点未回应、未收录或尚无本地数据库',raw:text.slice(0,20000)};
}
