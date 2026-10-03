import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function page(result) {
  let instance, saves = 0;
  const api = { today: () => '2026-09-30', modeLabel: () => '测试', listArrangements: async () => [], saveArrangement: async () => saves++, draftFromText: async () => result, errorMessage: error => error.message };
  const code = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/pages/secretary/index.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports: {}, require: () => api, wx: { showToast() {} }, Page: value => { instance = value; } });
  instance.setData = data => Object.assign(instance.data, data);
  return { instance, saves: () => saves };
}
test('不完整草稿清空旧字段并阻止保存，补全后才可写入', async () => {
  const c = page({ status: 'NEEDS_INPUT', title: '新安排', date: null, startTime: null, endTime: null, usedMemories: [], message: '请补全' });
  c.instance.setData({ title: '旧安排', date: '2026-10-10', startTime: '08:00', endTime: '09:00' });
  await c.instance.generate();
  assert.equal(c.instance.data.date, ''); assert.equal(c.instance.data.startTime, ''); assert.equal(c.instance.data.endTime, '');
  await c.instance.save(); assert.equal(c.saves(), 0); assert.match(c.instance.data.error, /补全/);
  c.instance.setData({ date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
  await c.instance.save(); assert.equal(c.saves(), 1);
});
test('模型不可用不显示可直接提交的旧表单，生成中不能保存', async () => {
  const c = page({ status: 'UNAVAILABLE', title: null, date: null, startTime: null, endTime: null, usedMemories: [], message: '暂不可用' });
  await c.instance.generate(); assert.equal(c.instance.data.showForm, false); assert.equal(c.instance.data.title, '');
  c.instance.setData({ drafting: true, title: '会议', date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
  await c.instance.save(); assert.equal(c.saves(), 0);
});
