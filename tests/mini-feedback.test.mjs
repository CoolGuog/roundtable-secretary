import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  let definition, next = 0; const timers = new Map(), durations = [], events = [];
  const js = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/components/feedback-toast/index.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { Component: value => { definition = value; }, setTimeout: (callback, duration) => { durations.push(duration); timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id) });
  const component = { data: {}, ...definition.methods, setData(value) { Object.assign(this.data, value); }, triggerEvent(name) { events.push(name); } };
  const tick = () => { const id = component._timer; const fn = timers.get(id); timers.delete(id); fn(); };
  return { component, definition, timers, durations, events, tick };
}
test('错误浮窗显示五次，每次一秒、间隔半秒，结束后通知页面清空错误', () => {
  const c=harness(); c.component.display('请补全名称');
  for(let i=0;i<5;i++) {
    assert.equal(c.component.data.visible,true); c.tick(); assert.equal(c.component.data.visible,false);
    if(i<4) c.tick();
  }
  assert.deepEqual(c.durations,[1000,500,1000,500,1000,500,1000,500,1000]);
  assert.deepEqual(c.events,['dismiss']); assert.equal(c.timers.size,0);
  c.component.display('请补全名称'); assert.equal(c.component.data.visible,true); assert.equal(c.component._remaining,5);
});
test('替换错误重置五次，点击关闭和离页停止闪现，销毁不再触发页面事件', () => {
  const c=harness(); c.component.display('日期错误'); c.tick();
  const old=c.component._timer; c.component.display('时间错误'); assert.equal(c.timers.has(old),false); assert.equal(c.component._remaining,5);
  c.component.dismiss(); assert.equal(c.timers.size,0); assert.equal(c.component.data.visible,false);
  c.component.display('日期错误'); c.definition.pageLifetimes.hide.call(c.component); assert.equal(c.timers.size,0);
  c.component.display('日期错误'); const count=c.events.length; c.definition.lifetimes.detached.call(c.component); assert.equal(c.timers.size,0); assert.equal(c.events.length,count);
});
test('每个浮窗页面在结束后清空绑定状态，使相同错误可以再次触发', () => {
  for(const name of ['review','week','roundtables','memories','calendar','settings','meeting-work','secretary']) {
    const root=`apps/miniprogram/src/pages/${name}/index`;
    assert.match(fs.readFileSync(root+'.wxml','utf8'),/binddismiss="onFeedbackDismiss"/);
    let page;
    const js=ts.transpileModule(fs.readFileSync(root+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
    const stub=new Proxy({}, {get:()=>()=>[]});
    vm.runInNewContext(js,{exports:{},require:()=>stub,Page:value=>page=value});
    const state={error:'相同错误',statusError:'状态错误',taskError:'任务错误'};
    page.onFeedbackDismiss.call({setData:patch=>Object.assign(state,patch)});
    assert.equal(state.error,''); if(name==='secretary') assert.equal(state.statusError,''); if(name==='week') assert.equal(state.taskError,'');
  }
});
