import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/local-draft.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports });
const draft = (text, previous = null, today = '2026-10-03') => exports.localDraft(text, previous, today);

test('本机秘书分步补全标题、日期、起止时间，不默认推断时长', () => {
  let value = draft('和导师开会');
  assert.equal(value.title, '和导师开会'); assert.match(value.message, /哪一天/);
  value = draft('明天', value); assert.equal(value.date, '2026-10-04'); assert.equal(value.title, '和导师开会');
  value = draft('下午三点', value); assert.equal(value.startTime, '15:00'); assert.equal(value.endTime, null); assert.match(value.message, /结束/);
  value = draft('持续一个小时', value); assert.equal(value.endTime, '16:00'); assert.equal(value.status, 'READY');
  assert.equal(value.model, '本机规则'); assert.equal(value.usedMemories.length, 0);
});
test('完整句子、星期、半点和明确结束时刻可识别', () => {
  let value = draft('明天下午三点到四点和导师开会');
  assert.equal(value.title, '和导师开会'); assert.equal(value.startTime, '15:00'); assert.equal(value.endTime, '16:00');
  value = draft('下周三下午三点半跑步'); assert.equal(value.date, '2026-10-07'); assert.equal(value.startTime, '15:30');
  value = draft('17:00结束', value); assert.equal(value.endTime, '17:00');
});
test('更改开始时间重新询问结束时间，显式改标题不覆盖其他字段', () => {
  let value = draft('明天15:00到16:00开会');
  value = draft('改到后天下午五点', value); assert.equal(value.date, '2026-10-05'); assert.equal(value.startTime, '17:00'); assert.equal(value.endTime, null);
  value = draft('持续半小时', value); assert.equal(value.endTime, '17:30');
  value = draft('标题改为项目讨论', value); assert.equal(value.title, '项目讨论'); assert.equal(value.startTime, '17:00');
});
test('歧义时刻、错误日期、跨日与过期上下文不会成为可保存草稿', () => {
  for (const text of ['明天三点开会', '明天25:00开会', '2026-02-30下午三点到四点开会', '明天23:30开会持续一小时']) {
    assert.equal(draft(text).status, 'NEEDS_INPUT', text);
  }
  const value = draft('持续半小时', { title: '过期安排', date: '2026-10-01', startTime: '09:00', endTime: null });
  assert.equal(value.date, null);
  assert.equal(draft('好的').title, null);
  const ready = draft('明天15:00到16:00开会');
  const unknown = draft('换个合适的时间', ready);
  assert.equal(unknown.startTime, ready.startTime); assert.match(unknown.message, /没听懂/);
});
