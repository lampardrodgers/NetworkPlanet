import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { run } from './process.js';
export const directHelper=fileURLToPath(new URL('../../scripts/direct-socket.py',import.meta.url));
export const loopback=address=>address==='127.0.0.1'||address==='::1'||address==='localhost';
export function directContext(config={}) {
 const all=os.networkInterfaces();
 const name=config.directInterface||Object.keys(all).find(n=>/^(en\d+|eth\d+|wlan\d+|wlp\w+|enp\w+)$/.test(n)&&all[n].some(a=>a.family==='IPv4'&&!a.internal));
 if(!name||!all[name]?.some(a=>a.family==='IPv4'&&!a.internal)||!/^(en\d+|eth\d+|wlan\d+|wlp\w+|enp\w+)$/.test(name))throw new Error('没有可用物理网卡；请在本地测量中选择 DIRECT 网卡');
 return {interface:name,transport:'direct'};
}
export function requireDirectAddress(address) {
 if(net.isIP(address)!==4)throw new Error('DIRECT 模式请填写真实 IPv4 地址；不使用可能被 TUN 改写的域名解析');
}
export async function directConnect(address,port,banner,signal,ctx) {
 requireDirectAddress(address);
 const r=await run('python3',[directHelper],{signal,timeout:12000,input:JSON.stringify({host:address,port,banner,interface:ctx.interface})});
 if(r.code)throw new Error('网卡绑定 TCP 失败：'+r.err.slice(0,180));
 return {...JSON.parse(r.out),...ctx};
}
export function directSshArgs(ssh,ctx) {
 if(!ctx||loopback(ssh.host))return [];
 requireDirectAddress(ssh.host);
 if(ssh.jump)throw new Error('DIRECT 网卡绑定暂不支持嵌套 SSH 跳板');
 const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
 return ['-o',`ProxyCommand=python3 ${q(directHelper)} --stream ${q(ctx.interface)} %h %p`];
}
