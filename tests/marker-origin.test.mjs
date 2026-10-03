import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
// 单元测试不加载浏览器专用的地球贴图 JSON；保留实际坐标换算和标记实现。
const hook=registerHooks({load(url,context,next){
 const loaded=next(url,context);
 if(url===new URL('../src/globe/Globe.js',import.meta.url).href)return {...loaded,source:String(loaded.source).replace("import { drawEarthCanvas, vectorLines } from './earthTexture.js';",'')};
 return loaded;
}});
const {Markers}=await import('../src/globe/Markers.js');
const {latLonToVec3}=await import('../src/globe/Globe.js');
hook.deregister();

test('地球起点切换从洛杉矶到杭州时同时更新地理坐标和成员连线锚点',()=>{
 const disposed=[];
 const markers=Object.assign(Object.create(Markers.prototype),{
  sites:new Map(),members:new Map(),
  createSite(id,g){return {id,lat:g.lat,lon:g.lon,center:latLonToVec3(g.lat,g.lon),servers:[]};},
  createMember(server,site){return {server,site,pos:site.center.clone()};},
  disposeSite(site){disposed.push(site);},disposeMember(){},refreshStatus(){},
 });
 const origin={id:'@origin',name:'本机',isOrigin:true,lat:34.05,lon:-118.24};
 markers.setData([origin],{});const first=markers.sites.get('site:origin');
 markers.setData([{...origin,lat:30.2741,lon:120.1551}],{});
 const next=markers.sites.get('site:origin');assert.notEqual(next,first);assert.equal(disposed.length,1);
 assert.equal(next.lat,30.2741);assert.equal(next.lon,120.1551);
 assert.ok(markers.members.get('@origin').pos.distanceTo(latLonToVec3(30.2741,120.1551))<1e-10);
 markers.setData([{...origin,lat:30.2741,lon:120.1551}],{});assert.equal(markers.sites.get('site:origin'),next);
 markers.setData([origin],{});assert.equal(markers.sites.get('site:origin').lon,-118.24);
});
