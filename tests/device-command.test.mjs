import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {deviceCommand} from '../shared/device-command.js';
const task={id:crypto.randomUUID(),token:'a'.repeat(64),sha256:'b'.repeat(64)};
const run=command=>new Promise(resolve=>{const p=spawn('/bin/sh',['-c',command],{env:{...process.env,HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',http_proxy:'http://127.0.0.1:1',https_proxy:'http://127.0.0.1:1'},timeout:10000});let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);p.on('close',code=>resolve({code,out}));});
test('命令获取、摘要校验、参数传递；忽略 HTTP 代理且拒绝被改动的程序',async()=>{
 const script='import sys; print("VERIFIED", sys.argv[1:])';
 let requestBody='',payload=script;
 const server=http.createServer(async(req,res)=>{for await(const c of req)requestBody+=c;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({script:payload}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  const t={...task,sha256:crypto.createHash('sha256').update(script).digest('hex')};
  const good=await run(deviceCommand(t,'mac',origin)+' --interface en0');
  assert.equal(good.code,0,good.out);assert.match(good.out,/VERIFIED.*--interface.*en0/);assert.deepEqual(JSON.parse(requestBody),{id:t.id,token:t.token});
  payload='print("SHOULD_NOT_RUN")';const bad=await run(deviceCommand(t,'linux',origin));assert.notEqual(bad.code,0);assert.match(bad.out,/verification failed/);assert.doesNotMatch(bad.out,/SHOULD_NOT_RUN/);
 }finally{await new Promise(r=>server.close(r));}
});
test('拒绝非 HTTPS 公网、命令注入凭证，Windows 不修改执行策略',()=>{
 assert.throws(()=>deviceCommand(task,'mac','http://example.com'));
 assert.throws(()=>deviceCommand({...task,token:"'; touch /tmp/evil"},'mac','https://example.com'));
 const cmd=deviceCommand(task,'windows','https://example.com');
 const ps=Buffer.from(cmd.split(' ').at(-1),'base64').toString('utf16le');
 assert.match(ps,/UseProxy=\$false/);assert.match(ps,/AllowAutoRedirect=\$false/);assert.match(ps,/Script verification failed/);assert.doesNotMatch(ps,/ExecutionPolicy|WriteAll|Set-Item|Set-Net/);
});
