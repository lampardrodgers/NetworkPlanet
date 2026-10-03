// 一次性设备测试：任务只有目标和短期上传令牌，不下发管理凭据或任意命令。
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import {classifyTrace} from './route-analysis.js';
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const text=(v,n=100)=>String(v||'').slice(0,n);
export function deviceTests(db,save,notify=()=>{}) {
 const pending=new Map();
 db.deviceRuns ||= [];
 const list=()=>db.deviceRuns;
 function create(b){
  for(const [k,v] of pending)if(v.expiresAt<Date.now())pending.delete(k);
  if(pending.size>=30)fail('待执行任务过多，请等待旧任务过期');
  if(!['mac','linux','windows'].includes(b.os))fail('支持 Mac、Windows、Linux');
  if(!/^[a-zA-Z0-9_-]{8,80}$/.test(b.deviceId||''))fail('设备标识无效');
  if(!Array.isArray(b.scope)||!b.scope.length||b.scope.length>40)fail('请选择 1～40 个节点');
  const kind=b.kind||'latency';if(!['latency','route','both'].includes(kind))fail('测试类型无效');
  const trace=kind==='route'||kind==='both'||b.trace===true;
  const directInterface=text(b.directInterface,50).trim();
  if(directInterface&&!/^[a-zA-Z0-9_.: -]{1,50}$/.test(directInterface))fail('网卡名称无效');
  const isPublic=ip=>net.isIP(ip)===4&&!/^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|198\.(18|19)|22[4-9]|23\d|24\d|25[0-5])\./.test(ip);
  const targets=[],skipped=[];
  for(const id of new Set(b.scope)){
   const s=db.servers.find(x=>x.id===id&&!x.demo);if(!s)fail('节点不存在');
   const p=db.localProfiles?.[id]||{},ip=s.host||s.ip;
   if(p.disabled){skipped.push({name:s.name,reason:'待开机 / 已停用'});continue;}
   const methods=[...new Set(p.methods?.length?p.methods:['icmp'])];
   if(trace&&!methods.includes('icmp'))methods.push('icmp');
   for(const method of methods){
    if(kind==='route'&&method!=='icmp')continue;
    if(!['icmp','tcp','ssh-banner'].includes(method)){skipped.push({name:s.name,reason:'VLESS 需要代理内核，仍由后台单独测量'});continue;}
    const address=method==='icmp'?ip:p.endpoint?.host||ip;
    if(!address){skipped.push({name:s.name,reason:method==='icmp'?'无独立公网 IPv4，不能以 frps 的 Ping 冒充设备':'没有服务入口地址'});continue;}
    if(!isPublic(address)){if(net.isIP(address))fail('仅允许公网 IPv4 目标');skipped.push({name:s.name,reason:'入口需要明确的公网 IPv4 地址'});continue;}
    const port=Number(p.endpoint?.port||22);if(!Number.isInteger(port)||port<1||port>65535)fail('入口端口无效');
    targets.push({id,name:s.name,ip:address,method,port:method==='icmp'?null:port,entryOnly:method==='tcp'&&address!==ip,latency:kind!=='route'&&(method!=='icmp'||(p.methods||['icmp']).includes('icmp'))});
   }
  }
  if(!targets.length)fail('没有可测的公网 IPv4 节点或服务入口');
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex'),expiresAt=Date.now()+3600000;
  const location=Number.isFinite(b.lat)&&Math.abs(b.lat)<=90&&Number.isFinite(b.lon)&&Math.abs(b.lon)<=180?{lat:b.lat,lon:b.lon}:{lat:null,lon:null};
  const job={id,deviceId:b.deviceId,name:text(b.name)||'未命名设备',os:b.os,trace,kind,directInterface,targets,skipped,expiresAt,...location};
  const manifest={...job,token};
  const template=fs.readFileSync(new URL(`../../scripts/device/${b.os==='windows'?'probe.ps1':'probe.py'}`,import.meta.url),'utf8');
  const script=template.replace('__NP_MANIFEST__',Buffer.from(JSON.stringify(manifest)).toString('base64'));
  pending.set(id,{...job,manifestBase:job,template,hash:crypto.createHash('sha256').update(token).digest(),used:false});
  return {id,token,sha256:crypto.createHash('sha256').update(script).digest('hex'),expiresAt,skipped,filename:`netplanet-${id.slice(0,8)}.${b.os==='windows'?'ps1':'py'}`,script};
 }
 function authorized(b){
  const j=pending.get(b.id);const digest=crypto.createHash('sha256').update(text(b.token,128)).digest();
  if(!j||j.expiresAt<Date.now()||!crypto.timingSafeEqual(j.hash,digest))throw Object.assign(new Error('任务令牌无效或已过期'),{status:401});
  if(j.used)throw Object.assign(new Error('此任务已提交，请重新生成任务'),{status:409});
  return j;
 }
 function fetchScript(b){
  const j=authorized(b);
  // 只返回创建时固定的模板和任务，不接受调用者提供程序或目标。
  return {script:j.template.replace('__NP_MANIFEST__',Buffer.from(JSON.stringify({...j.manifestBase,token:b.token})).toString('base64'))};
 }
 function accept(b){
  const j=authorized(b);
  if(!Array.isArray(b.results)||b.results.length>j.targets.length)fail('结果数量无效');
  const seen=new Set(),results=[];
  for(const r of b.results){
   const method=r.method||'icmp',key=r.target+'|'+method;
   const target=j.targets.find(t=>t.id===r.target&&t.method===method);if(!target||seen.has(key))fail('重复或未授权的目标');seen.add(key);
   if(!Array.isArray(r.samples)||r.samples.length>3||r.samples.some(n=>!Number.isFinite(n)||n<0||n>10000))fail('Ping 样本无效');
   if(!['mac-bound','linux-bound','windows-physical-route'].includes(r.proof)&&!r.error)fail('缺少直连校验信息');
   const ok=r.samples.length>0&&!r.error;
   const base={source:'device:'+j.deviceId,target:r.target,address:target.ip,port:target.port,entryOnly:target.entryOnly,finishedAt:Date.now(),transport:'device-direct-reported',interface:text(r.interface),proof:text(r.proof),error:text(r.error,300)};
   if(target.latency)results.push({...base,kind:'latency',method,state:r.error?'blocked':ok?'ok':'no-response',rtt:ok?r.samples.reduce((a,b)=>a+b,0)/r.samples.length:null,loss:r.error||method!=='icmp'?null:(3-r.samples.length)/3*100});
   if(j.trace&&method==='icmp'&&typeof r.trace==='string'&&r.trace.length&& !r.error){
    if(r.trace.length>20000)fail('路由数据过长');
    results.push({...classifyTrace(r.trace,target.ip),...base,kind:'route',method:'traceroute',state:'ok',raw:r.trace});
   }
  }
  for(const t of j.targets)if(!seen.has(t.id+'|'+t.method)||(!t.latency&&!results.some(r=>r.target===t.id&&r.kind==='route')))results.push({source:'device:'+j.deviceId,target:t.id,address:t.ip,finishedAt:Date.now(),kind:t.latency?'latency':'route',method:t.latency?t.method:'traceroute',state:'blocked',rtt:null,error:text(b.error,300)||text(b.results.find(r=>r.target===t.id&&r.method===t.method)?.error,300)||'脚本未完成此目标'});
  const run={id:j.id,deviceId:j.deviceId,name:j.name,os:j.os,kind:j.kind,directInterface:j.directInterface,lat:j.lat,lon:j.lon,finishedAt:Date.now(),error:text(b.error,300),results};
  db.deviceRuns=[...db.deviceRuns,run].slice(-50);j.used=true;save();notify();return {ok:true};
 }
 function location(b){
  if(!Number.isFinite(b.lat)||Math.abs(b.lat)>90||!Number.isFinite(b.lon)||Math.abs(b.lon)>180)fail('位置无效');
  const runs=db.deviceRuns.filter(r=>r.deviceId===b.deviceId);if(!runs.length)fail('请先完成此设备的一轮测试');
  for(const r of runs){r.lat=b.lat;r.lon=b.lon;if(b.name)r.name=text(b.name,80);}
  save();notify();return {ok:true};
 }
 return {create,accept,list,fetchScript,location};
}
