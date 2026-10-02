import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {meshNodes,meshJobs} from '../server/local/mesh.js';

test('全部互测排除停用、演示和 frp 节点；有向全连接无自身测试',()=>{
 const servers=[{id:'a',ip:'192.0.2.1'},{id:'b',ip:'192.0.2.2'},{id:'off',ip:'192.0.2.3'},{id:'frp',ip:''},{id:'demo',ip:'192.0.2.4',demo:true}];
 const nodes=meshNodes(servers,{off:{disabled:true},frp:{managementVia:['a']}});
 assert.deepEqual(nodes.map(s=>s.id),['a','b']);
 assert.deepEqual(meshJobs(nodes).map(j=>[j.source,j.target]),[['a','b'],['b','a']]);
 assert.ok(meshJobs(nodes).every(j=>j.requirePing&&j.kind==='latency'));
 assert.throws(()=>meshJobs(nodes.slice(0,1)));assert.throws(()=>meshJobs(Array(51).fill(nodes[0])));
});

test('一键互测由服务端选三台 VPS，产生六个 Ping 结果且保持手动',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'np-mesh-'));
 const fake=path.join(dir,'ssh');
 fs.writeFileSync(fake,`#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(/socket.create_connection|mkdir|systemctl|crontab/.test(s))process.exit(9);for(const m of s.matchAll(/printf '\\\\nNP_BEGIN_(\\d+)/g))console.log('NP_BEGIN_'+m[1]+'\\n64 bytes time=12 ms\\n5 packets transmitted, 5 received, 0% packet loss\\nNP_END_'+m[1]);});\n`,{mode:0o700});
 const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const hub=spawn(process.execPath,['server/index.js'],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,NP_DATA_DIR:dir,PORT:String(port),NP_MODE:'local',NP_DEMO:'0'},stdio:'ignore'});
 const call=async(method,url,body)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
 try{
  for(let i=0;i<100;i++){try{await call('GET','/api/local');break;}catch{await delay(50);}}
  for(let i=1;i<=3;i++){const s=await call('POST','/api/servers',{name:'fixture '+i,ip:'127.0.0.'+i});await call('PUT','/api/local/profiles/'+s.id,{ssh:{host:'127.0.0.1',user:'fixture',port:22},methods:[]});}
  const initial=await call('GET','/api/local');assert.equal(initial.results.length,0);
  await call('POST','/api/local/rounds',{kind:'mesh'});
  let result;for(let i=0;i<100;i++){result=await call('GET','/api/local');if(!result.active)break;await delay(50);}
  assert.equal(result.active,null);assert.equal(result.lastRound.total,6);assert.equal(result.lastRound.completed,6);
  assert.equal(result.results.length,6);assert.ok(result.results.every(r=>r.method==='icmp'&&r.state==='ok'&&r.source!==r.target&&r.segment==='vps-mesh'));
  assert.equal(result.config.mode,'manual');assert.equal(result.nextAt,null);
 }finally{hub.kill('SIGTERM');await new Promise(r=>hub.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
