// 将已完成的有向测量叠加到地图；这里只读取结果，不启动任何测试。
export function localMeasuredEdges(base, results, servers) {
  const ids=new Set(servers.map(s=>s.id));
  const edges=new Map(base.map(e=>[`${e.a}>${e.b}`,e]));
  const latest=new Map();
  for(const r of results){
    if(r.kind!=='latency'||!(r.source==='local'||ids.has(r.source))||!ids.has(r.target)||r.source===r.target||!['icmp','tcp','ssh-banner'].includes(r.method))continue;
    const key=`${r.source==='local'?'@origin':r.source}>${r.target}`;
    if(!latest.has(key)||(r.finishedAt||0)>(latest.get(key).finishedAt||0))latest.set(key,r);
  }
  for(const [key,r] of latest){
    const prior=edges.get(key);
    const ok=r.state==='ok'&&Number.isFinite(r.rtt);
    edges.set(key,{...prior,key,a:r.source==='local'?'@origin':r.source,b:r.target,kind:'mesh',estimate:null,
      measured:ok?{rtt:r.rtt,loss:r.loss??0}:null,
      statusText:ok?null:r.state==='cancelled'?'已取消':'测试失败',
      link:{...prior?.link,label:prior?.link?.label||(r.segment==='frpc-frps'?'frp':'直连'),compact:true},
      dests:new Set([r.target]),hit:{type:'server',id:r.target}});
  }
  return [...edges.values()];
}
