// 加密备份与文件式同步。只在明确提交导入时写入，不运行网络测试。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';
import { normalizeTargets, normalizeProbe } from './config.js';
import { normalizeServer, normalizeLink, normalizeRoute } from './store.js';
import { normalizeMeasurement, normalizeProfile } from './local/config.js';
import { parseVless } from './local/vless.js';
import { readSecrets } from './local/secrets.js';
import { portablePreferences } from '../shared/backup-preferences.js';

const scrypt = promisify(crypto.scrypt);
const FORMAT = 'network-planet-encrypted';
const LIMIT = 6 * 1024 * 1024;
const clone = x => JSON.parse(JSON.stringify(x));
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const idOK = x => typeof x === 'string' && /^[\w-]{1,64}$/.test(x) && !['__proto__','constructor','prototype'].includes(x);
function need(ok, message) { if (!ok) throw new Error(message); }
function object(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function safeParse(text) {
  return JSON.parse(text, (k,v) => { need(!['__proto__','constructor','prototype'].includes(k), '备份含无效字段'); return v; });
}
function passwordOK(p) { need(typeof p === 'string', '备份密码格式无效'); }
async function keyFor(password, salt) { return scrypt(password, salt, 32, { N:32768, r:8, p:1, maxmem:64*1024*1024 }); }
export async function encryptBackup(payload, password = '') {
  passwordOK(password);
  const text = JSON.stringify(payload);
  need(Buffer.byteLength(text) <= LIMIT, '备份超过 6 MiB，请取消包含测量历史后重试');
  if (!password) return safeParse(text);
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = await keyFor(password, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(FORMAT+':1'));
    const data = Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
    return { format:FORMAT, version:1, kdf:'scrypt-32768-8-1', cipher:'aes-256-gcm', salt:salt.toString('base64'), iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:data.toString('base64') };
  } finally { key.fill(0); }
}
export async function decryptBackup(envelope,password = '') {
  passwordOK(password);
  if (envelope?.format === 'network-planet-backup') {
    const text=JSON.stringify(envelope);
    need(Buffer.byteLength(text)<=LIMIT,'备份超过 6 MiB');
    return safeParse(text);
  }
  need(object(envelope) && envelope.format===FORMAT && envelope.version===1 && envelope.kdf==='scrypt-32768-8-1' && envelope.cipher==='aes-256-gcm','不支持的备份格式或版本');
  function bytes(name,len) {
    const s=envelope[name]; need(typeof s==='string' && /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length<=LIMIT*1.34,'备份编码无效');
    const b=Buffer.from(s,'base64'); need(len ? b.length===len : b.length<=LIMIT,'备份长度无效'); return b;
  }
  const salt=bytes('salt',16),iv=bytes('iv',12),tag=bytes('tag',16),data=bytes('data');
  const key=await keyFor(password,salt);
  let text;
  try { const d=crypto.createDecipheriv('aes-256-gcm',key,iv); d.setAAD(Buffer.from(FORMAT+':1')); d.setAuthTag(tag); text=Buffer.concat([d.update(data),d.final()]).toString('utf8'); }
  catch { throw new Error('密码错误或备份文件已损坏'); }
  finally { key.fill(0); }
  return safeParse(text);
}

function fileText(file,max=65536) {
  const fd=fs.openSync(file,'r');
  try { const stat=fs.fstatSync(fd); need(stat.isFile() && stat.size<=max,'文件类型或大小不符合要求'); return fs.readFileSync(fd,'utf8'); }
  finally { fs.closeSync(fd); }
}
function privateKey(text) { return typeof text==='string' && text.length<=65536 && /^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/m.test(text); }
function knownHosts(text) {
  need(typeof text==='string' && text.length<=65536,'SSH 主机指纹文件过大');
  for(const line of text.split('\n').filter(x=>x.trim()&&!x.startsWith('#'))) {
    need(/^(?:@(?:cert-authority|revoked) )?\S+ (?:ssh-|ecdsa-|sk-)[\w@.+-]+ [A-Za-z0-9+/=]+(?: .*)?$/.test(line),'SSH 主机指纹格式无效');
  }
  return text;
}
function entries(xs,label) {
  need(Array.isArray(xs)&&xs.length<=1000,`${label}数量或格式无效`);
  const seen=new Set();
  for(const x of xs){need(object(x)&&idOK(x.id)&&!seen.has(x.id),`${label} ID 无效或重复`);seen.add(x.id);}
  return xs;
}
function atomicJson(file,data) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600}); fs.renameSync(file+'.tmp',file);
}
function putImmutable(file,text) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  try { fs.writeFileSync(file,text,{mode:0o600,flag:'wx'}); }
  catch(e){if(e.code!=='EEXIST')throw e;need(fileText(file,LIMIT)===text,'已存在的迁移文件内容不一致');}
}

