import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/calendar-view.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText, { exports });
const view = (...args) => JSON.parse(JSON.stringify(exports.calendarView(...args)));
const item = (id, date, startTime, endTime, title = id) => ({ id, date, startTime, endTime, title, createdAt: '' });
const now = new Date('2026-10-03T07:00:00Z'); // 北京 15:00
const rows = [item('tomorrow', '2026-10-04', '08:00', '09:00', '项目会议'), item('ended', '2026-10-03', '14:00', '15:00', '项目复盘'),
  item('ongoing', '2026-10-03', '15:00', '16:00', 'API 讨论'), item('future', '2026-10-03', '17:00', '18:00', 'API 会议')];

test('按北京时间分钟判断开始和结束边界，未结束包含进行中', () => {
  const result = view(rows, '', 'all', '', now);
  assert.deepEqual(result.counts, { all: 4, today: 3, upcoming: 3, past: 1 });
  assert.deepEqual(result.groups[0].records.map(x => x.state), ['past', 'ongoing', 'future']);
  assert.equal(view(rows, '', 'upcoming', '', now).matchingCount, 3);
  assert.equal(view(rows, '', 'past', '', now).groups[0].records[0].id, 'ended');
});
test('搜索忽略大小写与首尾空格，和日期、分类组合且不改变原数据', () => {
  const before = JSON.stringify(rows);
  const result = view(rows, ' api ', 'upcoming', '2026-10-03', now);
  assert.equal(result.matchingCount, 2); assert.equal(result.filterActive, true);
  assert.equal(view(rows, '项目', 'past', '2026-10-04', now).matchingCount, 0);
  assert.equal(view(rows, '   ', 'all', '', now).filterActive, false);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(result.counts.all, 4, '分类计数来自完整列表，不能随搜索变化');
});
test('北京时间跨日更新今天分组，日期与时间顺序固定', () => {
  const records = [item('c', '2026-10-04', '09:00', '10:00'), item('a', '2026-10-03', '23:00', '23:59'), item('b', '2026-10-04', '08:00', '09:00')];
  assert.equal(view(records, '', 'today', '', new Date('2026-10-03T15:59:00Z')).matchingCount, 1);
  const after = view(records, '', 'today', '', new Date('2026-10-03T16:00:00Z'));
  assert.equal(after.matchingCount, 2); assert.match(after.groups[0].label, /^今天.*周日/);
  assert.deepEqual(after.groups[0].records.map(x => x.id), ['b', 'c']);
});
