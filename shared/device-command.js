// 命令只启动当前任务，校验脚本摘要后在内存执行；不写文件或更改系统配置。
const shQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
export function deviceCommand(task, os, origin) {
 const url=new URL(origin);
 if(url.origin!==origin||url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('测试命令需要 HTTPS 网站地址');
 if(!/^[a-f0-9-]{36}$/.test(task.id)||! /^[a-f0-9]{64}$/.test(task.token)||! /^[a-f0-9]{64}$/.test(task.sha256))throw new Error('任务凭证无效');
 const body=JSON.stringify({id:task.id,token:task.token});
 const endpoint=origin+'/api/device-tests/script';
 if(os==='windows'){
  // 子进程退出即释放全部变量；不使用 ExecutionPolicy Bypass，不写脚本文件。
  const code=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Net.Http; $h=New-Object Net.Http.HttpClientHandler; $h.UseProxy=$false; $h.AllowAutoRedirect=$false; $c=[Net.Http.HttpClient]::new($h); $c.Timeout=[TimeSpan]::FromSeconds(20); try { $r=$c.PostAsync(${psQuote(endpoint)},[Net.Http.StringContent]::new(${psQuote(body)},[Text.Encoding]::UTF8,'application/json')).GetAwaiter().GetResult(); if([int]$r.StatusCode -ne 200){throw 'Task unavailable; generate a new command'}; $s=($r.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).script; $sha=[Security.Cryptography.SHA256]::Create(); $digest=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant(); $sha.Dispose(); if($digest -ne '${task.sha256}'){throw 'Script verification failed'}; & ([ScriptBlock]::Create($s)) -Server ${psQuote(origin)} } finally { $c.Dispose(); $h.Dispose() }`;
  // UTF-16LE 是 PowerShell -EncodedCommand 的固定格式。
  const bytes=new Uint8Array(code.length*2);for(let i=0;i<code.length;i++){bytes[i*2]=code.charCodeAt(i)&255;bytes[i*2+1]=code.charCodeAt(i)>>8;}
  let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
  return 'powershell.exe -NoLogo -NoProfile -EncodedCommand '+btoa(binary);
 }
 const code=`import urllib.request,json,hashlib,sys; r=urllib.request.Request(${JSON.stringify(endpoint)},data=${JSON.stringify(body)}.encode(),headers={"Content-Type":"application/json"}); o=urllib.request.build_opener(urllib.request.ProxyHandler({}),type("NoRedirect",(urllib.request.HTTPRedirectHandler,),{"redirect_request":lambda *a,**k:None})()); s=json.loads(o.open(r,timeout=20).read(1048576))["script"]; h=hashlib.sha256(s.encode()).hexdigest(); h==${JSON.stringify(task.sha256)} or sys.exit("Script verification failed"); sys.argv=["netplanet","--server",${JSON.stringify(origin)}]+sys.argv[1:]; exec(compile(s,"<netplanet>","exec"),{"__name__":"__main__"})`;
 return 'python3 -B -c '+shQuote(code);
}
