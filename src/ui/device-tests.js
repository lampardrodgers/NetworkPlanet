import {store,setView} from '../state.js';
import {api} from '../api.js';
import {esc,fmtMs} from '../format.js';
import {openModal,$} from './dom.js';
import {CITIES} from '../../shared/cities.js';
import {deviceCommand} from '../../shared/device-command.js';
import {currentDeviceId,devicePreferences,saveDevicePreferences,trackDeviceTask} from '../device-state.js';
import {openConnection,openLocalMonitor} from './local.js';
import {setRouteOrigin} from './routes.js';
const TEST_MODES={
 latency:{label:'延迟测试',hint:'只测延迟，不探测线路。按节点配置执行 Ping、TCP 建连或 SSH 后端响应。'},
 route:{label:'线路分析',hint:'只探测网络跳点和线路归属，不更新 Ping 延迟。'},
 both:{label:'延迟 + 线路',hint:'一轮同时测延迟和线路。线路探测仅适用于有独立公网 IPv4 的节点。'},
};
export function openDeviceTests(){
 const deviceId=currentDeviceId()||crypto.randomUUID();
 const preferences=devicePreferences(),cfg=store.status.local?.config||store.settings.measurement||{};
 const profiles=store.status.local?.profiles||{};
 const selected=preferences.scope||cfg.scope?.length&&cfg.scope||store.servers.filter(s=>!s.demo).map(s=>s.id);
 const previous=(store.deviceRuns||[]).filter(r=>r.deviceId===deviceId).at(-1);
 let task=null,objectUrl=null,command='';
 const m=openModal({title:'从此设备测试 · 复制命令',wide:true,onClose:()=>{off();if(objectUrl)URL.revokeObjectURL(objectUrl);},content:`
 <p>复制命令，在要测试的电脑终端粘贴并回车。自动获取测试内容、执行并回传，测完退出。无需下载文件，不安装服务，不修改代理、路由或开机设置。</p>
 <p class="hint">Mac/Linux 需要现有 Python 3、系统 ping（Linux 还需 ip）。Windows 使用 PowerShell（尚未实机验证）；发现活动 VPN/虚拟网卡或不能确认物理出口即停止。不支持手机浏览器执行。</p>
 <form class="form"><div class="grid2"><label>设备名称<input class="input" name="deviceName" value="${esc(preferences.name||previous?.name||'我的电脑')}" maxlength="80" required></label><label>系统<select class="input" name="os"><option value="mac">Mac</option><option value="windows">Windows</option><option value="linux">Linux</option></select></label></div>
 <label>设备所在城市（用于地图，可不填）<select class="input" name="city"><option value="">未设置；只显示拓扑位置</option>${CITIES.map(c=>`<option value="${c.key}">${esc(c.zh||c.name)}</option>`).join('')}</select></label>
 <div class="grid2"><label>测试内容<select class="input" name="kind">${Object.entries(TEST_MODES).map(([value,mode])=>`<option value="${value}">${mode.label}</option>`).join('')}</select></label><label>DIRECT 物理网卡<input class="input" name="directInterface" value="${esc(preferences.directInterface||'')}" placeholder="自动选择，例如 en0 / eth0 / Ethernet"></label></div>
 <p class="hint" data-mode-summary role="status"></p>
 <p class="hint">配置保存只影响此设备，不改变后台任务。节点入口和测量方法共用连接档案；原生 Ping、TCP、SSH 后端响应均绑定物理出口。SSH 响应不是 Ping 延迟。</p>
 <div class="row-btns"><button type="button" class="btn sm" data-scope-all>全选可用节点</button><button type="button" class="btn sm" data-scope-none>全不选</button></div>
 <div class="local-scope">${store.servers.filter(s=>!s.demo).map(s=>{const p=profiles[s.id]||{};return `<div class="local-node"><label class="check"><input type="checkbox" name="scope" value="${s.id}" ${p.disabled?'disabled':selected.includes(s.id)?'checked':''}><b>${esc(s.name)}</b></label><span>${(p.methods||['icmp']).map(x=>({icmp:'Ping',tcp:'TCP 建连','ssh-banner':'SSH 后端响应',vless:'VLESS（后台）'}[x]||x)).map(esc).join(' / ')}<br>${p.disabled?'待开机 / 停用':esc(p.endpoint?.host||s.host||s.ip||'无公网入口')}${p.endpoint?.port?':'+p.endpoint.port:''}</span><button type="button" class="link-btn" data-device-profile="${s.id}">连接配置</button></div>`;}).join('')}</div>
 <details><summary>VPS 互测、SSH 中转段、VLESS 与后台调度</summary><p class="hint">这些任务使用部署主机保存的凭据，由后台执行。本机命令不下载 SSH 密码、密钥或 VLESS 凭据。这里也可打开同一配置入口。</p><button type="button" class="btn" data-backend-settings>后台测量配置 / VPS 互测</button></details>
 <div class="row-btns"><button class="btn" type="button" data-save-device>保存设置</button><button class="btn primary" type="submit">生成并复制测试命令</button></div><p class="hint">生成命令不会启动测试；在终端运行后只测一轮。停止测试请按 Ctrl+C。</p><span class="err"></span></form>
 <div class="device-task"></div><h4>设备测量记录</h4><div class="device-results"></div>`});
 const form=$('form',m.el);
 form.kind.value=Object.hasOwn(TEST_MODES,preferences.kind)?preferences.kind:preferences.trace?'both':'latency';
 function updateModeSummary(){const mode=TEST_MODES[form.kind.value];$('[data-mode-summary]',m.el).textContent='本轮：'+mode.label+'。'+mode.hint;}
 updateModeSummary();
 function invalidateCommand(){
  if(!command)return;
  command='';task=null;
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  $('.device-task',m.el).textContent='设置已修改，请重新生成并复制命令；旧命令不会随选项改变。';
 }
 form.addEventListener('change',()=>{updateModeSummary();invalidateCommand();});
 if(preferences.os||previous?.os)form.os.value=preferences.os||previous.os;
 const city=CITIES.find(c=>c.lat===previous?.lat&&c.lon===previous?.lon);form.city.value=preferences.city||city?.key||'';
 function settings(){return {name:form.deviceName.value,os:form.os.value,city:form.city.value,directInterface:form.directInterface.value.trim(),kind:form.kind.value,trace:form.kind.value!=='latency',scope:[...form.querySelectorAll('[name=scope]:checked:not(:disabled)')].map(x=>x.value)};}
 form.addEventListener('click',e=>{
  if(e.target.closest('[data-save-device]')){saveDevicePreferences(settings());$('.err',m.el).textContent='已保存，此次保存未启动测试。';}
  if(e.target.closest('[data-scope-all],[data-scope-none]')){form.querySelectorAll('[name=scope]:not(:disabled)').forEach(x=>x.checked=!!e.target.closest('[data-scope-all]'));invalidateCommand();}
  const profile=e.target.closest('[data-device-profile]');if(profile)openConnection(profile.dataset.deviceProfile);
  if(e.target.closest('[data-backend-settings]'))openLocalMonitor();
 });
 form.onsubmit=async e=>{e.preventDefault();const btn=e.submitter||form.querySelector('[type=submit]');btn.disabled=true;const controls=[];
  try{
   const settingsValue=settings();saveDevicePreferences(settingsValue);
   for(const el of form.querySelectorAll('input,select,button')){controls.push([el,el.disabled]);el.disabled=true;}
   const city=CITIES.find(c=>c.key===form.city.value);
   task=await api('POST','/api/device-tests',{...settingsValue,deviceId,lat:city?.lat??null,lon:city?.lon??null});
   trackDeviceTask(task.id);
   if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(new Blob([form.os.value==='windows'?'\ufeff':'',task.script],{type:'text/plain;charset=utf-8'}));
   command=deviceCommand(task,form.os.value,location.origin);
   $('.device-task',m.el).innerHTML=`<p><strong>本次命令：${TEST_MODES[task.kind].label}</strong> · 延迟 ${task.counts.latency} 项 · 线路 ${task.counts.route} 项</p><p><button type="button" class="btn primary" data-copy-command>复制测试命令</button> <span class="copy-status" role="status"></span></p><p>${form.os.value==='windows'?'打开 PowerShell':'打开终端'}，粘贴并回车。命令一小时内有效；无需切换目录。结果自动回传网页。</p><textarea class="input" readonly rows="3" aria-label="测试命令" spellcheck="false" style="width:100%;font-family:monospace;word-break:break-all">${esc(command)}</textarea><p class="hint">命令包含本次任务令牌，请勿转发。获取的程序会校验 SHA-256 后在内存中运行，不保存脚本文件。Mac 会自动识别物理出口；若仍有多个可用出口，按终端提示选择网卡。也可在上方指定 DIRECT 物理网卡。缺少工具、权限不足或策略阻止时停止，不自动安装或提权。</p><details><summary>查看脚本 / 手动下载（可选）</summary><p><a class="btn" href="${objectUrl}" download="${task.filename}">下载脚本</a></p><pre style="max-height:240px;overflow:auto">${esc(task.script)}</pre></details>${task.skipped.length?`<p>已跳过：${task.skipped.map(x=>esc(x.name+'（'+x.reason+'）')).join('、')}</p>`:''}<p class="device-wait">等待本机执行并上传……</p>`;
   await copyCommand();
   $('.err',m.el).textContent='';
  }catch(e){$('.err',m.el).textContent=e.message;}finally{for(const [el,disabled] of controls)el.disabled=disabled;btn.disabled=false;}
 };
 async function copyCommand(){
  const status=$('.copy-status',m.el);
  try{await navigator.clipboard.writeText(command);status.textContent='已复制，去终端粘贴并回车';}
  catch{status.textContent='浏览器未允许自动复制，请点“复制测试命令”，或选中下方命令复制。';$('.device-task textarea',m.el).select();}
 }
 function render(){
  const runs=[...(store.deviceRuns||[])].reverse();
  if(task&&runs.some(r=>r.id===task.id))$('.device-wait',m.el).textContent='已收到结果。此任务不能再次提交；重测请生成新命令。';
  $('.device-results',m.el).innerHTML=runs.map(r=>`<details ${r.id===task?.id?'open':''}><summary>${esc(r.name)} · ${TEST_MODES[r.results.some(x=>x.kind==='route')&&r.results.some(x=>x.kind==='latency')?'both':r.kind]?.label||'设备测试'} · ${new Date(r.finishedAt).toLocaleString()} · ${r.results.filter(x=>x.state==='ok').length} 项通过</summary><p>${esc(r.error||'以下结果由运行脚本的设备报告；未响应不等于节点离线。')}</p><button class="btn sm" data-map="${esc(r.deviceId)}">查看此设备最新线路</button><table class="local-table"><thead><tr><th>节点</th><th>方法 / 结果</th></tr></thead><tbody>${r.results.map(x=>`<tr><td>${esc(store.servers.find(s=>s.id===x.target)?.name||x.target)}</td><td><small>${esc(({icmp:'Ping',tcp:'TCP 建连','ssh-banner':'SSH 后端响应',traceroute:'线路分析'})[x.method]||x.method)}${x.entryOnly?' · 仅入口':''}</small>${esc(x.error||(x.kind==='route'?(x.networks?.join(' → ')||'未识别；可展开原始跳点'):x.rtt==null?'未响应':fmtMs(x.rtt)))}${x.raw?`<details><summary>跳点</summary><pre>${esc(x.raw)}</pre></details>`:''}</td></tr>`).join('')}</tbody></table></details>`).join('')||'<p class="hint">尚无设备测量。VPS 之间互测仍在“后台测量”中单独执行。</p>';
 }
 m.el.addEventListener('click',e=>{if(e.target.closest('[data-copy-command]')){copyCommand();return;}const b=e.target.closest('[data-map]');if(b){setRouteOrigin('device:'+b.dataset.map);setView({mode:'route',showLinks:true});m.close();}});
 const off=store.on('data',render);render();
}
