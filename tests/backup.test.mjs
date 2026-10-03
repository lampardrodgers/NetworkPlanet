import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {backupService,encryptBackup,decryptBackup} from '../server/backup.js';
import {normalizeSettings} from '../server/config.js';
import {readSecrets,writeSecrets} from '../server/local/secrets.js';
import {portablePreferences} from '../shared/backup-preferences.js';

const pw='test-only-long-password';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'np-backup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const db={servers:[],links:[],routes:[],accounts:[],settings:normalizeSettings({origin:{name:'目标机',lat:1,lon:2},measurement:{directInterface:'en0'}}),localProfiles:{},localResults:{},localHistory:[],deviceRuns:[],events:[],traffic:{},bandwidth:{}};
 let count=0,active=false,fail=false;
 const api=backupService({db,dataDir:dir,flush(){if(fail)throw Error('disk full');count++;fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify(db));},busy:()=>active});
 return {dir,db,api,setActive:x=>active=x,setFail:x=>fail=x,count:()=>count};
}
function populate(f){
 f.db.servers=[{id:'node_a',name:'A',ip:'192.0.2.1'},{id:'node_b',name:'B',ip:'192.0.2.2'}];
 f.db.links=[{id:'link_a',a:'node_a',b:'node_b',kind:'frp',label:'frp'}];
 f.db.routes=[{id:'route_a',from:'local',to:'node_b',via:['node_a'],hopLabels:['','frp']}];
 f.db.localProfiles={node_a:{methods:['icmp'],ssh:{host:'192.0.2.1',user:'root',port:22,identityFile:path.join(f.dir,'source-key')}},node_b:{methods:['ssh-banner'],managementVia:['node_a'],businessVia:['node_a'],endpoint:{host:'192.0.2.1',port:6000},frpServer:{host:'192.0.2.1',port:7000}}};
 fs.writeFileSync(path.join(f.dir,'source-key'),'-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n-----END OPENSSH PRIVATE KEY-----\n',{mode:0o600});
 fs.writeFileSync(path.join(f.dir,'local-secrets.json'),JSON.stringify({passwords:{node_b:'secret-password'},node_a:'vless://11111111-1111-4111-8111-111111111111@192.0.2.1:443?security=tls&type=tcp'}));
 f.db.settings.measurement={...f.db.settings.measurement,mode:'auto',intervalSec:60,scope:['node_a'],directInterface:'eth0'};
 const result={source:'local',target:'node_a',kind:'latency',method:'icmp',state:'ok',rtt:10,finishedAt:1000};
 f.db.localResults={one:result};f.db.localHistory=[result];
}
test('加密完整备份：凭据不明文出现，错误密码和篡改拒绝',async()=>{
 const b=await encryptBackup({value:'sensitive-password'},pw);
 assert.ok(!JSON.stringify(b).includes('sensitive-password'));
 assert.deepEqual(await decryptBackup(b,pw),{value:'sensitive-password'});
 await assert.rejects(decryptBackup(b,'wrong-long-password'),/密码错误/);
 const tamper={...b,data:(b.data[0]==='A'?'B':'A')+b.data.slice(1)};
 await assert.rejects(decryptBackup(tamper,pw),/密码错误/);
 await assert.rejects(decryptBackup({...b,kdf:'unbounded'},pw),/版本/);
});
test('迁移包含拓扑、凭据、私钥；网卡身份隔离、调度关闭、重复导入不重复',async t=>{
 const a=fixture(t),b=fixture(t);populate(a);
 const {file}=await a.api.export({password:pw,browser:{'np.view':{mode:'globe'},'np.adminToken':'never-export'}});
 const body={file,password:pw,options:{history:true}};
 const preview=await b.api.preview(body);
 assert.equal(preview.counts.servers,2);assert.equal(b.db.servers.length,0);
 const done=await b.api.apply({...body,revision:preview.revision});
 assert.equal(b.db.servers.length,2);assert.equal(b.db.routes[0].via[0],'node_a');
 assert.deepEqual(b.db.localProfiles.node_b.managementVia,['node_a']);
 assert.equal(readSecrets(b.db,b.dir).passwords.node_b,'secret-password');
 const key=b.db.localProfiles.node_a.ssh.identityFile;
 assert.ok(key.startsWith(path.join(b.dir,'imported-ssh')));assert.equal(fs.statSync(key).mode&0o777,0o600);
 assert.equal(b.db.settings.measurement.mode,'manual');assert.equal(b.db.settings.measurement.directInterface,'en0');
 assert.equal(b.db.settings.origin.name,'目标机');assert.equal(Object.keys(b.db.localResults).length,0);
 assert.equal(b.db.deviceRuns[0].name.startsWith('导入'),true);assert.equal(b.db.deviceRuns[0].results[0].source.startsWith('device:import-'),true);
 assert.equal((await decryptBackup(b.api.rollback(done.rollbackId),pw)).snapshot.servers.length,0);
 const originalVault=b.db.localSecretsFile;writeSecrets(b.db,b.dir,{passwords:{node_b:'changed'}});assert.notEqual(b.db.localSecretsFile,originalVault);
 const again=await b.api.preview(body);await b.api.apply({...body,revision:again.revision});
 assert.equal(b.db.servers.length,2);assert.equal(b.db.routes.length,1);assert.equal(b.db.links.length,1);assert.equal(b.db.deviceRuns.length,1);
 // 迁移后的新凭据文件仍可导出，便于后续双向文件同步。
 assert.equal((await decryptBackup((await b.api.export({password:pw})).file,pw)).secrets.passwords.node_b,'secret-password');
});
test('冲突保留、镜像删除、过期预览、活动测量与坏引用阻止写入',async t=>{
 const a=fixture(t),b=fixture(t);populate(a);const {file}=await a.api.export({password:pw});
 b.db.servers=[{id:'node_a',name:'本地改名',ip:'192.0.2.9'},{id:'extra',name:'目标独有',ip:'192.0.2.8'}];
 let body={file,password:pw,options:{conflict:'keep'}};
 let p=await b.api.preview(body);await b.api.apply({...body,revision:p.revision});
 assert.equal(b.db.servers.length,3);assert.equal(b.db.servers.find(s=>s.id==='node_a').name,'本地改名');
 body={...body,options:{mode:'mirror'}};p=await b.api.preview(body);
 assert.equal(p.rows.find(r=>r.id==='extra').action,'删除');
 b.db.servers[0].name='预览后修改';await assert.rejects(b.api.apply({...body,revision:p.revision}),/重新预览/);
 p=await b.api.preview(body);await assert.rejects(b.api.apply({...body,options:{mode:'merge'},revision:p.revision}),/重新预览/);b.setActive(true);await assert.rejects(b.api.apply({...body,revision:p.revision}),/正在测量/);b.setActive(false);
 await b.api.apply({...body,revision:p.revision});assert.equal(b.db.servers.length,2);
 const data=await decryptBackup(file,pw);data.snapshot.localProfiles.node_b.managementVia=['missing'];
 body.file=await encryptBackup(data,pw);await assert.rejects(b.api.preview(body),/引用无效/);
 assert.equal(b.db.servers.length,2);
});
test('路径只来自服务端生成；写入失败保持原配置与凭据',async t=>{
 const a=fixture(t),b=fixture(t);populate(a);const {file}=await a.api.export({password:pw});
 const raw=await decryptBackup(file,pw);raw.keyRefs.node_a='../../outside';
 await assert.rejects(b.api.preview({file:await encryptBackup(raw,pw),password:pw}),/引用无效/);
 const body={file,password:pw};const p=await b.api.preview(body);const old=JSON.stringify(b.db);b.setFail(true);
 await assert.rejects(b.api.apply({...body,revision:p.revision}),/写入失败/);
 assert.equal(JSON.stringify(b.db),old);assert.deepEqual(readSecrets(b.db,b.dir),{});
});
test('浏览器备份白名单不复制身份、网卡、位置、登录和待执行令牌',()=>{
 const out=portablePreferences({'np.view':{mode:'flat',showLabels:false},'np.routes':{origin:'device:private',sourceVisible:false},'np.deviceId':'private','np.adminToken':'secret','np.deviceConfig':{name:'本机',os:'mac',city:'shanghai',directInterface:'en0',scope:['a'],trace:true}});
 assert.deepEqual(out,{'np.view':{mode:'flat',showLabels:false},'np.routes':{suggest:true,sourceVisible:false},'np.deviceConfig':{trace:true,scope:['a']}});
});

