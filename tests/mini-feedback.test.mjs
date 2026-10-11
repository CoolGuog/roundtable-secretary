import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('顶端错误浮窗一秒消失，重复提示重新计时，隐藏和销毁取消计时', () => {
  let definition, next = 0; const timers = new Map(), durations = [];
  const js = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/components/feedback-toast/index.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { Component: value => { definition = value; }, setTimeout: (callback, duration) => { durations.push(duration); timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id) });
  const component = { data: {}, ...definition.methods, setData(value) { Object.assign(this.data, value); } };
  component.display('请补全名称'); assert.equal(component.data.visible, true); assert.equal(durations[0], 1000);
  const old = component._timer; component.display('请补全日期'); assert.equal(timers.has(old), false); assert.equal(timers.size, 1);
  timers.get(component._timer)(); assert.equal(component.data.visible, false);
  component.display('请补全日期'); assert.equal(component.data.visible, true);
  definition.pageLifetimes.hide.call(component); assert.equal(component.data.visible, false); assert.equal(component._timer, undefined);
  component.display('读取失败'); definition.lifetimes.detached.call(component); assert.equal(component._timer, undefined);
});
