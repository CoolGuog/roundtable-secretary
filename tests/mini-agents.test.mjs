import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness(request,confirm=true){
  let page;const timers=new Map();let id=0;
  const js=ts.transpileModule(fs.readFileSync('apps/miniprogram/src/pages/agents/index.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js,{exports:{},Page:value=>page=value,require:()=>({request,errorMessage:error=>error.message}),wx:{showModal:async()=>({confirm}),navigateBack(){}},setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  page.setData=patch=>Object.assign(page.data,patch);page.onLoad({id:'room'});page._visible=true;
  return {page,timers};
}
const state=authorized=>({enabled:true,isOwner:true,roomOpen:true,members:[{isMe:true,authorized}],run:null});

test('旧轮询不能覆盖新授权；离开页面停止轮询',async()=>{
  let finishRead;const h=harness(async(_path,method)=>method==='GET'?new Promise(resolve=>finishRead=resolve):state(true));
  const read=h.page.reload();await h.page.consent();assert.equal(h.page.data.authorized,true);
  finishRead(state(false));await read;assert.equal(h.page.data.authorized,true);assert.equal(h.timers.size,1);
  h.page.onHide();assert.equal(h.timers.size,0);assert.equal(h.page.data.busy,false);
});

test('取消授权或启动弹窗不请求；重复点击提交中只发一次',async()=>{
  const cancelled=[];const c=harness(async(...args)=>cancelled.push(args),false);
  await c.page.consent();await c.page.start();assert.equal(cancelled.length,0);
  const calls=[];let finish;const h=harness((...args)=>{calls.push(args);return new Promise(resolve=>finish=resolve);});
  const first=h.page.action('start','POST',{});await h.page.action('start','POST',{});assert.equal(calls.length,1);
  h.page.onHide();finish(state(true));await first;assert.equal(h.page.data.state,null);assert.equal(h.page.data.busy,false);
});