test('完整备份 API 认证、跨站隔离、预览和应用；基础 JSON 恢复线路',async t=>{
 const {spawn}=await import('node:child_process');const net=await import('node:net');
 const f=fixture(t),socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const hub=spawn(process.execPath,['server/index.js'],{env:{...process.env,NP_DATA_DIR:f.dir,PORT:String(port),NP_MODE:'local',ADMIN_TOKEN:'test-token',NP_DEMO:'0'},stdio:'ignore'});
 t.after(()=>hub.kill());const base='http://127.0.0.1:'+port;
 const call=async(url,body,auth=true,headers={})=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer test-token'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 for(let i=0;i<80;i++){try{await call('/api/status');break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.equal((await call('/api/backups/export',{password:pw},false)).status,401);
 assert.equal((await call('/api/backups/export',{password:pw},true,{Origin:'https://invalid.example'})).status,403);
 const ordinary={servers:[{id:'a',name:'A',ip:'192.0.2.1'},{id:'b',name:'B',ip:'192.0.2.2'}],routes:[{id:'r',from:'srv:a',to:'b',via:[]}]};
 assert.equal((await call('/api/import',ordinary)).status,200);
 let state=(await call('/api/state')).body;assert.equal(state.routes.length,1);assert.equal(state.routes[0].from,'srv:'+state.servers[0].id);
 const exported=await call('/api/backups/export',{password:pw});assert.equal(exported.status,200);
 const body={file:exported.body.file,password:pw,options:{mode:'merge'}};
 const preview=await call('/api/backups/preview',body);assert.equal(preview.status,200);
 const result=await call('/api/backups/apply',{...body,revision:preview.body.revision});assert.equal(result.status,200);
 assert.equal((await call('/api/backups/rollback/'+result.body.rollbackId)).body.format,'network-planet-encrypted');
 state=(await call('/api/state')).body;assert.equal(state.servers.length,2);assert.equal(state.settings.measurement.mode,'manual');
});

