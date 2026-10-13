import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../apps/api/dist/app.js';

async function setup(behavior) {
  const requests=[];
  const model={name:'test-agent',complete:async req=>{requests.push(req);const a=req.agent;
    if(!a.tools.read_busy)return {action:'read_busy'};
    if(!a.tools.read_preferences)return {action:'read_preferences'};
    return behavior(a);
  }};
  const app=await createApp({storage:'memory',authMode:'demo',secretary:{mode:'http',model}});
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{
    const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const data=res.status===204?null:await res.json();return {status:res.status,data};
  };
  const a=(await call('/dev/sessions',null,{name:'甲'})).data.token,b=(await call('/dev/sessions',null,{name:'乙'})).data.token,c=(await call('/dev/sessions',null,{name:'外人'})).data.token;
  const day=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const room=(await call('/roundtables',a,{title:'课程讨论',goal:'确定小组讨论时间',dateFrom:day,dateTo:day,startTime:'09:00',endTime:'18:00',durationMinutes:60})).data;
  await call('/roundtables/join',b,{code:room.inviteCode});
  for(const [token,label] of [[a,'A_PRIVATE'],[b,'B_PRIVATE']]) {
    await call('/me/memories',token,{category:'PREFERENCE',label:'偏好',content:label});
    await call(`/roundtables/${room.id}/membership`,token,{shareBusy:true},'PUT');
  }
  const root=`/roundtables/${room.id}`;
  const authorize=async()=>{for(const token of [a,b])assert.equal((await call(root+'/agents/consent',token,{enabled:true},'PUT')).status,200);};
  const wait=async()=>{for(let i=0;i<100;i++){const state=(await call(root+'/agents',a)).data;if(state.run?.status!=='RUNNING')return state;await new Promise(r=>setTimeout(r,10));}throw Error('协商超时');};
  return {app,call,a,b,c,root,day,requests,authorize,wait};
}
const answer=(a,choice)=>({action:'answer',choice,decision:choice===a.offer?'accept':'counter'});
test('两位Agent调用工具并根据对方反馈调整；私有数据隔离且全员确认才入库',async()=>{
  const s=await setup(a=>answer(a,a.tools.read_preferences.some(p=>p.content==='B_PRIVATE')?1:(a.offer??0)));
  try{
    assert.equal((await s.call(s.root+'/agents',s.c)).status,404);
    assert.equal((await s.call(s.root+'/agents/start',s.a,{})).status,400);
    await s.authorize();
    assert.equal((await s.call(s.root+'/agents/start',s.b,{})).status,403);
    const starts=await Promise.all([s.call(s.root+'/agents/start',s.a,{}),s.call(s.root+'/agents/start',s.a,{})]);assert.ok(starts.some(r=>r.status===201));assert.ok(starts.every(r=>r.status===201||r.status===429));
    const state=await s.wait();assert.equal(state.run.status,'READY');
    assert.equal(s.requests.length,12);
    assert.ok(state.run.events.some(e=>e.round===2));
    const shared=JSON.stringify(state);assert.ok(!shared.includes('A_PRIVATE'));assert.ok(!shared.includes('B_PRIVATE'));
    for(const req of s.requests) {const text=JSON.stringify(req);assert.ok(!(text.includes('A_PRIVATE')&&text.includes('B_PRIVATE')));assert.ok(!text.includes(s.a));}
    assert.deepEqual((await s.call('/me/arrangements',s.a)).data,[]);
    const proposal=(await s.call(s.root+'/proposal',s.a)).data;assert.ok(proposal.votes.every(v=>v.decision==='PENDING'));
    await s.call(s.root+'/proposals/'+proposal.id,s.a,{decision:'ACCEPT'},'PUT');
    assert.deepEqual((await s.call('/me/arrangements',s.a)).data,[]);
    await s.call(s.root+'/proposals/'+proposal.id,s.b,{decision:'ACCEPT'},'PUT');
    assert.equal((await s.call('/me/arrangements',s.a)).data.length,1);assert.equal((await s.call('/me/arrangements',s.b)).data.length,1);
  }finally{await s.app.close();}
});
test('三轮仍有分歧不创建方案；工具越权动作失败不写入',async()=>{
  const s=await setup(a=>answer(a,a.tools.read_preferences.some(p=>p.content==='B_PRIVATE')?1:0));
  try{await s.authorize();await s.call(s.root+'/agents/start',s.a,{});const state=await s.wait();assert.equal(state.run.status,'NO_AGREEMENT');assert.equal(Math.max(...state.run.events.map(e=>e.round)),3);assert.equal((await s.call(s.root+'/proposal',s.a)).status,204);}finally{await s.app.close();}
  const bad=await setup(()=>({action:'delete_schedule',userId:'another-user'}));
  try{await bad.authorize();await bad.call(bad.root+'/agents/start',bad.a,{});assert.equal((await bad.wait()).run.status,'FAILED');assert.deepEqual((await bad.call('/me/arrangements',bad.a)).data,[]);}finally{await bad.app.close();}
});
test('忙闲硬冲突不能由模型接受；撤回授权后停止',async()=>{
  const s=await setup(a=>answer(a,0));
  try{
    await s.call('/me/arrangements',s.a,{title:'私密课程',date:s.day,startTime:'09:00',endTime:'10:00'});await s.authorize();await s.call(s.root+'/agents/start',s.a,{});
    assert.equal((await s.wait()).run.status,'FAILED');assert.ok(!JSON.stringify(s.requests).includes('私密课程'));assert.equal((await s.call(s.root+'/proposal',s.a)).status,204);
  }finally{await s.app.close();}
  let release;const revoked=await setup(()=>new Promise(resolve=>release=resolve));
  try{
    await revoked.authorize();await revoked.call(revoked.root+'/agents/start',revoked.a,{});
    for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
    await revoked.call(revoked.root+'/agents/consent',revoked.b,{enabled:false},'PUT');release({action:'answer',choice:0,decision:'counter'});
    await new Promise(r=>setTimeout(r,20));assert.equal((await revoked.call(revoked.root+'/proposal',revoked.a)).status,204);
  }finally{await revoked.app.close();}
});
