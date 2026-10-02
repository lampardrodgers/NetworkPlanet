import test from 'node:test';
import assert from 'node:assert/strict';
import {localMeasuredEdges} from '../src/local-edges.js';
import {placeNodeLabel} from '../src/globe/labels.js';
import {showLinkLabel} from '../src/link-labels.js';
test('互测保留方向、最新失败覆盖旧成功、不编造反向结果',()=>{
 const servers=[{id:'a'},{id:'b'}];
 const sample={source:'a',target:'b',kind:'latency',method:'icmp'};
 const edges=localMeasuredEdges([], [{...sample,state:'ok',rtt:12,finishedAt:1},{...sample,state:'error',finishedAt:2}],servers);
 assert.equal(edges.length,1);assert.equal(edges[0].a,'a');assert.equal(edges[0].b,'b');assert.equal(edges[0].measured,null);assert.equal(edges[0].estimate,null);
 assert.equal(showLinkLabel(edges[0],true),true);assert.equal(showLinkLabel(edges[0],false),false);
});
test('重叠节点标签保留且移到视口内',()=>{
 const a={x:100,y:100,w:150,h:30};const b=placeNodeLabel(a,[a],600,400);
 assert.ok(b.x>=8&&b.y>=8&&b.x+b.w<=592&&b.y+b.h<=392);
 assert.ok(b.x+b.w<=a.x||b.x>=a.x+a.w||b.y+b.h<=a.y||b.y>=a.y+a.h);
});