test('可不设密码，也可使用一位密码；两种文件均可完整导入',async t=>{
 const a=fixture(t);populate(a);
 for(const password of ['', '1', 'a'.repeat(2048)]){
  const b=fixture(t),out=await a.api.export({password});
  assert.equal(out.file.format,password?'network-planet-encrypted':'network-planet-backup');
  const request={file:out.file,password};const p=await b.api.preview(request);
  await b.api.apply({...request,revision:p.revision});
  assert.equal(readSecrets(b.db,b.dir).passwords.node_b,'secret-password');
  assert.equal(b.db.servers.length,2);
 }
});
test('统一入口导入基础 JSON：保留已有凭据、线路、稳定 ID，提供回滚',async t=>{
 const f=fixture(t);populate(f);
 const data={servers:f.db.servers.map(s=>({...s,name:s.name+' changed'})),links:f.db.links,routes:f.db.routes};
 const p=await f.api['basic-preview']({data});
 const r=await f.api['basic-apply']({data,revision:p.revision});
 assert.equal(f.db.servers.length,2);assert.equal(f.db.servers[0].name,'A changed');
 assert.equal(readSecrets(f.db,f.dir).passwords.node_b,'secret-password');
 assert.equal(f.db.routes.length,1);assert.equal(f.api.rollback(r.rollbackId).format,'network-planet-backup');
 const p2=await f.api['basic-preview']({data});await f.api['basic-apply']({data,revision:p2.revision});assert.equal(f.db.servers.length,2);
});
