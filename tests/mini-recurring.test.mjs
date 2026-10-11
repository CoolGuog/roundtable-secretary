import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { repeatModules } from './mini-repeat-loader.mjs';

function client(storage = new Map()) {
  const wx = { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key) };
  const modules = repeatModules(wx), exports = {};
  const js = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/secretary.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { exports, wx, require: name => name === './config' ? { config: { mode: 'local' } } : modules.get(name) || {} });
  return { api: exports, storage };
}
const fields = { title: '每周课程', date: '2027-01-04', startTime: '08:30', endTime: '10:00' };
test('前后端重复引擎一致，闰日与跨年按日期计算，不受设备时区影响', () => {
  assert.equal(fs.readFileSync('apps/api/src/repeat-engine.ts', 'utf8'), fs.readFileSync('apps/miniprogram/src/services/repeat-engine.ts', 'utf8'));
  const engine = repeatModules({}).get('./repeat-engine');
  assert.equal(engine.validDay('2027-02-29'), false); assert.equal(engine.validDay('2028-02-29'), true);
  assert.equal(engine.dayAfter('2027-12-31', 1), '2028-01-01');
});
test('本机只保存一条无期限规则，重启仍可查看远期；单次和后续操作不破坏其他次数', async () => {
  const c = client(); await c.api.saveArrangement({ ...fields, repeat: { kind: 'weekly', weekdays: [1, 3] } });
  assert.equal(c.storage.get('roundtable.demo.recurring.v1').length, 1);
  const restarted = client(c.storage).api;
  assert.ok((await restarted.listArrangements('2035-01-01', '2035-01-31')).length > 8);
  let rows = await restarted.listArrangements('2027-01-04', '2027-01-18');
  const moved = rows.find(row => row.date === '2027-01-06');
  await restarted.updateArrangement(moved.id, { ...fields, date: '2027-01-07', title: '一次调课' }, 'one');
  rows = await restarted.listArrangements('2027-01-04', '2027-01-18');
  assert.ok(!rows.some(row => row.date === '2027-01-06'));
  assert.equal(rows.find(row => row.date === '2027-01-07').title, '一次调课');
  await restarted.updateArrangement(rows.find(row => row.date === '2027-01-11').id, { ...fields, date: '2027-01-11', startTime: '10:00', endTime: '11:00' }, 'future');
  rows = await restarted.listArrangements('2027-01-04', '2027-01-18');
  assert.equal(rows.find(row => row.date === '2027-01-04').startTime, '08:30');
  assert.equal(rows.find(row => row.date === '2027-01-18').startTime, '10:00');
  await restarted.deleteArrangement(rows.find(row => row.date === '2027-01-13').id, 'future');
  assert.equal((await restarted.listArrangements('2035-01-01', '2035-01-31')).length, 0);
  assert.equal(c.storage.has('roundtable.demo.arrangements.v1'), false, '不能把展开结果存成独立日程');
});
test('本机每日截止、无效规则与时间校验，操作失败不能改写已保存规则', async () => {
  const c = client();
  await c.api.saveArrangement({ ...fields, repeat: { kind: 'daily', weekdays: [], until: '2027-01-06' } });
  assert.equal((await c.api.listArrangements('2027-01-04', '2027-01-18')).length, 3);
  for (const value of [{ ...fields, date: '2027-02-30' }, { ...fields, startTime: '25:00' }, { ...fields, repeat: { kind: 'weekly', weekdays: [] } }]) await assert.rejects(c.api.saveArrangement(value));
  const saved = structuredClone(c.storage.get('roundtable.demo.recurring.v1'));
  const row = (await c.api.listArrangements('2027-01-04', '2027-01-18'))[0];
  await assert.rejects(c.api.deleteArrangement(row.id, 'bad'));
  assert.deepEqual(c.storage.get('roundtable.demo.recurring.v1'), saved);
});

test('本机旧周重复可补结束日期，单次编辑不能改变整组截止日期', async () => {
  const c = client(); await c.api.saveArrangement({ ...fields, repeat: { kind: 'weekly', weekdays: [1, 3] } });
  const rows = await c.api.listArrangements('2027-01-04', '2027-01-18');
  const anchor = rows.find(row => row.date === '2027-01-11');
  await assert.rejects(c.api.updateArrangement(anchor.id, { ...fields, date: anchor.date, repeatUntil: '2027-01-13' }, 'one'));
  await c.api.updateArrangement(anchor.id, { ...fields, date: anchor.date, repeatUntil: '2027-01-13' }, 'future');
  assert.equal((await c.api.listArrangements('2027-01-04', '2027-01-18')).length, 4);
  assert.equal((await c.api.listArrangements('2027-02-01', '2027-02-28')).length, 0);
});
