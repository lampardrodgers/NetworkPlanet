// 测试时短暂启动本地代理内核；配置只写本地私有临时目录，退出删除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { host, integer } from './config.js';
import { run } from './process.js';
export function parseVless(link) {
  let u; try {u=new URL(link);} catch {throw new Error('VLESS 链接格式无效');}
  const p=u.searchParams;
  if(u.protocol!=='vless:' || !/^[\da-f-]{36}$/i.test(u.username)) throw new Error('需要带 UUID 的 VLESS 链接');
  const security=p.get('security'), network=p.get('type')||'tcp';
  if(!['reality','tls'].includes(security)||!['tcp','raw','grpc','ws'].includes(network)) throw new Error('当前支持 VLESS TCP/gRPC/WS + TLS/REALITY');
  if(p.get('encryption') && p.get('encryption')!=='none') throw new Error('暂不支持此 VLESS encryption 参数');
  const known=new Set(['encryption','security','type','sni','fp','pbk','sid','flow','serviceName','path','host','alpn','pqv']);
  for(const [k,v] of p) if(v && !known.has(k)) throw new Error(`不支持的 VLESS 参数：${k}`);
  if(p.get('pqv')) throw new Error('暂不支持非空 pqv 参数');
  const sni=host(p.get('sni')||u.hostname);
  const streamSettings={network,security};
  if(security==='reality') {
    if(!/^[A-Za-z0-9_-]{43}$/.test(p.get('pbk')||'')||!/^([\da-f]{2}){0,8}$/i.test(p.get('sid')||'')) throw new Error('REALITY 公钥或 shortId 不完整');
    streamSettings.realitySettings={serverName:sni,fingerprint:p.get('fp')||'chrome',publicKey:p.get('pbk'),shortId:p.get('sid')||''};
  } else streamSettings.tlsSettings={serverName:sni,allowInsecure:false,...(p.get('alpn')?{alpn:p.get('alpn').split(',')}:{})};
  if(network==='grpc') streamSettings.grpcSettings={serviceName:p.get('serviceName')||p.get('path')||''};
  if(network==='ws') streamSettings.wsSettings={path:p.get('path')||'/',headers:{Host:p.get('host')||sni}};
  const flow=p.get('flow')||'';
  if(flow && !['xtls-rprx-vision','xtls-rprx-vision-udp443'].includes(flow)) throw new Error('不支持的 VLESS flow');
  if(flow && !['tcp','raw'].includes(network)) throw new Error('Vision 需要 TCP/RAW');
  const address=host(u.hostname), port=integer(u.port,1,65535,'VLESS 端口');
  return {address,port,network,security,outbound:{protocol:'vless',settings:{vnext:[{address,port,users:[{id:u.username,encryption:'none',flow}]}]},streamSettings}};
}
export function xrayConfig(link, port) {
  return {log:{loglevel:'none'},inbounds:[{listen:'127.0.0.1',port,protocol:'socks',settings:{auth:'noauth',udp:false}}],outbounds:[parseVless(link).outbound]};
}
async function freePort() {
  const s=net.createServer(); await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);}); const port=s.address().port;await new Promise(r=>s.close(r));return port;
}
export async function vlessProbe(link,signal) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'np-vless-'));fs.chmodSync(dir,0o700);
  let child, timer, killed=false, failure='', closed;
  const stop=()=>{killed=true;child?.kill('SIGTERM');};
  try {
    const port=await freePort();
    if(signal.aborted) throw new Error('已取消');
    const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(xrayConfig(link,port)),{mode:0o600});
    child=spawn(process.env.NP_XRAY_BIN||'xray',['run','-config',file],{stdio:'ignore'});
    closed=new Promise(r=>{child.on('close',r);child.on('error',()=>{failure='缺少或无法启动本地 Xray';r();});});
    signal.addEventListener('abort',stop,{once:true}); timer=setTimeout(stop,25000);
    let ready=false;
    for(let i=0;i<30&&!killed&&!failure;i++) {
      ready=await new Promise(r=>{ const s=net.connect({host:'127.0.0.1',port});s.on('connect',()=>{s.destroy();r(true);});s.on('error',()=>r(false)); });
      if(ready)break;
      if(child.exitCode!=null)break;
      await delay(100);
    }
    if(!ready)throw new Error(failure||'本地 Xray 未就绪，请检查版本和节点参数');
    // HTTPS 校验证书；固定小响应，无系统代理、无自动重定向。
    const target=process.env.NP_PROXY_TEST_URL||'https://www.gstatic.com/generate_204';
    if(!/^https:\/\//.test(target))throw new Error('代理测试目标必须是 HTTPS');
    const r=await run('curl',['--silent','--show-error','--noproxy','','--proxy',`socks5h://127.0.0.1:${port}`,'--connect-timeout','8','--max-time','15','--max-filesize','4096','-o','/dev/null','-w','%{http_code} %{time_starttransfer} %{time_total}',target],{signal,timeout:17000});
    const [status,ttfb,total]=r.out.trim().split(/\s+/).map(Number);
    if(r.code||!(status>=200&&status<400))throw new Error('代理请求失败或目标未正常响应');
    return {state:'ok',rtt:ttfb*1000,totalMs:total*1000,httpStatus:status,samples:1,target,timing:'请求开始至首字节（含代理、TLS 和目标处理）'};
  } finally {
    clearTimeout(timer);signal.removeEventListener('abort',stop);stop();
    if(child){const hard=setTimeout(()=>child.kill('SIGKILL'),1000);await closed;clearTimeout(hard);}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
