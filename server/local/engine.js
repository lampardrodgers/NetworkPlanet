import { secretPath, readSecrets, writeSecrets } from './secrets.js';
import { directContext } from './direct.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db, save } from '../store.js';
import { LOCAL_MODE, normalizeMeasurement, normalizeProfile, host } from './config.js';
import { ping, connect, remoteBatch, parsePing, traceroute } from './probes.js';
import { parseVless, vlessProbe } from './vless.js';
import { classifyTrace, asnDatabase, CLASSIFIER_VERSION } from './route-analysis.js';
import { workers } from './process.js';
import { meshNodes, meshJobs } from './mesh.js';
const dataDir=process.env.NP_DATA_DIR||path.resolve('data');
const secrets = () => readSecrets(db, dataDir);
let active=null, timer=null, nextAt=null, onChange=()=>{};
let controller=null, routeController=null, completion=null;
// 兼容修正：旧线路分类器把数据库来源写进了测量起点。只恢复带 DIRECT 原始证据的本机记录。
let fixedSources=false;
for(const r of [...Object.values(db.localResults),...db.localHistory])if(r.kind==='route'&&r.transport==='direct'&&r.raw?.startsWith('DIRECT ')&&r.source!=='local'&&!r.source?.startsWith('device:')){
 r.databaseSource=r.source;r.source='local';fixedSources=true;
}
if(fixedSources){db.localResults=Object.fromEntries(Object.values(db.localResults).map(r=>[[r.source,r.target,r.method,r.kind,r.address||'',r.port||''].join('|'),r]));save();}
// 规则升级只重新解释已有证据，不发包、不刷新采样时间，不启动自动测试。
let reclassified=false;
for(const r of [...Object.values(db.localResults),...db.localHistory])if(r.kind==='route'&&r.state==='ok'&&r.raw&&r.classifierVersion!==CLASSIFIER_VERSION){
 try{Object.assign(r,classifyTrace(r.raw,r.address));reclassified=true;}catch{}
}
if(reclassified)save();
export function onMeasurement(fn){onChange=fn;}

