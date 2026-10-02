import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeMeasurement, normalizeProfile, host } from '../server/local/config.js';
import { parsePing, connect, sshArgs, remoteBatch } from '../server/local/probes.js';
import { parseVless, xrayConfig } from '../server/local/vless.js';
import { classifyTrace } from '../server/local/route-analysis.js';
import { run } from '../server/local/process.js';
import { showLinkLabel } from '../src/link-labels.js';
import { clampMapLatitude, balancedWorldLongitude } from '../src/flat/layout.js';
test('世界接缝平衡欧亚美节点并保持本机连线连续',()=>{
 const points=[0,9,104,120,140,140,140,237,238,242,242,242,242,281].map((lon,i)=>({id:String(i),lon}));
 points.push({id:'@origin',lon:120});
 const edges=points.slice(0,-1).map(p=>({a:'@origin',b:p.id}));
 const center=balancedWorldLongitude(points,edges,120);
 assert.ok(center>=140&&center<=165);
 const wrap=x=>((x+180)%360+360)%360-180;
 const offsets=points.map(p=>wrap(p.lon-center));
 assert.ok(Math.max(...offsets)<150); // 北美右侧留出标签空间
 assert.ok(Math.min(...offsets)>-165); // 欧洲仍在左侧可见范围内
 for(const p of points)assert.ok(Math.abs(wrap(p.lon-center)-wrap(120-center))<=180);
 assert.equal(balancedWorldLongitude([],[],120),120);
});
test('世界地图在工具栏之间垂直居中，缩放后限制拖动边界',()=>{
 const H=800,k=3,top=100,bottom=80;
 const lat=clampMapLatitude(0,H,k,top,bottom);
 const north=H/2-(82-lat)*k,south=H/2-(-58-lat)*k;
 assert.ok(Math.abs((north-top)-(H-bottom-south))<1e-8);
 assert.equal(south-north,140*k); // 等比例移动，不拉伸地理形状
 assert.equal(clampMapLatitude(30,H,10,top,bottom),30);
 assert.equal(clampMapLatitude(90,H,10,top,bottom),52);
});
test('标签关闭时命名和实测连线均隐藏；未测 frp 保留边但不显示标签',()=>{
 const measured={link:{compact:true,label:'CN2'},measured:{rtt:140},estimate:140};
 const pending={link:{compact:true,label:'frp'},measured:null,estimate:null};
 assert.equal(showLinkLabel(measured,false),false);
 assert.equal(showLinkLabel({link:{label:'自定义线路'},estimate:12},false),false);
 assert.equal(showLinkLabel(measured,true),true);
 assert.equal(showLinkLabel(pending,true),false);
 assert.equal(pending.link.label,'frp');
 assert.equal(showLinkLabel({...measured,measured:{rtt:0},estimate:null},true),true);
});
const link='vless://00000000-0000-0000-0000-000000000001@192.0.2.1:443?encryption=none&security=reality&type=tcp&sni=example.com&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=1234&flow=xtls-rprx-vision';

