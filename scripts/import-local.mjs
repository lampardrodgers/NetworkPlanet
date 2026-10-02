// 从本地受限 JSON 文件导入。不会执行测量，不改变调度范围。
// 文件格式见 docs/node-onboarding/AGENTS.md。凭据不打印到终端。
import fs from 'node:fs';
const file=process.argv[2];if(!file)throw new Error('用法：node scripts/import-local.mjs /绝对路径/nodes.json');
const input=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(input.nodes))throw new Error('需要 nodes 数组');
const base=process.env.NP_HUB_URL||'http://127.0.0.1:50000';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw new Error('本工具只向本地 Hub 导入');
async function api(method,route,body){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(process.env.ADMIN_TOKEN?{Authorization:`Bearer ${process.env.ADMIN_TOKEN}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'导入失败');return d;}
const state=await api('GET','/api/state');if(!state.localMode)throw new Error('需要本地模式');
const ids=new Map();
for(const n of input.nodes){
 const tag=`local-key:${n.key}`;
 let existing=state.servers.find(s=>s.tags?.includes(tag));
 if(!existing)existing=state.servers.find(s=>s.name===n.name&&(s.ip||'')===(n.ip||''));
 const body={name:n.name,ip:n.ip||'',country:n.country||'',city:n.city||'',lat:n.lat??null,lon:n.lon??null,notes:n.notes||'',tags:[...new Set([...(existing?.tags||[]),tag,...(n.tags||[])])]};
 const saved=existing?await api('PUT',`/api/servers/${existing.id}`,body):await api('POST','/api/servers',body);ids.set(n.key,saved.id);
}
for(const n of input.nodes){
 const p=n.profile||{};const via=k=>(p[k]||[]).map(key=>{const id=ids.get(key);if(!id)throw new Error('中转 key 不存在');return id;});
 const profile={...p,managementVia:via('managementVia'),businessVia:via('businessVia')};
 await api('PUT',`/api/local/profiles/${ids.get(n.key)}`,profile);
 const path=profile.businessVia.length?profile.businessVia:profile.managementVia;
 if(path.length)await api('POST','/api/routes',{from:'local',to:ids.get(n.key),via:path,label:profile.businessVia.length?'已配置业务中转（待实测）':'frp 管理连接（待实测）',hopLabels:['公网入口',...path.map(()=>profile.businessVia.length?'VLESS 中转':'frp')]});
}
console.log(`已保存 ${ids.size} 个节点；未测试，未开启自动任务。`);
