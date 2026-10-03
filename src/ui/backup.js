import {api} from '../api.js';
import {$,openModal,toast} from './dom.js';
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
export function openBackup({parseImport}={}) {
  let selected=null;
  const m=openModal({title:'导入 / 导出',wide:true,content:`
    <div class="backup-panel">
      <p class="hint backup-intro">把配置文件传到另一套 Network Planet，即可继续使用。同一网站的设备已共享配置。</p>
      <div class="backup-grid">
        <section class="backup-card">
          <h4>导出配置</h4><p class="hint">包含 VPS、线路、登录凭据和测量记录。</p>
          <label class="backup-field">密码 <span class="muted">可选</span><input class="input" type="password" data-export-password autocomplete="new-password" placeholder="留空不加密" /></label>
          <p class="hint">不设密码时，文件内的登录凭据可直接读取。</p>
          <details class="backup-options"><summary>更多选项</summary>
            <label class="check"><input type="checkbox" data-history checked /> 包含测量历史</label>
            <label class="check"><input type="checkbox" data-basic /> 仅导出节点清单，不含登录信息</label>
          </details>
          <button class="btn primary" data-export-full>导出文件</button>
        </section>
        <section class="backup-card">
          <h4>导入配置</h4><p class="hint">选择文件，已有节点自动更新，新节点自动添加。</p>
          <div class="backup-file-row"><button type="button" class="btn" data-choose-file>选择文件</button><span data-filename>未选择文件</span></div>
          <input type="file" class="hidden" data-backup-file accept=".json,.csv,.txt" aria-label="导入配置文件" />
          <label class="backup-field hidden" data-import-password-label>文件密码<input class="input" type="password" data-import-password autocomplete="off" placeholder="输入导出时设置的密码" /></label>
          <details class="backup-options"><summary>更多选项</summary>
            <label class="check"><input type="checkbox" data-mirror /> 完全替换现有节点（同时同步删除）</label>
            <label class="check"><input type="checkbox" data-keep /> 相同节点保留此处配置</label>
            <label class="check"><input type="checkbox" data-import-history checked /> 导入测量历史</label>
            <label class="check"><input type="checkbox" data-settings checked /> 导入测试选项</label>
            <label class="check"><input type="checkbox" data-browser /> 恢复显示偏好</label>
          </details>
          <button class="btn primary" data-import-full disabled>导入文件</button>
          <p class="hint">导入前显示变更摘要，自动保存回滚文件。不会启动测试。</p>
        </section>
      </div>
      <p role="status" class="backup-message" data-message></p><div data-backup-result></div>
    </div>`});
  const el=m.el,message=$('[data-message]',el),importButton=$('[data-import-full]',el);
  const options=()=>({mode:$('[data-mirror]',el).checked?'mirror':'merge',conflict:$('[data-keep]',el).checked?'keep':'incoming',history:$('[data-import-history]',el).checked,settings:$('[data-settings]',el).checked,browser:$('[data-browser]',el).checked});
  const alive=()=>document.body.contains(el);
  let working=false;
  async function run(fn){
    if(working)return;working=true;message.classList.remove('err');message.textContent='处理中…';
    const controls=[...el.querySelectorAll('input,button')].filter(x=>!x.matches('[data-close]'));controls.forEach(x=>x.disabled=true);
    try{await fn();}catch(e){message.classList.add('err');message.textContent=e.message;}
    finally{working=false;if(alive()){controls.forEach(x=>x.disabled=false);importButton.disabled=!selected;syncOptions();}}
  }
  function syncOptions(){
    const basic=$('[data-basic]',el).checked;
    $('[data-export-password]',el).disabled=basic;
    $('[data-history]',el).disabled=basic;
    $('[data-keep]',el).disabled=$('[data-mirror]',el).checked;
  }
  $('[data-basic]',el).addEventListener('change',syncOptions);
  $('[data-mirror]',el).addEventListener('change',syncOptions);
  $('[data-choose-file]',el).addEventListener('click',()=>$('[data-backup-file]',el).click());
  $('[data-backup-file]',el).addEventListener('change',async e=>{
    selected=null;importButton.disabled=true;message.textContent='';$('[data-import-password-label]',el).classList.add('hidden');$('[data-import-password]',el).value='';
    const f=e.target.files[0];$('[data-filename]',el).textContent=f?.name||'未选择文件';
    try {
      if(!f)return;if(f.size>9*1024*1024)throw new Error('文件超过 9 MiB');
      const text=await f.text();let data;try{data=JSON.parse(text);}catch{}
      if(['network-planet-backup','network-planet-encrypted'].includes(data?.format))selected={data,full:true,name:f.name};
      else {const legacy=parseImport(text);if(!legacy.servers?.length)throw new Error('文件内没有节点');selected={data:legacy,full:false,name:f.name};}
      $('[data-import-password-label]',el).classList.toggle('hidden',data?.format!=='network-planet-encrypted');
      importButton.disabled=false;
    }catch(e){message.classList.add('err');message.textContent=e.message;}
  });
  $('[data-export-full]',el).addEventListener('click',()=>run(async()=>{
    const basic=$('[data-basic]',el).checked;
    const r=basic?{file:await api('GET','/api/export'),warnings:[]}:await api('POST','/api/backups/export',{password:$('[data-export-password]',el).value,history:$('[data-history]',el).checked,browser:browserPreferences()});
    download(r.file,`network-planet-${basic?'nodes':'full'}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    message.textContent='文件已导出。';
    $('[data-backup-result]',el).innerHTML=r.warnings.length?`<details open><summary>部分内容需要补充</summary>${r.warnings.map(x=>`<p class="hint">${esc(x)}</p>`).join('')}</details>`:'';
  }));
  function showPreview(summary){
    return new Promise(resolve=>{
      let accepted=false;
      const counts=summary.rows.reduce((a,r)=>(a[r.action]=(a[r.action]||0)+1,a),{});
      const preview=openModal({title:'确认导入',content:`<p>${Object.entries(counts).map(([action,n])=>esc(action)+' '+n+' 个节点').join('，')}。</p><p class="hint">${summary.mode==='mirror'?'将完全替换节点配置。':'目标端独有的节点会保留。'}自动测试保持关闭。</p><details class="backup-options"><summary>查看变更详情</summary><div class="backup-preview">${summary.rows.map(r=>`<p>${esc(r.action)} · ${esc(r.name)}</p>`).join('')}${(summary.warnings||[]).map(x=>`<p class="hint">${esc(x)}</p>`).join('')}</div></details><div class="form-actions"><button class="btn" data-close>取消</button><button class="btn ${summary.mode==='mirror'?'danger':'primary'}" data-confirm-import>确认导入</button></div>`,onClose:()=>resolve(accepted)});
      $('[data-confirm-import]',preview.el).addEventListener('click',()=>{accepted=true;preview.close();});
    });
  }
  importButton.addEventListener('click',()=>run(async()=>{
    if(!selected)throw new Error('请先选择文件');
    const source=selected,opts=options();
    const request={file:source.data,password:source.data.format==='network-planet-encrypted'?$('[data-import-password]',el).value:'',options:opts};
    const summary=await api('POST',source.full?'/api/backups/preview':'/api/backups/basic-preview',source.full?request:{data:source.data,options:opts});
    if(!alive())return;
    if(!(await showPreview(summary))||!alive()){message.textContent='已取消，配置未修改。';return;}
    const r=await api('POST',source.full?'/api/backups/apply':'/api/backups/basic-apply',source.full?{...request,revision:summary.revision,currentBrowser:browserPreferences()}:{data:source.data,options:opts,revision:summary.revision,currentBrowser:browserPreferences()});
    let prefsError='';if(r.browser)try{restorePreferences(r.browser);}catch{prefsError=' 显示偏好未能保存。';}
    message.textContent='导入完成。'+prefsError;
    $('[data-backup-result]',el).innerHTML='<div class="row-actions"><button class="btn" data-rollback-download>下载导入前的配置</button><button class="btn primary" data-reload>刷新查看</button></div>';
    $('[data-rollback-download]',el).addEventListener('click',()=>run(async()=>{download(await api('GET','/api/backups/rollback/'+r.rollbackId),'network-planet-rollback-'+r.rollbackId+'.json');message.textContent='已下载导入前的配置。';}));
    $('[data-reload]',el).addEventListener('click',()=>location.reload());
    toast('配置已导入，未启动测试','ok');
  }));
}