test('默认手动、线路关闭；自动必须有周期和范围；恶意主机不接受',()=>{
 const d=normalizeMeasurement();assert.equal(d.mode,'manual');assert.equal(d.intervalSec,null);assert.equal(d.routeAnalysis.enabled,false);
 assert.throws(()=>normalizeMeasurement({mode:'auto'}));assert.throws(()=>host('-oProxyCommand=bad'));assert.throws(()=>host('a;touch /tmp/x'));
 assert.equal(normalizeMeasurement({mode:'auto',intervalSec:60,scope:['a']}).intervalSec,60);
 const p=normalizeProfile({ssh:{host:'localhost',user:'root'}},{ssh:{identityFile:'/tmp/key'}});assert.equal(p.ssh.identityFile,'/tmp/key');
 assert.ok(sshArgs({host:'localhost',user:'root',port:22}).includes('StrictHostKeyChecking=yes'));
});
test('ICMP 统计和失败分离，不把缺工具当 100% 丢包',()=>{
 const p=parsePing('64 bytes time=10.0 ms\n64 bytes time=20.0 ms\n3 packets transmitted, 2 received, 33.3% packet loss\nrtt min/avg/max/mdev = 10/15/20/5 ms');
 assert.equal(p.rtt,15);assert.equal(p.loss,33.3);assert.equal(p.samples,2);
 assert.throws(()=>parsePing('ping: not found'));
});
test('VLESS 解析只支持明确参数，不回退到直连',()=>{
 assert.equal(parseVless(link).address,'192.0.2.1');assert.throws(()=>parseVless(link.replace('type=tcp','type=xhttp')));
 assert.throws(()=>parseVless(link.replace('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','broken')));
 assert.equal(xrayConfig(link,10000).outbounds.length,1);
 assert.equal(xrayConfig(link,10000).inbounds[0].listen,'127.0.0.1');
});
test('线路只报观测网络，不认证 GIA；支持 IPv6、未知跳',()=>{
 const r=classifyTrace(' 1 192.0.2.1 10 ms\n 2 *\n 3 2001:db8::1 20 ms','2001:db8::1',{updatedAt:1,source:'fixture',prefixes:[{asn:4809,prefix:'192.0.2.0/24'},{asn:58807,prefix:'2001:db8::/32'}]});
 assert.deepEqual(r.networks,['电信 CN2','移动 CMIN2']);assert.equal(r.hops[1].ips.length,0);assert.equal(r.complete,true);assert.equal(r.source,undefined);assert.equal(r.databaseSource,'fixture');assert.equal(r.networks.some(x=>x.includes('GIA')),false);
});
test('CN2 骨干接口不依赖 BGP 公告前缀；保留登记来源、不认证 GIA',()=>{
 const r=classifyTrace('8 59.43.0.1\n9 *\n10 59.43.0.2\n11 59.43.0.3\n14 192.0.2.10','192.0.2.10',{prefixes:[],source:'empty'});
 assert.deepEqual(r.networks,['电信 CN2']);assert.equal(r.complete,true);
 assert.equal(r.hops[0].networks[0].asn,null);assert.equal(r.hops[0].networks[0].evidence,'registered-infrastructure');
 assert.equal(r.hops[0].networks[0].source,'https://rdap.apnic.net/ip/59.43.0.0/16');
 assert.equal(r.networks.some(x=>x.includes('GIA')),false);
 assert.deepEqual(classifyTrace('1 59.44.0.1','59.44.0.1',{prefixes:[]}).networks,[]);
});
test('frp 入口连接成功不能代替 SSH 后端响应；取消关闭连接',async()=>{
 const sockets=new Set();const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{
  assert.equal((await connect('127.0.0.1',port,false)).state,'ok');
  const ac=new AbortController();const pending=connect('127.0.0.1',port,true,ac.signal);setTimeout(()=>ac.abort(),40);await assert.rejects(pending,/已取消/);
  server.removeAllListeners('connection');server.on('connection',s=>s.end('SSH-2.0-fixture\r\n'));
  assert.equal((await connect('127.0.0.1',port,true)).state,'ok');
 }finally{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});
test('命令超时和取消；有界输出',async()=>{
 await assert.rejects(run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:30}),/超时/);
 const ac=new AbortController();ac.abort();await assert.rejects(run('no-such-tool',[],{signal:ac.signal}),/取消/);
});
test('临时 SSH 双目标批量：只运行固定命令，不写远端；传输结果按目标分开',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'np-ssh-test-'));const fake=path.join(dir,'ssh');const old=process.env.PATH;
 fs.writeFileSync(fake,`#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(/mkdir|systemctl|crontab|touch|tee /.test(s))process.exit(9);for(const m of s.matchAll(/printf '\\\\nNP_BEGIN_(\\d+)/g))console.log('NP_BEGIN_'+m[1]+'\\n5 packets transmitted, 5 received, 0% packet loss\\n64 bytes time=12 ms\\nNP_END_'+m[1]);});\n`,{mode:0o700});
 process.env.PATH=dir+path.delimiter+old;
 try{const r=await remoteBatch({host:'fixture',port:22,user:'root'},[{host:'192.0.2.1'},{host:'192.0.2.2'}],new AbortController().signal);assert.equal(r.length,2);assert.equal(parsePing(r[1].text).rtt,12);}finally{process.env.PATH=old;fs.rmSync(dir,{recursive:true,force:true});}
});
test('Hub 集成：启动/保存/新增不测；显式本地一轮；停用和跨站拦截；凭据不返回',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'np-hub-test-'));const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const hub=spawn(process.execPath,['server/index.js'],{cwd:path.resolve('.'),env:{...process.env,NP_DATA_DIR:dir,PORT:String(port),NP_MODE:'local',NP_DEMO:'0'},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 const call=async(method,url,body,headers={})=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 let target;try{
  for(let i=0;i<100;i++){try{await fetch(base+'/api/state');break;}catch{await delay(50);}}
  const initial=(await call('GET','/api/local')).body;assert.equal(initial.config.mode,'manual');assert.equal(initial.results.length,0);assert.equal(initial.nextAt,null);
  target=net.createServer(s=>s.end('SSH-2.0-test\r\n'));await new Promise(r=>target.listen(0,'127.0.0.1',r));
  const node=(await call('POST','/api/servers',{name:'fixture',ip:'127.0.0.1'})).body;
  assert.ok(node.id);
  await call('PUT',`/api/local/profiles/${node.id}`,{methods:['ssh-banner'],endpoint:{host:'127.0.0.1',port:target.address().port},vless:link,sshPassword:'test-secret'});
  await call('PUT','/api/local/config',{routeAnalysis:{enabled:true}});
  let d=(await call('GET','/api/local')).body;assert.equal(d.results.length,0);assert.equal(d.nextAt,null);assert.equal(JSON.stringify(d).includes('test-secret'),false);assert.equal(JSON.stringify(d).includes('00000000-0000-0000'),false);
  assert.equal((await call('POST','/api/local/rounds',{scope:[node.id]},{Origin:'https://untrusted.example'})).status,403);
  await call('POST','/api/local/rounds',{scope:[node.id]});
  for(let i=0;i<50;i++){d=(await call('GET','/api/local')).body;if(!d.active)break;await delay(20);}
  assert.equal(d.results.length,1);assert.equal(d.results[0].method,'ssh-banner');assert.equal(d.results[0].state,'ok');assert.equal(d.config.mode,'manual');
  await call('PUT',`/api/local/profiles/${node.id}`,{disabled:true});assert.equal((await call('POST','/api/local/rounds',{scope:[node.id]})).status,400);
  assert.equal((await call('GET','/api/export')).body.servers.some(x=>x.vless||x.sshPassword),false);
  assert.equal(fs.statSync(path.join(dir,'local-secrets.json')).mode&0o777,0o600);
 }finally{if(target)await new Promise(r=>target.close(r));hub.kill('SIGTERM');await new Promise(r=>hub.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('未知本机坐标保持未知；frp/VLESS 响应不冒充直连延迟',async()=>{
 const {normalizeOrigin}=await import('../server/config.js');assert.equal(normalizeOrigin({lat:null,lon:null}).lat,null);assert.equal(normalizeOrigin({lat:0,lon:0}).lat,0);
 const {store}=await import('../src/state.js');const {routePlan,planSegments}=await import('../src/routes.js');
 store.localMode=true;store.servers=[{id:'x',name:'frp后端',ip:''}];store.settings={origin:{name:'本机',lat:null,lon:null}};store.routes=[];
 store.status.local={profiles:{x:{methods:['ssh-banner','vless']}},results:[{source:'local',target:'x',kind:'latency',method:'ssh-banner',address:'192.0.2.1',state:'ok',rtt:10,finishedAt:1}]};
 const plan=routePlan('local');
 assert.equal(plan.rows[0].direct.total,null);
 assert.equal(planSegments(plan)[0].estimate,null);
});
test('frp 分段使用客户端到服务器的实测；端到端独立，不复制反向 RTT',async()=>{
 const {store}=await import('../src/state.js');const {routePlan,planSegments}=await import('../src/routes.js');
 store.localMode=true;store.servers=[{id:'relay',name:'frps',ip:'192.0.2.1'},{id:'client',name:'frpc',ip:''}];
 store.settings={origin:{name:'本机',lat:0,lon:0}};store.routes=[{from:'local',to:'client',via:['relay'],hopLabels:['','frp']}];
 store.status.local={profiles:{client:{managementVia:['relay'],endpoint:{host:'192.0.2.1',port:6001}}},results:[
  {source:'client',target:'relay',kind:'latency',method:'tcp',state:'ok',rtt:99,finishedAt:1},
  {source:'client',target:'relay',kind:'latency',method:'tcp',state:'ok',rtt:33,finishedAt:2},
  {source:'local',target:'client',kind:'latency',method:'ssh-banner',state:'ok',rtt:848,address:'192.0.2.1',port:6001,finishedAt:2}
 ]};
 const edges=planSegments(routePlan('local'));
 assert.equal(edges.find(e=>e.a==='client'&&e.b==='relay').measured.rtt,33);
 assert.equal(edges.find(e=>e.a==='client'&&e.b==='relay').link.label,'frp');
 assert.equal(edges.some(e=>e.a==='relay'&&e.b==='client'),false);
 assert.equal(edges.find(e=>e.a==='@origin'&&e.b==='client').link.label,'端到端');
 assert.equal(edges.find(e=>e.a==='@origin'&&e.b==='client').measured.rtt,848);
 const profile=normalizeProfile({frpServer:{host:'192.0.2.1',port:7000}});
 assert.equal(normalizeProfile({note:'changed'},profile).frpServer.port,7000);
});


test('地图聚合不把温哥华与西雅图归入同一地点，但允许同城机房聚合',async()=>{
 const {sameMapSite}=await import('../src/flat/layout.js');
 const seattle={lat:47.6109,lon:-122.3303,country:'US'};
 const vancouver={lat:49.2827,lon:-123.1207,country:'CA'};
 assert.equal(sameMapSite([vancouver],seattle),false);
 assert.equal(sameMapSite([{lat:34.0481,lon:-118.2531,country:'US'}],{lat:34.0549,lon:-118.243,country:'US'}),true);
 assert.equal(sameMapSite([{...vancouver,country:'US'}],seattle),false);
});


test('DIRECT 配置不接受 TUN 网卡；SSH 通过绑定网卡的原始 TCP 流连接',async()=>{
 const {directSshArgs,requireDirectAddress}=await import('../server/local/direct.js');
 assert.throws(()=>normalizeMeasurement({directInterface:'utun6'}));
 assert.equal(normalizeMeasurement({}).proxyTests,false);
 assert.equal(normalizeMeasurement({directInterface:'en0'}).directInterface,'en0');
 assert.throws(()=>requireDirectAddress('example.com'));
 assert.throws(()=>directSshArgs({host:'192.0.2.1',jump:{host:'192.0.2.2'}},{interface:'en0'}));
 assert.match(directSshArgs({host:'192.0.2.1'},{interface:'en0'}).join(' '),/direct-socket.py.*--stream.*en0/);
});


test('地球与平面的连接来源与线路视图一致，开关可隐藏但不删除数据',async()=>{
 const {store,computeEdges}=await import('../src/state.js');
 store.localMode=true;store.localEdges=[{key:'@origin>a',a:'@origin',b:'a',measured:{rtt:20},estimate:null}];
 store.view.showLinks=true;
 assert.equal(computeEdges()[0].measured.rtt,20);
 store.view.showLinks=false;assert.deepEqual(computeEdges(),[]);
 assert.equal(store.localEdges.length,1);
 store.view.showLinks=true;
});
