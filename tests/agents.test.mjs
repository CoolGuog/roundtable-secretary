import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../apps/api/dist/app.js';

async function setup(behavior) {
  const requests=[];
  const model={name:'test-agent',complete:async req=>{requests.push(req);const a=req.agent;
    if(!a.tools.read_busy)return {action:'read_busy'};
    if(!a.tools.read_preferences)return {action:'read_preferences'};
    if(a.scheduleReadAllowed&&!a.tools.read_schedule)return {action:'read_schedule'};
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

test('五人协商不能忽略中间成员异议，五人全部亲自接受才写入',async()=>{
 const s=await setup(a=>answer(a,a.round>=2||a.tools.read_preferences.some(p=>p.content==='THIRD_PRIVATE')?1:0));
 try{
  const room=(await s.call(s.root,s.a)).data;
  const d=(await s.call('/dev/sessions',null,{name:'丁'})).data.token,e=(await s.call('/dev/sessions',null,{name:'戊'})).data.token;
  for(const token of [s.c,d,e]){assert.equal((await s.call('/roundtables/join',token,{code:room.inviteCode})).status,201);await s.call(s.root+'/membership',token,{shareBusy:true},'PUT');}
  await s.call('/me/memories',s.c,{category:'PREFERENCE',label:'个人条件',content:'THIRD_PRIVATE'});
  const people=[s.a,s.b,s.c,d,e];for(const token of people)await s.call(s.root+'/agents/consent',token,{enabled:true},'PUT');
  await s.call(s.root+'/agents/start',s.a,{});const state=await s.wait();assert.equal(state.run.status,'READY');assert.equal(Math.max(...state.run.events.map(e=>e.round)),2);
  assert.ok(!JSON.stringify(state).includes('THIRD_PRIVATE'));
  const proposal=(await s.call(s.root+'/proposal',s.a)).data;assert.equal(proposal.votes.length,5);
  for(const token of people.slice(0,4))await s.call(s.root+'/proposals/'+proposal.id,token,{decision:'ACCEPT'},'PUT');
  assert.deepEqual((await s.call('/me/arrangements',s.a)).data,[]);
  await s.call(s.root+'/proposals/'+proposal.id,e,{decision:'ACCEPT'},'PUT');
  for(const token of people)assert.equal((await s.call('/me/arrangements',token)).data.length,1);
 }finally{await s.app.close();}
});

test('未授权的日程名称读取被阻止',async()=>{
 const s=await setup(()=>({action:'read_schedule'}));
 try{await s.authorize();await s.call(s.root+'/agents/start',s.a,{});const state=await s.wait();assert.equal(state.run.status,'FAILED');assert.match(state.run.message,/未授权读取日程名称/);assert.equal((await s.call(s.root+'/proposal',s.a)).status,204);}finally{await s.app.close();}
});

test('日程名称需本人单独授权；规则硬过滤；解释和日程不传给伙伴',async()=>{
 const s=await setup(a=>({...answer(a,a.offer!==null&&a.tools.read_busy[a.offer]?a.offer:a.tools.read_busy.findIndex(Boolean)),explanation:a.tools.read_schedule?'A_ONLY_REASON':'B_ONLY_REASON'}));
 try{
  await s.call('/me/arrangements',s.a,{title:'A_ONLY_COURSE',date:s.day,startTime:'09:00',endTime:'10:00'});
  await s.call('/me/memories',s.a,{category:'CONSTRAINT',label:'可校验安排规则',content:'所有活动：前后各留出60分钟'});
  await s.authorize();await s.call(s.root+'/agents/consent',s.a,{enabled:true,shareDetails:true},'PUT');
  await s.call(s.root+'/agents/start',s.a,{activityKind:'leisure'});const state=await s.wait();assert.equal(state.run.status,'READY');assert.ok(state.run.slot.startTime>='11:00');
  assert.ok(state.run.explanation.some(x=>x.includes('60分钟')));assert.ok(state.run.explanation.some(x=>x.includes('A_ONLY_REASON')));
  const b=(await s.call(s.root+'/agents',s.b)).data;assert.ok(!JSON.stringify(b).includes('A_ONLY_REASON'));assert.ok(!JSON.stringify(b).includes('60分钟'));
  const aRequests=s.requests.filter(r=>r.agent.scheduleReadAllowed);assert.ok(aRequests.some(r=>JSON.stringify(r).includes('A_ONLY_COURSE')));
  assert.ok(s.requests.filter(r=>!r.agent.scheduleReadAllowed).every(r=>!JSON.stringify(r).includes('A_ONLY_COURSE')));
  assert.ok(!JSON.stringify(state.run.events).includes('A_ONLY_COURSE'));
 }finally{await s.app.close();}
});

test('接受空提议会获得纠正机会且不会跳过主人确认',async()=>{
  const s=await setup(a=>a.offer===null&&!a.feedback?{action:'answer',choice:null,decision:'accept'}:answer(a,0));
  try{await s.authorize();await s.call(s.root+'/agents/start',s.a,{});assert.equal((await s.wait()).run.status,'READY');assert.ok(s.requests.some(r=>r.agent.feedback.includes('不能accept null')));assert.deepEqual((await s.call('/me/arrangements',s.a)).data,[]);}finally{await s.app.close();}
});

test('有空闲时软偏好拒绝获得一次纠正；明确硬限制可退出而不写入',async()=>{
  const s=await setup(a=>a.feedback?answer(a,0):{action:'answer',choice:null,decision:'decline'});
  try{
    await s.authorize();await s.call(s.root+'/agents/start',s.a,{});assert.equal((await s.wait()).run.status,'READY');
    assert.ok(s.requests.some(r=>r.agent.feedback.includes('软偏好')));
    assert.equal(s.requests[0].agent.title,'课程讨论');assert.match(s.requests[0].agent.candidates[0].weekday,/^周/);
  }finally{await s.app.close();}
  const hard=await setup(()=>({action:'answer',choice:null,decision:'decline',reason:'hard_constraint'}));
  try{await hard.authorize();await hard.call(hard.root+'/agents/start',hard.a,{});assert.equal((await hard.wait()).run.status,'NO_AGREEMENT');assert.equal((await hard.call(hard.root+'/proposal',hard.a)).status,204);}finally{await hard.app.close();}
});

test('重复工具复用结果且提示模型继续决策；持续重复显示明确失败原因',async()=>{
  const recovered=await setup(a=>a.feedback?answer(a,0):{action:'read_preferences'});
  try{
    await recovered.authorize();await recovered.call(recovered.root+'/agents/start',recovered.a,{});
    const state=await recovered.wait();assert.equal(state.run.status,'READY');
    assert.equal(state.run.events.filter(e=>e.text.includes('调用个人偏好')).length,2);
    assert.equal(recovered.requests.length,8);
  }finally{await recovered.app.close();}
  const stuck=await setup(()=>({action:'read_preferences'}));
  try{
    await stuck.authorize();await stuck.call(stuck.root+'/agents/start',stuck.a,{});
    const state=await stuck.wait();assert.equal(state.run.status,'FAILED');assert.match(state.run.message,/重复读取工具/);
    assert.equal(state.run.events.filter(e=>e.text.includes('调用个人偏好')).length,1);
    assert.equal((await stuck.call(stuck.root+'/proposal',stuck.a)).status,204);
  }finally{await stuck.app.close();}
});
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
test('五轮仍有分歧不创建方案；工具越权动作失败不写入',async()=>{
  const s=await setup(a=>answer(a,a.tools.read_preferences.some(p=>p.content==='B_PRIVATE')?1:0));
  try{await s.authorize();await s.call(s.root+'/agents/start',s.a,{});const state=await s.wait();assert.equal(state.run.status,'NO_AGREEMENT');assert.equal(Math.max(...state.run.events.map(e=>e.round)),5);assert.equal((await s.call(s.root+'/proposal',s.a)).status,204);}finally{await s.app.close();}
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
