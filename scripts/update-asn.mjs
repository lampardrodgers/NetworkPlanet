// 手动下载公共 ASN 前缀，仅发送 ASN 编号，不提交用户节点 IP。
import fs from 'node:fs';
import path from 'node:path';
import { NETWORKS } from '../server/local/route-analysis.js';
const prefixes=[];
for(const asn of Object.keys(NETWORKS)) {
 const res=await fetch(`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`,{signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw new Error(`AS${asn} 下载失败`);
 const data=await res.json();if(data.status!=='ok'||!Array.isArray(data.data?.prefixes))throw new Error(`AS${asn} 返回格式无效`);
 prefixes.push(...data.data.prefixes.map(p=>({asn:+asn,prefix:p.prefix})));
 console.log(`AS${asn}: ${data.data.prefixes.length} 个前缀`);
}
const dir=process.env.NP_DATA_DIR||path.resolve('data');fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,'asn-prefixes.json');fs.writeFileSync(file+'.tmp',JSON.stringify({updatedAt:Date.now(),source:'RIPEstat announced-prefixes（选定的 8 个 ASN，非全网归属库）',prefixes}),{mode:0o600});fs.renameSync(file+'.tmp',file);
