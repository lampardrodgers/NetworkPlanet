// 只迁移显示和测试选项；不复制登录 Token、任务 Token、设备身份、位置或物理网卡。
export function portablePreferences(raw={}) {
  const out={};
  const v=raw['np.view'];
  if(v&&typeof v==='object'){
    const view={};if(['flat','globe','route'].includes(v.mode))view.mode=v.mode;
    for(const k of ['flatLocked','autoRotate','expandCities','showLinks','showMesh','showLinkLabels','showLabels'])if(typeof v[k]==='boolean')view[k]=v[k];
    out['np.view']=view;
  }
  const r=raw['np.routes'];if(r&&typeof r==='object')out['np.routes']={suggest:r.suggest!==false,sourceVisible:r.sourceVisible!==false};
  if(['city','provider','tag','none'].includes(raw['np.group']))out['np.group']=raw['np.group'];
  const d=raw['np.deviceConfig'];if(d&&typeof d==='object'){
    const prefs={};if(['latency','route','both'].includes(d.kind))prefs.kind=d.kind;for(const k of ['trace','routeAnalysis'])if(typeof d[k]==='boolean')prefs[k]=d[k];
    if(Array.isArray(d.scope))prefs.scope=d.scope.filter(x=>typeof x==='string'&&/^[\w-]{1,64}$/.test(x)).slice(0,500);
    out['np.deviceConfig']=prefs;
  }
  return out;
}
