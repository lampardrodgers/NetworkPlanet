import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceTests} from '../server/local/device-tests.js';
const setup=()=>{const db={servers:[{id:'a',name:'A',ip:'8.8.8.8'},{id:'b',name:'FRP'},{id:'off',name:'Off',ip:'1.1.1.1'}],localProfiles:{off:{disabled:true}},localResults:{keep:1}};return {db,api:deviceTests(db,()=>{})};};
const request={deviceId:'device-12345',name:'Mac test',scope:['a','b','off'],os:'mac',trace:true};
const decode=t=>JSON.parse(Buffer.from(t.script.match(/MANIFEST = '([^']+)'/)[1],'base64'));
test('明确的测试内容决定任务：延迟、线路、两者；旧 trace 只用于兼容无 kind 请求',()=>{
 for(const [kind,trace,latency] of [['latency',false,true],['route',true,false],['both',true,true]]){
  const {api,db}=setup();const t=api.create({...request,kind,trace:!trace}),m=decode(t);
  assert.equal(m.kind,kind);assert.equal(m.trace,trace);assert.equal(m.targets[0].latency,latency);
  assert.deepEqual(t.counts,{latency:latency?1:0,route:trace?1:0});assert.equal(t.kind,kind);
  api.accept({id:t.id,token:t.token,results:[{target:'a',proof:'mac-bound',samples:latency?[10,12,14]:[],...(trace?{trace:'1 8.8.8.8'}:{})}]});
  assert.deepEqual(db.deviceRuns[0].results.map(r=>r.kind),[...(latency?['latency']:[]),...(trace?['route']:[])]);
 }
 assert.equal(decode(setup().api.create(request)).kind,'both');
});
test('一次性脚本不含管理凭据、跳过内网/停用节点',()=>{
 const {api}=setup();const t=api.create(request),m=decode(t);
 assert.equal(m.targets.length,1);assert.equal(t.skipped.length,2);assert.equal(m.token.length,64);
 assert.ok(!t.script.includes('sshPassword'));assert.ok(!JSON.stringify(api.list()).includes(m.token));
});
test('上传授权、范围、单次提交和设备隔离',()=>{
 const {db,api}=setup();const m=decode(api.create(request));
 const base={id:m.id,token:m.token,results:[{target:'a',samples:[10,12,14],proof:'mac-bound',interface:'en0',trace:'1 59.43.1.1\n2 8.8.8.8'}]};
 assert.throws(()=>api.accept({...base,token:'bad'}),e=>e.status===401);
 assert.throws(()=>api.accept({...base,results:[{...base.results[0],target:'unknown'}]}));
 assert.deepEqual(api.accept(base),{ok:true});assert.equal(db.deviceRuns[0].results[0].rtt,12);assert.equal(db.deviceRuns[0].results[0].source,'device:device-12345');
 assert.deepEqual(db.localResults,{keep:1});assert.throws(()=>api.accept(base),e=>e.status===409);
});
test('没有直连证据不接收成功；校验失败清空延迟',()=>{
 const {db,api}=setup();const m=decode(api.create(request));
 assert.throws(()=>api.accept({id:m.id,token:m.token,results:[{target:'a',samples:[3]}]}));
 api.accept({id:m.id,token:m.token,results:[{target:'a',samples:[3],error:'VPN route blocked'}]});
 assert.equal(db.deviceRuns[0].results[0].rtt,null);assert.equal(db.deviceRuns[0].results[0].state,'blocked');
});
test('非公网目标、重复结果、异常样本拒绝；令牌到期拒绝',()=>{
 const {db,api}=setup();db.servers.push({id:'private',ip:'192.168.1.1'});
 assert.throws(()=>api.create({...request,scope:['private']}));
 const m=decode(api.create(request)),r={target:'a',samples:[2],proof:'mac-bound'};
 assert.throws(()=>api.accept({id:m.id,token:m.token,results:[r,r]}));
 assert.throws(()=>api.accept({id:m.id,token:m.token,results:[{...r,samples:[-2]}]}));
 const original=Date.now;try{Date.now=()=>m.expiresAt+1;assert.throws(()=>api.accept({id:m.id,token:m.token,results:[]}),e=>e.status===401);}finally{Date.now=original;}
});
test('地图起点只读取该设备最新轮次，不补入后台或旧设备数据',async()=>{
 const {store}=await import('../src/state.js');const {routePlan}=await import('../src/routes.js');
 store.localMode=true;store.servers=[{id:'a',ip:'8.8.8.8',name:'A',lat:1,lon:2},{id:'b',name:'B',lat:3,lon:4}];store.routes=[];
 store.status.local={profiles:{},results:[{source:'local',target:'a',kind:'latency',method:'icmp',state:'ok',rtt:1,address:'8.8.8.8'}]};
 store.deviceRuns=[{deviceId:'x',name:'X',results:[{target:'b',kind:'latency',state:'ok',rtt:22}]},{deviceId:'x',name:'X',results:[{target:'a',kind:'latency',state:'ok',rtt:99}]}];
 const plan=routePlan('device:x');assert.equal(plan.rows.find(r=>r.to==='a').path.total,99);assert.equal(plan.rows.find(r=>r.to==='b').path.total,null);
});
test('取脚本仅接受本轮有效令牌，内容固定，上传后失效',()=>{
 const {api}=setup(),t=api.create(request),m=decode(t);
 assert.throws(()=>api.fetchScript({id:t.id,token:'bad'}),e=>e.status===401);
 assert.equal(api.fetchScript({id:t.id,token:t.token,scope:['evil']}).script,t.script);
 api.accept({id:t.id,token:t.token,results:[]});
 assert.throws(()=>api.fetchScript({id:t.id,token:t.token}),e=>e.status===409);
 const next=api.create(request),now=Date.now;try{Date.now=()=>next.expiresAt+1;assert.throws(()=>api.fetchScript({id:next.id,token:next.token}),e=>e.status===401);}finally{Date.now=now;}
});
test('设备继承节点方法与公网入口；只下发探测所需字段',()=>{
 const {db,api}=setup();db.localProfiles.b={methods:['ssh-banner','tcp'],endpoint:{host:'1.1.1.1',port:2222},ssh:{password:'DO_NOT_SEND'},vless:'DO_NOT_SEND'};
 const t=api.create({...request,directInterface:'en0'}),m=decode(t);
 assert.equal(m.directInterface,'en0');assert.deepEqual(m.targets.filter(x=>x.id==='b').map(x=>x.method),['ssh-banner','tcp']);
 assert.ok(!t.script.includes('DO_NOT_SEND'));
 api.accept({id:t.id,token:t.token,results:[{target:'b',method:'ssh-banner',samples:[21],proof:'mac-bound'},{target:'b',method:'tcp',samples:[5],proof:'mac-bound'}]});
 assert.equal(db.deviceRuns[0].results.find(r=>r.method==='ssh-banner').rtt,21);assert.equal(db.deviceRuns[0].results.find(r=>r.method==='tcp').entryOnly,true);
});
test('只测线路保留延迟轮次；VPS 起点状态不混用后台延迟',async()=>{
 const {deviceResults,preferredLatency}=await import('../shared/device-results.js');
 const runs=[{deviceId:'x',kind:'latency',results:[{target:'a',kind:'latency',method:'icmp',state:'ok',rtt:99}]},{deviceId:'x',kind:'route',results:[{target:'a',kind:'route',state:'ok',networks:['CN2']}]}];
 assert.equal(preferredLatency(deviceResults(runs,'x'),'a').rtt,99);assert.equal(deviceResults(runs,'x').length,2);
 const {store,statusOf}=await import('../src/state.js');store.localMode=true;store.activeOrigin='vps1';store.status.servers={a:{hubRtt:2}};store.status.local={results:[{source:'vps1',target:'a',kind:'latency',method:'icmp',state:'ok',rtt:55}]};assert.equal(statusOf('a').hubRtt,55);assert.equal(statusOf('b').hubRtt,null);store.activeOrigin='local';assert.equal(statusOf('a').hubRtt,2);
});
test('纯线路任务不能伪造延迟；位置只修改选中设备',()=>{
 const {db,api}=setup(),t=api.create({...request,kind:'route'}),m=decode(t);
 assert.equal(m.targets[0].latency,false);
 api.accept({id:t.id,token:t.token,results:[{target:'a',method:'icmp',proof:'mac-bound',samples:[],trace:'1 59.43.1.1\n2 8.8.8.8'}]});
 assert.deepEqual(db.deviceRuns[0].results.map(r=>r.kind),['route']);
 api.location({deviceId:request.deviceId,lat:30,lon:120});assert.equal(db.deviceRuns[0].lat,30);assert.throws(()=>api.location({deviceId:request.deviceId,lat:300,lon:120}));
});
