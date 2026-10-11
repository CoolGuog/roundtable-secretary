import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/arrangement-conflicts.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const input = { title: '会议', date: '2026-10-05', startTime: '10:00', endTime: '11:00' };
const row = (id, startTime, endTime, date = input.date) => ({ id, title: id, startTime, endTime, date, createdAt: '' });

test('冲突覆盖包含、相交与完全相同，接壤和异日不冲突且不修改输入', () => {
  const items = [row('left', '09:30', '10:30'), row('right', '10:30', '11:30'), row('contains', '09:00', '12:00'),
    row('inside', '10:15', '10:45'), row('same', '10:00', '11:00'), row('before', '09:00', '10:00'),
    row('after', '11:00', '12:00'), row('other-day', '10:00', '11:00', '2026-10-06')];
  const before = JSON.stringify(items);
  assert.deepEqual(Array.from(exports.findConflicts(input, items), x => x.id), ['contains', 'left', 'same', 'inside', 'right']);
  assert.equal(JSON.stringify(items), before);
});
test('冲突前拒绝无效日期、时刻与空标题，闰年合法', () => {
  assert.equal(exports.validateDraft(input), '');
  assert.equal(exports.validateDraft({ ...input, date: '2028-02-29' }), '');
  for (const patch of [{ title: ' ' }, { title: '字'.repeat(61) }, { date: '2026-02-29' }, { date: '2026-04-31' },
    { date: '2019-12-31' }, { date: '2100-01-01' }, { startTime: '9:00' }, { endTime: '24:00' }, { startTime: '11:00' }, { startTime: '12:00' }]) {
    assert.notEqual(exports.validateDraft({ ...input, ...patch }), '', JSON.stringify(patch));
  }
});
test('重新确认识别草稿或冲突列表内容变化，忽略无关创建时间', () => {
  const items = [row('one', '10:00', '11:00')];
  const signature = exports.conflictSignature(input, items);
  for (const field of ['title', 'date', 'startTime', 'endTime']) {
    assert.notEqual(exports.conflictSignature({ ...input, [field]: 'changed' }, items), signature);
  }
  for (const field of ['id', 'title', 'date', 'startTime', 'endTime']) {
    assert.notEqual(exports.conflictSignature(input, [{ ...items[0], [field]: 'changed' }]), signature);
  }
  assert.equal(exports.conflictSignature(input, [{ ...items[0], createdAt: 'changed' }]), signature);
});