export function putProfile(id,input){
  if(!db.servers.some(s=>s.id===id&&!s.demo))throw new Error('请选择真实节点');
  const p=normalizeProfile(input,db.localProfiles[id]);
  for(const ref of [...p.managementVia,...p.businessVia])if(ref===id||!db.servers.some(s=>s.id===ref&&!s.demo))throw new Error('中转节点引用无效');
  if(input.vless!==undefined){
    if(input.vless)parseVless(input.vless);
    const vault=secrets();input.vless?vault[id]=String(input.vless):delete vault[id];
    writeSecrets(db,dataDir,vault);
  }
  if(input.sshPassword!==undefined){
    const vault=secrets();vault.passwords ||= {};
    if(input.sshPassword) vault.passwords[id]=String(input.sshPassword); else delete vault.passwords[id];
    writeSecrets(db,dataDir,vault);
  }
  db.localProfiles[id]=p;save();return publicProfiles()[id];
}
export function publicProfiles(){
  const vault=secrets();
  return Object.fromEntries(Object.entries(db.localProfiles).map(([id,p])=>{
    let vless=null;try{if(vault[id]){const {address,port,network,security}=parseVless(vault[id]);vless={address,port,network,security};}}catch{}
    return [id,{...p,ssh:p.ssh?{...p.ssh,identityFile:undefined,knownHostsFile:undefined,hasIdentity:!!p.ssh.identityFile,hasPassword:!!vault.passwords?.[id]}:null,vless}];
  }));
}
export function getMeasurement(){
 const cfg=db.settings.measurement;
 const freshMs=Math.max(300000,(cfg.intervalSec||60)*3000);
 return {enabled:LOCAL_MODE,host:os.hostname(),schemaVersion:1,config:cfg,nextAt,active,lastRound:db.localLastRound||null,
  profiles:publicProfiles(),results:Object.values(db.localResults).map(r=>({...r,stale:Date.now()-r.finishedAt>(r.kind==='route'?cfg.routeAnalysis.refreshSec*2000:freshMs)})),
  history:db.localHistory.slice(-100),asn:{updatedAt:asnDatabase().updatedAt,source:asnDatabase().source}};
}
export function configureMeasurement(patch){
 const config=normalizeMeasurement(patch,db.settings.measurement);
 for(const id of config.scope)if(!db.servers.some(s=>s.id===id&&!s.demo)||db.localProfiles[id]?.disabled)throw new Error('自动范围含不存在、演示或停用节点');
 db.settings.measurement=config;save();
 if(!config.routeAnalysis.enabled)routeController?.abort();
 reschedule();onChange();return getMeasurement();
}
export function reschedule(){
 clearTimeout(timer);timer=null;nextAt=null;
 if(!LOCAL_MODE||db.settings.measurement.mode!=='auto')return;
 const interval=db.settings.measurement.intervalSec*1000;
 nextAt=Date.now()+interval;
 timer=setTimeout(()=>{
   const late=Date.now()-nextAt;
   if(late<=5000&&!active){try{startRound({scope:db.settings.measurement.scope,kind:'latency',remote:db.settings.measurement.remote,auto:true});}catch{}}
   reschedule();onChange();
 },interval);
 timer.unref();
}
export function stopRound(){controller?.abort();routeController?.abort();return {stopping:!!active};}
export function shutdownMeasurement(){clearTimeout(timer);stopRound();return completion||Promise.resolve();}
function record(job,result){
 const r={...job,...result,source:job.source,target:job.target,finishedAt:Date.now(),roundId:active?.id};
 const key=[r.source,r.target,r.method,r.kind,r.address||'',r.port||''].join('|');db.localResults[key]=r;
 // 最多 2000 个最新结果、500 个历史结果，避免长时间运行无限增长。
 const keys=Object.keys(db.localResults);for(const k of keys.slice(0,Math.max(0,keys.length-2000)))delete db.localResults[k];
 db.localHistory.push(r);if(db.localHistory.length>500)db.localHistory.splice(0,db.localHistory.length-500);
 if(active)active.completed++;
 save();onChange();
}
function errorRecord(job,e){record(job,{state:controller?.signal.aborted||e.message==='已取消'?'cancelled':'error',rtt:null,error:String(e.message||'测试失败').slice(0,200)});}
export function startRound({scope,kind='latency',remote=false,auto=false}={}){
 if(!LOCAL_MODE)throw new Error('当前不是本地模式');
 if(active)return active;
 if(!['latency','route','mesh'].includes(kind))throw new Error('任务类型无效');
 if(kind==='mesh'){
  if(auto)throw new Error('全部 VPS 互测仅支持手动运行');
  const nodes=meshNodes(db.servers,db.localProfiles);meshJobs(nodes);scope=nodes.map(s=>s.id);
 }
 if(kind==='route'&&!db.settings.measurement.routeAnalysis.enabled)throw new Error('请先开启线路分析');
 if(!Array.isArray(scope)||!scope.length||scope.length>500)throw new Error('请选择测试节点');
 let selected=[...new Set(scope)].map(id=>db.servers.find(s=>s.id===id&&!s.demo));
 if(auto) selected=selected.filter(s=>s&&!db.localProfiles[s.id]?.disabled);
 if(!selected.length)throw new Error('范围内没有可测试节点');
 if(selected.some(s=>!s||db.localProfiles[s.id]?.disabled))throw new Error('范围含不存在、演示或停用节点');
 controller=new AbortController();routeController=new AbortController();
 const rc=routeController;controller.signal.addEventListener('abort',()=>rc.abort(),{once:true});
 active={id:`round_${Date.now()}`,kind,auto,scope:selected.map(s=>s.id),startedAt:Date.now(),completed:0,total:0};
 const round=active;
 completion=execute(selected,kind,remote,auto).catch(e=>{round.error=e.message;}).finally(()=>{
  round.finishedAt=Date.now();round.state=controller.signal.aborted?'cancelled':'done';
  db.localLastRound={...round};active=null;save();onChange();
 });
 onChange();return round;
}
async function execute(selected,kind,remote,auto){
 const localJobs=[],pairMap=new Map(),cfg=db.settings.measurement,profiles=structuredClone(db.localProfiles);
 const ctx=directContext(cfg);
 const wantTrace=kind==='route'||(auto&&cfg.routeAnalysis.enabled&&cfg.routeAnalysis.withAuto);
 if(kind==='mesh')for(const job of meshJobs(selected))pairMap.set(`${job.source}|${job.target}|latency`,job);
 const addTrace=j=>{
  const old=Object.values(db.localResults).find(r=>r.kind==='route'&&r.source===j.source&&r.target===j.target&&r.address===j.address);
  if(!auto||!old||Date.now()-old.finishedAt>=cfg.routeAnalysis.refreshSec*1000)localJobs.push({...j,method:'traceroute',kind:'route'});
 };
 for(const s of selected){
  if(kind==='mesh')continue;
  const p=profiles[s.id]||{methods:['icmp']};const endpoint=p.endpoint||{host:s.host||s.ip,port:s.probePort||22};
  if(kind==='latency')for(const method of p.methods){
   if(method==='vless'&&!cfg.proxyTests)continue;
   // 内网设备没有公网地址时，不把入口 IP 的 ping 当成内网设备 ping。
   const address=method==='icmp'?(s.host||s.ip):endpoint.host;
   localJobs.push({source:'local',target:s.id,address:address||null,port:endpoint.port,method,kind:'latency',...(method==='vless'?{transport:'proxy'}:ctx)});
  }
  if(wantTrace)addTrace({source:'local',target:s.id,address:s.host||s.ip||endpoint.host,entryOnly:!(s.host||s.ip)});
  if(remote)for(const via of [p.managementVia||[],p.businessVia||[]]){
   const chain=[...via,s.id];for(let i=1;i<chain.length;i++)for(const [a,b] of [[chain[i-1],chain[i]],[chain[i],chain[i-1]]]){
    if(profiles[a]?.disabled||profiles[b]?.disabled)continue;
    const frpSegment=via===p.managementVia&&a===s.id&&b===via.at(-1)&&p.frpServer;
    const target=db.servers.find(x=>x.id===b);const address=frpSegment?.host||target?.host||target?.ip;
    for (const type of [...(kind==='latency'?['latency']:[]),...(wantTrace?['route']:[])]) {
      if (type==='route' && auto) {
        const old=Object.values(db.localResults).find(r=>r.kind==='route'&&r.source===a&&r.target===b&&r.address===address);
        if(old&&Date.now()-old.finishedAt<cfg.routeAnalysis.refreshSec*1000)continue;
      }
      const k=`${a}|${b}|${type}`;if(!pairMap.has(k))pairMap.set(k,{source:a,target:b,address:address||null,port:frpSegment?.port||profiles[b]?.endpoint?.port||22,method:type==='route'?'traceroute':'icmp',kind:type,...(frpSegment?{segment:'frpc-frps'}:{})});
    }
   }
  }
 }
 active.total=localJobs.length+pairMap.size;onChange();
 await workers(localJobs,4,async job=>{
  const signal=job.kind==='route'?routeController.signal:controller.signal;
  if(signal.aborted)return;
  try{
   let result;
   if(job.method==='vless'){const link=secrets()[job.target];if(!link)throw new Error('未配置 VLESS 链接');result=await vlessProbe(link,signal);}
   else {Object.assign(job,ctx);if(!job.address)throw new Error('没有该设备的直达地址；入口响应不能代替此段');host(job.address);
    result=job.kind==='route'?classifyTrace(await traceroute(job.address,signal,ctx),job.address):job.method==='icmp'?await ping(job.address,signal,ctx):await connect(job.address,job.port,job.method==='ssh-banner',signal,ctx);
   }record(job,result);
  }catch(e){errorRecord(job,e);}
 },controller.signal);
 // 每个源节点一次 SSH 会话批量执行。远端没有文件、服务或定时器写入。
 const groups=new Map();for(const job of pairMap.values()){const key=job.source+'|'+job.kind;const list=groups.get(key)||[];list.push(job);groups.set(key,list);}
 await workers([...groups],2,async ([key,jobs])=>{
  const source=jobs[0].source, groupKind=jobs[0].kind;
  const signal=groupKind==='route'?routeController.signal:controller.signal;if(signal.aborted)return;
  const ssh=profiles[source]?.ssh;const valid=[];
  for(const j of jobs){if(!ssh||!j.address)errorRecord(j,new Error(!ssh?'源节点未配置无人值守 SSH':'目标无直达地址，不能测量该隧道内部段'));else valid.push({...j,host:j.address});}
  if(!valid.length)return;
  try{
   for(let i=0;i<valid.length&&!signal.aborted;i+=4){
    const out=await remoteBatch(ssh,valid.slice(i,i+4),signal,groupKind==='route',secrets().passwords?.[source]?{file:secretPath(db,dataDir),id:source}:null,ctx);
    for(const {job,text} of out)try{
      if(job.requirePing&&text.includes('NP_UNAVAILABLE'))throw new Error('源 VPS 没有 ping；未安装软件，也未用 TCP 替代');
      if(groupKind==='latency'&&text.includes('NP_TCP ')){
       const result=JSON.parse(text.split('NP_TCP ')[1].split('\n')[0]);
       if(!Number.isFinite(result.rtt)||result.rtt<0)throw new Error('远程 TCP 结果无效');
       for(const [k,old] of Object.entries(db.localResults))if(old.source===job.source&&old.target===job.target&&old.kind==='latency'&&old.method==='icmp'&&old.state==='error')delete db.localResults[k];
       record({...job,method:'tcp'},{state:'ok',rtt:result.rtt,samples:1,note:'源端没有 ping，使用现有 Python 测 TCP 建连',transport:'remote-direct',sshInterface:ctx.interface});
      }else record(job,groupKind==='route'?classifyTrace(text,job.address):parsePing(text));
     }catch(e){errorRecord(job,e);}
   }
  }catch(e){for(const j of valid)errorRecord(j,e);}
 },controller.signal);
}
