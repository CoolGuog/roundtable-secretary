// 主动调用真实模型，产生API费用；仅使用独立内存中的虚构数据，不连接用户数据库。
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import {createApp} from '../apps/api/dist/app.js';
import {configuredHttpModel} from '../apps/api/dist/secretary-access.js';

let app;
try {
  const env={...parseEnv(fs.readFileSync(new URL('../.env',import.meta.url),'utf8')),...process.env};
  const upstream=configuredHttpModel(env);
  const model={name:upstream.name,complete:async req=>{const result=await upstream.complete(req);if(process.argv.includes('--debug'))console.log(JSON.stringify({action:String(result?.action).slice(0,30),choice:String(result?.choice).slice(0,30),decision:String(result?.decision).slice(0,30)}));return result;}};
  app=await createApp({storage:'memory',authMode:'demo',secretary:{mode:'http',model}});
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const call=async(path,token,body,method=body===undefined?'GET':'POST')=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok)throw Error('Request failed');
    return response.status===204?null:response.json();
  };
  const a=(await call('/dev/sessions',null,{name:'虚构甲'})).token,b=(await call('/dev/sessions',null,{name:'虚构乙'})).token;
  const day=new Date(Date.now()+32*3600000).toISOString().slice(0,10);
  const weekend=process.argv.includes('--weekend');
  const start=new Date(day+'T00:00:00Z');const saturday=new Date(start.getTime()+((6-start.getUTCDay()+7)%7)*86400000).toISOString().slice(0,10);
  const room=await call('/roundtables',a,{title:weekend?'虚构看电影':'虚构课程讨论',goal:weekend?'一起看电影放松':'商量一小时课程讨论时间，尽量照顾双方偏好',dateFrom:day,dateTo:weekend?saturday:day,startTime:weekend?'09:00':'13:00',endTime:'18:00',durationMinutes:60});
  await call('/roundtables/join',b,{code:room.inviteCode});const root='/roundtables/'+room.id;
  for(const [token,content] of [[a,'下午均可，优先接受对方可行的提议'],[b,weekend?'尽量把娱乐活动安排在周六':'优先15点以后']]){
    await call('/me/memories',token,{category:'PREFERENCE',label:'虚构偏好',content});
    await call(root+'/membership',token,{shareBusy:true},'PUT');
    await call(root+'/agents/consent',token,{enabled:true},'PUT');
  }
  await call('/me/arrangements',b,{title:'虚构课程',date:weekend?saturday:day,startTime:weekend?'09:00':'13:00',endTime:weekend?'12:00':'14:00'});
  await call(root+'/agents/start',a,{});
  let state;
  for(let i=0;i<130;i++){
    state=await call(root+'/agents',a);
    if(state.run.status!=='RUNNING')break;
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  console.log(JSON.stringify(state.run));
  if(state.run.status!=='READY')throw Error('No agreement');
  if(weekend && (state.run.slot.date!==saturday || state.run.slot.startTime<'12:00'))throw Error('Weekend preference not met');
  const proposal=await call(root+'/proposal',a);
  if(!proposal.votes.every(v=>v.decision==='PENDING'))throw Error('Unexpected vote');
  if((await call('/me/arrangements',a)).length!==0||(await call('/me/arrangements',b)).length!==1)throw Error('Unexpected write');
  console.log('PASS: 真实模型协商完成；双方待确认；没有自动写入日程。');
} catch {
  console.error('真实秘书协商验证未完成，请检查模型配置或公开协商结果；未输出密钥与上游响应。');process.exitCode=1;
} finally {await app?.close();}
