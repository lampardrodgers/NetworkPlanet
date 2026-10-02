import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('自动轮次：首次等待、无重叠、休眠不补跑、关闭取消；新节点不扩张范围',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'np-schedule-test-'));process.env.NP_DATA_DIR=dir;process.env.NP_MODE='local';
 const {db}=await import('../server/store.js');const engine=await import('../server/local/engine.js');
 db.servers=[{id:'a',name:'A'},{id:'b',name:'B'}];db.localProfiles={a:{methods:[]},b:{methods:[]}};
 const original={setTimeout:global.setTimeout,clearTimeout:global.clearTimeout,now:Date.now};let now=100000, timers=[];
 global.setTimeout=(fn,ms)=>{const t={fn,ms,cleared:false,unref(){return this;}};timers.push(t);return t;};global.clearTimeout=t=>{if(t)t.cleared=true;};Date.now=()=>now;
 const scheduled=()=>timers.filter(t=>t.ms===60000&&!t.cleared).at(-1);
 const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
 try{
  engine.configureMeasurement({mode:'auto',intervalSec:60,scope:['a']});assert.equal(engine.getMeasurement().active,null);assert.equal(engine.getMeasurement().nextAt,160000);
  assert.deepEqual(engine.getMeasurement().config.scope,['a']);
  const first=scheduled();now=160000;first.cleared=true;first.fn();assert.ok(engine.getMeasurement().active);await settle();assert.equal(engine.getMeasurement().active,null);assert.equal(engine.getMeasurement().lastRound.startedAt,160000);
  // 手动轮正在执行时，自动计时到达也不新开轮次。
  now=220000;const manual=engine.startRound({scope:['a']});const t=scheduled();t.cleared=true;t.fn();assert.equal(engine.getMeasurement().active.id,manual.id);await settle();
  const last=engine.getMeasurement().lastRound.id;
  now=500000;const late=scheduled();late.cleared=true;late.fn();await settle();assert.equal(engine.getMeasurement().lastRound.id,last);assert.equal(engine.getMeasurement().nextAt,560000);
  engine.configureMeasurement({mode:'manual'});assert.equal(engine.getMeasurement().nextAt,null);assert.equal(scheduled(),undefined);
  engine.configureMeasurement({routeAnalysis:{enabled:true}});assert.equal(engine.getMeasurement().nextAt,null);
 }finally{engine.shutdownMeasurement();global.setTimeout=original.setTimeout;global.clearTimeout=original.clearTimeout;Date.now=original.now;fs.rmSync(dir,{recursive:true,force:true});}
});
