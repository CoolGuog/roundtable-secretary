import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/week-view.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, { exports });
const row = (id, startTime, endTime, date = '2026-10-06') => ({ id, title: id, date, startTime, endTime, createdAt: '' });
const task = (id, dueDate, state) => ({ id, dueDate, state });
const view = (...args) => JSON.parse(JSON.stringify(exports.weeklyView(...args)));
test('周一开始，跨月跨年按北京时间，空白日期保留七天', () => {
  assert.equal(exports.weekStart('2027-01-01'), '2026-12-28'); assert.equal(exports.weekStart('2026-10-04'), '2026-09-28');
  const result = view([], [], '2026-10-06', new Date('2026-10-05T16:00:00Z'));
  assert.equal(result.days.length, 7); assert.equal(result.start, '2026-10-05'); assert.match(result.days[1].label, /^今天/);
  for (const value of ['2026-02-30', '2019-12-31', '2100-01-01', 'bad']) assert.throws(() => exports.weekStart(value));
});
test('重叠、包含和接壤时段去重统计，保留条数和结束边界，原始记录不变', () => {
  const records = [row('c', '11:00', '12:00'), row('a', '09:00', '11:00'), row('b', '09:30', '10:00'), row('d', '10:30', '11:30'), row('outside', '08:00', '09:00', '2026-10-12')];
  const before = JSON.stringify(records), result = view(records, [], '2026-10-06', new Date('2026-10-06T02:00:00Z'));
  assert.equal(result.stats.count, 4); assert.equal(result.stats.occupiedMinutes, 180); assert.equal(result.days[1].scheduledMinutes, 270);
  assert.equal(result.stats.ended, 1); assert.equal(result.days[1].records[0].stateLabel, '进行中'); assert.equal(JSON.stringify(records), before);
});
test('任务仅按选中周截止日期统计，待验收仍未完成，API 模式不显示假零值', () => {
  const tasks = [task('a', '2026-10-05', 'TODO'), task('b', '2026-10-06', 'REVIEW'), task('c', '2026-10-07', 'DONE'), task('outside', '2026-10-12', 'DOING')];
  const result = view([], tasks, '2026-10-06', new Date('2026-10-06T02:00:00Z'));
  assert.equal(result.stats.taskCount, 3); assert.equal(result.stats.taskDone, 1); assert.equal(result.stats.taskPending, 2); assert.equal(result.stats.taskOverdue, 1);
  assert.equal(view([], null, '2026-10-06').taskStatsAvailable, false);
  assert.equal(view([], [], '2020-01-01').canPrevious, false); assert.equal(view([], [], '2020-01-06').canPrevious, true);
  assert.equal(view([], [], '2099-12-31').canNext, false);
});
