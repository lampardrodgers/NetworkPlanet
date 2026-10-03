// 延迟与线路可分开执行；最新线路轮次不能抹掉最近的延迟轮次。
export function deviceResults(runs, id) {
 const own=(runs||[]).filter(r=>r.deviceId===id);
 const latency=own.filter(r=>r.kind!=='route').at(-1);
 const route=own.filter(r=>r.kind==='route'||r.kind==='both'||r.results.some(x=>x.kind==='route')).at(-1);
 return [...(latency?.results||[]).filter(r=>r.kind==='latency'),...(route?.results||[]).filter(r=>r.kind==='route')];
}
export function preferredLatency(results,target){
 const priority=['icmp','ssh-banner','tcp'];
 const candidates=results.filter(r=>r.target===target&&r.kind==='latency'&&!r.entryOnly);
 return candidates.filter(r=>r.state==='ok').sort((a,b)=>priority.indexOf(a.method)-priority.indexOf(b.method))[0]||candidates[0]||null;
}