export function backupService({db,dataDir,flush,busy=()=>false,changed=()=>{},reschedule=()=>{}}) {
  dataDir=path.resolve(dataDir);
  let processing=false;
  async function exclusive(fn) { need(!processing,'另一项备份操作正在处理，请稍后重试');processing=true;try{return await fn();}finally{processing=false;} }
  const ensureInstance=()=>{if(!db.backupInstanceId){db.backupInstanceId=crypto.randomUUID();flush();}return db.backupInstanceId;};
  function capture(browser={},history=true) {
    const instanceId=ensureInstance(), snapshot=clone(db), warnings=[], keys={}, keyRefs={}, hosts={}, hostRefs={};
    delete snapshot.localSecretsFile;
    // 只读取节点明确引用的私钥与这些 SSH 地址的指纹，不打包整个 ~/.ssh。
    for(const [id,p] of Object.entries(snapshot.localProfiles||{})) {
      if(!p.ssh)continue;
      if(p.ssh.identityFile){
        try{const text=fileText(p.ssh.identityFile);need(privateKey(text),'不是可迁移的私钥');const ref=hash(text);keys[ref]=text;keyRefs[id]=ref;}
        catch{warnings.push(`${snapshot.servers.find(s=>s.id===id)?.name||id}：私钥未能读取，导入后需重新配置`);}
      }
      let lines=[];
      for(const h of [p.ssh,p.ssh.jump].filter(Boolean))for(const f of [p.ssh.knownHostsFile,path.join(dataDir,'ssh/known_hosts'),path.join(os.homedir(),'.ssh/known_hosts')].filter(Boolean)){
        try{const target=h.port===22?h.host:`[${h.host}]:${h.port}`;const out=execFileSync('ssh-keygen',['-F',target,'-f',f],{encoding:'utf8',timeout:1000,maxBuffer:65536,stdio:['ignore','pipe','ignore']});lines.push(...out.split('\n').filter(x=>x&&!x.startsWith('#')));}catch{}
      }
      const text=[...new Set(lines)].join('\n');
      if(text){knownHosts(text);const ref=hash(text);hosts[ref]=text;hostRefs[id]=ref;}
      else warnings.push(`${snapshot.servers.find(s=>s.id===id)?.name||id}：未找到 SSH 主机指纹，首次连接需核对`);
      if(p.ssh.jump)warnings.push(`${snapshot.servers.find(s=>s.id===id)?.name||id}：SSH 跳板需在目标主机核对指纹与认证`);
      p.ssh.identityFile='';p.ssh.knownHostsFile='';
    }
    if(!history)for(const k of ['localResults','localHistory','deviceRuns','localLastRound','traffic','bandwidth','events'])delete snapshot[k];
    return {format:'network-planet-backup',version:1,exportedAt:new Date().toISOString(),instanceId,host:os.hostname(),history,snapshot,secrets:readSecrets(db,dataDir),keys,keyRefs,hosts,hostRefs,browser:portablePreferences(browser),warnings};
  }
  function revision() {
    // 不让持续写入的历史结果使预览失效；配置、凭据变化则必须重新预览。
    return hash([db.servers,db.links,db.routes,db.accounts,db.localProfiles,db.settings,readSecrets(db,dataDir)]);
  }
  function plan(payload,options={}) {
    need(object(payload)&&payload.format==='network-planet-backup'&&payload.version===1&&idOK(payload.instanceId),'备份内容或版本无效');
    need(object(payload.snapshot)&&object(payload.secrets)&&object(payload.keys)&&object(payload.hosts),'备份缺少配置或凭据');
    const mode=options.mode||'merge', conflict=options.conflict||'incoming';
    need(['merge','mirror'].includes(mode)&&['incoming','keep'].includes(conflict),'同步方式无效');
    const incoming=payload.snapshot, next=clone(db), source=entries(incoming.servers,'节点'), warnings=[...(payload.warnings||[])].map(x=>String(x).slice(0,250));
    need(source.length<=500,'最多导入 500 个节点');
    const local=new Map(db.servers.map(s=>[s.id,s]));
    const selected=new Set(source.filter(s=>!local.has(s.id)||mode==='mirror'||conflict==='incoming').map(s=>s.id));
    const rows=source.map(s=>({id:s.id,name:String(s.name||s.id),action:!local.has(s.id)?'新增':selected.has(s.id)?'更新':'保留'}));
    if(mode==='mirror')rows.push(...db.servers.filter(s=>!source.some(x=>x.id===s.id)).map(s=>({id:s.id,name:s.name,action:'删除'})));
    const mergeList=(current,items,key=x=>x.id)=>{
      let list=mode==='mirror'?[]:[...current];
      for(const x of items){const exists=list.some(y=>y.id===x.id||key(y)===key(x));
        if(exists&&mode!=='mirror'&&conflict==='keep')continue;
        list=list.filter(y=>y.id!==x.id&&key(y)!==key(x));list.push(x);
      }return list;
    };
    const servers=source.map(s=>({...normalizeServer(s),id:s.id,agentToken:local.get(s.id)?.agentToken||crypto.randomBytes(18).toString('base64url'),createdAt:s.createdAt||Date.now(),locSource:String(s.locSource||''),locIp:String(s.locIp||'')}));
    next.servers=mergeList(db.servers,servers);
    const ids=new Set(next.servers.map(s=>s.id)), has=x=>ids.has(x);
    const accounts=entries(incoming.accounts||[],'供应商账号');
    next.accounts=mergeList(db.accounts||[],accounts.map(a=>({id:a.id,provider:String(a.provider||''),label:String(a.label||''),credentials:object(a.credentials)?a.credentials:{},createdAt:a.createdAt||Date.now()})));
    for(const s of next.servers)if(s.accountId)need(next.accounts.some(a=>a.id===s.accountId),'节点关联供应商账号不存在');
    const links=entries(incoming.links||[],'连接').map(l=>({...normalizeLink(l),id:l.id}));
    for(const l of links)need(has(l.a)&&has(l.b)&&l.a!==l.b,'连接引用无效');
    next.links=mergeList(db.links||[],links,l=>[l.a,l.b].sort().join('|'));
    const routes=entries(incoming.routes||[],'线路').map(r=>({...normalizeRoute(r),id:r.id}));
    for(const r of routes)need(r.from&&has(r.to)&&r.via.every(has)&&(!r.from.startsWith('srv:')||has(r.from.slice(4))),'线路引用无效');
    next.routes=mergeList(db.routes||[],routes,r=>r.from+'|'+r.to);
    need(object(incoming.localProfiles||{}),'连接档案格式无效');
    need(Object.keys(incoming.localProfiles||{}).every(id=>source.some(s=>s.id===id)),'连接档案引用了备份外节点');
    next.localProfiles=mode==='mirror'?{}:clone(db.localProfiles||{});
    const vault=mode==='mirror'?{}:clone(readSecrets(db,dataDir));vault.passwords ||= {};
    const files=[];
    for(const s of source)if(selected.has(s.id)){
      const id=s.id;
      delete next.localProfiles[id];delete vault[id];delete vault.passwords[id];
      if(incoming.localProfiles?.[id]){
        const p=clone(incoming.localProfiles[id]);
        if(p.ssh){p.ssh.identityFile='';p.ssh.knownHostsFile='';}
        const normalized=normalizeProfile(p);
        need([...normalized.managementVia,...normalized.businessVia].every(ref=>has(ref)&&ref!==id),'中转节点引用无效');
        for(const [refs,items,field,type] of [[payload.keyRefs,payload.keys,'identityFile','key'],[payload.hostRefs,payload.hosts,'knownHostsFile','hosts']]){
          const ref=refs?.[id];if(!ref)continue;
          need(/^[a-f0-9]{64}$/.test(ref)&&typeof items[ref]==='string'&&hash(items[ref])===ref&&normalized.ssh,'私钥或指纹引用无效');
          if(type==='key')need(privateKey(items[ref]),'私钥格式无效');else knownHosts(items[ref]);
          const file=path.join(dataDir,'imported-ssh',ref+'.'+type);normalized.ssh[field]=file;files.push({file,text:items[ref]});
        }
        next.localProfiles[id]=normalized;
      }
      if(payload.secrets[id]){need(typeof payload.secrets[id]==='string','VLESS 凭据格式无效');parseVless(payload.secrets[id]);vault[id]=payload.secrets[id];}
      if(payload.secrets.passwords?.[id]){need(typeof payload.secrets.passwords[id]==='string'&&payload.secrets.passwords[id].length<=4096,'SSH 密码格式无效');vault.passwords[id]=payload.secrets.passwords[id];}
    }
    // 部署主机相关字段始终留在目标端，自动任务导入后保持关闭。
    const before=db.settings.measurement;
    if(options.settings!==false){
      next.settings.targets=normalizeTargets(incoming.settings?.targets);
      next.settings.probe=normalizeProbe(incoming.settings?.probe);
      next.settings.probe.bandwidth.autoHours=0;
      // 告警配置可带走，但启用与通知端点留在目标端。
      next.settings.alerts=db.settings.alerts;
      const measurement=normalizeMeasurement({...incoming.settings?.measurement,mode:'manual',directInterface:before.directInterface});
      measurement.scope=measurement.scope.filter(id=>has(id)&&!next.localProfiles[id]?.disabled&&!next.servers.find(s=>s.id===id)?.demo);
      next.settings.measurement=measurement;
    }else next.settings.measurement={...before,mode:'manual',scope:before.scope.filter(has)};
    warnings.push('自动测试已暂停；物理网卡、部署主机位置、网站地址和登录权限保留目标端设置。');
    if(before.directInterface)warnings.push(`请确认目标主机物理网卡 ${before.directInterface} 仍正确。`);
    else warnings.push('目标主机尚未设置物理网卡；测试前请在后台测量中配置。');
    if(options.history!==false && payload.history){
      need(Array.isArray(incoming.localHistory||[])&&object(incoming.localResults||{})&&Array.isArray(incoming.deviceRuns||[]),'测量历史格式无效');
      const validResult=r=>object(r)&&has(r.target)&&typeof r.source==='string'&&Number.isFinite(r.finishedAt);
      const results=Object.values(incoming.localResults||{}).filter(r=>has(r?.target));need(results.every(validResult),'测量记录无效');
      // 旧主机的 local 结果转成独立设备，绝不作为新主机的测量结果。
      const sameInstance=payload.instanceId===ensureInstance();
      const originResults=results.filter(r=>r.source==='local'&&!sameInstance);
      const deviceId='import-'+payload.instanceId;
      const migrated=originResults.length?[{id:'import-'+hash(originResults).slice(0,32),deviceId,name:'导入 · '+String(payload.host||'原主机'),kind:'both',finishedAt:Math.max(...originResults.map(r=>r.finishedAt)),lat:incoming.settings?.origin?.lat??null,lon:incoming.settings?.origin?.lon??null,results:originResults.map(r=>({...r,source:'device:'+deviceId,imported:true}))}]:[];
      for(const run of incoming.deviceRuns||[])need(object(run)&&idOK(run.deviceId)&&typeof run.id==='string'&&Array.isArray(run.results)&&run.results.every(r=>object(r)&&typeof r.source==='string'&&Number.isFinite(r.finishedAt)),'设备测量记录无效');
      const allRuns=new Map((next.deviceRuns||[]).map(r=>[r.id,r]));
      for(const run of [...(incoming.deviceRuns||[]),...migrated])if(!allRuns.has(run.id))allRuns.set(run.id,run);
      for(const field of ['traffic','bandwidth']){
        need(object(incoming[field]||{}),'统计数据格式无效');
        next[field]={...(mode==='mirror'?{}:next[field]),...(conflict==='keep'?{}:incoming[field])};
      }
      const events=new Map((next.events||[]).map(r=>[r.id||hash(r),r]));
      for(const event of incoming.events||[])events.set(event.id||hash(event),event);
      next.events=[...events.values()].slice(-500);
      next.deviceRuns=[...allRuns.values()].sort((a,b)=>a.finishedAt-b.finishedAt).slice(-100);
      for(const r of results.filter(r=>r.source!=='local'||sameInstance)){
        const key=[r.source,r.target,r.method,r.kind,r.address||'',r.port||''].join('|');
        if(!next.localResults[key]||next.localResults[key].finishedAt<r.finishedAt)next.localResults[key]=r;
      }
      const allHistory=new Map((next.localHistory||[]).map(r=>[hash(r),r]));
      for(const r of incoming.localHistory||[]){if(!has(r?.target))continue;need(validResult(r),'历史记录无效');const row=r.source==='local'&&!sameInstance?{...r,source:'device:'+deviceId,imported:true}:r;allHistory.set(hash(row),row);}
      next.localHistory=[...allHistory.values()].sort((a,b)=>a.finishedAt-b.finishedAt).slice(-1000);
    }
    next.localResults=Object.fromEntries(Object.entries(next.localResults||{}).filter(([,r])=>has(r.target)&&(r.source==='local'||r.source.startsWith('device:')||has(r.source))));
    next.localHistory=(next.localHistory||[]).filter(r=>has(r.target));
    next.deviceRuns=(next.deviceRuns||[]).map(r=>({...r,results:r.results.filter(x=>has(x.target))}));
    next.backupInstanceId=ensureInstance();
    const prefs=portablePreferences(payload.browser||{});
    return {next,vault,files,prefs,summary:{rows,mode,conflict,exportedAt:payload.exportedAt,host:payload.host,counts:{servers:next.servers.length,links:next.links.length,routes:next.routes.length,profiles:Object.keys(next.localProfiles).length,keys:new Set(files.filter(f=>f.file.endsWith('.key')).map(f=>f.file)).size,passwords:Object.keys(vault.passwords).length,vless:next.servers.filter(s=>typeof vault[s.id]==='string').length},warnings:[...new Set(warnings)],revision:hash([revision(),payload,options])}};
  }
  function basicPayload(data) {
    data=safeParse(JSON.stringify(data));
    need(Array.isArray(data.servers)&&data.servers.length>0&&data.servers.length<=500,'文件内没有有效节点');
    const payload=capture({},false), ids=new Map();
    payload.exportedAt=data.exportedAt||null;
    payload.snapshot.servers=data.servers.map(raw=>{
      need(object(raw),'节点格式无效');
      const match=db.servers.find(s=>s.name===raw.name&&s.ip===raw.ip);
      const id=idOK(raw.id)?raw.id:match?.id||'srv_'+hash([raw.name,raw.ip,raw.host]).slice(0,12);
      if(raw.id)ids.set(raw.id,id);ids.set(raw.name,id);
      return {...raw,id};
    });
    const remap=id=>ids.get(id)||id;
    payload.snapshot.links=(data.links||[]).map(l=>({...l,id:idOK(l.id)?l.id:'lnk_'+hash(l).slice(0,12),a:remap(l.a),b:remap(l.b)}));
    payload.snapshot.routes=(data.routes||[]).map(r=>({...r,id:idOK(r.id)?r.id:'route_'+hash(r).slice(0,12),from:r.from?.startsWith('srv:')?'srv:'+remap(r.from.slice(4)):r.from,to:remap(r.to),via:(r.via||[]).map(remap)}));
    const importedIds=new Set(payload.snapshot.servers.map(s=>s.id));
    payload.snapshot.localProfiles=Object.fromEntries(Object.entries(payload.snapshot.localProfiles||{}).filter(([id])=>importedIds.has(id)));
    payload.warnings=['这是节点清单，没有携带登录凭据；已有同 ID 节点的连接配置会保留。'];
    return payload;
  }
  const basicRequest=b=>({file:basicPayload(b.data),password:'',options:{...b.options,settings:false,history:false,browser:false},revision:b.revision,currentBrowser:b.currentBrowser});
  const service = {
    'basic-preview': b=>service.preview(basicRequest(b)),
    'basic-apply': b=>service.apply(basicRequest(b)),
    export: b=>exclusive(async()=>{const p=capture(b.browser,b.history!==false);return {file:await encryptBackup(p,b.password),warnings:p.warnings};}),
    preview: b=>exclusive(async()=>plan(await decryptBackup(b.file,b.password),b.options).summary),
    apply: b=>exclusive(async()=>{
      need(!busy(),'当前正在测量，请结束本轮后再导入');
      const payload=await decryptBackup(b.file,b.password);let p=plan(payload,b.options);
      need(b.revision&&b.revision===p.summary.revision,'配置在预览后已改变，请重新预览');
      const rollback=await encryptBackup(capture(b.currentBrowser,true),b.password);
      // 加密期间允许其他请求读取；写入前再次检查配置与任务状态。
      need(!busy(),'测量状态已改变，请重新预览');
      p=plan(payload,b.options);
      need(p.summary.revision===b.revision,'配置或导入选项已改变，请重新预览');
      const rollbackId=crypto.randomUUID();atomicJson(path.join(dataDir,'backups',rollbackId+'.json'),rollback);
      for(const f of p.files)putImmutable(f.file,f.text);
      const vaultText=JSON.stringify(p.vault),vaultName='vaults/'+hash(vaultText)+'.json';
      putImmutable(path.join(dataDir,vaultName),vaultText);p.next.localSecretsFile=vaultName;
      const old=clone(db);
      try { for(const k of Object.keys(db))delete db[k];Object.assign(db,p.next);flush(); }
      catch(e){for(const k of Object.keys(db))delete db[k];Object.assign(db,old);throw new Error('导入写入失败；当前配置未切换');}
      reschedule();changed('backup');
      return {summary:p.summary,rollbackId,browser:b.options?.browser===true?p.prefs:null};
    }),
    rollback: id=>{need(/^[a-f0-9-]{36}$/.test(id),'回滚编号无效');return safeParse(fileText(path.join(dataDir,'backups',id+'.json'),LIMIT*1.4));},
  };
  return service;
}
