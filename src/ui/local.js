// 本地测量控制台。配置编辑不会启动任务。
import { store } from '../state.js';
import { api } from '../api.js';
import { esc, fmtMs } from '../format.js';
import { openModal, $, toast } from './dom.js';
const names={icmp:'Ping 往返延迟（ICMP）',tcp:'TCP 建连','ssh-banner':'SSH 后端响应',vless:'VLESS 响应',traceroute:'线路分析'};
const name=id=>id==='local'?'本机':store.servers.find(s=>s.id===id)?.name||id;
const when=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'—';
export function openLocalMonitor(){
 const data=store.status.local, cfg=data?.config||store.settings.measurement;
 if(!cfg)return toast('本地测量服务尚未就绪','error');
 const profiles=data?.profiles||{};
 const m=openModal({title:'本地测量',wide:true,content:`
 <form class="form local-monitor"><div class="row-btns"><button type="button" class="btn primary" data-run="mesh">全部 VPS 互相 Ping 一轮</button><span class="hint">只测 VPS 之间；每方向 5 包，可停止，不开启自动测试。</span></div><p class="hint">测量电脑：${esc(data?.host||'本机')}。配置和历史保存在本地。VPS 上不安装探针。DIRECT 测试绑定物理网卡，不使用系统代理。VLESS 代理测试需单独开启。</p>
 <div class="grid2"><label>测试方式<select class="input" name="mode"><option value="manual" ${cfg.mode==='manual'?'selected':''}>手动测试</option><option value="auto" ${cfg.mode==='auto'?'selected':''}>自动测试</option></select></label>
 <label>每轮间隔（分钟，1～1440）<input class="input" name="interval" type="number" min="1" max="1440" step="any" value="${cfg.intervalSec?cfg.intervalSec/60:''}" placeholder="自动测试时必填" /></label></div>
 <div class="grid2"><label>DIRECT 物理网卡<input class="input" name="directInterface" value="${esc(cfg.directInterface||'')}" placeholder="自动选择，例如 en0" /></label><label class="check"><input type="checkbox" name="proxyTests" ${cfg.proxyTests?'checked':''}/> 另测 VLESS 代理（不属于 DIRECT）</label></div>
 <label class="check"><input type="checkbox" name="remote" ${cfg.remote?'checked':''}/> 同时通过 SSH 测量选中节点涉及的中转段（双向；需要源端密钥和目标直达地址）</label>
 <div class="grid2"><label class="check"><input type="checkbox" name="analysis" ${cfg.routeAnalysis.enabled?'checked':''}/> 开启线路分析</label><label class="check"><input type="checkbox" name="withAuto" ${cfg.routeAnalysis.withAuto?'checked':''}/> 随自动轮次更新线路</label></div>
 <label>线路最短刷新间隔（小时）<input class="input" name="refresh" type="number" min="0.083334" max="168" step="any" value="${cfg.routeAnalysis.refreshSec/3600}" /></label>
 <p class="hint">开启线路分析只启用能力，不开始测试。CN2、CMIN2、9929 等标签来自本地 ASN 数据；不能仅凭标签认证 GIA。</p>
 <div class="local-scope">${store.servers.filter(s=>!s.demo).map(s=>`<div class="local-node"><label class="check"><input name="scope" type="checkbox" value="${esc(s.id)}" ${cfg.scope.includes(s.id)?'checked':''} ${profiles[s.id]?.disabled?'disabled':''}/><b>${esc(s.name)}</b></label><span>${[...(profiles[s.id]?.businessVia?.length?profiles[s.id].businessVia:profiles[s.id]?.managementVia||[]),s.id].map(name).map(esc).join(' → ')}<br/>${profiles[s.id]?.disabled?'待开机 / 停用':profiles[s.id]?.ssh?'SSH 已配置 / 待实测':'无 SSH 档案'} · ${profiles[s.id]?.vless?'VLESS 已配置':'无 VLESS'}</span><button type="button" class="link-btn" data-profile="${esc(s.id)}">连接配置</button></div>`).join('')}</div>
 <div class="row-btns"><button type="submit" class="btn primary">保存设置</button><button type="button" class="btn" data-run="latency">选中节点测一轮</button><button type="button" class="btn" data-run="route">选中线路分析一轮</button><button type="button" class="btn" data-stop>停止本轮</button></div>
 <p class="hint">手动按钮只执行一次。自动任务仅包含保存时选中的节点。新增节点不自动进入范围。关闭自动测试不终止当前轮次。</p><span class="err"></span>
 </form><div class="local-progress"></div><div class="local-results"></div>`});
 const form=$('form',m.el), error=$('.err',m.el);
 const scope=()=>[...form.querySelectorAll('[name=scope]:checked:not(:disabled)')].map(x=>x.value);
 form.addEventListener('submit',async e=>{e.preventDefault();try{const out=await api('PUT','/api/local/config',{directInterface:form.directInterface.value,proxyTests:form.proxyTests.checked,mode:form.mode.value,intervalSec:form.interval.value?Math.round(Number(form.interval.value)*60):null,scope:scope(),remote:form.remote.checked,routeAnalysis:{enabled:form.analysis.checked,withAuto:form.withAuto.checked,refreshSec:Math.round(Number(form.refresh.value)*3600)}});store.status.local=out;render();error.textContent='';toast('设置已保存；未立即发起测试','ok');}catch(e){error.textContent=e.message;}});
 form.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.profile)return openConnection(b.dataset.profile);
  try{
   if(b.dataset.run){await api('POST','/api/local/rounds',{scope:scope(),kind:b.dataset.run,remote:form.remote.checked});toast('已创建一轮任务','ok');}
   if(b.hasAttribute('data-stop'))await api('POST','/api/local/stop',{});
   error.textContent='';
  }catch(e){error.textContent=e.message;}
 });
 function render(){
  if(!m.el.isConnected){off();return;}
  const d=store.status.local;if(!d)return;
  $('.local-progress',m.el).textContent=d.active?`正在执行：${d.active.completed}/${d.active.total} · ${d.active.kind==='route'?'线路分析':d.active.kind==='mesh'?'全部 VPS 互相 Ping':'延迟测试'}`:`当前空闲 · 下次自动测试：${when(d.nextAt)}`;
  form.querySelectorAll('[data-run]').forEach(b=>b.disabled=!!d.active);
  $('.local-results',m.el).innerHTML=`<p class="hint">ASN 数据更新时间：${when(d.asn?.updatedAt)} · ${esc(d.asn?.source||'未导入')}</p><table class="local-table"><thead><tr><th>路径 / 方法</th><th>结果</th><th>采样时间</th></tr></thead><tbody>${(d.results||[]).filter(r=>!(r.state==='error'&&r.method==='icmp'&&(d.results||[]).some(x=>x.source===r.source&&x.target===r.target&&x.method==='tcp'&&x.state==='ok'&&x.finishedAt>r.finishedAt))).sort((a,b)=>b.finishedAt-a.finishedAt).map(r=>`<tr><td>${esc(name(r.source))} → ${esc(name(r.target))}<small>${r.segment==='vps-mesh'?'VPS 互测 · ':''}${esc(names[r.method]||r.method)}${r.interface?' · DIRECT '+esc(r.interface):''}${r.entryOnly?' · 仅公网入口':''}</small></td><td>${r.kind==='route'?`<b>${esc(r.networks?.join(' → ')||'未识别')}</b><details><summary>路由依据</summary><p>${esc(r.note||r.error||'')}</p><pre>${esc(r.raw||'无结果')}</pre></details>`:r.state==='ok'?`${fmtMs(r.rtt)}${r.loss!=null?` · 丢包 ${r.loss}%`:''}`:esc(r.error||({refused:'端口拒绝','no-response':'未响应',cancelled:'已取消'}[r.state])||r.state)}${r.stale?'<small>历史结果 / 已过期</small>':''}</td><td>${esc(when(r.finishedAt))}</td></tr>`).join('')||'<tr><td colspan="3">尚未测试。选择节点后可手动测试一轮。</td></tr>'}</tbody></table>`;
 }
 const off=store.on('status',render);render();
}
export function openConnection(id){
 const p=store.status.local?.profiles?.[id]||{};
 const s=store.servers.find(s=>s.id===id);
 const option=(key,values)=>store.servers.filter(x=>x.id!==id&&!x.demo).sort((a,b)=>(values?.includes(a.id)?values.indexOf(a.id):-1)-(values?.includes(b.id)?values.indexOf(b.id):-1)).map(x=>`<label class="check"><input type="checkbox" name="${key}" value="${esc(x.id)}" ${values?.includes(x.id)?'checked':''}/> ${esc(x.name)}</label>`).join('');
 const m=openModal({title:`连接配置 · ${s?.name||id}`,content:`<form class="form"><p class="hint">保存不运行测试。密钥和 VLESS 凭据仅保留本地；不向远端写入文件。多级中转的顺序请通过接入 API 指定。</p>
 <label class="check"><input type="checkbox" name="disabled" ${p.disabled?'checked':''}/> 停用测试（待开机 / 待打通）</label>
 <div class="grid2"><label>服务入口地址<input class="input" name="endpointHost" value="${esc(p.endpoint?.host||s?.host||s?.ip||'')}"/></label><label>服务入口端口<input class="input" name="endpointPort" type="number" value="${p.endpoint?.port||22}"/></label></div>
 <div class="row-btns">${Object.entries(names).filter(([k])=>k!=='traceroute').map(([k,v])=>`<label class="check"><input type="checkbox" name="methods" value="${k}" ${(p.methods||['icmp']).includes(k)?'checked':''}/> ${v}</label>`).join('')}</div>
 <div class="grid2"><label>SSH 地址<input class="input" name="sshHost" value="${esc(p.ssh?.host||'')}"/></label><label>SSH 端口<input class="input" name="sshPort" type="number" value="${p.ssh?.port||22}"/></label></div>
 <label>SSH 用户<input class="input" name="user" value="${esc(p.ssh?.user||'')}"/></label><label>本机密钥绝对路径<input class="input" name="identity" placeholder="${p.ssh?.hasIdentity?'留空保留已有密钥路径':'留空使用默认密钥 / ssh-agent'}"/></label>
 <label>SSH 密码（可选，只保存在本地）<input class="input" name="sshPassword" type="password" autocomplete="new-password" placeholder="留空保留已有设置"/></label>
 <label>VLESS 链接<textarea class="input" name="vless" rows="3" placeholder="${p.vless?'已保存，留空保留；凭据不回显':'可选'}"></textarea></label>
 <label>管理中转（按下列顺序）</label><div class="local-picks">${option('managementVia',p.managementVia)}</div><label>业务中转（按下列顺序）</label><div class="local-picks">${option('businessVia',p.businessVia)}</div>
 <label>说明<input class="input" name="note" value="${esc(p.note||'')}"/></label><span class="err"></span><button class="btn primary">保存连接</button></form>`});
 const f=$('form',m.el);const checked=k=>[...f.querySelectorAll(`[name=${k}]:checked`)].map(x=>x.value);
 f.addEventListener('submit',async e=>{e.preventDefault();try{
  const ssh=f.sshHost.value?{host:f.sshHost.value,port:+f.sshPort.value,user:f.user.value,...(f.identity.value?{identityFile:f.identity.value}:{})}:null;
  await api('PUT',`/api/local/profiles/${id}`,{...(f.sshPassword.value?{sshPassword:f.sshPassword.value}:{}),disabled:f.disabled.checked,methods:checked('methods'),endpoint:f.endpointHost.value?{host:f.endpointHost.value,port:+f.endpointPort.value}:null,ssh,managementVia:checked('managementVia'),businessVia:checked('businessVia'),note:f.note.value,...(f.vless.value?{vless:f.vless.value}:{})});
  store.status.local=await api('GET','/api/local');store.emit('status');m.close();toast('连接已保存；未发起测试','ok');
 }catch(e){$('.err',f).textContent=e.message;}});
}
