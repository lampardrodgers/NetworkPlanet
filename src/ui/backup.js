import {api} from '../api.js';
import {$,openModal,toast,confirmDialog} from './dom.js';
import {esc} from '../format.js';
import {portablePreferences} from '../../shared/backup-preferences.js';

function browserPreferences(){
  const data={};
  for(const key of ['np.view','np.routes','np.group','np.deviceConfig']){
    try{const s=localStorage.getItem(key);if(s)data[key]=key==='np.group'?s:JSON.parse(s);}catch{}
  }
  return portablePreferences(data);
}
function restorePreferences(data){
  for(const [key,value] of Object.entries(portablePreferences(data))){
    const previous=key==='np.group'?null:JSON.parse(localStorage.getItem(key)||'{}');
    localStorage.setItem(key,key==='np.group'?value:JSON.stringify({...previous,...value}));
  }
}
function download(data,name){
  const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function openBackup(){
  let file=null,revision=null;
  const m=openModal({title:'加密完整备份 / 同步',wide:true,content:`
    <p>将节点、连接、线路、SSH / VLESS 凭据、可读取的私钥及测量记录，保存为密码保护的备份。其他设备导入后可继续更新同一批节点。</p>
    <p class="hint">同一个网站的配置已经共享。导入会修改当前网站的服务端配置。独立部署时，才需要将备份导入另一套服务。</p>
    <div class="form">
      <label>备份密码（至少 12 个字符）<input class="input" type="password" data-password autocomplete="new-password" placeholder="导出时设置，导入时填写原密码" /></label>
      <p class="hint">请自行保管密码，系统不保存密码，也无法找回。网站登录密码不包含在备份内。</p>
      <h4>导出</h4>
      <label class="check"><input type="checkbox" data-history checked /> 包含历史测量结果</label>
      <button class="btn primary" data-export-full>下载加密备份</button>
      <h4>导入与同步</h4>
      <label>选择加密备份<input class="input" type="file" data-backup-file accept=".json" /></label>
      <label>同步方式<select class="input" data-mode><option value="merge">合并更新：保留目标端独有节点</option><option value="mirror">覆盖同步：节点与备份一致，移除目标端独有节点</option></select></label>
      <label>相同 ID 的配置<select class="input" data-conflict><option value="incoming">使用备份中的配置与凭据</option><option value="keep">保留目标端配置与凭据（仅合并模式）</option></select></label>
      <label class="check"><input type="checkbox" data-settings checked /> 导入测试选项、周期和节点范围（自动测试保持关闭）</label>
      <label class="check"><input type="checkbox" data-import-history checked /> 合并历史结果，保留原测量设备来源</label>
      <label class="check"><input type="checkbox" data-browser /> 恢复本浏览器的显示偏好与测试选项</label>
      <p class="hint">保留目标端设备身份、网卡、位置、登录权限和网站地址。SSH 私钥使用新的受限存储路径；主机指纹随配置迁移。不会安装软件或修改系统网络。旧探针的时序文件和系统服务配置不属于此备份。</p>
      <div class="row-actions"><button class="btn" data-preview>检查备份并预览</button><button class="btn primary" data-apply disabled>确认导入</button></div>
      <p class="err" role="status" data-message></p><div data-preview-result></div><div data-backup-result></div>
    </div>`});
  const el=m.el, message=$('[data-message]',el),apply=$('[data-apply]',el);
  const opts=()=>({mode:$('[data-mode]',el).value,conflict:$('[data-conflict]',el).value,settings:$('[data-settings]',el).checked,history:$('[data-import-history]',el).checked,browser:$('[data-browser]',el).checked});
  const password=()=>$('[data-password]',el).value;
  const invalidate=()=>{revision=null;apply.disabled=true;$('[data-preview-result]',el).textContent='';};
  for(const selector of ['[data-password]','[data-mode]','[data-conflict]','[data-settings]','[data-import-history]','[data-browser]'])$(selector,el).addEventListener('input',invalidate);
  $('[data-mode]',el).addEventListener('change',()=>{$('[data-conflict]',el).disabled=$('[data-mode]',el).value==='mirror';});
  $('[data-backup-file]',el).addEventListener('change',async e=>{
    invalidate();file=null;message.textContent='';
    try{const f=e.target.files[0];if(!f)return;if(f.size>9*1024*1024)throw new Error('备份文件超过 9 MiB');file=JSON.parse(await f.text());if(file.format!=='network-planet-encrypted')throw new Error('请选择加密完整备份；普通 JSON 请使用基础导入。');}
    catch(x){file=null;message.textContent=x.message;}
  });
  async function run(button,fn){button.disabled=true;message.textContent='处理中…';try{await fn();}catch(e){message.textContent=e.message;}finally{if(document.body.contains(el))button.disabled=false;}}
  $('[data-export-full]',el).addEventListener('click',e=>run(e.currentTarget,async()=>{
    const r=await api('POST','/api/backups/export',{password:password(),history:$('[data-history]',el).checked,browser:browserPreferences()});
    download(r.file,`network-planet-full-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    message.textContent='加密备份已生成。'+(r.warnings.length?' 以下项目需注意：':'');
    $('[data-backup-result]',el).innerHTML=r.warnings.map(x=>`<p class="hint">${esc(x)}</p>`).join('');
  }));
  $('[data-preview]',el).addEventListener('click',e=>run(e.currentTarget,async()=>{
    invalidate();if(!file)throw new Error('请先选择备份文件');
    const r=await api('POST','/api/backups/preview',{file,password:password(),options:opts()});revision=r.revision;
    $('[data-preview-result]',el).innerHTML=`<p>来自 ${esc(r.host)} · ${esc(r.exportedAt)}。导入后共 ${r.counts.servers} 个节点、${r.counts.profiles} 份连接档案、${r.counts.routes} 条线路、${r.counts.keys} 份私钥、${r.counts.passwords} 份 SSH 密码、${r.counts.vless} 条 VLESS 凭据。</p><div style="max-height:230px;overflow:auto"><table class="table"><thead><tr><th>节点</th><th>操作</th></tr></thead><tbody>${r.rows.map(row=>`<tr><td>${esc(row.name)}</td><td>${esc(row.action)}</td></tr>`).join('')}</tbody></table></div>${r.warnings.map(x=>`<p class="hint">${esc(x)}</p>`).join('')}`;
    apply.disabled=false;message.textContent='检查完成，尚未修改配置。确认导入前会自动保存加密回滚备份。';
  }));
  apply.addEventListener('click',async e=>{
    if(!revision)return;
    if(!(await confirmDialog(opts().mode==='mirror'?'按预览覆盖同步节点与连接凭据，移除目标端独有节点。继续？':'按预览合并节点与连接凭据，并暂停自动测试。继续？',{okText:'确认导入',danger:opts().mode==='mirror'})))return;
    await run(e.currentTarget,async()=>{
      const r=await api('POST','/api/backups/apply',{file,password:password(),options:opts(),revision,currentBrowser:browserPreferences()});
      revision=null;apply.disabled=true;
      let prefsError='';if(r.browser)try{restorePreferences(r.browser);}catch{prefsError=' 浏览器偏好未能写入，但服务端配置已导入。';}
      message.textContent='导入完成，未启动网络测试。'+prefsError;
      $('[data-backup-result]',el).innerHTML='<button class="btn" data-rollback-download>下载导入前的回滚备份</button> <button class="btn primary" data-reload>刷新查看</button><p class="hint">回滚备份使用本次导入的密码。需要撤销时，将它作为备份再次导入。</p>';
      $('[data-rollback-download]',el).addEventListener('click',e=>run(e.currentTarget,async()=>{download(await api('GET','/api/backups/rollback/'+r.rollbackId),'network-planet-rollback-'+r.rollbackId+'.json');message.textContent='已下载回滚备份。';}));
      $('[data-reload]',el).addEventListener('click',()=>location.reload());
      toast('完整配置已导入，自动测试保持关闭','ok');
    });
    if(!revision)apply.disabled=true;
  });
}
