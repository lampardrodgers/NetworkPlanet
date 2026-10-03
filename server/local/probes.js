import { directConnect, directSshArgs, loopback, requireDirectAddress } from './direct.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { host } from './config.js';
import { run } from './process.js';
const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
export function parsePing(text) {
  const values = [...text.matchAll(/time[=<]\s*([\d.]+)\s*ms/gi)].map(m => +m[1]).filter(Number.isFinite).sort((a,b) => a-b);
  const loss = text.match(/([\d.]+)%\s*(?:packet )?loss/);
  const summary = text.match(/(?:min\/avg\/max\/(?:mdev|stddev))\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/);
  if (!loss) throw new Error('ping 未返回有效结果，可能缺少工具或权限');
  return { rtt: values.length ? (values[Math.floor((values.length-1)/2)] + values[Math.floor(values.length/2)])/2 : null,
    avg: summary ? +summary[2] : null, min: summary ? +summary[1] : null, max: summary ? +summary[3] : null,
    jitter: summary ? +summary[4] : null, loss: +loss[1], samples: values.length,
    state: values.length ? 'ok' : 'no-response' };
}
export async function ping(address, signal, ctx=null) {
  host(address);
  if(ctx&&!loopback(address))requireDirectAddress(address);
  const v6 = net.isIP(address) === 6;
  const cmd = process.platform === 'darwin' && v6 ? '/sbin/ping6' : 'ping';
  const args = process.platform === 'darwin' ? ['-n','-c','3',address] : ['-n',...(v6?['-6']:[]),'-c','3','-W','2',address];
  if(ctx&&!loopback(address)) args.unshift(...(process.platform==='darwin'?['-b',ctx.interface]:['-I',ctx.interface]));
  const r = await run(cmd, args, { signal, timeout: 12000, env: { ...process.env, LC_ALL: 'C' } });
  return parsePing(r.out);
}
export function connect(address, port, banner, signal, ctx=null) {
  if(ctx&&!loopback(address))return directConnect(address,port,banner,signal,ctx);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消'));
    const t = performance.now();
    const socket = net.connect({ host: host(address), port });
    let data = '', done = false;
    const finish = (result, error) => { if(done) return; done=true; clearTimeout(timer); signal?.removeEventListener('abort',abort); socket.destroy(); error ? reject(error) : resolve(result); };
    const abort = () => finish(null,new Error('已取消'));
    const timer=setTimeout(()=>finish({state:'no-response',rtt:null,samples:0}),5000);
    signal?.addEventListener('abort',abort,{once:true});
    socket.on('connect',()=>{ if(!banner) finish({state:'ok',rtt:performance.now()-t,samples:1}); });
    socket.on('data', chunk=>{ data+=chunk; if(data.length>8192) finish(null,new Error('服务响应不符合 SSH 协议')); else if (/(?:^|\n)SSH-2\.0-/.test(data)) finish({state:'ok',rtt:performance.now()-t,samples:1}); });
    socket.on('error', e=>finish({state:e.code==='ECONNREFUSED'?'refused':'no-response',rtt:null,samples:0}));
    socket.on('end',()=>finish({state:'no-response',rtt:null,samples:0}));
  });
}
export function sshArgs(s, password = false) {
  // 不加载用户的 RemoteCommand/LocalCommand，避免登录时意外安装 terminfo 等。
  const args=['-F','/dev/null','-T','-o',password?'BatchMode=no':'BatchMode=yes','-o','NumberOfPasswordPrompts=1','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ConnectionAttempts=1','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','RequestTTY=no'];
  if(s.knownHostsFile) args.push('-o','UserKnownHostsFile='+JSON.stringify(s.knownHostsFile));
  if(s.identityFile) args.push('-i',s.identityFile,'-o','IdentitiesOnly=yes');
  if(s.jump) args.push('-J',`${s.jump.user}@${net.isIP(s.jump.host)===6?'['+s.jump.host+']':s.jump.host}:${s.jump.port}`);
  return [...args,'-p',String(s.port),`${s.user}@${s.host}`];
}
export async function remoteBatch(ssh, jobs, signal, trace=false, credential=null,ctx=null) {
  const lines=['export LC_ALL=C','os=$(uname -s)'];
  jobs.forEach((j,i)=>{
    const target=quote(host(j.host));
    lines.push(`printf '\\nNP_BEGIN_${i}\\n'`);
    if(trace) lines.push(`if command -v timeout >/dev/null 2>&1; then timeout 85 traceroute -n -m 30 -q 1 -w 1 ${target}; else traceroute -n -m 30 -q 1 -w 1 ${target}; fi`);
    else {
      const port=Number.isInteger(j.port)&&j.port>0&&j.port<65536?j.port:22;
      const tcp="import socket,time,json; t=time.monotonic(); s=socket.create_connection(("+JSON.stringify(j.host)+","+port+"),5); print('NP_TCP '+json.dumps({'rtt':(time.monotonic()-t)*1000,'port':"+port+"})); s.close()";
      lines.push(`if command -v ping >/dev/null 2>&1; then if [ "$os" = Darwin ]; then ping -n -c 5 -t 12 ${target}; else ping -n -c 5 -W 2 -w 12 ${target}; fi; ${j.requirePing ? "else printf 'NP_UNAVAILABLE: ping not installed\\n'; fi" : `elif command -v python3 >/dev/null 2>&1; then python3 -c ${quote(tcp)}; else printf 'NP_UNAVAILABLE: no ping or python3\\n'; fi`}`);
    }
    lines.push(`printf '\\nNP_END_${i}\\n'`);
  });
  const r=await run('ssh',[...directSshArgs(ssh,ctx),...sshArgs(ssh,!!credential),'sh -s'],{signal,env:credential?{...process.env,SSH_ASKPASS:fileURLToPath(new URL('../../scripts/ssh-askpass.mjs',import.meta.url)),SSH_ASKPASS_REQUIRE:'force',DISPLAY:process.env.DISPLAY||':0',NP_PASSWORD_FILE:credential.file,NP_PASSWORD_ID:credential.id}:undefined,input:lines.join('\n')+'\n',timeout:12000+jobs.length*(trace?90000:15000)});
  if (r.code === 255) throw new Error(/Host key verification|REMOTE HOST IDENTIFICATION/.test(r.err)?'SSH 主机密钥未受信任或已变化，请在本机确认':'SSH 登录失败：检查本机密钥、用户和入口；没有修改远端');
  return jobs.map((j,i)=>{ const match=r.out.match(new RegExp(`NP_BEGIN_${i}\\n([\\s\\S]*?)\\nNP_END_${i}`)); return {job:j,text:match?.[1]||''}; });
}
export async function traceroute(address, signal, ctx=null) {
  if(ctx&&!loopback(address)&&process.platform==='darwin')return boundTrace(address,signal,ctx);
  host(address);
  const v6=net.isIP(address)===6;
  const cmd=process.platform==='darwin'&&v6?'/usr/sbin/traceroute6':'traceroute';
  const args=['-n',...(process.platform!=='darwin'&&v6?['-6']:[]),'-m','30','-q','1','-w','1',address];
  const r=await run(cmd,args,{signal,timeout:90000,env:{...process.env,LC_ALL:'C'}});
  if(r.code!==0&&!/^\s*\d+\s/m.test(r.out)) throw new Error('路由探测不可用：检查工具或权限');
  return r.out;
}

// macOS traceroute -i 只选择源地址，不能保证绕过 TUN；使用绑定物理网卡的 ICMP TTL 探测。
async function boundTrace(address,signal,ctx) {
 requireDirectAddress(address);
 const hops=[];let ended=false;
 for(let start=1;start<=30&&!ended;start+=3){
  const batch=await Promise.all(Array.from({length:Math.min(3,31-start)},async(_,i)=>{
   const ttl=start+i;
   const r=await run('/sbin/ping',['-n','-b',ctx.interface,'-c','1','-m',String(ttl),'-W','1000','-t','2',address],{signal,timeout:3500,env:{...process.env,LC_ALL:'C'}});
   const match=r.out.match(/bytes from ([\d.]+):/);
   const reached=!!match&&match[1]===address&&/icmp_seq=/.test(r.out);
   const ms=r.out.match(/time[=<]([\d.]+) ms/);
   return {line:` ${ttl} ${match?.[1]||'*'}${ms?' '+ms[1]+' ms':''}`,reached};
  }));
  for(const h of batch){hops.push(h.line);if(h.reached){ended=true;break;}}
 }
 return `DIRECT ${ctx.interface} · ICMP TTL · 每跳一个包\n`+hops.join('\n');
}
